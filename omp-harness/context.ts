// Le contexte partagé des pièces du service : dépendances, journal et transitions.
//
// Chaque pièce (conduite des étapes, outils hôtes, merge, boucle humaine, audits)
// reçoit ce contexte au lieu d'un sac de dépendances. Il porte les deux gestes qui
// doivent être faits partout de la même façon :
// - `event` : un événement au journal (ou poussé en direct s'il est éphémère) ;
// - `transition` : un changement d'état validé par la table de `machine.ts`, écrit
//   par compare-and-swap, ses événements dans la MÊME transaction SQLite.
import { Baseline } from "./baseline.ts";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { repoByName } from "./config.ts";
import type { RunPatch, RunRow, Store } from "./db.ts";
import { HarnessError } from "./errors.ts";
import type { EventType } from "./events.ts";
import { EPHEMERAL_EVENTS } from "./events.ts";
import { remoteEnv, type Git } from "./git.ts";
import type { HeavyRunner } from "./heavy.ts";
import type { RunState, Transition } from "./machine.ts";
import type { LogLine } from "./logger.ts";
import { assertTransition, isTerminal, splitAbandoned, splitReleased } from "./machine.ts";
import { Notifier } from "./notify.ts";
import { Observability } from "./observability.ts";
import type { Oracle } from "./oracle.ts";
import type { Exec } from "./proc.ts";
import { OAuthLogins } from "./oauth.ts";
import { ProviderRegistry } from "./providers.ts";
import type { RunnerProcess } from "./rpc.ts";
import { writePipelineOverlay } from "./runner.ts";
import type { Scheduler } from "./scheduler.ts";
import type { ChannelFetch } from "./canaux/channels.ts";
import { Monitor } from "./monitor.ts";
import { SessionFeeds } from "./session-feed.ts";
import { SessionGraphs } from "./session-graph.ts";
import { ActivityPusher, ApnsClient } from "./push.ts";
import { AlertPusher } from "./push-alerts.ts";
import { ProofStore, currentRound } from "./proofs.ts";
import { TestFeeds } from "./test-feed.ts";
import type { Lookup } from "./browser/guard.ts";
import type { VpsOptions } from "./browser/vps.ts";

export type SpawnRunner = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
) => RunnerProcess;

export type HarnessDeps = {
  config: HarnessConfig;
  store: Store;
  scheduler: Scheduler;
  git: Git;
  heavy: HeavyRunner;
  oracle: Oracle;
  spawn: SpawnRunner;
  exec: Exec;
  /** Le journal structuré (logger.ts) ; absent : rien n'est journalisé. */
  log?: LogLine;
  /** Le `fetch` des canaux corpo (canaux/) ; absent : celui de la plateforme. Les tests y branchent des doublures. */
  fetch?: ChannelFetch;
  tickMs?: number;
  /** Tests seulement : la résolution DNS du pré-contrôle des outils `browser_*` (browser/guard.ts). */
  browserLookup?: Lookup;
  /** Tests seulement : les réglages de l'exécuteur du VPS (délais courts, adresses de vérification, DNS). */
  vps?: Partial<Pick<VpsOptions, "lookup" | "probeUrls" | "pollSec" | "retryMs" | "importTtlMs" | "probeEveryMs">>;
};

/**
 * Qui fait un geste : le nom du client authentifié (`null` : le service lui-même ou
 * un appel interne), et la révision du run qu'il a lue (`If-Match`) s'il en donne une.
 * `pilot` : le geste vient du pilote d'un audit (pilot.ts), pas d'un humain — ses
 * refus ne deviennent pas des corrections humaines dans l'oracle.
 */
export type Actor = { by: string | null; rev?: number; pilot?: boolean };

export const SERVICE: Actor = { by: null };

export class HarnessContext {
  readonly config: HarnessConfig;
  readonly store: Store;
  readonly scheduler: Scheduler;
  readonly git: Git;
  readonly heavy: HeavyRunner;
  /** Le rouge de base : ce que la suite complète de main échoue déjà (un échec connu ne bloque pas). */
  readonly baseline: Baseline;
  readonly proofs: ProofStore;
  readonly oracle: Oracle;
  readonly spawn: SpawnRunner;
  readonly exec: Exec;
  /** Le journal : une chaîne, et son niveau, son run et son dépôt quand ils sont connus. */
  readonly log: LogLine;
  /** Les fournisseurs et chaînes de modèles déclarés par l'API (admin). */
  readonly providers: ProviderRegistry;
  /** Les connexions OAuth des fournisseurs, menées depuis les apps (admin). */
  readonly logins: OAuthLogins;
  /** Les notifications sortantes (ntfy), abonnées au journal : chaque pièce n'a rien à faire pour notifier. */
  readonly notifier: Notifier;
  /** Le direct des sessions de runners : poussé en événements éphémères `session`, gardé en tampon borné. */
  readonly sessions: SessionFeeds;
  /** Le graphe de session des runs : écrit dans `_session-graph.json`, poussé en événement éphémère `graph`. */
  readonly graphs: SessionGraphs;
  /** La veille : coût et budget des features, alertes (agent muet, étape lente, boucle de corrections). */
  readonly monitor: Monitor;
  /** La sortie en direct des jobs de tests (événements éphémères `test_output`, derniers jobs en mémoire). */
  readonly tests: TestFeeds;
  /** Les Live Activities de l'app iOS, mises à jour par APNs (`config.apns`). */
  readonly push: ActivityPusher;
  /** Erreurs des clients, état des sauvegardes, santé de la mémoire, compteurs HTTP (`GET /metrics`). */
  readonly observability: Observability;
  /** Les alertes push des appareils enregistrés (APNs, même clé que les Live Activities). */
  readonly alerts: AlertPusher;
  #overlay: string | null = null;

  constructor(deps: HarnessDeps) {
    this.config = deps.config;
    this.store = deps.store;
    this.scheduler = deps.scheduler;
    this.git = deps.git;
    this.heavy = deps.heavy;
    this.proofs = new ProofStore(deps.config.dataDir);
    this.oracle = deps.oracle;
    this.spawn = deps.spawn;
    this.exec = deps.exec;
    this.log = deps.log ?? (() => {});
    this.providers = new ProviderRegistry({
      config: this.config,
      store: this.store,
      scheduler: this.scheduler,
      log: this.log,
    });
    this.logins = new OAuthLogins({
      config: this.config,
      spawn: this.spawn,
      exec: this.exec,
      providers: this.providers,
      log: this.log,
    });
    this.notifier = new Notifier({ config: this.config, store: this.store, log: this.log });
    this.notifier.subscribe();
    this.sessions = new SessionFeeds({
      store: this.store,
      // Le direct d'un run porte son id ; celui d'un audit (`audit:<id>`) porte l'audit et son
      // dépôt ; celui d'un job du poste (`workstation:<job>`) n'a pas de dépôt (propriétaire seul).
      publish: (owner, entry) => {
        if (owner.startsWith("workstation:")) {
          this.event("session", null, { workstation: owner.slice("workstation:".length), entry }, null);
          return;
        }
        if (!owner.startsWith("audit:")) {
          this.event("session", owner, { entry });
          return;
        }
        const auditId = owner.slice("audit:".length);
        this.event("session", null, { auditId, entry }, this.store.getAudit(auditId)?.repo ?? null);
      },
      // Les clés que le service passe aux runners : masquées si l'agent les affiche.
      secrets: () => Object.values(this.providers.runnerEnv()),
      onUsage: (owner, step, usage) => this.monitor.recordUsage(owner, step, usage),
    });
    this.graphs = new SessionGraphs({
      store: this.store,
      publish: (runId, payload) => this.event("graph", runId, payload),
      secrets: () => Object.values(this.providers.runnerEnv()),
      log: this.log,
    });
    this.monitor = new Monitor({
      store: this.store,
      config: () => this.config,
      event: (type, runId, payload, repo) => this.event(type, runId, payload, repo ?? null),
      sessions: this.sessions,
    });
    this.tests = new TestFeeds({ publish: (runId, payload) => this.event("test_output", runId, payload) });
    this.heavy.attachOutput(this.tests);
    this.baseline = new Baseline({
      config: () => this.config,
      store: this.store,
      git: this.git,
      heavy: this.heavy,
      log: this.log,
      event: (runId, payload) => this.event("heavy_baseline", runId, payload),
    });
    const apns = new ApnsClient({ config: () => this.config.apns, log: this.log });
    this.push = new ActivityPusher({
      store: this.store,
      config: () => this.config.apns,
      apns,
      content: (run) => ({
        state: run.state,
        step: run.step,
        tool: this.sessions.activity(run.id)?.tool ?? null,
        alert: this.monitor.alertsOf(run.id)[0]?.kind ?? null,
        cost: Math.round(this.store.runCost(run.id) * 100) / 100,
        updatedAt: run.updatedAt,
      }),
      log: this.log,
    });
    this.push.subscribe();
    this.observability = new Observability(this);
    this.alerts = new AlertPusher({ store: this.store, apns, config: () => this.config.apns, log: this.log });
    this.alerts.subscribe();
  }

  /** L'overlay de réglages du profil pipeline, écrit une fois. */
  overlay(): string {
    this.#overlay ??= writePipelineOverlay(this.config.dataDir);
    return this.#overlay;
  }

  /** Un dépôt DÉCLARÉ par son nom (la configuration peut être rechargée : toujours relue). */
  repo(name: string): RepoConfig {
    const repo = repoByName(this.config, name);
    if (!repo) throw new HarnessError(404, `dépôt inconnu : ${name}`);
    return repo;
  }

  run(runId: string): RunRow {
    const run = this.store.getRun(runId);
    if (!run) throw new HarnessError(404, `run inconnu : ${runId}`);
    return run;
  }

  /** Un événement : journalisé, ou poussé en direct s'il est éphémère. */
  event(
    type: EventType,
    runId: string | null,
    payload: Record<string, unknown> = {},
    repo: string | null = null,
  ): void {
    if (EPHEMERAL_EVENTS.has(type)) this.store.publish(type, runId, payload, repo);
    else this.store.appendEvent(type, runId, payload, repo);
  }

  /**
   * Applique une transition SI le run est encore dans un des états `expected` (et, si
   * l'acteur en donne une, à la révision qu'il a lue) ; sinon `null`. La table de
   * `machine.ts` est vérifiée d'abord : une transition hors table est un bug, elle lève.
   * `quiet` : l'autonomie va valider cette attente (autonomy-gates.ts) — `specs_ready` et
   * `verdict` ne partent pas (elle les publie elle-même si elle y renonce).
   */
  transition(
    run: RunRow,
    transition: Transition,
    expected: readonly RunState[],
    options: { patch?: RunPatch; actor?: Actor; quiet?: boolean } = {},
  ): RunRow | null {
    assertTransition(expected, transition.state);
    const { store } = this;
    const by = options.actor?.by ?? null;
    const updated = store.transaction(() => {
      const next = store.updateRunIf(
        run.id,
        expected,
        {
          state: transition.state,
          step: transition.step,
          fixes: transition.fixes,
          attempts: transition.attempts,
          reason: transition.reason,
          notBefore: transition.notBefore,
          ...options.patch,
        },
        options.actor?.rev,
      );
      if (!next) return null;
      this.event("run_state", run.id, {
        state: transition.state,
        step: transition.step,
        reason: transition.reason,
        ...(by ? { by } : {}),
      });
      if (transition.state === "escalated") {
        const items = store.listEscalations({ runId: run.id, status: "open" });
        this.event("escalations", run.id, {
          step: run.step,
          items: items.map((item) => ({
            id: item.id,
            category: item.category,
            question: item.question,
            options: item.options,
            stake: item.card?.stake ?? null,
          })),
        });
      }
      if (transition.state === "awaiting_human" && options.quiet !== true) {
        if (transition.step === "specs") this.event("specs_ready", run.id, { reason: transition.reason });
        else
          this.event("verdict", run.id, {
            verdict: next.verdict,
            reason: transition.reason,
            // Seules les preuves du tour de revue courant comptent : celles d'avant la dernière correction restent listées.
            proofs: currentRound(this.proofs.list(run.id), this.store.listSteps(run.id)).length,
          });
      }
      if (transition.state === "failed")
        this.event("run_failed", run.id, {
          step: transition.step,
          reason: transition.reason,
          cause: next.lastFailCause,
        });
      if (isTerminal(transition.state) && run.projectId) this.#closeProjectIfDone(run.projectId, run.repo);
      if (isTerminal(transition.state)) this.#settleSplit(next);
      return next;
    });
    if (!updated)
      this.log(`run ${run.id} : transition vers ${transition.state} écartée (état changé entre-temps)`, {
        runId: run.id,
        repo: run.repo,
      });
    return updated;
  }

  /**
   * Les features découpées qui attendent le merge de ce run (`afterRun`) : mergé, elles
   * quittent l'attente ; annulé ou en échec, elles sont annulées avec lui — elles
   * dépendaient de son code. Elles n'ont jamais démarré : la file seulement.
   */
  #settleSplit(parent: RunRow): void {
    const fate = parent.state === "cancelled" ? "a été annulé" : "a échoué";
    for (const child of this.store.listRuns({ afterRun: parent.id, state: ["queued"] })) {
      const settled =
        parent.state === "merged"
          ? splitReleased(child, parent.title)
          : splitAbandoned(child, `annulée : « ${parent.title} », dont elle attendait le merge, ${fate}`);
      this.transition(child, settled, ["queued"]);
    }
  }

  /** Le projet est clos quand plus aucun de ses runs n'est vivant : `project_done` compte ce qui a mergé. */
  #closeProjectIfDone(projectId: string, repo: string): void {
    const runs = this.store.listRuns({ projectId });
    if (runs.some((other) => !isTerminal(other.state))) return;
    const project = this.store.getProject(projectId);
    if (!project || project.status === "done") return;
    this.store.setProjectStatus(projectId, "done");
    const merged = runs.filter((other) => other.state === "merged").length;
    this.event(
      "project_done",
      null,
      { projectId, title: project.title, merged, notMerged: runs.length - merged },
      repo,
    );
  }

  /** `main` local avancé depuis le remote (fast-forward seulement ; une divergence est journalisée). */
  async fetchMain(repo: RepoConfig): Promise<void> {
    if (!repo.remote) return;
    const result = await this.git.raw(
      repo.path,
      ["fetch", "-q", repo.remote, `refs/heads/${repo.mainBranch}:refs/heads/${repo.mainBranch}`],
      remoteEnv(repo),
    );
    if (result.code !== 0)
      this.log(`fetch ${repo.name} : ${result.stderr.trim().slice(0, 200)}`, { level: "warn", repo: repo.name });
  }

  /** Les checkpoints du run retrouvés par leur trailer après une réécriture (rebase). */
  async remapCheckpoints(runId: string, worktree: string, base: string): Promise<void> {
    const map = await this.git.checkpoints(worktree, base, runId);
    this.store.transaction(() => {
      for (const decision of this.store.listDecisions({ runId })) {
        const sha = map.get(decision.seq);
        if (sha && sha !== decision.checkpointSha) this.store.setCheckpoint(decision.id, sha);
      }
    });
  }
}
