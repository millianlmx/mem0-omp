// L'audit d'un dépôt : un runner lit `main` dans un worktree détaché (rien n'y est
// commité), rend faiblesses et features par l'outil hôte `audit_propose` ; l'humain
// choisit, et les propositions retenues partent en projet — planifié par modules
// comme un /project.
import * as path from "node:path";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { launch } from "./config.ts";
import type { AuditProposal, AuditRow, Store } from "./db.ts";
import type { Git } from "./git.ts";
import type { Oracle } from "./oracle.ts";
import { renderMemories } from "./oracle.ts";
import type { Exec } from "./proc.ts";
import { auditPrompt } from "./prompts.ts";
import type { HostToolResult } from "./rpc.ts";
import { RpcRunner } from "./rpc.ts";
import { hostToolsFor, runnerArgv, runnerEnv, runnerUnit, stopRunner } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import type { SpawnRunner } from "./orchestrator.ts";
// Cycle d'import sans risque : HarnessError ne sert qu'à l'appel, jamais au chargement.
import { HarnessError } from "./orchestrator.ts";


export type AuditorDeps = {
  config: HarnessConfig;
  store: Store;
  scheduler: Scheduler;
  git: Git;
  oracle: Oracle;
  spawn: SpawnRunner;
  exec: Exec;
  log: (line: string) => void;
  repo: (name: string) => RepoConfig;
  overlay: () => string;
  createProject: (input: { repo: string; title: string; features: { title: string; request: string; modules?: string[] }[] }) => Promise<{ projectId: string }>;
};

type LiveAudit = { abort: AbortController; runner: RpcRunner | null; unit: string | null; proposals: AuditProposal[] | null; done: Promise<void> };


/** Valide les arguments de `audit_propose`. */
export function parseProposals(args: Record<string, unknown>): { ok: true; proposals: AuditProposal[] } | { ok: false; error: string } {
  if (!Array.isArray(args.proposals)) return { ok: false, error: "proposals : liste attendue" };
  const proposals: AuditProposal[] = [];
  for (const [index, item] of args.proposals.slice(0, 10).entries()) {
    const p = (item ?? {}) as Record<string, unknown>;
    const strings = (value: unknown) => Array.isArray(value) && value.every(entry => typeof entry === "string");
    if (typeof p.title !== "string" || p.title.trim() === "" || typeof p.request !== "string" || p.request.trim() === "") {
      return { ok: false, error: `proposals[${index}] : title et request non vides attendus` };
    }
    if (!strings(p.modules) || (p.kind !== "faiblesse" && p.kind !== "feature") || typeof p.rationale !== "string") {
      return { ok: false, error: `proposals[${index}] : modules (chaînes), kind (faiblesse | feature) et rationale attendus` };
    }
    proposals.push({ title: p.title.trim(), request: p.request.trim(), modules: p.modules as string[], kind: p.kind, rationale: p.rationale.trim() });
  }
  return { ok: true, proposals };
}


export class Auditor {
  readonly #deps: AuditorDeps;
  readonly #live = new Map<string, LiveAudit>();

  constructor(deps: AuditorDeps) {
    this.#deps = deps;
  }

  #event(audit: AuditRow, extra: Record<string, unknown> = {}): void {
    this.#deps.store.appendEvent("audit_state", null, { auditId: audit.id, state: audit.state, repo: audit.repo, reason: audit.reason, ...extra });
  }

  #get(id: string): AuditRow {
    const audit = this.#deps.store.getAudit(id);
    if (!audit) throw new HarnessError(404, `audit inconnu : ${id}`);
    return audit;
  }

  create(repo: string, focus: string): AuditRow {
    this.#deps.repo(repo);
    const audit = this.#deps.store.createAudit({ id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, repo, focus: focus.trim() });
    this.#event(audit);
    return audit;
  }

  /** Les audits en file que le scheduler admet. */
  tick(): void {
    for (const audit of this.#deps.store.listAudits(["queued"])) {
      if (this.#live.has(audit.id)) continue;
      const slot = this.#deps.scheduler.tryAcquire("runner", audit.id);
      if ("refused" in slot) return;
      const live: LiveAudit = { abort: new AbortController(), runner: null, unit: null, proposals: null, done: Promise.resolve() };
      this.#live.set(audit.id, live);
      live.done = this.#drive(audit, live).finally(async () => {
        await this.#stopRunner(live);
        slot.release();
        this.#live.delete(audit.id);
      });
    }
  }

  async #drive(queued: AuditRow, live: LiveAudit): Promise<void> {
    const { store, git, config } = this.#deps;
    const repo = this.#deps.repo(queued.repo);
    const worktree = path.join(config.worktreesDir, repo.name, `_audit-${queued.id}`);
    const started = store.updateAuditIf(queued.id, ["queued"], { state: "analysing" });
    if (!started) return;
    this.#event(started);
    let outcome: { proposals: AuditProposal[] } | { reason: string };
    try {
      outcome = { proposals: await this.#analyse(queued, live, repo, worktree) };
    } catch (err) {
      outcome = { reason: err instanceof Error ? err.message : String(err) };
    } finally {
      // Runner arrêté et worktree rendu AVANT d'annoncer l'issue.
      await this.#stopRunner(live);
      await git.removeWorktree(repo.path, worktree, null).catch(() => {});
    }
    if (live.abort.signal.aborted) return;
    const audit =
      "proposals" in outcome
        ? store.updateAuditIf(queued.id, ["analysing"], { state: "proposed", proposals: outcome.proposals, reason: null })
        : store.updateAuditIf(queued.id, ["analysing"], { state: "failed", reason: outcome.reason });
    if (audit) this.#event(audit, "proposals" in outcome ? { proposals: outcome.proposals.length } : {});
    if ("reason" in outcome) this.#deps.log(`audit ${queued.id} en échec : ${outcome.reason}`);
  }

  async #analyse(audit: AuditRow, live: LiveAudit, repo: RepoConfig, worktree: string): Promise<AuditProposal[]> {
    const { git, config, scheduler, oracle } = this.#deps;
    await git.addWorktree(repo.path, worktree, null, await git.revParse(repo.path, repo.mainBranch));
    const pick = await scheduler.waitModel("heavy", config.models.heavy, 0, live.abort.signal);
    const unit = runnerUnit(audit.id, 0);
    const argv = runnerArgv(config, { unit, cwd: worktree, overlay: this.#deps.overlay(), model: pick?.choice ?? null, scope: repo.scope });
    const proc = this.#deps.spawn(argv.command, argv.args, { cwd: worktree, env: runnerEnv(repo.scope, config.oracle) });
    live.runner = new RpcRunner(proc, { onHostTool: (name, args) => this.#hostTool(audit, live, name, args) });
    live.unit = unit;
    await live.runner.ready();
    await live.runner.setHostTools(hostToolsFor("audit"));
    const memories = renderMemories(await oracle.recall(repo.scope, audit.focus || repo.name));
    let result = await live.runner.prompt(auditPrompt({ repo: repo.name, focus: audit.focus, memories }));
    if (result.status === "completed" && live.proposals === null) {
      result = await live.runner.prompt("L'étape /audit n'est pas terminée : les propositions n'ont pas été rendues par `audit_propose`. Rends-les maintenant.");
    }
    if (result.status !== "completed") throw new Error(result.error?.message ?? "erreur du runner");
    if (live.proposals === null) throw new Error("les propositions n'ont pas été rendues par `audit_propose`");
    return live.proposals;
  }

  async #hostTool(audit: AuditRow, live: LiveAudit, name: string, args: Record<string, unknown>): Promise<HostToolResult> {
    const repo = this.#deps.repo(audit.repo);
    switch (name) {
      case "progress": {
        const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
        this.#deps.store.appendEvent("progress", null, { auditId: audit.id, message });
        return { text: "noté" };
      }
      case "oracle_recall":
        return { text: renderMemories(await this.#deps.oracle.recall(repo.scope, typeof args.query === "string" ? args.query : audit.focus || repo.name)) };
      case "audit_propose": {
        const parsed = parseProposals(args);
        if (!parsed.ok) return { text: `propositions refusées : ${parsed.error}`, isError: true };
        live.proposals = parsed.proposals;
        return { text: `${parsed.proposals.length} proposition(s) enregistrée(s). Termine ton tour.` };
      }
      default:
        return { text: `outil inconnu : ${name}`, isError: true };
    }
  }

  async #stopRunner(live: LiveAudit): Promise<void> {
    const runner = live.runner;
    const unit = live.unit;
    live.runner = null;
    live.unit = null;
    if (runner) await stopRunner(this.#deps.config, this.#deps.exec, runner, unit);
  }

  /** Les propositions retenues (index) partent en projet ; l'audit est clos. */
  async launch(id: string, items: number[], title = ""): Promise<{ audit: AuditRow; projectId: string }> {
    const audit = this.#get(id);
    if (audit.state !== "proposed") throw new HarnessError(409, `l'audit n'a pas de propositions à lancer (état ${audit.state})`);
    const picked = [...new Set(items)].map(index => audit.proposals[index]);
    if (picked.length === 0 || picked.some(item => item === undefined)) throw new HarnessError(400, `items : index de propositions attendus (0 à ${audit.proposals.length - 1})`);
    // Le CAS d'abord : deux lancements simultanés ne créent pas deux projets.
    if (!this.#deps.store.updateAuditIf(id, ["proposed"], { state: "launched" })) throw new HarnessError(409, "l'audit a changé d'état");
    try {
      const features = (picked as AuditProposal[]).map(item => ({ title: item.title, request: item.request, ...(item.modules.length > 0 ? { modules: item.modules } : {}) }));
      const { projectId } = await this.#deps.createProject({ repo: audit.repo, title: title.trim() || `Audit — ${audit.focus || audit.repo}`, features });
      const launched = this.#deps.store.updateAuditIf(id, ["launched"], { projectId }) as AuditRow;
      this.#event(launched, { projectId });
      return { audit: launched, projectId };
    } catch (err) {
      this.#deps.store.updateAuditIf(id, ["launched"], { state: "proposed" });
      throw err;
    }
  }

  async cancel(id: string): Promise<AuditRow> {
    const audit = this.#get(id);
    const cancelled = this.#deps.store.updateAuditIf(id, ["queued", "analysing", "proposed"], { state: "cancelled", reason: "annulé par l'humain" });
    if (!cancelled) throw new HarnessError(409, `audit déjà ${audit.state}`);
    const live = this.#live.get(id);
    if (live) {
      live.abort.abort();
      await this.#stopRunner(live);
      await live.done;
    }
    this.#event(cancelled);
    return cancelled;
  }

  /** Un audit qu'un process mort a laissé en analyse repart de zéro (rien n'a été écrit). */
  async recover(): Promise<void> {
    const { store, config, exec } = this.#deps;
    for (const audit of store.listAudits(["analysing"])) {
      if (config.runner.isolation === "systemd") {
        const stop = launch(config, ["--stop", `${runnerUnit(audit.id, 0)}.scope`]);
        await exec(stop.command, stop.args, { timeoutMs: 15_000 });
      }
      const worktree = path.join(config.worktreesDir, audit.repo, `_audit-${audit.id}`);
      await this.#deps.git.removeWorktree(this.#deps.repo(audit.repo).path, worktree, null).catch(() => {});
      const requeued = store.updateAuditIf(audit.id, ["analysing"], { state: "queued", reason: "service redémarré — audit relancé" });
      if (requeued) this.#event(requeued);
    }
  }

  async stop(): Promise<void> {
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await this.#stopRunner(live);
    }
    await Promise.allSettled(lives.map(live => live.done));
  }
}
