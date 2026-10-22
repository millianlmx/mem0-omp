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
import { isTerminal } from "./machine.ts";
import { renderMemories } from "./oracle.ts";
import { auditPrompt } from "./prompts.ts";
import type { HostToolResult } from "./rpc.ts";
import { forceStop, hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";

export type AuditorHooks = {
  createProject: (
    input: { repo: string; title: string; features: { title: string; request: string; modules?: string[] }[] },
    actor: Actor,
  ) => Promise<{ projectId: string }>;
};

type LiveAudit = {
  abort: AbortController;
  session: RunnerSession | null;
  proposals: AuditProposal[] | null;
  done: Promise<void>;
};

const LEVELS = ["low", "medium", "high"] as const;
type Level = (typeof LEVELS)[number];

function level(value: unknown): Level | null {
  return LEVELS.find((entry) => entry === value) ?? null;
}

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Ordre topologique stable des index `picked` selon `dependsOn` (les prérequis hors de la
 * sélection sont ignorés : l'humain a choisi). `null` si les dépendances bouclent.
 */
export function launchOrder(proposals: readonly Pick<AuditProposal, "dependsOn">[], picked: number[]): number[] | null {
  const chosen = new Set(picked);
  const order: number[] = [];
  const placed = new Set<number>();
  let progressed = true;
  while (progressed && order.length < picked.length) {
    progressed = false;
    for (const index of picked) {
      if (placed.has(index)) continue;
      const deps = (proposals[index]?.dependsOn ?? []).filter((dep) => chosen.has(dep));
      if (deps.every((dep) => placed.has(dep))) {
        order.push(index);
        placed.add(index);
        progressed = true;
      }
    }
  }
  return order.length === picked.length ? order : null;
}

/**
 * Valide les arguments de `audit_propose` : une faiblesse cite au moins un `fichier:ligne`,
 * `dependsOn` (titres ou index) est résolu en index, sans inconnue, sans soi-même, sans cycle.
 */
export function parseProposals(
  args: Record<string, unknown>,
): { ok: true; proposals: AuditProposal[] } | { ok: false; error: string } {
  if (!Array.isArray(args.proposals)) return { ok: false, error: "proposals : liste attendue" };
  const items = args.proposals.slice(0, 10).map((item: unknown): Record<string, unknown> => {
    return typeof item === "object" && item !== null && !Array.isArray(item) ? { ...item } : {};
  });
  const titles = items.map((p) => (typeof p.title === "string" ? p.title.trim().toLowerCase() : ""));
  const proposals: AuditProposal[] = [];
  for (const [index, p] of items.entries()) {
    if (
      typeof p.title !== "string" ||
      p.title.trim() === "" ||
      typeof p.request !== "string" ||
      p.request.trim() === ""
    ) {
      return { ok: false, error: `proposals[${index}] : title et request non vides attendus` };
    }
    if (!strings(p.modules) || (p.kind !== "faiblesse" && p.kind !== "feature") || typeof p.rationale !== "string") {
      return {
        ok: false,
        error: `proposals[${index}] : modules (chaînes), kind (faiblesse | feature) et rationale attendus`,
      };
    }
    const evidence = strings(p.evidence) ? p.evidence.map((entry) => entry.trim()).filter((entry) => entry !== "") : null;
    if (evidence === null) return { ok: false, error: `proposals[${index}] : evidence (liste de fichier:ligne) attendue` };
    if (p.kind === "faiblesse" && evidence.length === 0) {
      return {
        ok: false,
        error: `proposals[${index}] « ${p.title.trim()} » : une faiblesse cite au moins un fichier:ligne dans evidence`,
      };
    }
    const impact = level(p.impact);
    const effort = level(p.effort);
    if (impact === null || effort === null)
      return { ok: false, error: `proposals[${index}] : impact et effort (low | medium | high) attendus` };
    if (!Array.isArray(p.dependsOn)) return { ok: false, error: `proposals[${index}] : dependsOn (liste) attendue` };
    const dependsOn: number[] = [];
    for (const dep of p.dependsOn) {
      const resolved =
        typeof dep === "number" && Number.isInteger(dep)
          ? dep
          : typeof dep === "string"
            ? titles.indexOf(dep.trim().toLowerCase())
            : -1;
      if (resolved < 0 || resolved >= items.length)
        return { ok: false, error: `proposals[${index}] : dependsOn cite une proposition inconnue (${String(dep)})` };
      if (resolved === index) return { ok: false, error: `proposals[${index}] : dependsOn se cite elle-même` };
      if (!dependsOn.includes(resolved)) dependsOn.push(resolved);
    }
    proposals.push({
      title: p.title.trim(),
      request: p.request.trim(),
      modules: p.modules,
      kind: p.kind,
      rationale: p.rationale.trim(),
      evidence,
      dependsOn,
      impact,
      effort,
    });
  }
  if (launchOrder(proposals, proposals.map((_, index) => index)) === null)
    return { ok: false, error: "dependsOn : les dépendances forment un cycle" };
  return { ok: true, proposals };
}

/** Le modèle a répondu sans rendre de propositions : relancer l'analyse n'y changerait rien. */
class NoProposalsError extends Error {}

export class Auditor {
  readonly #ctx: HarnessContext;
  readonly #hooks: AuditorHooks;
  readonly #live = new Map<string, LiveAudit>();

  constructor(ctx: HarnessContext, hooks: AuditorHooks) {
    this.#ctx = ctx;
    this.#hooks = hooks;
  }

  #event(audit: AuditRow, extra: Record<string, unknown> = {}): void {
    this.#ctx.event(
      "audit_state",
      null,
      { auditId: audit.id, state: audit.state, repo: audit.repo, reason: audit.reason, ...extra },
      audit.repo,
    );
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
    let outcome: { proposals: AuditProposal[] } | { reason: string } = { reason: "" };
    // Une analyse en échec (runner, réseau, échéance) repart une fois, runner et worktree neufs ;
    // pas quand le modèle a répondu sans rien proposer : la relance rendrait la même chose.
    for (let attempt = 0; attempt < 2; attempt++) {
      live.proposals = null;
      let retry = false;
      try {
        outcome = { proposals: await this.#analyse(queued, live, repo, worktree, attempt) };
      } catch (err) {
        outcome = { reason: err instanceof Error ? err.message : String(err) };
        retry = attempt === 0 && !(err instanceof NoProposalsError) && !live.abort.signal.aborted;
      } finally {
        // Runner arrêté et worktree rendu AVANT d'annoncer l'issue (ou de repartir).
        await live.session?.stop();
        live.session = null;
        await git.removeWorktree(repo.path, worktree, null).catch(() => {});
      }
      if (!retry) break;
      this.#ctx.log(`audit ${queued.id} : analyse relancée après « ${"reason" in outcome ? outcome.reason : ""} »`);
      this.#event(started, { retry: true, reason: "reason" in outcome ? outcome.reason : "" });
    }
    if (live.abort.signal.aborted) return;
    store.transaction(() => {
      const audit =
        "proposals" in outcome
          ? store.updateAuditIf(queued.id, ["analysing"], {
              state: "proposed",
              proposals: outcome.proposals,
              reason: null,
            })
          : store.updateAuditIf(queued.id, ["analysing"], { state: "failed", reason: outcome.reason });
      if (audit) this.#event(audit, "proposals" in outcome ? { proposals: outcome.proposals.length } : {});
    });
    if ("reason" in outcome) this.#ctx.log(`audit ${queued.id} en échec : ${outcome.reason}`);
  }

  async #analyse(
    audit: AuditRow,
    live: LiveAudit,
    repo: RepoConfig,
    worktree: string,
    attempt: number,
  ): Promise<AuditProposal[]> {
    const { git, config, oracle, store } = this.#ctx;
    await git.addWorktree(repo.path, worktree, null, await git.revParse(repo.path, repo.mainBranch));
    // La même session que les runs : bascule de fournisseur sur rate limit, échéance de l'étape.
    const session = new RunnerSession(
      this.#ctx,
      { repo, cwd: worktree },
      {
        onHostTool: (name, args) => this.#hostTool(audit, live, name, args),
        event: (type, payload) => this.#ctx.event(type, null, { auditId: audit.id, ...payload }, audit.repo),
      },
    );
    live.session = session;
    const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
    await session.open("heavy", runnerUnit(audit.id, attempt), live.abort.signal);
    await session.setHostTools(hostToolsFor("audit"));
    const query = audit.focus || repo.name;
    const [memories, delivered] = await Promise.all([
      oracle.recall(repo.scope, query),
      oracle.recall(repo.scope, `feature mergée ${repo.name}`),
    ]);
    const inFlight = store
      .listRuns({ repo: repo.name })
      .filter((run) => !isTerminal(run.state))
      .map((run) => run.title);
    let result = await session.prompt(
      auditPrompt({
        repo: repo.name,
        focus: audit.focus,
        memories: renderMemories(memories),
        inFlight,
        delivered: renderMemories(delivered.filter((m) => /feature mergée/i.test(m.text))),
      }),
      live.abort.signal,
      deadlineAt,
    );
    if (result.status === "completed" && live.proposals === null) {
      result = await session.prompt(
        "L'étape /audit n'est pas terminée : les propositions n'ont pas été rendues par `audit_propose`. Rends-les maintenant.",
        live.abort.signal,
        deadlineAt,
      );
    }
    if (result.status !== "completed") throw new Error(result.error?.message ?? "erreur du runner");
    if (live.proposals === null) throw new NoProposalsError("les propositions n'ont pas été rendues par `audit_propose`");
    return live.proposals;
  }

  async #hostTool(
    audit: AuditRow,
    live: LiveAudit,
    name: string,
    args: Record<string, unknown>,
  ): Promise<HostToolResult> {
    const repo = this.#ctx.repo(audit.repo);
    switch (name) {
      case "progress": {
        const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
        this.#ctx.event("progress", null, { auditId: audit.id, message }, audit.repo);
        return { text: "noté" };
      }
      case "oracle_recall":
        return {
          text: renderMemories(
            await this.#ctx.oracle.recall(
              repo.scope,
              typeof args.query === "string" ? args.query : audit.focus || repo.name,
            ),
          ),
        };
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

  /**
   * Les propositions retenues (index) partent en projet, ordonnées selon `dependsOn` : le
   * `projectOrder` posé par createProject fait passer une feature après ses prérequis.
   * L'audit est clos.
   */
  async launch(
    id: string,
    items: number[],
    title = "",
    actor: Actor = SERVICE,
  ): Promise<{ audit: AuditRow; projectId: string }> {
    const { store } = this.#ctx;
    const audit = this.#get(id);
    if (audit.state !== "proposed")
      throw new HarnessError(409, `l'audit n'a pas de propositions à lancer (état ${audit.state})`);
    const indexes = [...new Set(items)];
    if (indexes.length === 0 || indexes.some((index) => audit.proposals[index] === undefined))
      throw new HarnessError(400, `items : index de propositions attendus (0 à ${audit.proposals.length - 1})`);
    const ordered = launchOrder(audit.proposals, indexes);
    if (ordered === null) throw new HarnessError(400, "dependsOn : les dépendances des propositions forment un cycle");
    const picked = ordered.flatMap((index) => audit.proposals[index] ?? []);
    // Le CAS d'abord : deux lancements simultanés (deux clients) ne créent pas deux projets.
    if (!store.updateAuditIf(id, ["proposed"], { state: "launched" }))
      throw new HarnessError(409, "l'audit a changé d'état");
    try {
      const features = picked.map((item) => ({
        title: item.title,
        request: item.request,
        ...(item.modules.length > 0 ? { modules: item.modules } : {}),
      }));
      const { projectId } = await this.#hooks.createProject(
        { repo: audit.repo, title: title.trim() || `Audit — ${audit.focus || audit.repo}`, features },
        actor,
      );
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
    const cancelled = this.#ctx.store.updateAuditIf(id, ["queued", "analysing", "proposed"], {
      state: "cancelled",
      reason: "annulé par l'humain",
    });
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
      const requeued = store.updateAuditIf(audit.id, ["analysing"], {
        state: "queued",
        reason: "service redémarré — audit relancé",
      });
      if (requeued) this.#event(requeued);
    }
  }

  async stop(): Promise<void> {
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await live.session?.stop();
    }
    await Promise.allSettled(lives.map((live) => live.done));
  }
}
