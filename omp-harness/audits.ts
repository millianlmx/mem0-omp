// L'audit d'un dépôt : un runner lit `main` dans un worktree détaché (rien n'y est
// commité), rend faiblesses et features par l'outil hôte `audit_propose` ; l'humain
// choisit, et les propositions retenues partent en projet — planifié par modules
// comme un /project.
import * as path from "node:path";
import type { RepoConfig } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import { SERVICE } from "./context.ts";
import type { AuditProposal, AuditRow } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { renderMemories } from "./oracle.ts";
import { auditPrompt } from "./prompts.ts";
import type { HostToolResult } from "./rpc.ts";
import { forceStop, hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";


export type AuditorHooks = {
  createProject: (input: { repo: string; title: string; features: { title: string; request: string; modules?: string[] }[] }, actor: Actor) => Promise<{ projectId: string }>;
};

type LiveAudit = { abort: AbortController; session: RunnerSession | null; proposals: AuditProposal[] | null; done: Promise<void> };


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
  readonly #ctx: HarnessContext;
  readonly #hooks: AuditorHooks;
  readonly #live = new Map<string, LiveAudit>();

  constructor(ctx: HarnessContext, hooks: AuditorHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  #event(audit: AuditRow, extra: Record<string, unknown> = {}): void {
    this.#ctx.event("audit_state", null, { auditId: audit.id, state: audit.state, repo: audit.repo, reason: audit.reason, ...extra }, audit.repo);
  }

  #get(id: string): AuditRow {
    const audit = this.#ctx.store.getAudit(id);
    if (!audit) throw new HarnessError(404, `audit inconnu : ${id}`);
    return audit;
  }

  create(repo: string, focus: string, actor: Actor = SERVICE): AuditRow {
    this.#ctx.repo(repo);
    const { store } = this.#ctx;
    return store.transaction(() => {
      const audit = store.createAudit({ id: newId("a"), repo, focus: focus.trim() });
      this.#event(audit, actor.by ? { by: actor.by } : {});
      return audit;
    });
  }

  /** Les audits en file que le scheduler admet. */
  tick(): void {
    for (const audit of this.#ctx.store.listAudits(["queued"])) {
      if (this.#live.has(audit.id)) continue;
      const slot = this.#ctx.scheduler.tryAcquire("runner", audit.id);
      if ("refused" in slot) return;
      const live: LiveAudit = { abort: new AbortController(), session: null, proposals: null, done: Promise.resolve() };
      this.#live.set(audit.id, live);
      live.done = this.#drive(audit, live).finally(async () => {
        await live.session?.stop();
        slot.release();
        this.#live.delete(audit.id);
      });
    }
  }

  async #drive(queued: AuditRow, live: LiveAudit): Promise<void> {
    const { store, git, config } = this.#ctx;
    const repo = this.#ctx.repo(queued.repo);
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
      await live.session?.stop();
      await git.removeWorktree(repo.path, worktree, null).catch(() => {});
    }
    if (live.abort.signal.aborted) return;
    store.transaction(() => {
      const audit =
        "proposals" in outcome
          ? store.updateAuditIf(queued.id, ["analysing"], { state: "proposed", proposals: outcome.proposals, reason: null })
          : store.updateAuditIf(queued.id, ["analysing"], { state: "failed", reason: outcome.reason });
      if (audit) this.#event(audit, "proposals" in outcome ? { proposals: outcome.proposals.length } : {});
    });
    if ("reason" in outcome) this.#ctx.log(`audit ${queued.id} en échec : ${outcome.reason}`);
  }

  async #analyse(audit: AuditRow, live: LiveAudit, repo: RepoConfig, worktree: string): Promise<AuditProposal[]> {
    const { git, config, oracle } = this.#ctx;
    await git.addWorktree(repo.path, worktree, null, await git.revParse(repo.path, repo.mainBranch));
    // La même session que les runs : bascule de fournisseur sur rate limit, échéance de l'étape.
    const session = new RunnerSession(this.#ctx, { repo, cwd: worktree }, {
      onHostTool: (name, args) => this.#hostTool(audit, live, name, args),
      event: (type, payload) => this.#ctx.event(type, null, { auditId: audit.id, ...payload }, audit.repo),
    });
    live.session = session;
    const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
    await session.open("heavy", runnerUnit(audit.id, 0), live.abort.signal);
    await session.setHostTools(hostToolsFor("audit"));
    const memories = renderMemories(await oracle.recall(repo.scope, audit.focus || repo.name));
    let result = await session.prompt(auditPrompt({ repo: repo.name, focus: audit.focus, memories }), live.abort.signal, deadlineAt);
    if (result.status === "completed" && live.proposals === null) {
      result = await session.prompt("L'étape /audit n'est pas terminée : les propositions n'ont pas été rendues par `audit_propose`. Rends-les maintenant.", live.abort.signal, deadlineAt);
    }
    if (result.status !== "completed") throw new Error(result.error?.message ?? "erreur du runner");
    if (live.proposals === null) throw new Error("les propositions n'ont pas été rendues par `audit_propose`");
    return live.proposals;
  }

  async #hostTool(audit: AuditRow, live: LiveAudit, name: string, args: Record<string, unknown>): Promise<HostToolResult> {
    const repo = this.#ctx.repo(audit.repo);
    switch (name) {
      case "progress": {
        const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
        this.#ctx.event("progress", null, { auditId: audit.id, message }, audit.repo);
        return { text: "noté" };
      }
      case "oracle_recall":
        return { text: renderMemories(await this.#ctx.oracle.recall(repo.scope, typeof args.query === "string" ? args.query : audit.focus || repo.name)) };
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

  /** Les propositions retenues (index) partent en projet ; l'audit est clos. */
  async launch(id: string, items: number[], title = "", actor: Actor = SERVICE): Promise<{ audit: AuditRow; projectId: string }> {
    const { store } = this.#ctx;
    const audit = this.#get(id);
    if (audit.state !== "proposed") throw new HarnessError(409, `l'audit n'a pas de propositions à lancer (état ${audit.state})`);
    const picked = [...new Set(items)].map(index => audit.proposals[index]);
    if (picked.length === 0 || picked.some(item => item === undefined)) throw new HarnessError(400, `items : index de propositions attendus (0 à ${audit.proposals.length - 1})`);
    // Le CAS d'abord : deux lancements simultanés (deux clients) ne créent pas deux projets.
    if (!store.updateAuditIf(id, ["proposed"], { state: "launched" })) throw new HarnessError(409, "l'audit a changé d'état");
    try {
      const features = (picked as AuditProposal[]).map(item => ({ title: item.title, request: item.request, ...(item.modules.length > 0 ? { modules: item.modules } : {}) }));
      const { projectId } = await this.#hooks.createProject({ repo: audit.repo, title: title.trim() || `Audit — ${audit.focus || audit.repo}`, features }, actor);
      const launched = store.updateAuditIf(id, ["launched"], { projectId }) as AuditRow;
      this.#event(launched, { projectId, ...(actor.by ? { by: actor.by } : {}) });
      return { audit: launched, projectId };
    } catch (err) {
      store.updateAuditIf(id, ["launched"], { state: "proposed" });
      throw err;
    }
  }

  async cancel(id: string, actor: Actor = SERVICE): Promise<AuditRow> {
    const audit = this.#get(id);
    const cancelled = this.#ctx.store.updateAuditIf(id, ["queued", "analysing", "proposed"], { state: "cancelled", reason: "annulé par l'humain" });
    if (!cancelled) throw new HarnessError(409, `audit déjà ${audit.state}`);
    const live = this.#live.get(id);
    if (live) {
      live.abort.abort();
      await live.session?.stop();
      await live.done;
    }
    this.#event(cancelled, actor.by ? { by: actor.by } : {});
    return cancelled;
  }

  /** Un audit qu'un process mort a laissé en analyse repart de zéro (rien n'a été écrit). */
  async recover(): Promise<void> {
    const { store, config, exec } = this.#ctx;
    for (const audit of store.listAudits(["analysing"])) {
      await forceStop(config, exec, runnerUnit(audit.id, 0));
      const worktree = path.join(config.worktreesDir, audit.repo, `_audit-${audit.id}`);
      await this.#ctx.git.removeWorktree(this.#ctx.repo(audit.repo).path, worktree, null).catch(() => {});
      const requeued = store.updateAuditIf(audit.id, ["analysing"], { state: "queued", reason: "service redémarré — audit relancé" });
      if (requeued) this.#event(requeued);
    }
  }

  async stop(): Promise<void> {
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await live.session?.stop();
    }
    await Promise.allSettled(lives.map(live => live.done));
  }
}
