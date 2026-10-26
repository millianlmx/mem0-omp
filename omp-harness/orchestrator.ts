// Le cœur du Pipeline Service : il admet les runs, conduit chacun à travers la
// machine à états et délègue le reste à ses pièces :
// - `steps.ts`        la conduite d'une étape (worktree, prompt, clôture) ;
// - `host-tools.ts`   les outils hôtes des runners ;
// - `merger.ts`       les merges, en file par dépôt ;
// - `gestures.ts`     la boucle humaine (escalades, décisions, validations, annulation) ;
// - `audits.ts`       les audits de dépôt ;
// - `dreams.ts`       le rêve de la mémoire (consolidation des faits d'un dépôt au repos) ;
// - `queries.ts`      les lectures de l'API.
//
// Un seul process, un seul écrivain : toute mutation passe par `Store`, toute
// transition par la table de `machine.ts`. Les runs avancent en parallèle (une
// boucle async par run actif), sur plusieurs dépôts et projets à la fois, bornés par
// le scheduler (slots, admission mémoire, jetons par fournisseur), le planificateur
// (modules disjoints seulement) et le plafond de chaque dépôt (`maxParallel`).
// L'admission est ÉQUITABLE : priorité d'abord, puis le dépôt et le projet qui ont le
// moins de runs vivants, puis l'ancienneté — aucun projet ne prend tous les runners.
import { Auditor } from "./audits.ts";
import { Dreamer } from "./dreams.ts";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { retryBackoff } from "./config.ts";
import type { Actor, HarnessDeps } from "./context.ts";
import { HarnessContext, SERVICE } from "./context.ts";
import type { DecisionRow, RepoFilter, RunRow } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { HumanLoop } from "./gestures.ts";
import { newId } from "./ids.ts";
import { changesOf, fileDiffOf, timelineOf } from "./inspect.ts";
import { Metrics } from "./metrics.ts";
import type { BudgetDue } from "./monitor.ts";
import type { StepKind } from "./machine.ts";
import { ACTIVE_STATES, crashed, heldForDailyBudget, nextAfter, pausedForBudget, recovered } from "./machine.ts";
import type { FailCause, StepOutcome } from "./machine.ts";
import { Merger } from "./merger.ts";
import { briefOfReq } from "./oracle.ts";
import { knownModules, modulesViaOracle, schedulable } from "./planner.ts";
import { loadOf, runView } from "./queries.ts";
import { forceStop } from "./runner.ts";
import { auditOwner } from "./session-feed.ts";
import { projectScope } from "./scope.ts";
import type { Slot } from "./scheduler.ts";
import type { LiveRun } from "./steps.ts";
import { StepExecutor, challengeUnit, liveRun } from "./steps.ts";

export { HarnessError } from "./errors.ts";
export type { Actor, SpawnRunner } from "./context.ts";

export type OrchestratorDeps = HarnessDeps;

/** `req` : le compte rendu de besoins déjà établi en session interactive (/req local) — le run part de /specs. */
export type NewRunInput = {
  repo: string;
  title: string;
  request: string;
  slug?: string;
  modules?: string[];
  req?: string;
  priority?: number;
};

export type NewProjectInput = {
  repo: string;
  title: string;
  priority?: number;
  features: { title: string; request: string; slug?: string; modules?: string[] }[];
};

/** Une heure : la cadence de la purge du journal. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export function slugify(text: string): string {
  const slug = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "feature" : slug;
}

/** Un candidat à l'admission et ce qui décide de son rang. */
type Candidate = { run: RunRow; resumed: boolean; group: string };

export class Orchestrator {
  readonly #ctx: HarnessContext;
  readonly #steps: StepExecutor;
  readonly #merger: Merger;
  readonly #human: HumanLoop;
  readonly #live = new Map<string, LiveRun & { slot: Slot }>();
  /** Le dernier refus d'admission annoncé par run : un refus n'est écrit qu'une fois, pas à chaque tour. */
  readonly #refused = new Map<string, string>();
  /** Les runs dont la veille a arrêté l'étape sur leur plafond de coût, et ce plafond. */
  readonly #budgetStops = new Map<string, BudgetDue>();
  /** Les runs dont les modules sont en cours de déduction : pas candidats avant. */
  readonly #inferring = new Set<string>();
  readonly #tickMs: number;
  #timer: NodeJS.Timeout | null = null;
  #ticking: Promise<void> | null = null;
  #stopping = false;
  /** Les tours automatiques n'ont lieu qu'après `start()` : la reprise des runs interrompus passe d'abord. */
  #started = false;
  #prunedAt = 0;
  /** La fin du dernier tour de scheduling (ou le démarrage) : `GET /v1/health` en lit l'âge. */
  #lastTickAt: number | null = null;

  /** Les audits de dépôt : même scheduler, mêmes runners, propositions lancées en projet. */
  readonly audits: Auditor;
  /** Le rêve de la mémoire : consolidation des faits d'un dépôt au repos, par un runner. */
  readonly dreams: Dreamer;
  /** La santé du serveur au fil du temps (`GET /v1/metrics`). */
  readonly metrics: Metrics;
  #stopMetrics: (() => void) | null = null;

  constructor(deps: OrchestratorDeps) {
    this.#ctx = new HarnessContext(deps);
    this.#tickMs = deps.tickMs ?? 1000;
    this.metrics = new Metrics({
      store: this.#ctx.store,
      scheduler: this.#ctx.scheduler,
      liveRuns: () => this.#live.size,
      sampleSec: () => this.#ctx.config.monitoring.sampleSec,
      keep: () => this.#ctx.config.monitoring.keep,
    });
    this.#steps = new StepExecutor(this.#ctx, {
      createProject: (input, actor) => this.createProject(input, actor),
      followUp: async (input, actor) => this.createRun(input, actor),
    });
    this.#merger = new Merger(this.#ctx, {
      onDone: () => this.#kick(),
      followUp: async (input, actor) => this.createRun(input, actor),
    });
    this.#human = new HumanLoop(this.#ctx, {
      halt: (runId) => this.#halt(runId),
      tick: () => this.#kick(),
      merging: (runId) => this.#merger.has(runId),
      followUp: async (input, actor) => this.createRun(input, actor),
      revertMerge: (runId, actor) => this.#merger.revert(runId, actor),
    });
    this.audits = new Auditor(this.#ctx, { createProject: (input, actor) => this.createProject(input, actor) });
    this.dreams = new Dreamer(this.#ctx);
  }

  get store(): HarnessContext["store"] {
    return this.#ctx.store;
  }

  get config(): HarnessConfig {
    return this.#ctx.config;
  }

  /** Les fournisseurs LLM et les chaînes de modèles, déclarés par l'API. */
  get providers(): HarnessContext["providers"] {
    return this.#ctx.providers;
  }

  /** Les connexions OAuth des fournisseurs, menées depuis les apps. */
  get logins(): HarnessContext["logins"] {
    return this.#ctx.logins;
  }

  /** Le direct des sessions de runners (tampon des dernières entrées de chaque run). */
  get sessions(): HarnessContext["sessions"] {
    return this.#ctx.sessions;
  }

  // -- cycle de vie ---------------------------------------------------------

  /** Reprise après redémarrage, puis la boucle de scheduling. */
  async start(): Promise<void> {
    this.#ctx.overlay();
    // Les fournisseurs et chaînes déclarés par l'API passent avant la reprise des runs.
    this.#ctx.providers.apply();
    await this.#prepareRepos(this.#ctx.config.repos);
    await this.recover();
    this.#started = true;
    this.#lastTickAt = Date.now();
    this.#stopMetrics = this.metrics.subscribe();
    this.#prune();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
    void this.tick();
  }

  /** Verrouille le gitdir de chaque dépôt et calcule sa scope mémoire si elle n'est pas déclarée. */
  async #prepareRepos(repos: RepoConfig[]): Promise<void> {
    for (const repo of repos) {
      try {
        await this.#ctx.git.protectRepo(repo.path);
      } catch (err) {
        this.#ctx.log(`dépôt ${repo.name} : droits du gitdir non verrouillés — ${String(err)}`);
      }
      // La scope mémoire non déclarée est celle que le plugin mémoire du Mac calcule.
      if (repo.scope === "") {
        try {
          repo.scope = await projectScope(this.#ctx.git, repo.path, repo.mainBranch);
        } catch {
          repo.scope = repo.name;
        }
        this.#ctx.log(`dépôt ${repo.name} : mémoire du projet « ${repo.scope} »`);
      }
    }
  }

  /**
   * Recharge la liste des dépôts sans redémarrer (SIGHUP) : les nouveaux sont
   * préparés et deviennent utilisables, ceux qui changent prennent leurs nouveaux
   * réglages au prochain run. Un dépôt retiré qui a encore des runs vivants est gardé.
   */
  async reloadRepos(next: RepoConfig[]): Promise<{ added: string[]; removed: string[]; kept: string[] }> {
    const config = this.#ctx.config;
    const before = new Map(config.repos.map((repo) => [repo.name, repo]));
    const names = new Set(next.map((repo) => repo.name));
    const kept = config.repos.filter(
      (repo) =>
        !names.has(repo.name) &&
        this.store.listRuns({ repo: repo.name, state: [...ACTIVE_STATES, "queued"] }).length > 0,
    );
    for (const repo of next) {
      const previous = before.get(repo.name);
      if (previous && repo.scope === "") repo.scope = previous.scope;
    }
    await this.#prepareRepos(next.filter((repo) => !before.has(repo.name) || repo.scope === ""));
    config.repos = [...next, ...kept];
    const added = next.filter((repo) => !before.has(repo.name)).map((repo) => repo.name);
    const removed = [...before.keys()].filter((name) => !names.has(name) && !kept.some((repo) => repo.name === name));
    this.#ctx.log(
      `dépôts rechargés : +${added.join(", ") || "∅"} −${removed.join(", ") || "∅"}${kept.length > 0 ? ` (gardés, runs vivants : ${kept.map((repo) => repo.name).join(", ")})` : ""}`,
    );
    this.#kick();
    return { added, removed, kept: kept.map((repo) => repo.name) };
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#stopMetrics?.();
    await this.#ticking;
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await live.session?.stop();
    }
    await Promise.allSettled(lives.map((live) => live.done));
    await this.audits.stop();
    await this.dreams.stop();
    await this.#ctx.logins.stop();
    // Un merge en cours n'est pas attendu (sa suite complète peut durer) : le run reste
    // `merging` en base et son merge repart au démarrage suivant.
  }

  /**
   * Les runs qu'un process mort a laissés `running` reprennent à leur DERNIER
   * checkpoint : le travail non commité de l'étape interrompue est jeté, l'étape
   * repart avec un nouveau runner.
   */
  async recover(): Promise<void> {
    const { store, config, exec, git } = this.#ctx;
    for (const step of store.interruptRunningSteps()) {
      if (step.unit) await forceStop(config, exec, step.unit);
      // Le contradicteur d'une étape de contrat a sa propre unité, absente de la ligne de l'étape.
      if (step.kind === "req" || step.kind === "specs")
        await forceStop(config, exec, challengeUnit(step.runId, step.id));
    }
    // Chaque worktree encore vivant est re-reconnu côté clone (jamais par son `.git`).
    for (const run of store.listRuns({ state: ["queued", "running", "escalated", "awaiting_human", "merging"] })) {
      if (!run.worktree) continue;
      try {
        await git.trustWorktree(this.#ctx.repo(run.repo).path, run.worktree);
      } catch (err) {
        this.#ctx.transition(
          run,
          crashed(run, `worktree non reconnu par son clone : ${err instanceof Error ? err.message : String(err)}`),
          [run.state],
        );
      }
    }
    for (const run of store.listRuns({ state: ["running"] })) {
      if (run.worktree) {
        try {
          await git.resetTo(run.worktree, "HEAD");
        } catch (err) {
          this.#ctx.log(`reprise ${run.id} : retour au checkpoint impossible — ${String(err)}`);
        }
      }
      const cursor = { step: (run.step ?? "req") as StepKind, fixes: run.fixes, attempts: run.attempts };
      store.transaction(() => {
        if (this.#ctx.transition(run, recovered(cursor), ["running"]))
          this.#ctx.event("recovered", run.id, { step: run.step });
      });
    }
    await this.audits.recover();
    await this.dreams.recover();
  }

  /** La rétention du journal : au démarrage, puis au plus une fois par heure. */
  #prune(): void {
    const now = Date.now();
    if (now - this.#prunedAt < PRUNE_EVERY_MS) return;
    this.#prunedAt = now;
    const before = now - this.#ctx.config.events.retentionDays * 24 * 60 * 60 * 1000;
    const pruned = this.store.pruneEvents(before);
    this.store.pruneSessions(before);
    if (pruned > 0)
      this.#ctx.log(`journal : ${pruned} événement(s) de plus de ${this.#ctx.config.events.retentionDays} j purgé(s)`);
  }

  /** Un tour automatique (un run créé, un slot rendu, un geste) : seulement une fois le service démarré. */
  #kick(): void {
    if (this.#started) void this.tick();
  }

  /** Un tour de scheduling : merges dus, escalades échues, audits, puis les runs en file que le planificateur libère. */
  tick(): Promise<void> {
    if (this.#ticking || this.#stopping) return this.#ticking ?? Promise.resolve();
    this.#ticking = this.#tick().finally(() => {
      this.#ticking = null;
      this.#lastTickAt = Date.now();
    });
    return this.#ticking;
  }

  /** La fin du dernier tour de scheduling, ou du démarrage ; `null` avant `start()`. */
  get lastTickAt(): number | null {
    return this.#lastTickAt;
  }

  async #tick(): Promise<void> {
    const { store } = this.#ctx;
    this.#prune();
    for (const run of store.listRuns({ state: ["merging"] })) this.#merger.enqueue(run);
    // Une escalade ouverte depuis trop longtemps est tranchée sur la recommandation de l'agent.
    try {
      await this.#human.autoDecideExpired(Date.now());
    } catch (err) {
      this.#ctx.log(`auto-décision des escalades échues : ${err instanceof Error ? err.message : String(err)}`);
    }
    this.audits.tick();
    this.#admit();
    // Après les runs : un dépôt ne rêve que sur un slot que nul run n'attend.
    this.dreams.tick();
    this.#watch();
    this.metrics.maybeSample();
  }

  /** La veille des runs conduits : agent muet, étape lente, boucle de corrections. */
  #watch(): void {
    try {
      this.#ctx.monitor.watch(
        [...this.#live.values()].map((live) => ({
          runId: live.runId,
          step: live.step ? { id: live.step.id, kind: live.step.kind, startedAt: live.step.startedAt } : null,
          fixes: this.store.getRun(live.runId)?.fixes ?? 0,
        })),
      );
    } catch (err) {
      this.#ctx.log(`veille : ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Les candidats de chaque dépôt : les runs repris d'abord, puis les nouveaux que les modules et `maxParallel` laissent partir. */
  #candidates(): { candidates: Candidate[]; activeByRepo: Map<string, number>; activeByGroup: Map<string, number> } {
    const { store } = this.#ctx;
    // Un run relancé après un échec attend son heure (`notBefore`) : il n'est pas candidat avant.
    const queued = store
      .listRunsDue(Date.now())
      .filter((run) => !this.#live.has(run.id) && !this.#inferring.has(run.id));
    // Un run lancé reste `queued` en base jusqu'à son worktree : il occupe déjà ses modules.
    const active = store.listRuns({ state: ACTIVE_STATES }).filter((run) => !this.#live.has(run.id));
    for (const live of this.#live.keys()) {
      const run = store.getRun(live);
      if (run) active.push(run);
    }
    const activeByRepo = new Map<string, number>();
    const activeByGroup = new Map<string, number>();
    for (const run of active) {
      activeByRepo.set(run.repo, (activeByRepo.get(run.repo) ?? 0) + 1);
      activeByGroup.set(groupOf(run), (activeByGroup.get(groupOf(run)) ?? 0) + 1);
    }
    const byRepo = new Map<string, RunRow[]>();
    for (const run of queued) byRepo.set(run.repo, [...(byRepo.get(run.repo) ?? []), run]);
    const candidates: Candidate[] = [];
    for (const [name, runs] of byRepo) {
      const repo = this.#ctx.config.repos.find((entry) => entry.name === name);
      if (!repo) continue;
      // Un run qui a déjà un worktree a déjà été admis par le planificateur : il repasse devant.
      const resumed = runs.filter((run) => run.worktree !== null);
      const fresh = runs.filter((run) => run.worktree === null);
      const others = active.filter((run) => run.repo === name).map((run) => ({ id: run.id, modules: run.modules }));
      const free = new Set(
        schedulable(
          fresh.map((run) => ({ id: run.id, modules: run.modules })),
          [...others, ...resumed.map((run) => ({ id: run.id, modules: run.modules }))],
        ),
      );
      let room =
        repo.maxParallel === null ? Number.POSITIVE_INFINITY : repo.maxParallel - (activeByRepo.get(name) ?? 0);
      for (const run of [...resumed, ...fresh.filter((run) => free.has(run.id))]) {
        if (room <= 0) break;
        candidates.push({ run, resumed: run.worktree !== null, group: groupOf(run) });
        room--;
      }
    }
    return { candidates, activeByRepo, activeByGroup };
  }

  /** L'admission équitable : un candidat à la fois, au meilleur rang, tant qu'un slot runner se libère. */
  #admit(): void {
    const { candidates, activeByRepo, activeByGroup } = this.#candidates();
    // Un run qui n'attend plus (admis, annulé, devenu non candidat) oublie son dernier refus.
    const waiting = new Set(candidates.map((c) => c.run.id));
    for (const id of this.#refused.keys()) if (!waiting.has(id)) this.#refused.delete(id);
    const rank = (c: Candidate): number[] => [
      -c.run.priority,
      c.resumed ? 0 : 1,
      activeByRepo.get(c.run.repo) ?? 0,
      activeByGroup.get(c.group) ?? 0,
      c.run.createdAt,
    ];
    // Le plafond journalier du serveur atteint : personne ne part, chacun sait pourquoi (une fois).
    const daily = candidates.length > 0 ? this.#ctx.monitor.dailyBudgetDue() : null;
    if (daily) {
      const detail = `plafond journalier atteint : ${daily.spent.toFixed(2)} $ / ${daily.ceiling.toFixed(2)} $ — reprise à ${new Date(daily.resetsAt).toISOString()}`;
      for (const candidate of candidates) {
        if (this.#refused.get(candidate.run.id)?.split(":")[0] === "daily_budget") continue;
        this.#ctx.event("admission_refused", candidate.run.id, {
          reason: "daily_budget",
          detail,
          waiting: candidates.length,
        });
        this.#refused.set(candidate.run.id, `daily_budget: ${detail}`);
      }
      return;
    }
    while (candidates.length > 0) {
      candidates.sort((a, b) => compareRanks(rank(a), rank(b)));
      const next = candidates.shift() as Candidate;
      const slot = this.#ctx.scheduler.tryAcquire("runner", next.run.id);
      if ("refused" in slot) {
        const why = `${slot.refused}: ${slot.detail}`;
        if (this.#refused.get(next.run.id)?.split(":")[0] !== slot.refused) {
          this.#ctx.event("admission_refused", next.run.id, {
            reason: slot.refused,
            detail: slot.detail,
            waiting: candidates.length + 1,
          });
        }
        this.#refused.set(next.run.id, why);
        return;
      }
      this.#refused.delete(next.run.id);
      activeByRepo.set(next.run.repo, (activeByRepo.get(next.run.repo) ?? 0) + 1);
      activeByGroup.set(next.group, (activeByGroup.get(next.group) ?? 0) + 1);
      this.#launch(next.run.id, slot);
    }
  }

  #launch(runId: string, slot: Slot): void {
    const live = { ...liveRun(runId), slot };
    this.#live.set(runId, live);
    live.done = this.#drive(live).finally(async () => {
      await live.session?.stop();
      slot.release();
      this.#live.delete(runId);
      // Un slot rendu : le suivant de la file peut partir sans attendre le tour d'horloge.
      if (!this.#stopping) this.#kick();
    });
  }

  /** Attend qu'un run vivant soit arrêté (gestes humains sur un run en cours). */
  async #halt(runId: string): Promise<void> {
    const live = this.#live.get(runId);
    if (!live) return;
    live.abort.abort();
    await live.session?.stop();
    await live.done;
  }

  // -- conduite d'un run ----------------------------------------------------

  async #drive(live: LiveRun): Promise<void> {
    const { store, config } = this.#ctx;
    try {
      let run = store.getRun(live.runId) as RunRow;
      if (run.worktree === null) run = await this.#steps.provision(run);
      // Une revue reprise (escalade, renversement) re-passe par le rebase.
      if (run.step === "review") live.pendingRebase = true;
      // Un geste humain (annulation…) a pu passer pendant le provisionnement : rien ne l'écrase.
      const started = this.#ctx.transition(
        run,
        {
          state: "running",
          step: run.step,
          fixes: run.fixes,
          attempts: run.attempts,
          keepRunner: false,
          rebase: false,
          notBefore: null,
          reason: run.reason ?? "",
        },
        ["queued"],
      );
      if (!started) return;
      while (!live.abort.signal.aborted) {
        run = store.getRun(live.runId) as RunRow;
        if (run.state !== "running" || run.step === null) break;
        // Le plafond de coût atteint (`pauseOnBudget`) : l'humain accorde la suite avant l'étape.
        const due = this.#ctx.monitor.pauseDue(run.id);
        if (due) {
          this.#ctx.transition(
            run,
            pausedForBudget({ step: run.step, fixes: run.fixes, attempts: run.attempts }, due.cost, due.threshold),
            ["running"],
          );
          break;
        }
        // Le plafond journalier du serveur : la feature rend son slot avant l'étape, l'admission la retient.
        const daily = this.#ctx.monitor.dailyBudgetDue();
        if (daily) {
          this.#ctx.transition(
            run,
            heldForDailyBudget(
              { step: run.step, fixes: run.fixes, attempts: run.attempts },
              daily.spent,
              daily.ceiling,
            ),
            ["running"],
          );
          break;
        }
        // Pendant l'étape, la veille l'arrête dès que son coût franchit le plafond (`pauseOnBudget`).
        const release = this.#ctx.monitor.guard(run.id, (due) => {
          this.#budgetStops.set(live.runId, due);
          live.abort.abort();
        });
        let outcome: StepOutcome | null = null;
        try {
          outcome = await this.#steps.execute(live, run);
        } catch (err) {
          // Arrêtée par la veille, l'étape qui lève n'est pas un crash : la feature attend l'humain.
          if (!this.#budgetStops.has(live.runId)) throw err;
        } finally {
          release();
        }
        if (live.abort.signal.aborted || outcome === null) {
          const stopped = this.#budgetStops.get(live.runId);
          this.#budgetStops.delete(live.runId);
          if (stopped) {
            run = store.getRun(live.runId) as RunRow;
            const cursor = { step: run.step as StepKind, fixes: run.fixes, attempts: run.attempts };
            this.#ctx.transition(run, pausedForBudget(cursor, stopped.cost, stopped.threshold), ["running"]);
          }
          break;
        }
        run = store.getRun(live.runId) as RunRow;
        const transition = nextAfter(
          { step: run.step as StepKind, fixes: run.fixes, attempts: run.attempts, lastFailCause: run.lastFailCause },
          outcome,
          {
            fixCap: config.review.fixCap,
            retryBackoffSec: retryBackoff(config),
            specsGate: config.review.specsGate,
            mergeRetries: config.review.mergeRetries,
          },
          Date.now(),
        );
        // La cause d'un échec est gardée jusqu'à ce que l'étape rende quelque chose ; la
        // contestation d'un correcteur (`missing_output`) survit à la revue qui la suit,
        // pour que la seconde contestation passe à l'humain.
        const lastFailCause: FailCause | null =
          outcome.kind === "failed"
            ? outcome.cause
            : run.step === "review" && run.lastFailCause === "missing_output"
              ? run.lastFailCause
              : null;
        if (
          !this.#ctx.transition(run, transition, ["running"], {
            patch: { notBefore: transition.notBefore, lastFailCause },
          })
        )
          break;
        if (!transition.keepRunner) await live.session?.stop();
        if (transition.rebase) live.pendingRebase = true;
        if (transition.state !== "running") break;
      }
    } catch (err) {
      const run = store.getRun(live.runId);
      if (run && (run.state === "queued" || run.state === "running") && !live.abort.signal.aborted) {
        const reason = err instanceof Error ? err.message : String(err);
        if (this.#ctx.transition(run, crashed(run, reason), [run.state]))
          this.#ctx.log(`run ${live.runId} en échec : ${reason}`);
      }
    }
  }

  // -- API : création -------------------------------------------------------

  #freeSlug(repo: string, wanted: string): string {
    let slug = wanted;
    for (let n = 2; this.store.slugTaken(repo, slug); n++) slug = `${wanted}-${n}`;
    return slug;
  }

  /**
   * Un run sans `modules` : ils sont déduits par l'oracle (comme pour un projet) avant
   * l'admission — sinon le run chevaucherait tout le dépôt jusqu'à ses specs. La
   * déduction est asynchrone ; le run est créé tout de suite et n'est pas candidat
   * tant qu'elle court.
   */
  createRun(
    input: NewRunInput & { projectId?: string; projectOrder?: number; inferModules?: boolean },
    actor: Actor = SERVICE,
  ): RunRow {
    const repo = this.#ctx.repo(input.repo);
    if (input.title.trim() === "" || input.request.trim() === "")
      throw new HarnessError(400, "title et request sont requis");
    const req = input.req?.trim() ?? "";
    if (req !== "" && !/^##\s+Besoins/m.test(req)) throw new HarnessError(400, "req : la section `## Besoins` manque");
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || Math.abs(priority) > 1000)
      throw new HarnessError(400, "priority : entier entre -1000 et 1000");
    const { store } = this.#ctx;
    const run = store.transaction(() => {
      const slug = this.#freeSlug(input.repo, slugify(input.slug ?? input.title));
      const created = store.createRun({
        id: newId("r"),
        repo: input.repo,
        slug,
        title: input.title.trim(),
        request: input.request.trim(),
        branch: `harness/${slug}`,
        modules: input.modules ?? [],
        priority,
        createdBy: actor.by,
        ...(req !== "" ? { step: "specs" as const } : {}),
        ...(input.projectId ? { projectId: input.projectId, projectOrder: input.projectOrder ?? 0 } : {}),
      });
      if (req !== "") store.putArtifact(created.id, "req.md", `${req}\n`, null);
      this.#ctx.event("run_created", created.id, {
        repo: created.repo,
        slug: created.slug,
        title: created.title,
        modules: created.modules,
        projectId: created.projectId,
        priority,
        ...(actor.by ? { by: actor.by } : {}),
      });
      return created;
    });
    // Seuls les titres de besoins (`B-n`) entrent dans l'oracle : un souvenir court, qui se rappelle bien.
    const brief = req !== "" ? briefOfReq(req) : "";
    if (brief !== "")
      void this.#ctx.oracle.retain(repo.scope, `Compte rendu de besoins — « ${run.title} » :\n${brief}`, [
        "harness",
        "besoins",
      ]);
    if (input.inferModules !== false && (input.modules ?? []).length === 0) void this.#inferModules(run);
    else this.#kick();
    return run;
  }

  /** Les modules d'un run créé sans : l'oracle, puis `modules` posés s'ils ne l'ont pas été entre-temps (`set_modules`). */
  async #inferModules(run: RunRow): Promise<void> {
    const { store, oracle, git } = this.#ctx;
    this.#inferring.add(run.id);
    try {
      const repo = this.#ctx.repo(run.repo);
      const known = knownModules(await git.listFiles(repo.path, repo.mainBranch));
      const { modules } = await modulesViaOracle(oracle, repo.scope, `${run.title}\n${run.request}`, known);
      const current = store.getRun(run.id);
      if (modules.length > 0 && current && current.modules.length === 0 && current.state === "queued") {
        store.updateRun(run.id, { modules });
        this.#ctx.event("modules", run.id, { modules, source: "oracle" });
      }
    } catch (err) {
      this.#ctx.log(`run ${run.id} : modules non déduits — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#inferring.delete(run.id);
      this.#kick();
    }
  }

  /** /project : les modules de chaque feature (déclarés, sinon via l'oracle), puis une file planifiée. */
  async createProject(input: NewProjectInput, actor: Actor = SERVICE): Promise<{ projectId: string; runs: RunRow[] }> {
    const { store, oracle, git } = this.#ctx;
    const repo = this.#ctx.repo(input.repo);
    if (input.features.length === 0) throw new HarnessError(400, "un projet a au moins une feature");
    const known = knownModules(await git.listFiles(repo.path, repo.mainBranch));
    const modules: string[][] = [];
    for (const feature of input.features) {
      modules.push(
        feature.modules && feature.modules.length > 0
          ? feature.modules
          : (await modulesViaOracle(oracle, repo.scope, `${feature.title}\n${feature.request}`, known)).modules,
      );
    }
    // Le projet et ses runs naissent ensemble : un client ne voit jamais un projet à moitié créé.
    return store.transaction(() => {
      const project = store.createProject({ id: newId("p"), repo: repo.name, title: input.title });
      const runs = input.features.map((feature, order) =>
        this.createRun(
          {
            ...feature,
            repo: repo.name,
            modules: modules[order] ?? [],
            // Déjà demandés à l'oracle ci-dessus : une liste vide le reste.
            inferModules: false,
            projectId: project.id,
            projectOrder: order,
            ...(input.priority !== undefined ? { priority: input.priority } : {}),
          },
          actor,
        ),
      );
      this.#ctx.event(
        "project_created",
        null,
        {
          projectId: project.id,
          repo: repo.name,
          runs: runs.map((run) => ({ id: run.id, modules: run.modules })),
          ...(actor.by ? { by: actor.by } : {}),
        },
        repo.name,
      );
      return { projectId: project.id, runs };
    });
  }

  // -- API : boucle humaine -------------------------------------------------

  answerEscalations(
    runId: string,
    answers: { id: number; answer: string; reason?: string }[],
    actor: Actor = SERVICE,
  ): Promise<RunRow> {
    return this.#human.answerEscalations(runId, answers, actor);
  }

  /** La relance par l'humain d'un run échoué ou en attente : même étape, tout de suite. */
  retry(runId: string, actor: Actor = SERVICE): Promise<RunRow> {
    // Une feature arrêtée sur son budget : la relancer lui en accorde un de plus.
    this.visibleRun(runId);
    this.#ctx.monitor.acknowledgeBudget(runId, actor.by);
    return this.#human.retry(runId, actor);
  }

  /** Accepte d'un geste toutes les décisions prises seules d'un run. */
  acceptAllDecisions(runId: string, actor: Actor = SERVICE): Promise<{ accepted: number }> {
    return this.#human.acceptAllDecisions(runId, actor);
  }

  /** Le revert d'un run mergé : son commit squash est défait sur `main`, un run de suite est ouvert. */
  revert(runId: string, actor: Actor = SERVICE): Promise<RunRow> {
    return this.#merger.revert(runId, actor);
  }

  acceptDecision(runId: string, seq: number, actor: Actor = SERVICE): Promise<DecisionRow> {
    return this.#human.acceptDecision(runId, seq, actor);
  }

  reverseDecision(runId: string, seq: number, option: string, reason: string, actor: Actor = SERVICE): Promise<RunRow> {
    return this.#human.reverseDecision(runId, seq, option, reason, actor);
  }

  validate(runId: string, approve: boolean, reason: string, actor: Actor = SERVICE): Promise<RunRow> {
    return this.#human.validate(runId, approve, reason, actor);
  }

  cancel(runId: string, actor: Actor = SERVICE): Promise<RunRow> {
    return this.#human.cancel(runId, actor);
  }

  setPriority(runId: string, priority: number, actor: Actor = SERVICE): Promise<RunRow> {
    return this.#human.setPriority(runId, priority, actor);
  }

  // -- API : lectures -------------------------------------------------------

  /** Le run, s'il appartient à un dépôt que le lecteur voit (sinon 404 : on ne trahit pas son existence). */
  visibleRun(runId: string, repos: RepoFilter = null): RunRow {
    const run = this.#ctx.run(runId);
    if (repos !== null && !repos.includes(run.repo)) throw new HarnessError(404, `run inconnu : ${runId}`);
    return run;
  }

  /** La vue complète d'un run : étapes, décisions, escalades, tests, artefacts. */
  runView(runId: string, repos: RepoFilter = null): Record<string, unknown> {
    const view = runView(this.store, this.visibleRun(runId, repos), this.#live.has(runId));
    return {
      ...view,
      usage: this.store.runUsage(runId),
      budget: this.#ctx.monitor.budget(runId),
      alerts: this.#ctx.monitor.alertsOf(runId),
    };
  }

  /**
   * Le direct de la session d'un run : ses dernières entrées, s'il est conduit en ce
   * moment, et le curseur du journal d'où suivre la suite (`/v1/events?run=…&live=1&after=…`).
   */
  sessionView(
    runId: string,
    repos: RepoFilter = null,
    page: { before?: number | null; limit?: number } = {},
  ): Record<string, unknown> {
    const run = this.visibleRun(runId, repos);
    const { entries, more } = this.#ctx.sessions.page(run.id, page.before ?? null, page.limit);
    return {
      runId: run.id,
      auditId: null,
      live: this.#live.has(run.id),
      cursor: this.store.lastEventId(),
      entries,
      more,
    };
  }

  /** Le direct de l'analyse d'un audit, sous la même forme (`auditId` au lieu de `runId`). */
  auditSessionView(auditId: string, page: { before?: number | null; limit?: number } = {}): Record<string, unknown> {
    const { entries, more } = this.#ctx.sessions.page(auditOwner(auditId), page.before ?? null, page.limit);
    return { runId: null, auditId, live: this.audits.isLive(auditId), cursor: this.store.lastEventId(), entries, more };
  }

  /**
   * Une entrée du direct d'un run et son détail : pour un outil, ses arguments complets
   * (`args`) et sa sortie entière (`output`, celle qui s'écrit s'il tourne encore) ;
   * pour un long paragraphe, son texte entier (`output`). 404 si l'entrée est inconnue.
   */
  sessionEntryView(runId: string, seq: number, repos: RepoFilter = null): Record<string, unknown> {
    const run = this.visibleRun(runId, repos);
    return { runId: run.id, auditId: null, ...this.#sessionEntry(run.id, seq) };
  }

  /** Une entrée du direct de l'analyse d'un audit et son détail. */
  auditSessionEntryView(auditId: string, seq: number): Record<string, unknown> {
    return { runId: null, auditId, ...this.#sessionEntry(auditOwner(auditId), seq) };
  }

  #sessionEntry(owner: string, seq: number): Record<string, unknown> {
    const found = this.#ctx.sessions.details(owner, seq);
    if (!found) throw new HarnessError(404, `entrée de session inconnue : ${seq}`);
    const { args, output, result, view } = found.details;
    return { entry: found.entry, args, output, result, view };
  }

  /** La frise d'un run : étapes, tests, décisions, événements marquants, coût par étape. */
  timeline(runId: string, repos: RepoFilter = null): Record<string, unknown> {
    return timelineOf(this.#ctx, this.visibleRun(runId, repos), this.#live.has(runId));
  }

  /** Les fichiers touchés par un run (worktree, sinon commit squash). */
  changes(runId: string, repos: RepoFilter = null): Promise<Record<string, unknown>> {
    return changesOf(this.#ctx, this.visibleRun(runId, repos));
  }

  /** Les différences d'un fichier touché par un run. */
  fileDiff(runId: string, file: string, repos: RepoFilter = null): Promise<Record<string, unknown>> {
    return fileDiffOf(this.#ctx, this.visibleRun(runId, repos), file);
  }

  /** La sortie des derniers jobs de tests d'un run, en cours compris. */
  liveTests(runId: string, repos: RepoFilter = null): Record<string, unknown> {
    const run = this.visibleRun(runId, repos);
    return { runId: run.id, cursor: this.store.lastEventId(), jobs: this.#ctx.tests.jobs(run.id) };
  }

  /** La veille : coût, budget et alertes des features. */
  get monitor(): HarnessContext["monitor"] {
    return this.#ctx.monitor;
  }

  status(repos: RepoFilter = null): Record<string, unknown> {
    const load = loadOf(this.store, repos, new Set(this.#live.keys()));
    // Un client borné ne voit que les libellés (ids de run ou d'audit) de ses dépôts ; les compteurs restent globaux.
    const visible = (label: string): boolean => {
      if (repos === null) return true;
      const id = label.split(":")[0] ?? "";
      const repo = this.store.getRun(id)?.repo ?? this.store.getAudit(id)?.repo ?? null;
      return repo !== null && repos.includes(repo);
    };
    const snapshot = this.#ctx.scheduler.snapshot();
    return {
      runs: load.runs,
      byRepo: load.byRepo,
      live: [...this.#live.keys()].filter(visible),
      scheduler: {
        ...snapshot,
        runner: { ...snapshot.runner, labels: snapshot.runner.labels.filter(visible) },
        heavy: { ...snapshot.heavy, labels: snapshot.heavy.labels.filter(visible) },
      },
      repos: this.#ctx.config.repos
        .filter((repo) => repos === null || repos.includes(repo.name))
        .map((repo) => ({ name: repo.name, scope: repo.scope, maxParallel: repo.maxParallel })),
    };
  }

  /** L'état de la mémoire du projet : configurée, joignable. */
  async oracleStatus(): Promise<{ configured: boolean; ok: boolean }> {
    if (!this.#ctx.config.oracle) return { configured: false, ok: false };
    return { configured: true, ok: await this.#ctx.oracle.health() };
  }
}

/** Le groupe d'équité d'un run : son projet, sinon lui-même. */
function groupOf(run: RunRow): string {
  return run.projectId ?? `run:${run.id}`;
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}
