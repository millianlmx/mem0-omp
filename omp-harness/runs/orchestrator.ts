// Le cœur du Pipeline Service : il admet les runs, conduit chacun à travers la
// machine à états et délègue le reste à ses pièces :
// - `steps.ts`        la conduite d'une étape (worktree, prompt, clôture) ;
// - `host-tools.ts`   les outils hôtes des runners ;
// - `merger.ts`       les merges, en file par dépôt ;
// - `gestures.ts`     la boucle humaine (escalades, décisions, validations, annulation) ;
// - `audits.ts`       les audits de dépôt ;
// - `dreams.ts`       le rêve de la mémoire (consolidation des faits d'un dépôt au repos) ;
// - `workstation.ts`  le poste de travail (extension Chrome, file d'actions, profil) et
//   `workstation-agent.ts` son agent 24/24 ;
// - `issues.ts`       les issues GitHub d'un dépôt déclaré, lancées en run ;
// - `digest.ts`       le rapport du matin, posté chaque jour ;
// - `schedules.ts`    les planifications récurrentes (runs, audits, relèves d'issues) ;
// - `vigie/desk.ts`   la vigie : ses réglages, ses incidents et ses gardes ;
// - `atlassian/desk.ts` le connecteur Atlassian (Jira, Confluence, plan du jour, savoir corpo) ;
// - `proposals.ts`    le bac « Propositions » (ce que l'usine pourrait faire seule) et le gabarit « refaire » ;
// - `queries.ts`      les lectures de l'API ;
// - `run-queue.ts`    l'admission équitable et la file d'attente ;
// - `run-creation.ts` la création des runs et des projets ;
// - `pause-desk.ts`   la pause globale et par espace ;
// - `run-views.ts`    les vues de lecture rendues à l'API.
//
// Un seul process, un seul écrivain : toute mutation passe par `Store`, toute
// transition par la table de `machine.ts`. Les runs avancent en parallèle (une
// boucle async par run actif), sur plusieurs dépôts et projets à la fois, bornés par
// le scheduler (slots, admission mémoire, jetons par fournisseur), le planificateur
// (modules disjoints seulement) et le plafond de chaque dépôt (`maxParallel`).
import { AutonomyGates } from "../autonomy/autonomy-gates.ts";
import type { AutonomyRuleInput } from "../autonomy/autonomy-learning.ts";
import type { AutonomyRule } from "../autonomy/autonomy-rules.ts";
import { Auditor } from "../jobs/audits.ts";
import { Dreamer } from "../jobs/dreams.ts";
import { createFromPlan } from "../intake/intake-create.ts";
import { Intaker } from "../intake/intake.ts";
import { AuditPilot } from "../human/pilot.ts";
import type { HarnessConfig, RepoConfig } from "../config/config.ts";
import { configWarnings, fixCapFor, retryBackoff } from "../config/config.ts";
import type { Actor, HarnessDeps } from "./context.ts";
import { HarnessContext, SERVICE } from "./context.ts";
import type { DecisionRow, RepoFilter, RunAutonomy, RunRow } from "../db/db.ts";
import { DigestSender } from "../reports/digest.ts";
import { Briefings } from "../human/briefing.ts";
import type { Briefing } from "../human/briefing.ts";
import { factoryState, factoryStatePrompt } from "../reports/brief.ts";
import type { Brief } from "../reports/brief.ts";
import { HumanLoop } from "../human/gestures.ts";
import type { AmendVia, Delivered, EscalationAnswer } from "../human/gestures.ts";
import { IDEMPOTENCY_TTL_MS } from "../api/idempotency.ts";
import type { CancelMotive } from "../api/input.ts";
import { Metrics } from "../operations/metrics.ts";
import type { BudgetDue, RunBudget } from "../operations/monitor.ts";
import type { StepKind } from "./machine.ts";
import {
  ACTIVE_STATES,
  acceptsSpecs,
  crashed,
  heldForDailyBudget,
  heldForPause,
  nextAfter,
  pausedForBudget,
  recovered,
} from "./machine.ts";
import type { FailCause, HumanWaitView, StepOutcome } from "./machine.ts";
import { Merger } from "./merger.ts";
import type { LostWrites } from "../memory/oracle.ts";
import type { Proof } from "../heavy/proofs.ts";
import type { ConfigAdmin } from "../config/repos.ts";
import { forceStopQa } from "../browser/qa.ts";
import { forceStop } from "../runners/runner.ts";
import type { SessionGraphView } from "../sessions/session-graph.ts";
import { Schedules } from "../jobs/schedules.ts";
import { projectScope } from "../memory/scope.ts";
import type { Slot } from "../runners/scheduler.ts";
import type { LiveRun } from "./steps.ts";
import { StepExecutor, challengeUnit, liveRun } from "./steps.ts";
import { Splitter } from "./split.ts";
import { StandingRules } from "../human/standing-rules.ts";
import { Workstation } from "../workstation/workstation.ts";
import { IssueDesk } from "../forge/issues.ts";
import { SignalDesk } from "../corporate/signals.ts";
import { WorkstationAgent } from "../workstation/workstation-agent.ts";
import { VigieDesk } from "../vigie/desk.ts";
import { BrowserDesk } from "../browser/desk.ts";
import { VpsBrowser } from "../browser/vps.ts";
import { AtlassianDesk, spaceAtlassian } from "../atlassian/desk.ts";
import type { AtlassianFetch } from "../atlassian/desk.ts";
import { SpaceDesk } from "../spaces/spaces.ts";
import { LocalSessionDesk } from "../sessions/local-sessions.ts";
import { ProposalDesk } from "../human/proposals.ts";
import { RunQueue, spaceBudgetText } from "./run-queue.ts";
import type { QueueWait, RunWithWait } from "./run-queue.ts";
import { RunCreation } from "./run-creation.ts";
import type { NewRunInput, NewProjectInput } from "./run-creation.ts";
import { PauseDesk } from "./pause-desk.ts";
import type { PauseState, PauseView } from "./pause-desk.ts";
import { RunViews } from "./run-views.ts";

export { HarnessError } from "../api/errors.ts";
export type { Actor, SpawnRunner } from "./context.ts";

export type OrchestratorDeps = HarnessDeps;

/** Une heure : la cadence de la purge du journal. */
const PRUNE_EVERY_MS = 60 * 60 * 1000;

export class Orchestrator {
  readonly #ctx: HarnessContext;
  readonly #steps: StepExecutor;
  readonly #briefings: Briefings;
  readonly #splits: Splitter;
  readonly #merger: Merger;
  readonly #human: HumanLoop;
  readonly #live = new Map<string, LiveRun & { slot: Slot }>();
  /** Les runs dont la veille a arrêté l'étape sur leur plafond de coût, et ce plafond. */
  readonly #budgetStops = new Map<string, BudgetDue>();
  /** L'admission équitable et la file d'attente : ce qui retient chaque run en file. */
  readonly #queue: RunQueue;
  /** La création des runs et des projets. */
  readonly #creation: RunCreation;
  /** La pause globale et celle des espaces. */
  readonly #pauses: PauseDesk;
  /** Les vues de lecture rendues à l'API. */
  readonly #views: RunViews;
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
  /** Le pilote des audits lancés : il tranche à la place de l'humain ce qui est réversible. */
  readonly pilot: AuditPilot;
  /** Le rêve de la mémoire : consolidation des faits d'un dépôt au repos, par un runner. */
  readonly dreams: Dreamer;
  /** Le poste de travail : observation, file d'actions de l'extension, meetings, profil. */
  readonly workstation: Workstation;
  /** L'agent 24/24 du poste et ses jobs (profil, digest des meetings, services). */
  readonly workstationAgent: WorkstationAgent;
  /** Les signalements des collègues et leurs propositions (pont corpo ↔ usine) */
  readonly signals: SignalDesk;
  /** La santé du serveur au fil du temps (`GET /v1/metrics`). */
  readonly metrics: Metrics;
  /** Les issues GitHub des dépôts déclarés, lancées en run (`POST /v1/mcp`). */
  readonly issues: IssueDesk;
  /** Les contextes de navigation des outils MCP `browser_*` (service `moli`, un contexte jetable par session). */
  readonly browsers: BrowserDesk;
  /** L'exécuteur du poste sur le VPS (`browserId: "vps"`, `moli-poste`) : il loue la file comme une extension. */
  readonly vps: VpsBrowser;
  /** Le rapport du matin, posté chaque jour à `notify.digestHour`. */
  readonly digest: DigestSender;
  /** Les planifications récurrentes, déclenchées par le tour de scheduling. */
  readonly schedules: Schedules;
  /** Les Demandes : une phrase libre classée par un job léger, confirmée en un objet par les chemins existants. */
  readonly intake: Intaker;
  /** La vigie : réglages, battement de cœur, incidents, publications et corrections gardées. */
  readonly vigie: VigieDesk;
  /** Le connecteur Atlassian : Jira et Confluence (serveur Rovo MCP), plan du jour, savoir de la boîte. */
  readonly atlassian: AtlassianDesk;
  /** Les espaces (clients) : l'espace d'un dépôt, son curseur d'autonomie par défaut, son budget journalier. */
  readonly spaces: SpaceDesk;
  /** Les sessions omp locales qui se signalent au serveur, et leur reprise par un run. */
  readonly localSessions: LocalSessionDesk;
  /** Le bac « Propositions » : ce que l'usine pourrait faire seule, accepté ou écarté d'un geste ; « refaire » un run. */
  readonly proposals: ProposalDesk;
  /** L'autonomie par paliers : lève seule certaines attentes humaines, selon les règles du dépôt. */
  readonly #autonomy: AutonomyGates;
  /** Les consignes permanentes de l'humain (« toujours faire ainsi »), dites dans le prompt de chaque étape. */
  readonly standing: StandingRules;
  #stopMetrics: (() => void) | null = null;

  constructor(deps: OrchestratorDeps) {
    this.#ctx = new HarnessContext(deps);
    this.#pauses = new PauseDesk(this.#ctx, this, {
      live: this.#live,
      halt: (runId) => this.#halt(runId),
      kick: () => this.#kick(),
    });
    this.#queue = new RunQueue(this.#ctx, this, {
      live: this.#live,
      launch: (runId, slot) => this.#launch(runId, slot),
      waiting: (run) => this.#splits.waiting(run),
      inferring: (runId) => this.#creation.isInferring(runId),
      pauseHold: () => this.#pauses.hold(),
      spaceHold: (repo) => this.#pauses.spaceHold(repo),
    });
    this.#creation = new RunCreation(this.#ctx, this, { kick: () => this.#kick() });
    this.#views = new RunViews(this.#ctx, this, {
      live: this.#live,
      briefing: (run) => this.#briefings.read(run),
      heldBy: (run) => this.#queue.heldBy(run),
      paused: () => this.#pauses.pause.paused,
    });
    this.#tickMs = deps.tickMs ?? 1000;
    // Un slot runner prêté (son agent attend ses tests) : le suivant de la file part sans attendre le tour.
    this.#ctx.scheduler.onLend((kind) => {
      if (kind === "runner" && !this.#stopping) this.#kick();
    });
    // L'étanchéité d'un espace lit autour de lui sa connexion Atlassian et les réglages de la vigie ; son
    // retrait lit sa pause et la connexion Atlassian par défaut, puis oublie ce qui n'était qu'à lui.
    this.spaces = new SpaceDesk(this.#ctx, {
      atlassian: (spaceId) => spaceAtlassian(this.#ctx.config, spaceId),
      vigie: () => this.vigie.settings(),
      paused: (spaceId) => this.#pauses.spacePaused(spaceId),
      defaultAtlassian: () => this.atlassian.enabled() && this.atlassian.connected(),
      removed: (spaceId) => {
        this.#pauses.forgetSpace(spaceId);
        this.atlassian.forgetSpace(spaceId);
      },
    });
    this.#pauses.loadSpaces();
    this.standing = new StandingRules(this.#ctx);
    this.metrics = new Metrics({
      store: this.#ctx.store,
      scheduler: this.#ctx.scheduler,
      liveRuns: () => this.#live.size,
      sampleSec: () => this.#ctx.config.monitoring.sampleSec,
      keep: () => this.#ctx.config.monitoring.keep,
    });
    this.#splits = new Splitter(this.#ctx, {
      openProject: (input, parent) => this.#creation.openProject(input, SERVICE, { afterRun: parent }),
    });
    this.#briefings = new Briefings(this.#ctx);
    this.atlassian = new AtlassianDesk(this.#ctx, {
      fetch: deps.atlassianFetch ?? (globalThis.fetch as unknown as AtlassianFetch),
    });
    this.#steps = new StepExecutor(this.#ctx, {
      split: (run, features, step) => this.#splits.launch(run, features, step, "runner"),
      atlassian: this.atlassian,
    });
    this.#merger = new Merger(this.#ctx, {
      onDone: () => this.#kick(),
      followUp: async (input, actor) => this.#creation.followUp(input, actor),
    });
    this.#human = new HumanLoop(this.#ctx, {
      halt: (runId) => this.#halt(runId),
      tick: () => this.#kick(),
      merging: (runId) => this.#merger.has(runId),
      followUp: async (input, actor) => this.#creation.followUp(input, actor),
      revertMerge: (runId, actor) => this.#merger.revert(runId, actor),
      steer: (runId, message) => this.#live.get(runId)?.session?.steer(message) ?? Promise.resolve(false),
      specsAccepted: (run) => this.#splits.accepted(run),
      liftable: (run) => this.#autonomy.liftable(run),
      standing: this.standing,
    });
    this.audits = new Auditor(this.#ctx, { createProject: (input, actor) => this.createProject(input, actor) });
    this.pilot = new AuditPilot(this.#ctx, {
      validate: (runId, approve, reason, actor) => this.#human.validate(runId, approve, reason, actor),
      retry: (runId, actor, instructions) => this.#human.retry(runId, actor, instructions),
      cancel: (runId, actor) => this.#human.cancel(runId, actor),
    });
    this.issues = new IssueDesk(this.#ctx, { createRun: (input, actor) => this.createRun(input, actor) });
    this.localSessions = new LocalSessionDesk(this.#ctx, {
      createRun: (input, actor) => this.createRun(input, actor),
    });
    this.vigie = new VigieDesk(this.#ctx, this.issues);
    this.browsers = new BrowserDesk(() => this.#ctx.config.browser, {
      log: this.#ctx.log,
      ...(deps.browserLookup ? { lookup: deps.browserLookup } : {}),
    });
    this.#autonomy = new AutonomyGates(this.#ctx, {
      validate: (runId, approve, reason, actor, options) =>
        this.#human.validate(runId, approve, reason, actor, options),
      launchedByVigie: (runId) => this.vigie.launchedByVigie(runId),
    });
    this.dreams = new Dreamer(this.#ctx);
    this.workstation = new Workstation(this.#ctx);
    this.signals = new SignalDesk(this.#ctx, { workstation: this.workstation, issues: this.issues });
    this.workstationAgent = new WorkstationAgent(this.#ctx, this.workstation, this.signals, this.atlassian);
    this.vps = new VpsBrowser(this.workstation, {
      config: () => this.#ctx.config.workstation.vps,
      log: this.#ctx.log,
      ...deps.vps,
    });
    this.digest = new DigestSender({
      config: this.#ctx.config,
      store: this.#ctx.store,
      notifier: this.#ctx.notifier,
      log: this.#ctx.log,
      health: () => this.#ctx.observability.digestHealth(),
    });
    this.schedules = new Schedules(this.#ctx, {
      createRun: (input, actor) => this.createRun(input, actor),
      createAudit: (repo, focus, actor) => this.audits.create(repo, focus, actor),
      fixLabeled: (repo, label, actor) => this.issues.fixLabeled(this.#ctx.repo(repo), label, actor),
      runAutomation: (automationId, actor) => this.workstation.runAutomation(automationId, actor),
    });
    this.intake = new Intaker(this.#ctx, {
      create: (plan, client, actor, autonomy, spaceId) => createFromPlan(this, client, actor, plan, autonomy, spaceId),
      spaces: this.spaces,
      state: (scope) =>
        factoryStatePrompt(
          factoryState(this.store, scope === "*" ? null : scope, Date.now(), (run) => this.#queue.heldBy(run)),
        ),
    });
    this.proposals = new ProposalDesk(this.#ctx, {
      issues: this.issues,
      vigie: this.vigie,
      audits: this.audits,
      signals: this.signals,
      atlassian: this.atlassian,
      createRun: (input, actor) => this.createRun(input, actor),
      retry: (runId, actor) => this.retry(runId, actor),
      applyRule: (admin, rule, actor) => this.applyAutonomyRule(admin, rule, actor),
    });
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

  /** Les alertes push des appareils : `useClients` leur donne le registre des clients de l'API. */
  get alerts(): HarnessContext["alerts"] {
    return this.#ctx.alerts;
  }

  /** Le direct des sessions de runners (tampon des dernières entrées de chaque run). */
  get sessions(): HarnessContext["sessions"] {
    return this.#ctx.sessions;
  }

  /** Erreurs des clients, sauvegardes, santé de la mémoire et compteurs de `GET /metrics`. */
  get observability(): HarnessContext["observability"] {
    return this.#ctx.observability;
  }

  // -- cycle de vie ---------------------------------------------------------

  /** Reprise après redémarrage, puis la boucle de scheduling. */
  async start(): Promise<void> {
    this.#ctx.overlay();
    // Les fournisseurs et chaînes déclarés par l'API passent avant la reprise des runs.
    this.#ctx.providers.apply();
    await this.#prepareRepos(this.#ctx.config.repos);
    // Les portées mémoire en double ou réservées : dites au journal, jamais un refus de démarrer (config.ts).
    for (const warning of configWarnings(this.#ctx.config))
      this.#ctx.log(`configuration : ${warning.text}`, { level: "warn" });
    // Une cible de notification bornée à un espace qui n'existe pas : dite au journal, jamais un refus de démarrer.
    for (const warning of this.#ctx.notifier.spaceWarnings())
      this.#ctx.log(`configuration : ${warning}`, { level: "warn" });
    await this.recover();
    this.#started = true;
    this.#lastTickAt = Date.now();
    this.#stopMetrics = this.metrics.subscribe();
    this.#prune();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
    void this.tick();
    // La relève des issues du label : la première peu après, pas pendant le démarrage.
    this.issues.start();
    this.digest.start();
    // La collecte des propositions sur les forges (PR sans activité, CI rouge, issues du label) : hors de toute requête.
    this.proposals.start();
  }

  /** Verrouille le gitdir de chaque dépôt et calcule sa scope mémoire si elle n'est pas déclarée. */
  async #prepareRepos(repos: RepoConfig[]): Promise<void> {
    for (const repo of repos) {
      try {
        await this.#ctx.git.protectRepo(repo.path);
      } catch (err) {
        this.#ctx.log(`dépôt ${repo.name} : droits du gitdir non verrouillés — ${String(err)}`, {
          level: "warn",
          repo: repo.name,
        });
      }
      // La scope mémoire non déclarée est celle que le plugin mémoire du Mac calcule.
      if (repo.scope === "") {
        try {
          repo.scope = await projectScope(this.#ctx.git, repo.path, repo.mainBranch);
        } catch {
          repo.scope = repo.name;
        }
        this.#ctx.log(`dépôt ${repo.name} : mémoire du projet « ${repo.scope} »`, { repo: repo.name });
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
    this.digest.stop();
    this.#stopMetrics?.();
    await this.issues.stop();
    await this.proposals.stop();
    await this.browsers.stop();
    await this.#ticking;
    await this.#pauses.suspending;
    // Une relève d'issues partie d'une échéance finit (ses runs sont créés ou non, jamais à moitié).
    await this.schedules.stop();
    const lives = [...this.#live.values()];
    for (const live of lives) {
      live.abort.abort();
      await live.session?.stop();
    }
    await Promise.allSettled(lives.map((live) => live.done));
    await this.audits.stop();
    await this.intake.stop();
    await this.pilot.stop();
    await this.dreams.stop();
    // L'exécuteur du VPS lâche son long-poll et ferme sa connexion avant que le poste ne se ferme.
    await this.vps.stop();
    // Les attentes du poste (long-polls de l'extension) rendent tout de suite.
    this.workstation.close();
    await this.workstationAgent.stop();
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
      // La QA de /review (prévisualisation et navigateur) n'a pas pu s'arrêter avec son process.
      if (step.kind === "review" && config.heavy.isolation === "container")
        await forceStopQa(config, exec, step.runId, step.id);
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
          this.#ctx.log(`reprise ${run.id} : retour au checkpoint impossible — ${String(err)}`, {
            level: "warn",
            runId: run.id,
            repo: run.repo,
          });
        }
      }
      const cursor = { step: (run.step ?? "req") as StepKind, fixes: run.fixes, attempts: run.attempts };
      store.transaction(() => {
        if (this.#ctx.transition(run, recovered(cursor), ["running"]))
          this.#ctx.event("recovered", run.id, { step: run.step });
      });
    }
    await this.audits.recover();
    await this.intake.recover();
    await this.pilot.recover();
    await this.dreams.recover();
    await this.#ctx.baseline.recover();
    await this.workstationAgent.recover();
    if (this.#ctx.config.workstation.enabled) this.vps.start();
  }

  /** La rétention du journal : au démarrage, puis au plus une fois par heure. */
  #prune(): void {
    const now = Date.now();
    if (now - this.#prunedAt < PRUNE_EVERY_MS) return;
    this.#prunedAt = now;
    const before = now - this.#ctx.config.events.retentionDays * 24 * 60 * 60 * 1000;
    const pruned = this.store.pruneEvents(before);
    this.store.pruneSessions(before);
    this.store.pruneIdempotency(now - IDEMPOTENCY_TTL_MS);
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
    // En pause (« Tout suspendre »), le serveur ne décide plus rien seul : aucun NOUVEAU merge n'est enfilé
    // (un merge déjà enfilé finit), aucune escalade n'est tranchée à l'échéance, aucune attente n'est validée
    // par l'autonomie. Un run `merging`, une échéance passée, une attente retenue (`hold`) restent tels
    // quels : le premier tour après la reprise les reprend. La pause est relue avant chacun des trois : une
    // pause posée pendant que le tour attend (`await`) vaut pour la suite du tour. La pause d'un ESPACE
    // retient de même les trois pour ses seuls dépôts (`spaceHeld` de `PauseDesk`) : les autres espaces continuent.
    if (this.#pauses.hold() === null) {
      for (const run of store.listRuns({ state: ["merging"] }))
        if (!this.#pauses.spaceHeld(run.repo)) this.#merger.enqueue(run);
      // Une PR fusionnée sur la forge hors du harness : le run qui l'attendait passe au merge, qui le constate.
      const waiting = store.listRuns({ state: ["awaiting_human"] }).filter((run) => !this.#pauses.spaceHeld(run.repo));
      void this.#merger.reconcile(waiting, Date.now());
    }
    // Une escalade ouverte depuis trop longtemps est tranchée sur la recommandation de l'agent.
    try {
      if (this.#pauses.hold() === null) await this.#human.autoDecideExpired(Date.now(), this.#pauses.spaceHeld);
    } catch (err) {
      this.#ctx.log(`auto-décision des escalades échues : ${err instanceof Error ? err.message : String(err)}`, {
        level: "error",
        err,
      });
    }
    try {
      if (this.#pauses.hold() === null) await this.#autonomy.tick(this.#pauses.spaceHeld);
    } catch (err) {
      this.#ctx.log(`autonomie : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    // En pause (« Tout suspendre »), rien de neuf ne part : ni planification, ni audit, ni Demande, ni
    // pilote, ni job du poste, ni rêve — ce qui tourne finit, et la vigie ne fait que suivre ses incidents.
    const hold = this.#pauses.hold();
    // La pause ou le budget du jour d'un ESPACE retient de même tout ce qui est à lui (`spaceHolds` de `PauseDesk`) —
    // ses planifications, audits, Demandes, rêves et jobs du poste ; les autres espaces et le hors-espace continuent.
    const holds = this.#pauses.spaceHolds(Date.now());
    // Les planifications dues d'abord : un run ou un audit qu'elles créent part dès ce tour.
    try {
      if (hold === null) void this.schedules.tick(Date.now(), (target) => this.#pauses.scheduleHold(target, holds));
    } catch (err) {
      this.#ctx.log(`planifications : ${err instanceof Error ? err.message : String(err)}`);
    }
    if (hold === null) this.audits.tick(holds);
    try {
      if (hold === null) this.intake.tick(holds);
    } catch (err) {
      this.#ctx.log(`demandes : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    try {
      if (hold === null) this.pilot.tick();
    } catch (err) {
      this.#ctx.log(`pilote des audits : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    try {
      this.workstationAgent.tick(Date.now(), hold, (space) => holds.ofSpace(space)?.text ?? null);
    } catch (err) {
      this.#ctx.log(`poste de travail : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    this.#queue.admit();
    // Après les runs : un dépôt ne rêve que sur un slot que nul run n'attend.
    if (hold === null) this.dreams.tick(Date.now(), holds);
    this.#watch();
    this.metrics.maybeSample();
    this.#ctx.observability.tick();
    this.vigie.maybeTick(Date.now());
    try {
      this.proposals.maybeTick(Date.now());
    } catch (err) {
      this.#ctx.log(`propositions : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
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
      this.#ctx.log(`veille : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
  }

  /**
   * Un run tel que l'API le rend. En file et retenu : sa raison dit ce qui le retient, par qui, jusqu'à
   * quand et avec quels chiffres. Chez l'humain : pourquoi (`humanWait`). En échec : où et pourquoi (`failure`).
   */
  withWait(run: RunRow): RunWithWait {
    return this.#queue.withWait(run);
  }

  /**
   * Pourquoi ce run attend l'humain, en données (`humanWaitFacts`) ; `null` hors attente humaine. Rien
   * n'est recalculé de coûteux : une attente ne relit que ce qu'elle a déjà en base — ses specs et ses
   * désaccords (specs), l'évidence de sa dernière revue (verdict), son coût et son budget (budget), ses
   * escalades ouvertes (questions). Un run qui n'attend pas ne lit rien.
   */
  humanWait(run: RunRow): HumanWaitView | null {
    return this.#queue.humanWait(run);
  }

  /** Les runs DUS retenus en file, par cause, et la cause dominante (la plus fréquente) : la file de `/v1/status`. */
  queueWaits(repos: RepoFilter = null): { held: number; byCause: Record<string, number>; dominant: QueueWait | null } {
    return this.#queue.queueWaits(repos);
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
        // La pause (globale, ou celle de l'espace du dépôt) : comme au plafond journalier, la feature rend
        // son slot avant l'étape et retourne en file.
        const pauser = this.#pauses.pauser(run.repo);
        if (pauser !== null) {
          this.#ctx.transition(
            run,
            heldForPause({ step: run.step, fixes: run.fixes, attempts: run.attempts }, pauser),
            ["running"],
          );
          break;
        }
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
        // Le budget journalier de l'espace du dépôt, atteint entre deux étapes : même arrêt — la feature
        // retourne en file à son étape, sans échec compté, et l'admission la retient (`space_budget`).
        const space = this.spaces.budgetHold(run.repo, Date.now());
        if (space) {
          this.#ctx.transition(
            run,
            {
              ...heldForDailyBudget(
                { step: run.step, fixes: run.fixes, attempts: run.attempts },
                space.spent,
                space.ceiling,
              ),
              reason: spaceBudgetText(space),
            },
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
            fixCap: fixCapFor(config, run),
            retryBackoffSec: retryBackoff(config),
            specsGate: config.review.specsGate,
            mergeRetries: config.review.mergeRetries,
            ask: run.autonomy === "ask",
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
        // L'attente de specs ou d'arbitrage s'ouvre sur sa carte : écrite AVANT la transition, jamais bloquante.
        if (transition.state === "awaiting_human") await this.#briefings.prepare(run, transition);
        // Une attente que l'autonomie va lever seule : les notifications sont retenues (`hold`) jusqu'à
        // son tour, qui valide ou y renonce et les publie (autonomy-gates.ts).
        const held =
          transition.state === "awaiting_human"
            ? this.#autonomy.evaluate({
                ...run,
                state: transition.state,
                step: transition.step,
                reason: transition.reason,
              })
            : null;
        // Des specs acceptées sans porte : leur découpage part dans la même transaction.
        const moved = store.transaction(() => {
          const next = this.#ctx.transition(run, transition, ["running"], {
            patch: { notBefore: transition.notBefore, lastFailCause },
            quiet: held?.ok === true,
          });
          if (next && held?.ok) this.#ctx.event("autonomy", run.id, { action: "hold", gate: held.gate, rev: next.rev });
          if (next && acceptsSpecs(run.step, transition)) this.#splits.accepted(next);
          return next;
        });
        if (!moved) break;
        if (!transition.keepRunner) await live.session?.stop();
        if (transition.rebase) live.pendingRebase = true;
        if (transition.state !== "running") break;
      }
    } catch (err) {
      const run = store.getRun(live.runId);
      if (run && (run.state === "queued" || run.state === "running") && !live.abort.signal.aborted) {
        const reason = err instanceof Error ? err.message : String(err);
        if (this.#ctx.transition(run, crashed(run, reason), [run.state]))
          this.#ctx.log(`run ${live.runId} en échec : ${reason}`, {
            level: "error",
            runId: run.id,
            repo: run.repo,
            err,
          });
      }
    } finally {
      // L'arrêt immédiat d'une pause : l'étape abandonnée n'est ni un échec ni une tentative.
      this.#pauses.parkIfStopped(live.runId);
    }
  }

  // -- API : création -------------------------------------------------------

  /**
   * Un run sans `modules` : ils sont déduits par l'oracle (comme pour un projet) avant
   * l'admission — sinon le run chevaucherait tout le dépôt jusqu'à ses specs. La
   * déduction est asynchrone ; le run est créé tout de suite et n'est pas candidat
   * tant qu'elle court. `afterRun` : le parent d'une feature découpée, dont elle attend
   * le merge en file (split.ts). `inheritAutonomy` : le curseur du run dont celui-ci descend
   * (découpage, run de suite) — hérité tel quel, ce n'est pas l'acteur qui le monte.
   */
  createRun(
    input: NewRunInput & {
      projectId?: string;
      projectOrder?: number;
      inferModules?: boolean;
      afterRun?: Pick<RunRow, "id" | "title">;
      inheritAutonomy?: RunAutonomy | null;
    },
    actor: Actor = SERVICE,
  ): RunRow {
    return this.#creation.createRun(input, actor);
  }

  /** /project : les modules de chaque feature (déclarés, sinon via l'oracle), puis une file planifiée. */
  createProject(input: NewProjectInput, actor: Actor = SERVICE): Promise<{ projectId: string; runs: RunRow[] }> {
    return this.#creation.createProject(input, actor);
  }

  // -- API : boucle humaine -------------------------------------------------

  /** Les réponses aux escalades d'un run ; `always` sur une réponse en fait une consigne permanente du dépôt. */
  answerEscalations(runId: string, answers: EscalationAnswer[], actor: Actor = SERVICE): Promise<RunRow> {
    return this.#human.answerEscalations(runId, answers, actor);
  }

  /**
   * La relance par l'humain d'un run échoué ou en attente : même étape, tout de suite.
   * `instructions` : la consigne que l'étape relancée recevra. Un pilote est refusé (403)
   * sur un budget dépassé AVANT que la relance n'en accorde un autre.
   */
  retry(runId: string, actor: Actor = SERVICE, instructions = ""): Promise<RunRow> {
    this.#human.assertPilotMay(this.visibleRun(runId), actor);
    // Une feature arrêtée sur son budget : la relancer lui en accorde un de plus.
    this.#ctx.monitor.acknowledgeBudget(runId, actor.by);
    return this.#human.retry(runId, actor, instructions);
  }

  /**
   * Une consigne à un run : injectée dans le prompt en cours de sa session si elle tourne,
   * sinon gardée pour le prochain prompt (`delivered` : `session` ou `pending`).
   */
  instruct(runId: string, text: string, actor: Actor = SERVICE): Promise<{ run: RunRow; delivered: Delivered }> {
    return this.#human.instruct(runId, text, actor);
  }

  /** Le budget propre d'un run (`null` : celui de la configuration), prioritaire sur `monitoring.runBudgetUsd`. */
  setBudget(runId: string, budget: number | null, actor: Actor = SERVICE): Promise<{ run: RunRow; budget: RunBudget }> {
    return this.#human.setBudget(runId, budget, actor);
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

  /** La validation des specs ou du verdict ; `always` : la raison d'un refus devient une consigne permanente du dépôt. */
  validate(runId: string, approve: boolean, reason: string, actor: Actor = SERVICE, always = false): Promise<RunRow> {
    return this.#human.validate(runId, approve, reason, actor, { always });
  }

  /**
   * Le curseur d'autonomie d'un run. Sorti de « tout me demander » (ou passé à « livre et préviens-moi »)
   * pendant qu'il attend l'humain, l'attente est réévaluée tout de suite : levable, le prochain tour la valide.
   */
  async setAutonomy(runId: string, level: RunAutonomy | null, actor: Actor = SERVICE): Promise<RunRow> {
    await this.#human.setAutonomy(runId, level, actor);
    this.#autonomy.reconsider(runId);
    this.#kick();
    return this.#ctx.run(runId);
  }

  /**
   * Règle la porte d'un type de travail d'un dépôt (`POST /v1/autonomy/rules`, proposition de palier acceptée) :
   * la configuration est écrite et rechargée par `admin` (400 si elle est refusée, rien ne change).
   */
  async applyAutonomyRule(
    admin: ConfigAdmin,
    input: AutonomyRuleInput,
    actor: Actor = SERVICE,
  ): Promise<{ repo: string; rules: AutonomyRule[] }> {
    const set = await admin.setAutonomyRule(input);
    this.#ctx.event("autonomy_rule", null, { ...input, ...(actor.by ? { by: actor.by } : {}) }, input.repo);
    return set;
  }

  /** L'annulation ; `motive` : le motif que l'humain en donne (cause, note), `null` : aucun. */
  cancel(runId: string, actor: Actor = SERVICE, motive: CancelMotive | null = null): Promise<RunRow> {
    return this.#human.cancel(runId, actor, motive);
  }

  /** Corriger un run là où il est (specs refaites, correction, relance ou consigne selon son état) ; `via` dit par où. */
  amend(runId: string, text: string, actor: Actor = SERVICE, always = false): Promise<{ run: RunRow; via: AmendVia }> {
    return this.#human.amend(runId, text, actor, always);
  }

  /** Les modules d'un run, restreints par l'humain : l'admission les relit au tour suivant. */
  setModules(runId: string, modules: string[], actor: Actor = SERVICE): Promise<RunRow> {
    return this.#human.setModules(runId, modules, actor);
  }

  setPriority(runId: string, priority: number, actor: Actor = SERVICE): Promise<RunRow> {
    return this.#human.setPriority(runId, priority, actor);
  }

  // -- API : pause globale --------------------------------------------------

  /** La pause globale telle que `GET /v1/pause` la rend. */
  get pause(): PauseState {
    return this.#pauses.pause;
  }

  /** `GET /v1/pause` : la pause globale, et les espaces en pause dont le lecteur voit un dépôt. */
  pauseView(repos: RepoFilter = null): PauseView {
    return this.#pauses.pauseView(repos);
  }

  /**
   * « Tout suspendre », ou reprendre. En pause, plus aucun run n'est admis, chaque run vivant retourne
   * en file avant sa prochaine étape (rien n'est annulé), et ni audit, ni rêve, ni planification, ni
   * Demande, ni job du poste ne démarre ; `paused: false` relance le tour. `now` : ce qui tourne est
   * interrompu sur-le-champ (`#suspendNow`) au lieu de finir son étape — une pause déjà posée sans lui
   * peut le recevoir ensuite. Le réglage est écrit (`settings`, clé `pause`) : il survit à un redémarrage.
   * Réservé au propriétaire : un client borné à des dépôts ou un pilote est refusé (403). Redire l'état
   * courant ne change rien.
   *
   * `spaceRef` (identifiant ou nom) : la pause d'UN espace, par le même chemin (réglage `pause:<espaceId>`,
   * événement `pause` avec `space`). Ses runs ne sont plus admis, ses runs vivants retournent en file
   * (tout de suite avec `now`), ses merges non engagés, son autonomie et ses échéances attendent ; les
   * autres espaces continuent. Espace inconnu : 404, après le refus du non-propriétaire.
   */
  setPause(
    paused: boolean,
    reason: string,
    actor: Actor = SERVICE,
    repos: RepoFilter = null,
    now = false,
    spaceRef: string | null = null,
  ): PauseState {
    return this.#pauses.setPause(paused, reason, actor, repos, now, spaceRef);
  }

  // -- API : lectures -------------------------------------------------------

  /** Le run, s'il appartient à un dépôt que le lecteur voit (sinon 404 : on ne trahit pas son existence). */
  visibleRun(runId: string, repos: RepoFilter = null): RunRow {
    return this.#views.visibleRun(runId, repos);
  }

  /** La vue complète d'un run : étapes, décisions, escalades, tests, artefacts ; en file, ce qui le retient. */
  runView(runId: string, repos: RepoFilter = null): Record<string, unknown> {
    return this.#views.runView(runId, repos);
  }

  /** Un run tel que l'API le rend, avec la carte en tête de ce qu'il attend (`briefing`, vide s'il n'attend ni specs ni arbitrage). */
  withBriefing<T extends RunRow>(run: T): T & { briefing: Briefing } {
    return this.#views.withBriefing(run);
  }

  /** La boîte de l'humain : `inboxOf` (filtrée par dépôts), les alertes et les coûts des runs listés. */
  inboxView(repos: RepoFilter = null): Record<string, unknown> {
    return this.#views.inboxView(repos);
  }

  /**
   * Le brief « pendant votre absence » de `client` sur les dépôts qu'il voit : depuis `since`, sinon
   * depuis la dernière fois qu'il l'a vu (`POST /v1/brief/seen`), sinon sur 24 heures. `owner` : le
   * client voit tous les dépôts — sa lecture bornée à un espace (`?space=`) compte aussi ses propositions.
   */
  briefView(
    client: string,
    since: number | null,
    repos: RepoFilter = null,
    now = Date.now(),
    owner = repos === null,
  ): Brief {
    return this.#views.briefView(client, since, repos, now, owner);
  }

  /** Le client a vu le brief : le prochain part de cet instant. */
  briefSeen(client: string, now = Date.now()): number {
    return this.#views.briefSeen(client, now);
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
    return this.#views.sessionView(runId, repos, page);
  }

  /** Le graphe de session d'un run : ce que l'agent a lu, cherché, testé, modifié et décidé. */
  graphView(runId: string, repos: RepoFilter = null): SessionGraphView {
    return this.#views.graphView(runId, repos);
  }

  /** Le direct de l'analyse d'un audit, sous la même forme (`auditId` au lieu de `runId`). */
  auditSessionView(auditId: string, page: { before?: number | null; limit?: number } = {}): Record<string, unknown> {
    return this.#views.auditSessionView(auditId, page);
  }

  /**
   * Une entrée du direct d'un run et son détail : pour un outil, ses arguments complets
   * (`args`) et sa sortie entière (`output`, celle qui s'écrit s'il tourne encore) ;
   * pour un long paragraphe, son texte entier (`output`). 404 si l'entrée est inconnue.
   */
  sessionEntryView(runId: string, seq: number, repos: RepoFilter = null): Record<string, unknown> {
    return this.#views.sessionEntryView(runId, seq, repos);
  }

  /** Une entrée du direct de l'analyse d'un audit et son détail. */
  auditSessionEntryView(auditId: string, seq: number): Record<string, unknown> {
    return this.#views.auditSessionEntryView(auditId, seq);
  }

  /** La frise d'un run : étapes, tests, décisions, événements marquants, coût par étape. */
  timeline(runId: string, repos: RepoFilter = null): Record<string, unknown> {
    return this.#views.timeline(runId, repos);
  }

  /** Les fichiers touchés par un run (worktree, sinon commit squash). */
  changes(runId: string, repos: RepoFilter = null): Promise<Record<string, unknown>> {
    return this.#views.changes(runId, repos);
  }

  /** Les différences d'un fichier touché par un run. */
  fileDiff(runId: string, file: string, repos: RepoFilter = null): Promise<Record<string, unknown>> {
    return this.#views.fileDiff(runId, file, repos);
  }

  /** La sortie des derniers jobs de tests d'un run, en cours compris. */
  liveTests(runId: string, repos: RepoFilter = null): Record<string, unknown> {
    return this.#views.liveTests(runId, repos);
  }

  /** Les preuves d'un run (le dossier d'un dépôt invisible n'est jamais lu : 404 avant). */
  proofsView(runId: string, repos: RepoFilter = null): { runId: string; proofs: Proof[] } {
    return this.#views.proofsView(runId, repos);
  }

  /** Le contenu d'une preuve par son rang. */
  proofContent(runId: string, n: number, repos: RepoFilter = null): { proof: Proof; data: Buffer } {
    return this.#views.proofContent(runId, n, repos);
  }

  /** La veille : coût, budget et alertes des features. */
  get monitor(): HarnessContext["monitor"] {
    return this.#ctx.monitor;
  }

  status(repos: RepoFilter = null): Record<string, unknown> {
    return this.#views.status(repos);
  }

  /** L'état de la mémoire du projet : configurée, joignable, et les écritures perdues depuis le démarrage. */
  oracleStatus(): Promise<{ configured: boolean; ok: boolean; lostWrites: LostWrites }> {
    return this.#views.oracleStatus();
  }
}
