// Le rêve de la mémoire (phases 3 et 4) : quand un dépôt est au repos, un runner relit
// les faits nouveaux de sa mémoire (le dossier de mem0-rs) et les consolide en
// observations, liens de cause et mental models, rendus par l'outil hôte
// `dream_consolidate`. Le service mémoire valide et applique la consolidation d'un bloc ;
// un refus revient au modèle avec sa raison, qui corrige et rappelle l'outil.
//
// Les phases 1, 2, 5 et 6 (réindexation, paires proches, oubli, journal) tournent dans
// mem0-rs, sur son propre LLM : seules celles qui raisonnent sur toute une portée passent
// par une session omp, dont les modèles sont déjà configurés pour les runs.
//
// Rien n'est persisté ici : le filigrane de consolidation vit dans mem0-rs, et un rêve
// interrompu (arrêt, échec) est simplement repris au prochain examen.
import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoConfig } from "./config.ts";
import type { Actor, HarnessContext } from "./context.ts";
import { SERVICE } from "./context.ts";
import { HarnessError } from "./errors.ts";
import { newId } from "./ids.ts";
import { isTerminal } from "./machine.ts";
import type { ConsolidationReport, DreamDossier } from "./oracle.ts";
import { renderMemories } from "./oracle.ts";
import { dreamPrompt } from "./prompts.ts";
import type { HostToolResult } from "./rpc.ts";
import { hostToolsFor, runnerUnit } from "./runner.ts";
import { RunnerSession } from "./runner-session.ts";

export type DreamState = "dreaming" | "done" | "skipped" | "failed";

/** Le dernier rêve d'un dépôt, tel que rendu par `GET /v1/dreams`. */
export type DreamRow = {
  repo: string;
  id: string;
  state: DreamState;
  /** Début du rêve (ms). */
  at: number;
  /** Faits nouveaux du dossier ; `null` avant sa lecture. */
  facts: number | null;
  reason: string | null;
  report: ConsolidationReport | null;
};

type LiveDream = { abort: AbortController; session: RunnerSession | null; done: Promise<void> };

/** Les champs que `dream_consolidate` transmet au service mémoire. */
export type Consolidation = {
  observations: { id?: string; text: string; evidence: string[] }[];
  obsolete: string[];
  causes: { source: string; target: string; reason: string }[];
  models: { name: string; content: string; sources: string[] }[];
};

function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function records(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((entry) => entry !== null && typeof entry === "object");
}

/**
 * Le contrôle de forme des arguments de `dream_consolidate` (le service mémoire juge le
 * fond : ids connus, faits et observations de la portée, modèles existants).
 */
export function parseConsolidation(
  args: Record<string, unknown>,
): { ok: true; consolidation: Consolidation } | { ok: false; error: string } {
  const { observations, obsolete, causes, models } = args;
  if (!records(observations) || !strings(obsolete) || !records(causes) || !records(models))
    return { ok: false, error: "observations, obsolete, causes et models : quatre listes attendues" };
  for (const [index, o] of observations.entries()) {
    if (typeof o.text !== "string" || o.text.trim() === "" || !strings(o.evidence) || o.evidence.length === 0)
      return { ok: false, error: `observations[${index}] : un texte et au moins un fait en evidence` };
    if (o.id !== undefined && typeof o.id !== "string")
      return { ok: false, error: `observations[${index}].id : texte` };
  }
  for (const [index, c] of causes.entries())
    if (typeof c.source !== "string" || typeof c.target !== "string" || typeof c.reason !== "string")
      return { ok: false, error: `causes[${index}] : source, target et reason attendus` };
  for (const [index, m] of models.entries())
    if (typeof m.name !== "string" || typeof m.content !== "string" || m.content.trim() === "" || !strings(m.sources))
      return { ok: false, error: `models[${index}] : name, content non vide et sources attendus` };
  return {
    ok: true,
    consolidation: {
      observations: observations.map((o) => ({
        ...(typeof o.id === "string" ? { id: o.id } : {}),
        text: o.text as string,
        evidence: o.evidence as string[],
      })),
      obsolete,
      causes: causes.map((c) => ({
        source: c.source as string,
        target: c.target as string,
        reason: c.reason as string,
      })),
      models: models.map((m) => ({
        name: m.name as string,
        content: m.content as string,
        sources: m.sources as string[],
      })),
    },
  };
}

/**
 * Le dossier vaut-il une session ? Oui si un rêve est demandé (et qu'il y a du nouveau),
 * s'il y a au moins `minFacts` faits nouveaux, ou si le plus ancien attend depuis
 * `maxDelayHours`. Rend la raison d'un report sinon.
 */
export function dreamDue(
  dossier: DreamDossier,
  rules: { minFacts: number; maxDelayHours: number; requested: boolean },
  now: number,
): string | null {
  const facts = dossier.new_facts.length;
  if (!dossier.due || facts === 0) return "rien de nouveau depuis la dernière consolidation";
  if (rules.requested || facts >= rules.minFacts) return null;
  const oldest = Date.parse(dossier.new_facts[0]?.updated_at ?? "");
  if (Number.isFinite(oldest) && now - oldest >= rules.maxDelayHours * 3_600_000) return null;
  return `${facts} fait(s) nouveau(x), en attente de ${rules.minFacts} ou de ${rules.maxDelayHours} h`;
}

export class Dreamer {
  readonly #ctx: HarnessContext;
  readonly #live = new Map<string, LiveDream>();
  readonly #rows = new Map<string, DreamRow>();
  readonly #checked = new Map<string, number>();
  readonly #requested = new Set<string>();

  constructor(ctx: HarnessContext) {
    this.#ctx = ctx;
  }

  #event(row: DreamRow, extra: Record<string, unknown> = {}): void {
    this.#ctx.event(
      "dream_state",
      null,
      {
        dreamId: row.id,
        repo: row.repo,
        state: row.state,
        facts: row.facts,
        reason: row.reason,
        report: row.report,
        ...extra,
      },
      row.repo,
    );
  }

  /** Les derniers rêves, un par dépôt (ceux que `repos` laisse voir). */
  list(repos: readonly string[] | null = null): DreamRow[] {
    return [...this.#rows.values()].filter((row) => repos === null || repos.includes(row.repo));
  }

  /** Un rêve demandé : le dépôt est examiné au prochain tour, sans attendre ni seuil de faits. */
  request(repo: string, actor: Actor = SERVICE): void {
    this.#ctx.repo(repo);
    if (this.#ctx.config.oracle === null) throw new HarnessError(409, "aucun service mémoire configuré (oracle)");
    this.#requested.add(repo);
    this.#ctx.log(`rêve demandé pour ${repo}${actor.by ? ` par ${actor.by}` : ""}`);
  }

  isLive(repo: string): boolean {
    return this.#live.has(repo);
  }

  /** Les dépôts dont l'examen est dû et qui sont au repos : un rêve chacun, si un slot runner est libre. */
  tick(now = Date.now()): void {
    const { config, store, scheduler, monitor } = this.#ctx;
    if (config.oracle === null) return;
    for (const repo of config.repos) {
      if (this.#live.has(repo.name)) continue;
      const requested = this.#requested.has(repo.name);
      if (!requested) {
        if (config.dreams.checkMinutes === null) continue;
        const last = this.#checked.get(repo.name);
        if (last !== undefined && now - last < config.dreams.checkMinutes * 60_000) continue;
        // Le repos d'abord : un dépôt qui a des runs en cours ne rêve pas.
        if (store.listRuns({ repo: repo.name }).some((run) => !isTerminal(run.state))) continue;
      }
      if (monitor.dailyBudgetDue()) return;
      const slot = scheduler.tryAcquire("runner", `dream:${repo.name}`);
      if ("refused" in slot) return;
      this.#checked.set(repo.name, now);
      this.#requested.delete(repo.name);
      const live: LiveDream = { abort: new AbortController(), session: null, done: Promise.resolve() };
      this.#live.set(repo.name, live);
      live.done = this.#drive(repo, live, requested).finally(async () => {
        await live.session?.stop();
        slot.release();
        this.#live.delete(repo.name);
      });
    }
  }

  async #drive(repo: RepoConfig, live: LiveDream, requested: boolean): Promise<void> {
    const { config, oracle, git } = this.#ctx;
    const row: DreamRow = {
      repo: repo.name,
      id: newId("d"),
      state: "dreaming",
      at: Date.now(),
      facts: null,
      reason: null,
      report: null,
    };
    const finish = (state: DreamState, reason: string | null, report: ConsolidationReport | null = null) => {
      Object.assign(row, { state, reason, report });
      this.#rows.set(repo.name, { ...row });
      this.#event(row);
    };
    const dossier = await oracle.dreamDossier(repo.scope);
    if (dossier === null)
      return finish("skipped", "dossier de rêve indisponible (service mémoire injoignable ou sans rêve)");
    row.facts = dossier.new_facts.length;
    const wait = dreamDue(dossier, { ...config.dreams, requested }, Date.now());
    if (wait !== null) return finish("skipped", wait);
    this.#rows.set(repo.name, { ...row });
    this.#event(row);
    const worktree = path.join(config.worktreesDir, repo.name, `_dream-${row.id}`);
    try {
      const report = await this.#dream(repo, row, live, worktree, dossier);
      finish("done", null, report);
      this.#ctx.log(
        `rêve de ${repo.name} : ${report.observations_added} observation(s) créée(s), ${report.observations_refined} affinée(s), ${report.models} modèle(s)`,
      );
    } catch (err) {
      if (live.abort.signal.aborted) return;
      const reason = err instanceof Error ? err.message : String(err);
      finish("failed", reason);
      this.#ctx.log(`rêve de ${repo.name} en échec : ${reason}`);
    } finally {
      await live.session?.stop();
      live.session = null;
      await git.removeWorktree(repo.path, worktree, null).catch(() => {});
    }
  }

  async #dream(
    repo: RepoConfig,
    row: DreamRow,
    live: LiveDream,
    worktree: string,
    dossier: DreamDossier,
  ): Promise<ConsolidationReport> {
    const { git, config } = this.#ctx;
    await git.addWorktree(repo.path, worktree, null, await git.revParse(repo.path, repo.mainBranch));
    let report: ConsolidationReport | null = null;
    const session = new RunnerSession(
      this.#ctx,
      { repo, cwd: worktree },
      {
        onHostTool: async (name, args) => {
          const result = await this.#hostTool(repo, dossier, name, args);
          if (result.report) report = result.report;
          return result.answer;
        },
        event: (type, payload) => this.#ctx.event(type, null, { dreamId: row.id, ...payload }, repo.name),
      },
    );
    live.session = session;
    const deadlineAt = Date.now() + config.runner.stepTimeoutSec * 1000;
    await session.open(config.dreams.tier, runnerUnit(row.id, 0), live.abort.signal);
    await session.setHostTools(hostToolsFor("dream"));
    let result = await session.prompt(dreamPrompt({ repo: repo.name, dossier }), live.abort.signal, deadlineAt);
    if (result.status === "completed" && report === null) {
      result = await session.prompt(
        "L'étape /reve n'est pas terminée : la consolidation n'a pas été rendue (ou a été refusée) par `dream_consolidate`. Rends-la maintenant.",
        live.abort.signal,
        deadlineAt,
      );
    }
    if (result.status !== "completed") throw new Error(result.error?.message ?? "erreur du runner");
    if (report === null) throw new Error("la consolidation n'a pas été rendue par `dream_consolidate`");
    return report;
  }

  async #hostTool(
    repo: RepoConfig,
    dossier: DreamDossier,
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ answer: HostToolResult; report?: ConsolidationReport }> {
    switch (name) {
      case "progress": {
        const message = typeof args.message === "string" ? args.message.slice(0, 500) : "";
        this.#ctx.event("progress", null, { dream: repo.name, message }, repo.name);
        return { answer: { text: "noté" } };
      }
      case "oracle_recall":
        return {
          answer: {
            text: renderMemories(
              await this.#ctx.oracle.recall(repo.scope, typeof args.query === "string" ? args.query : repo.name),
            ),
          },
        };
      case "dream_consolidate": {
        const parsed = parseConsolidation(args);
        if (!parsed.ok) return { answer: { text: `consolidation refusée : ${parsed.error}`, isError: true } };
        try {
          const report = await this.#ctx.oracle.consolidate(repo.scope, {
            ...parsed.consolidation,
            horizon_us: dossier.horizon_us,
          });
          return {
            answer: {
              text: `Consolidation appliquée : ${report.observations_added} observation(s) créée(s), ${report.observations_refined} affinée(s), ${report.observations_removed} retirée(s), ${report.causes} cause(s), ${report.models} modèle(s). Termine ton tour.`,
            },
            report,
          };
        } catch (err) {
          return {
            answer: {
              text: `consolidation refusée par le service mémoire : ${err instanceof Error ? err.message : String(err)}`,
              isError: true,
            },
          };
        }
      }
      default:
        return { answer: { text: `outil inconnu : ${name}`, isError: true } };
    }
  }

  /** Les worktrees de rêve qu'un process mort a laissés derrière lui. */
  async recover(): Promise<void> {
    const { config, git } = this.#ctx;
    for (const repo of config.repos) {
      const dir = path.join(config.worktreesDir, repo.name);
      const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.startsWith("_dream-")) : [];
      for (const name of left) await git.removeWorktree(repo.path, path.join(dir, name), null).catch(() => {});
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
