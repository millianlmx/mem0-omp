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
// - `queries.ts`      les lectures de l'API.
//
// Un seul process, un seul écrivain : toute mutation passe par `Store`, toute
// transition par la table de `machine.ts`. Les runs avancent en parallèle (une
// boucle async par run actif), sur plusieurs dépôts et projets à la fois, bornés par
// le scheduler (slots, admission mémoire, jetons par fournisseur), le planificateur
// (modules disjoints seulement) et le plafond de chaque dépôt (`maxParallel`).
// L'admission est ÉQUITABLE : priorité d'abord, puis le dépôt et le projet qui ont le
// moins de runs vivants, puis l'ancienneté — aucun projet ne prend tous les runners.
import { AutonomyGates } from "./autonomy-gates.ts";
import type { AutonomyRuleInput } from "./autonomy-learning.ts";
import type { AutonomyRule, WorkKind } from "./autonomy-rules.ts";
import { Auditor } from "./audits.ts";
import { Dreamer } from "./dreams.ts";
import { createFromPlan } from "./intake-create.ts";
import { Intaker } from "./intake.ts";
import { AuditPilot, raisesAutonomy } from "./pilot.ts";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { retryBackoff } from "./config.ts";
import type { Actor, HarnessDeps } from "./context.ts";
import { HarnessContext, SERVICE } from "./context.ts";
import type { DecisionRow, RepoFilter, RunAutonomy, RunRow } from "./db.ts";
import { detectIrreversible } from "./decisions.ts";
import { DigestSender } from "./digest.ts";
import { HarnessError } from "./errors.ts";
import { Briefings } from "./briefing.ts";
import type { Briefing } from "./briefing.ts";
import { BRIEF_WINDOW_MS, briefOf, briefSeenKey, factoryState, factoryStatePrompt } from "./brief.ts";
import type { Brief, HeldBy } from "./brief.ts";
import { HumanLoop } from "./gestures.ts";
import type { AmendVia, Delivered, EscalationAnswer } from "./gestures.ts";
import { newId } from "./ids.ts";
import { budgetUsd } from "./input.ts";
import type { CancelMotive } from "./input.ts";
import { changesOf, fileDiffOf, timelineOf } from "./inspect.ts";
import { Metrics } from "./metrics.ts";
import type { BudgetDue, RunBudget } from "./monitor.ts";
import type { RunState, StepKind } from "./machine.ts";
import {
  ACTIVE_STATES,
  acceptsSpecs,
  crashed,
  PAUSE_REASON,
  heldForDailyBudget,
  heldForPause,
  nextAfter,
  pausedForBudget,
  recovered,
} from "./machine.ts";
import type { FailCause, StepOutcome } from "./machine.ts";
import { Merger } from "./merger.ts";
import { briefOfReq } from "./oracle.ts";
import type { LostWrites } from "./oracle.ts";
import type { Proof } from "./proofs.ts";
import { knownModules, modulesViaOracle, overlaps, schedulable } from "./planner.ts";
import { inboxOf, loadOf, runView } from "./queries.ts";
import type { ConfigAdmin } from "./repos.ts";
import { forceStopQa } from "./browser/qa.ts";
import { forceStop } from "./runner.ts";
import { auditOwner } from "./session-feed.ts";
import type { SessionGraphView } from "./session-graph.ts";
import { Schedules } from "./schedules.ts";
import { projectScope } from "./scope.ts";
import type { Slot } from "./scheduler.ts";
import type { LiveRun } from "./steps.ts";
import { SPECS_BASELINE, StepExecutor, challengeUnit, directSpecs, liveRun } from "./steps.ts";
import { Splitter, waitReason } from "./split.ts";
import { StandingRules } from "./standing-rules.ts";
import { Workstation } from "./workstation.ts";
import { IssueDesk } from "./issues.ts";
import { SignalDesk } from "./corporate/signals.ts";
import { WorkstationAgent } from "./workstation-agent.ts";
import { VigieDesk } from "./vigie/desk.ts";
import { BrowserDesk } from "./browser/desk.ts";
import { VpsBrowser } from "./browser/vps.ts";
import { AtlassianDesk } from "./atlassian/desk.ts";
import type { AtlassianFetch } from "./atlassian/desk.ts";
import { SpaceDesk } from "./spaces.ts";
import { LocalSessionDesk } from "./local-sessions.ts";
import { ProposalDesk } from "./proposals.ts";

export { HarnessError } from "./errors.ts";
export type { Actor, SpawnRunner } from "./context.ts";

export type OrchestratorDeps = HarnessDeps;

/**
 * `req` : le compte rendu de besoins déjà établi en session interactive (/req local) — le run part de /specs.
 * `lane: "full"` : la voie complète (/req) même si la demande porte ses critères d'acceptation.
 * `budgetUsd` : le budget propre du run, prioritaire sur `monitoring.runBudgetUsd`.
 */
export type NewRunInput = {
  repo: string;
  title: string;
  request: string;
  slug?: string;
  modules?: string[];
  req?: string;
  priority?: number;
  lane?: "full";
  budgetUsd?: number;
  /** Le type de travail et les labels déclarés par le créateur (`POST /v1/runs`), lus par l'autonomie par paliers. */
  kind?: WorkKind;
  labels?: string[];
  /** Le curseur d'autonomie du run (`ask`, `deliver`, `null` : les règles du dépôt) ; absent : celui de l'espace du dépôt. */
  autonomy?: RunAutonomy | null;
};

export type NewProjectInput = {
  repo: string;
  title: string;
  priority?: number;
  /** Le curseur d'autonomie de toutes ses features ; absent : celui de l'espace du dépôt. */
  autonomy?: RunAutonomy | null;
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

/** Un run qui en retient un autre : le parent d'une feature découpée, ou un run dont les modules recoupent les siens. */
export type QueueBlocker = { runId: string; title: string; state: RunState; modules: string[] };

/**
 * Ce qui retient un run `queued` : la cause et son texte, recalculés à chaque tour (les chiffres
 * restent à jour). `blockedBy` : les runs qui le retiennent (`modules`, `parent`) ; `until` :
 * l'instant avant lequel il ne repart pas (`backoff`). Les causes d'un run DÛ sont les codes de
 * `admission_refused` ; `parent`, `backoff` et `inferring` (`NOT_DUE`) retiennent un run qui
 * n'est pas encore candidat — l'API les dit, sans refus journalisé ni place dans la file de `/v1/status`.
 */
export type QueueWait = {
  cause:
    | "slots"
    | "memory"
    | "daily_budget"
    | "repo_cap"
    | "modules"
    | "unknown_repo"
    | "parent"
    | "backoff"
    | "inferring"
    | "paused"
    | "space_budget";
  text: string;
  blockedBy?: QueueBlocker[];
  until?: number;
};

const NOT_DUE: readonly QueueWait["cause"][] = ["parent", "backoff", "inferring"];

/** Un run tel que l'API le rend : en file, sa raison est ce qui le retient (`waitCause` en dit le code). */
export type RunWithWait = RunRow & { waitCause?: QueueWait["cause"]; blockedBy?: QueueBlocker[]; waitUntil?: number };

/**
 * La pause globale (« Tout suspendre ») : qui l'a posée ou levée, quand, et pourquoi. `now` : elle a
 * interrompu sur-le-champ ce qui tournait, au lieu de laisser finir les étapes en cours. Gardée dans
 * les réglages (`settings`, clé `pause`) : elle survit à un redémarrage.
 */
export type PauseState = {
  paused: boolean;
  by: string | null;
  at: number | null;
  reason: string | null;
  now: boolean;
};

const PAUSE_KEY = "pause";
/** Qui a suspendu, quand la pause vient du service lui-même (aucun client). */
const PAUSE_SERVICE = "le service";

/** Le plus grand nombre de runs nommés dans `blockedBy` : les actifs d'abord, puis la file. */
const MAX_BLOCKERS = 8;

export class Orchestrator {
  readonly #ctx: HarnessContext;
  readonly #steps: StepExecutor;
  readonly #briefings: Briefings;
  readonly #splits: Splitter;
  readonly #merger: Merger;
  readonly #human: HumanLoop;
  readonly #live = new Map<string, LiveRun & { slot: Slot }>();
  /**
   * Ce qui retient chaque run en file, tenu en mémoire seulement : rien n'est écrit en
   * base (ni révision ni horodatage ne bougent), et tout repart de zéro au démarrage.
   * `admission_refused` n'est journalisé que lorsque la CAUSE d'un run change.
   */
  readonly #waits = new Map<string, QueueWait>();
  /** Les runs dont la veille a arrêté l'étape sur leur plafond de coût, et ce plafond. */
  readonly #budgetStops = new Map<string, BudgetDue>();
  /** Les runs dont les modules sont en cours de déduction : pas candidats avant. */
  readonly #inferring = new Set<string>();
  /** La pause globale, relue des réglages au démarrage : rien n'est admis ni lancé tant qu'elle tient. */
  #pause: PauseState;
  /** Les runs vivants qu'une pause immédiate (`now`) interrompt : ils retournent en file, sans échec compté. */
  readonly #pauseStops = new Set<string>();
  /** L'arrêt immédiat en cours (runs, audits, Demandes, pilote) : rien ne repart avant qu'il ait fini. */
  #suspending: Promise<void> | null = null;
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
    this.#pause = pauseOf(this.#ctx.store.getSetting<unknown>(PAUSE_KEY));
    this.#tickMs = deps.tickMs ?? 1000;
    this.spaces = new SpaceDesk(this.#ctx);
    this.standing = new StandingRules(this.#ctx);
    this.metrics = new Metrics({
      store: this.#ctx.store,
      scheduler: this.#ctx.scheduler,
      liveRuns: () => this.#live.size,
      sampleSec: () => this.#ctx.config.monitoring.sampleSec,
      keep: () => this.#ctx.config.monitoring.keep,
    });
    this.#splits = new Splitter(this.#ctx, {
      openProject: (input, parent) => this.#openProject(input, SERVICE, { afterRun: parent }),
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
      followUp: async (input, actor) => this.#followUp(input, actor),
    });
    this.#human = new HumanLoop(this.#ctx, {
      halt: (runId) => this.#halt(runId),
      tick: () => this.#kick(),
      merging: (runId) => this.#merger.has(runId),
      followUp: async (input, actor) => this.#followUp(input, actor),
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
      create: (plan, client, actor, autonomy) => createFromPlan(this, client, actor, plan, autonomy),
      state: (scope) =>
        factoryStatePrompt(
          factoryState(this.store, scope === "*" ? null : scope, Date.now(), (run) => this.#heldBy(run)),
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
    await this.#suspending;
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
      this.#ctx.log(`auto-décision des escalades échues : ${err instanceof Error ? err.message : String(err)}`, {
        level: "error",
        err,
      });
    }
    try {
      await this.#autonomy.tick();
    } catch (err) {
      this.#ctx.log(`autonomie : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    // En pause (« Tout suspendre »), rien de neuf ne part : ni planification, ni audit, ni Demande, ni
    // pilote, ni job du poste, ni rêve — ce qui tourne finit, et la vigie ne fait que suivre ses incidents.
    const hold = this.#pauseHold();
    // Les planifications dues d'abord : un run ou un audit qu'elles créent part dès ce tour.
    try {
      if (hold === null) void this.schedules.tick(Date.now());
    } catch (err) {
      this.#ctx.log(`planifications : ${err instanceof Error ? err.message : String(err)}`);
    }
    if (hold === null) this.audits.tick();
    try {
      if (hold === null) this.intake.tick();
    } catch (err) {
      this.#ctx.log(`demandes : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    try {
      if (hold === null) this.pilot.tick();
    } catch (err) {
      this.#ctx.log(`pilote des audits : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    try {
      this.workstationAgent.tick(Date.now(), hold);
    } catch (err) {
      this.#ctx.log(`poste de travail : ${err instanceof Error ? err.message : String(err)}`, { level: "error", err });
    }
    this.#admit();
    // Après les runs : un dépôt ne rêve que sur un slot que nul run n'attend.
    if (hold === null) this.dreams.tick();
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
   * Ce qui retient un run en file qui n'est pas encore candidat, ou `null` s'il est dû : le merge
   * de son parent (feature découpée), l'heure de sa relance (`notBefore`), ses modules en cours de déduction.
   */
  #notDue(run: RunRow, now: number): QueueWait | null {
    const parent = run.afterRun !== null && this.#splits.waiting(run) ? this.store.getRun(run.afterRun) : null;
    if (parent) return { cause: "parent", text: waitReason(parent), blockedBy: [blockerOf(parent)] };
    if (run.notBefore !== null && run.notBefore > now)
      return {
        cause: "backoff",
        text: run.reason ?? `relance différée : reprise à ${new Date(run.notBefore).toISOString()}`,
        until: run.notBefore,
      };
    if (this.#inferring.has(run.id))
      return {
        cause: "inferring",
        text: "modules en cours de déduction : l'oracle cherche ce que la feature touchera",
      };
    return null;
  }

  /**
   * Les candidats de chaque dépôt : les runs repris d'abord, puis les nouveaux que les
   * modules et `maxParallel` laissent partir. `held` : ce qui retient les autres runs en file —
   * pas encore dus (`#notDue`), ou dus sans être candidats (plafond du dépôt, modules partagés,
   * budget de l'espace, dépôt retiré).
   */
  #candidates(): {
    candidates: Candidate[];
    held: Map<string, QueueWait>;
    activeByRepo: Map<string, number>;
    activeByGroup: Map<string, number>;
  } {
    const { store } = this.#ctx;
    const now = Date.now();
    const held = new Map<string, QueueWait>();
    // Un run relancé après un échec attend son heure (`notBefore`) : il n'est pas candidat avant.
    // Une feature découpée attend le merge de son parent : elle ne réserve même pas ses modules.
    const queued: RunRow[] = [];
    for (const run of store.listRuns({ state: ["queued"] })) {
      if (this.#live.has(run.id)) continue;
      const wait = this.#notDue(run, now);
      if (wait) held.set(run.id, wait);
      else queued.push(run);
    }
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
      if (!repo) {
        for (const run of runs) {
          held.set(run.id, { cause: "unknown_repo", text: `dépôt ${name} absent de la configuration du serveur` });
        }
        continue;
      }
      // Le budget journalier de l'espace du dépôt atteint : aucun de ses runs ne part avant minuit UTC.
      const space = this.spaces.budgetHold(name, now);
      if (space) {
        const text = `budget journalier de l'espace « ${space.space} » atteint : ${space.spent.toFixed(2)} $ / ${space.ceiling.toFixed(2)} $ — reprise à minuit UTC ou budget relevé`;
        for (const run of runs) held.set(run.id, { cause: "space_budget", text });
        continue;
      }
      // Un run qui a déjà un worktree a déjà été admis par le planificateur : il repasse devant.
      const resumed = runs.filter((run) => run.worktree !== null);
      const fresh = runs.filter((run) => run.worktree === null);
      // Un run garé chez l'humain (`awaiting_human`) ne tient plus ses modules : il peut y rester des heures, et la
      // file entière l'attendrait pour rien. À sa reprise, la revue et le merge rebasent sur main (conflits compris).
      const others = active.filter((run) => run.repo === name && run.state !== "awaiting_human");
      const free = new Set(
        schedulable(
          fresh.map((run) => ({ id: run.id, modules: run.modules })),
          [...others, ...resumed].map((run) => ({ id: run.id, modules: run.modules })),
        ),
      );
      // Qui tient les modules d'un run retenu : les runs actifs, puis ceux de la file passés avant lui (l'ordre du plan).
      const taken = [...others, ...resumed];
      for (const run of fresh) {
        if (!free.has(run.id)) {
          held.set(run.id, {
            cause: "modules",
            text: `ses modules (${run.modules.join(", ") || "tout le dépôt"}) recoupent ceux d'un run de ${name} en cours ou passé avant lui`,
            blockedBy: taken
              .filter((other) => overlaps(run.modules, other.modules))
              .slice(0, MAX_BLOCKERS)
              .map(blockerOf),
          });
        }
        taken.push(run);
      }
      const running = activeByRepo.get(name) ?? 0;
      let room = repo.maxParallel === null ? Number.POSITIVE_INFINITY : repo.maxParallel - running;
      for (const run of [...resumed, ...fresh.filter((run) => free.has(run.id))]) {
        if (room <= 0) {
          held.set(run.id, {
            cause: "repo_cap",
            text: `plafond du dépôt ${name} atteint : ${running} run(s) en cours, maxParallel ${repo.maxParallel}`,
          });
          continue;
        }
        candidates.push({ run, resumed: run.worktree !== null, group: groupOf(run) });
        room--;
      }
    }
    return { candidates, held, activeByRepo, activeByGroup };
  }

  /** L'admission équitable : un candidat à la fois, au meilleur rang, tant qu'un slot runner se libère. */
  #admit(): void {
    const { candidates, held, activeByRepo, activeByGroup } = this.#candidates();
    const waits = new Map(held);
    const rank = (c: Candidate): number[] => [
      -c.run.priority,
      c.resumed ? 0 : 1,
      activeByRepo.get(c.run.repo) ?? 0,
      activeByGroup.get(c.group) ?? 0,
      c.run.createdAt,
    ];
    // La pause globale : personne ne part, rien n'est annulé — chacun sait qui a suspendu.
    const hold = this.#pauseHold();
    if (hold !== null) {
      for (const candidate of candidates) waits.set(candidate.run.id, { cause: "paused", text: hold });
      this.#settleWaits(waits);
      return;
    }
    // Le plafond journalier du serveur atteint : personne ne part, chacun sait pourquoi.
    const daily = candidates.length > 0 ? this.#ctx.monitor.dailyBudgetDue() : null;
    if (daily) {
      const text = `plafond journalier atteint : ${daily.spent.toFixed(2)} $ / ${daily.ceiling.toFixed(2)} $ — reprise à ${new Date(daily.resetsAt).toISOString()}`;
      for (const candidate of candidates) waits.set(candidate.run.id, { cause: "daily_budget", text });
      this.#settleWaits(waits);
      return;
    }
    while (candidates.length > 0) {
      candidates.sort((a, b) => compareRanks(rank(a), rank(b)));
      const next = candidates.shift() as Candidate;
      const slot = this.#ctx.scheduler.tryAcquire("runner", next.run.id);
      if ("refused" in slot) {
        // Le premier de la file est refusé : ceux qui le suivent attendent la même chose.
        for (const run of [next.run, ...candidates.map((c) => c.run)]) {
          waits.set(run.id, { cause: slot.refused, text: slot.detail });
        }
        break;
      }
      activeByRepo.set(next.run.repo, (activeByRepo.get(next.run.repo) ?? 0) + 1);
      activeByGroup.set(next.group, (activeByGroup.get(next.group) ?? 0) + 1);
      this.#launch(next.run.id, slot);
    }
    this.#settleWaits(waits);
  }

  /**
   * Garde ce qui retient chaque run en file (le texte suit les chiffres à chaque tour) ;
   * `admission_refused` n'est journalisé que lorsqu'un run DÛ change de cause (un run qui attend
   * son parent, son heure ou ses modules n'a rien demandé). Un run qui n'attend plus (admis,
   * annulé) oublie la sienne.
   */
  #settleWaits(waits: Map<string, QueueWait>): void {
    let waiting = 0;
    for (const wait of waits.values()) if (!NOT_DUE.includes(wait.cause)) waiting += 1;
    for (const [id, wait] of waits) {
      if (!NOT_DUE.includes(wait.cause) && this.#waits.get(id)?.cause !== wait.cause) {
        this.#ctx.event("admission_refused", id, { reason: wait.cause, detail: wait.text, waiting });
      }
    }
    this.#waits.clear();
    for (const [id, wait] of waits) this.#waits.set(id, wait);
  }

  /** Un run tel que l'API le rend : en file et retenu, sa raison dit ce qui le retient, par qui et jusqu'à quand. */
  withWait(run: RunRow): RunWithWait {
    const wait = run.state === "queued" ? this.#waits.get(run.id) : undefined;
    if (!wait) return run;
    return {
      ...run,
      reason: wait.text,
      waitCause: wait.cause,
      ...(wait.blockedBy ? { blockedBy: wait.blockedBy } : {}),
      ...(wait.until !== undefined ? { waitUntil: wait.until } : {}),
    };
  }

  /** Les runs DUS retenus en file, par cause, et la cause dominante (la plus fréquente) : la file de `/v1/status`. */
  queueWaits(repos: RepoFilter = null): { held: number; byCause: Record<string, number>; dominant: QueueWait | null } {
    const byCause: Record<string, number> = {};
    const first = new Map<string, QueueWait>();
    let held = 0;
    for (const [id, wait] of this.#waits) {
      const run = this.store.getRun(id);
      if (NOT_DUE.includes(wait.cause) || !run || (repos !== null && !repos.includes(run.repo))) continue;
      held += 1;
      byCause[wait.cause] = (byCause[wait.cause] ?? 0) + 1;
      if (!first.has(wait.cause)) first.set(wait.cause, wait);
    }
    const top = Object.entries(byCause).sort((a, b) => b[1] - a[1])[0]?.[0];
    return { held, byCause, dominant: top === undefined ? null : (first.get(top) ?? null) };
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
        // La pause globale : comme au plafond journalier, la feature rend son slot avant l'étape et retourne en file.
        if (this.#pause.paused) {
          this.#ctx.transition(
            run,
            heldForPause({ step: run.step, fixes: run.fixes, attempts: run.attempts }, this.#pause.by ?? PAUSE_SERVICE),
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
      if (this.#pauseStops.delete(live.runId)) this.#parkForPause(live.runId);
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
    const repo = this.#ctx.repo(input.repo);
    if (input.title.trim() === "" || input.request.trim() === "")
      throw new HarnessError(400, "title et request sont requis");
    const req = input.req?.trim() ?? "";
    // Le curseur d'autonomie : celui qu'on demande, sinon celui du run dont on descend, sinon celui de l'espace.
    const fallback = input.inheritAutonomy === undefined ? this.spaces.autonomyOf(input.repo) : input.inheritAutonomy;
    const autonomy = input.autonomy === undefined ? fallback : input.autonomy;
    if (actor.pilot && raisesAutonomy(fallback, autonomy))
      throw new HarnessError(403, "geste réservé à l'humain — un pilote ne monte pas l'autonomie d'un run");
    const specs = req === "" && autonomy !== "ask" ? this.#directSpecs(input) : null;
    if (req !== "" && !/^##\s+Besoins/m.test(req)) throw new HarnessError(400, "req : la section `## Besoins` manque");
    const priority = input.priority ?? 0;
    if (!Number.isInteger(priority) || Math.abs(priority) > 1000)
      throw new HarnessError(400, "priority : entier entre -1000 et 1000");
    const budget = budgetUsd(input.budgetUsd);
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
        ...(input.kind !== undefined ? { kind: input.kind } : {}),
        ...(input.labels !== undefined ? { labels: input.labels } : {}),
        autonomy,
        ...(req !== "" ? { step: "specs" as const } : specs !== null ? { step: "impl" as const } : {}),
        ...(input.projectId ? { projectId: input.projectId, projectOrder: input.projectOrder ?? 0 } : {}),
        ...(input.afterRun ? { afterRun: input.afterRun.id, reason: waitReason(input.afterRun) } : {}),
      });
      if (req !== "") store.putArtifact(created.id, "req.md", `${req}\n`, null);
      if (budget !== undefined) this.#ctx.monitor.setRunBudget(created.id, budget, actor.by);
      // Voie directe : les specs synthétisées sont aussi les specs gelées sur lesquelles la revue juge.
      if (specs !== null) {
        store.putArtifact(created.id, "specs.md", specs, null);
        store.putArtifact(created.id, SPECS_BASELINE, specs, null);
      }
      this.#ctx.event("run_created", created.id, {
        repo: created.repo,
        slug: created.slug,
        title: created.title,
        modules: created.modules,
        projectId: created.projectId,
        priority,
        ...(created.autonomy !== null ? { autonomy: created.autonomy } : {}),
        ...(budget !== undefined ? { budgetUsd: budget } : {}),
        lane: specs !== null ? "direct" : "full",
        ...(input.afterRun ? { afterRun: input.afterRun.id } : {}),
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

  /**
   * Le specs.md de la voie directe (`directSpecs`), ou `null` : voie complète. Une demande
   * à critères passe quand même par /req si le client le demande (`lane: "full"`), si
   * `lanes.direct` est coupé, ou si la porte des specs l'aurait arrêtée : toujours
   * (`specsGate: true`), ou en `"auto"` sur l'irréversible et la première feature d'un
   * projet. Les modules vides ne comptent pas : l'oracle les déduit comme pour tout run créé sans.
   */
  #directSpecs(input: NewRunInput & { projectId?: string; projectOrder?: number }): string | null {
    const { config } = this.#ctx;
    if (input.lane === "full" || !config.lanes.direct || config.review.specsGate === true) return null;
    const specs = directSpecs(input.title, input.request);
    if (specs === null || config.review.specsGate === false) return specs;
    const firstOfProject = Boolean(input.projectId) && (input.projectOrder ?? 0) === 0;
    return detectIrreversible(specs) !== null || firstOfProject ? null : specs;
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
      this.#ctx.log(`run ${run.id} : modules non déduits — ${err instanceof Error ? err.message : String(err)}`, {
        level: "warn",
        runId: run.id,
        repo: run.repo,
      });
    } finally {
      this.#inferring.delete(run.id);
      this.#kick();
    }
  }

  /** /project : les modules de chaque feature (déclarés, sinon via l'oracle), puis une file planifiée. */
  async createProject(input: NewProjectInput, actor: Actor = SERVICE): Promise<{ projectId: string; runs: RunRow[] }> {
    const { oracle, git } = this.#ctx;
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
    return this.#openProject(
      { ...input, features: input.features.map((feature, order) => ({ ...feature, modules: modules[order] ?? [] })) },
      actor,
      // Déjà demandés à l'oracle ci-dessus : une liste vide le reste.
      { inferModules: false },
    );
  }

  /**
   * Le projet et ses runs, nés ensemble : un client ne voit jamais un projet à moitié créé.
   * `inferModules` : les features sans modules les demandent à l'oracle après coup (un
   * découpage, qui naît dans la transaction d'une transition, ne l'attend pas) ;
   * `afterRun` : le parent dont chaque feature attend le merge.
   */
  #openProject(
    input: NewProjectInput,
    actor: Actor,
    options: { inferModules?: boolean; afterRun?: RunRow },
  ): { projectId: string; runs: RunRow[] } {
    const { store } = this.#ctx;
    const repo = this.#ctx.repo(input.repo);
    // Une feature découpée hérite du curseur de son parent ; sinon celui du projet, s'il en donne un.
    const inherit: { inheritAutonomy?: RunAutonomy | null; autonomy?: RunAutonomy | null } = options.afterRun
      ? { inheritAutonomy: options.afterRun.autonomy }
      : input.autonomy !== undefined
        ? { autonomy: input.autonomy }
        : {};
    return store.transaction(() => {
      const project = store.createProject({ id: newId("p"), repo: repo.name, title: input.title });
      const runs = input.features.map((feature, order) =>
        this.createRun(
          {
            ...feature,
            repo: repo.name,
            modules: feature.modules ?? [],
            projectId: project.id,
            projectOrder: order,
            ...(options.inferModules === false ? { inferModules: false } : {}),
            ...(options.afterRun ? { afterRun: options.afterRun } : {}),
            ...inherit,
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
          ...(options.afterRun ? { afterRun: options.afterRun.id } : {}),
          ...(actor.by ? { by: actor.by } : {}),
        },
        repo.name,
      );
      return { projectId: project.id, runs };
    });
  }

  /** Un run de suite hérite du curseur du run dont il descend : ce n'est pas l'acteur (un pilote compris) qui le monte. */
  #followUp({ autonomy, ...input }: NewRunInput, actor: Actor): RunRow {
    return this.createRun({ ...input, ...(autonomy !== undefined ? { inheritAutonomy: autonomy } : {}) }, actor);
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
   * Le curseur d'autonomie d'un run. Passé à « livre et préviens-moi » pendant qu'il attend l'humain,
   * l'attente est réévaluée tout de suite : levable, le prochain tour la valide.
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
    return this.#pause;
  }

  /**
   * Ce qui retient tout pendant la pause globale (« en pause : suspendu par … »), ou `null` hors pause.
   * Une pause levée pendant que son arrêt immédiat s'achève retient encore, le temps qu'il finisse.
   */
  #pauseHold(): string | null {
    const { paused, by, reason } = this.#pause;
    if (!paused) return this.#suspending === null ? null : "reprise : l'arrêt immédiat de la pause s'achève";
    return `${PAUSE_REASON} ${by ?? PAUSE_SERVICE}${reason === null ? "" : ` — ${reason}`}`;
  }

  /**
   * « Tout suspendre », ou reprendre. En pause, plus aucun run n'est admis, chaque run vivant retourne
   * en file avant sa prochaine étape (rien n'est annulé), et ni audit, ni rêve, ni planification, ni
   * Demande, ni job du poste ne démarre ; `paused: false` relance le tour. `now` : ce qui tourne est
   * interrompu sur-le-champ (`#suspendNow`) au lieu de finir son étape — une pause déjà posée sans lui
   * peut le recevoir ensuite. Le réglage est écrit (`settings`, clé `pause`) : il survit à un redémarrage.
   * Réservé au propriétaire : un client borné à des dépôts ou un pilote est refusé (403). Redire l'état
   * courant ne change rien.
   */
  setPause(paused: boolean, reason: string, actor: Actor = SERVICE, repos: RepoFilter = null, now = false): PauseState {
    if (repos !== null) throw new HarnessError(403, "la pause de tout le serveur est réservée au propriétaire");
    if (actor.pilot)
      throw new HarnessError(403, "geste réservé à l'humain — un pilote ne suspend ni ne relance l'usine");
    const current = this.#pause;
    const hardened = paused && current.paused && now && !current.now;
    if (paused === current.paused && !hardened) return current;
    // Une pause durcie (`now` après coup) garde son instant, et sa raison si aucune autre n'est donnée.
    const next: PauseState = {
      paused,
      by: actor.by,
      at: hardened ? current.at : Date.now(),
      reason: !paused ? null : reason !== "" ? reason : hardened ? current.reason : null,
      now: paused && now,
    };
    const { store } = this.#ctx;
    store.transaction(() => {
      store.setSetting(PAUSE_KEY, next, actor.by);
      this.#ctx.event("pause", null, { paused, by: actor.by, reason: next.reason, now: next.now }, null);
    });
    this.#pause = next;
    this.#ctx.log(
      paused
        ? `pause globale ${next.now ? "immédiate " : ""}posée${actor.by ? ` par ${actor.by}` : ""}${next.reason === null ? "" : ` : ${next.reason}`}`
        : `pause globale levée${actor.by ? ` par ${actor.by}` : ""}`,
    );
    if (next.now) {
      const suspending = (this.#suspending ?? Promise.resolve())
        .then(() => this.#suspendNow())
        .catch((err: unknown) =>
          this.#ctx.log(`pause immédiate : ${err instanceof Error ? err.message : String(err)}`, {
            level: "error",
            err,
          }),
        )
        .finally(() => {
          if (this.#suspending === suspending) this.#suspending = null;
          this.#kick();
        });
      this.#suspending = suspending;
    }
    this.#kick();
    return next;
  }

  /**
   * L'arrêt immédiat d'une pause (`now`). Chaque run vivant est interrompu comme par une annulation
   * (étape abandonnée, runner arrêté) mais retourne en file à la même étape (`#parkForPause`). Les
   * audits et les Demandes en cours sont arrêtés et repartent de zéro à la reprise, par le chemin d'un
   * redémarrage (ils n'ont encore rien écrit) ; le pilote rend la main sans rien inscrire. Les rêves et
   * les jobs du poste finissent : rien ne sait les reprendre (le poste a son propre arrêt d'urgence).
   */
  async #suspendNow(): Promise<void> {
    const runs = [...this.#live.keys()];
    for (const id of runs) this.#pauseStops.add(id);
    await Promise.allSettled(runs.map((id) => this.#halt(id)));
    await this.audits.stop();
    await this.audits.recover();
    await this.intake.stop();
    await this.intake.recover();
    await this.pilot.stop();
  }

  /**
   * Un run qu'une pause immédiate vient d'interrompre : s'il est encore `running`, il retourne en file
   * à la même étape, tentatives et dernière cause d'échec intactes, sans délai de relance. Son worktree
   * et ses checkpoints restent ; l'étape relancée à la reprise apprend d'où repartir.
   */
  #parkForPause(runId: string): void {
    const { store } = this.#ctx;
    const run = store.getRun(runId);
    if (run?.state !== "running" || run.step === null) return;
    const cursor = { step: run.step, fixes: run.fixes, attempts: run.attempts };
    store.transaction(() => {
      if (this.#ctx.transition(run, heldForPause(cursor, this.#pause.by ?? PAUSE_SERVICE), ["running"]))
        store.addInstructions(
          runId,
          `Étape /${cursor.step} interrompue par la pause du serveur à ${new Date().toISOString()} ; le worktree garde le travail en cours : repars de \`git diff ${run.baseSha ?? "main"}\` — ne refais pas ce qui est fait.`,
        );
    });
  }

  // -- API : lectures -------------------------------------------------------

  /** Le run, s'il appartient à un dépôt que le lecteur voit (sinon 404 : on ne trahit pas son existence). */
  visibleRun(runId: string, repos: RepoFilter = null): RunRow {
    const run = this.#ctx.run(runId);
    if (repos !== null && !repos.includes(run.repo)) throw new HarnessError(404, `run inconnu : ${runId}`);
    return run;
  }

  /** La vue complète d'un run : étapes, décisions, escalades, tests, artefacts ; en file, ce qui le retient. */
  runView(runId: string, repos: RepoFilter = null): Record<string, unknown> {
    const view = runView(
      this.store,
      this.withWait(this.visibleRun(runId, repos)),
      this.#live.has(runId),
      this.config.review.escalationTimeoutSec,
    );
    return {
      ...view,
      run: this.withBriefing(view.run as RunRow),
      usage: this.store.runUsage(runId),
      budget: this.#ctx.monitor.budget(runId),
      alerts: this.#ctx.monitor.alertsOf(runId),
    };
  }

  /** Un run tel que l'API le rend, avec la carte en tête de ce qu'il attend (`briefing`, vide s'il n'attend ni specs ni arbitrage). */
  withBriefing<T extends RunRow>(run: T): T & { briefing: Briefing } {
    return { ...run, briefing: this.#briefings.read(run) };
  }

  /** La boîte de l'humain : `inboxOf` (filtrée par dépôts), les alertes et les coûts des runs listés. */
  inboxView(repos: RepoFilter = null): Record<string, unknown> {
    const inbox = inboxOf(this.store, repos, this.config.review.escalationTimeoutSec);
    const runs = (inbox.runs as RunRow[]).map((run) => this.withBriefing(this.withWait(run)));
    const awaiting = (inbox.awaiting as RunRow[]).map((run) => this.withBriefing(run));
    const batches = (inbox.batches as { run: RunRow | null; items: unknown[] }[]).map((batch) => ({
      ...batch,
      run: batch.run === null ? null : this.withBriefing(this.withWait(batch.run)),
    }));
    return {
      ...inbox,
      runs,
      awaiting,
      batches,
      alerts: this.#ctx.monitor.alerts(repos),
      costs: this.store.runCosts(runs.map((run) => run.id)),
    };
  }

  /** Ce qui retient ce run en file (cause et texte), ou `null` : ce que lisent le brief et l'état de l'usine. */
  #heldBy(run: RunRow): HeldBy | null {
    const wait = run.state === "queued" ? this.#waits.get(run.id) : undefined;
    return wait ? { cause: wait.cause, text: wait.text } : null;
  }

  /**
   * Le brief « pendant votre absence » de `client` sur les dépôts qu'il voit : depuis `since`, sinon
   * depuis la dernière fois qu'il l'a vu (`POST /v1/brief/seen`), sinon sur 24 heures.
   */
  briefView(client: string, since: number | null, repos: RepoFilter = null, now = Date.now()): Brief {
    const seenAt = this.store.getSetting<number>(briefSeenKey(client));
    return briefOf(this.store, {
      since: since ?? seenAt ?? now - BRIEF_WINDOW_MS,
      until: now,
      seenAt,
      repos,
      heldBy: (run) => this.#heldBy(run),
      proposals: this.proposals.count(repos),
    });
  }

  /** Le client a vu le brief : le prochain part de cet instant. */
  briefSeen(client: string, now = Date.now()): number {
    this.store.setSetting(briefSeenKey(client), now, client);
    return now;
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

  /** Le graphe de session d'un run : ce que l'agent a lu, cherché, testé, modifié et décidé. */
  graphView(runId: string, repos: RepoFilter = null): SessionGraphView {
    return this.#ctx.graphs.view(this.visibleRun(runId, repos).id);
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

  /** Les preuves d'un run (le dossier d'un dépôt invisible n'est jamais lu : 404 avant). */
  proofsView(runId: string, repos: RepoFilter = null): { runId: string; proofs: Proof[] } {
    const run = this.visibleRun(runId, repos);
    return { runId: run.id, proofs: this.#ctx.proofs.list(run.id) };
  }

  /** Le contenu d'une preuve par son rang. */
  proofContent(runId: string, n: number, repos: RepoFilter = null): { proof: Proof; data: Buffer } {
    return this.#ctx.proofs.read(this.visibleRun(runId, repos).id, n);
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
      // La pause globale (« Tout suspendre ») : rien n'est admis tant qu'elle tient (`GET /v1/pause` dit par qui).
      paused: this.#pause.paused,
      // La file : combien de runs dus sont retenus, par cause, et ce qui retient le plus.
      queue: this.queueWaits(repos),
      repos: this.#ctx.config.repos
        .filter((repo) => repos === null || repos.includes(repo.name))
        .map((repo) => ({ name: repo.name, scope: repo.scope, maxParallel: repo.maxParallel })),
    };
  }

  /** L'état de la mémoire du projet : configurée, joignable, et les écritures perdues depuis le démarrage. */
  async oracleStatus(): Promise<{ configured: boolean; ok: boolean; lostWrites: LostWrites }> {
    const lostWrites = this.#ctx.oracle.lostWrites();
    if (!this.#ctx.config.oracle) return { configured: false, ok: false, lostWrites };
    return { configured: true, ok: await this.#ctx.oracle.health(), lostWrites };
  }
}

/** Le groupe d'équité d'un run : son projet, sinon lui-même. */
function groupOf(run: RunRow): string {
  return run.projectId ?? `run:${run.id}`;
}

/** Un run tel que `blockedBy` le nomme. */
function blockerOf(run: RunRow): QueueBlocker {
  return { runId: run.id, title: run.title, state: run.state, modules: run.modules };
}

/** La pause lue dans les réglages : absente ou illisible, le serveur n'est pas en pause. */
function pauseOf(stored: unknown): PauseState {
  const off: PauseState = { paused: false, by: null, at: null, reason: null, now: false };
  if (typeof stored !== "object" || stored === null) return off;
  const { paused, by, at, reason, now } = stored as Record<string, unknown>;
  if (typeof paused !== "boolean") return off;
  return {
    paused,
    by: typeof by === "string" ? by : null,
    at: typeof at === "number" ? at : null,
    reason: typeof reason === "string" ? reason : null,
    now: paused && now === true,
  };
}

function compareRanks(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) {
    const diff = (a[i] as number) - (b[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}
