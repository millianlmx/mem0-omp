// Les vues de lecture que l'orchestrateur rend à l'API : un run, la boîte de l'humain, le brief d'absence, le direct
// d'une session, les preuves et l'état du serveur. Elles ne mutent rien.
import { configWarnings } from "../config/config.ts";
import type { HarnessContext } from "./context.ts";
import type { RepoFilter, RunRow } from "../db/db.ts";
import { HarnessError } from "../api/errors.ts";
import type { Briefing } from "../human/briefing.ts";
import { BRIEF_WINDOW_MS, briefOf, briefSeenKey } from "../reports/brief.ts";
import type { Brief, HeldBy } from "../reports/brief.ts";
import { changesOf, fileDiffOf, timelineOf } from "../api/inspect.ts";
import type { LostWrites } from "../memory/oracle.ts";
import type { Proof } from "../heavy/proofs.ts";
import { inboxOf, loadOf, runView } from "../api/queries.ts";
import { auditOwner } from "../sessions/session-feed.ts";
import type { SessionGraphView } from "../sessions/session-graph.ts";
import type { Slot } from "../runners/scheduler.ts";
import type { LiveRun } from "./steps.ts";
import type { Orchestrator } from "./orchestrator.ts";

type ViewsHost = Pick<
  Orchestrator,
  | "store"
  | "config"
  | "audits"
  | "proposals"
  | "spaces"
  | "visibleRun"
  | "withWait"
  | "withBriefing"
  | "humanWait"
  | "queueWaits"
>;

type ViewsHooks = {
  /** Les runs conduits en ce moment : lus ici, jamais écrits. */
  live: ReadonlyMap<string, LiveRun & { slot: Slot }>;
  /** La carte de ce qu'un run attend. */
  briefing: (run: RunRow) => Briefing;
  /** Ce qui retient ce run en file, ou `null`. */
  heldBy: (run: RunRow) => HeldBy | null;
  /** La pause globale tient-elle ? */
  paused: () => boolean;
};

export class RunViews {
  readonly #ctx: HarnessContext;
  readonly #host: ViewsHost;
  readonly #hooks: ViewsHooks;

  constructor(ctx: HarnessContext, host: ViewsHost, hooks: ViewsHooks) {
    this.#ctx = ctx;
    this.#host = host;
    this.#hooks = hooks;
  }

  /** Le run, s'il appartient à un dépôt que le lecteur voit (sinon 404 : on ne trahit pas son existence). */
  visibleRun(runId: string, repos: RepoFilter): RunRow {
    const run = this.#ctx.run(runId);
    if (repos !== null && !repos.includes(run.repo)) throw new HarnessError(404, `run inconnu : ${runId}`);
    return run;
  }

  /** La vue complète d'un run : étapes, décisions, escalades, tests, artefacts ; en file, ce qui le retient. */
  runView(runId: string, repos: RepoFilter): Record<string, unknown> {
    const view = runView(
      this.#host.store,
      this.#host.withWait(this.#host.visibleRun(runId, repos)),
      this.#hooks.live.has(runId),
      this.#host.config.review.escalationTimeoutSec,
    );
    return {
      ...view,
      run: this.#host.withBriefing(view.run as RunRow),
      usage: this.#host.store.runUsage(runId),
      budget: this.#ctx.monitor.budget(runId),
      alerts: this.#ctx.monitor.alertsOf(runId),
    };
  }

  /** Un run tel que l'API le rend, avec la carte en tête de ce qu'il attend (`briefing`, vide s'il n'attend ni specs ni arbitrage). */
  withBriefing<T extends RunRow>(run: T): T & { briefing: Briefing } {
    return { ...run, briefing: this.#hooks.briefing(run) };
  }

  /** La boîte de l'humain : `inboxOf` (filtrée par dépôts), les alertes et les coûts des runs listés. */
  inboxView(repos: RepoFilter): Record<string, unknown> {
    const inbox = inboxOf(this.#host.store, repos, this.#host.config.review.escalationTimeoutSec);
    const runs = (inbox.runs as RunRow[]).map((run) => this.#host.withBriefing(this.#host.withWait(run)));
    const awaiting = (inbox.awaiting as RunRow[]).map((run) => this.#host.withBriefing(this.#host.withWait(run)));
    const batches = (inbox.batches as { run: RunRow | null; items: unknown[] }[]).map((batch) => ({
      ...batch,
      run: batch.run === null ? null : this.#host.withBriefing(this.#host.withWait(batch.run)),
    }));
    return {
      ...inbox,
      runs,
      awaiting,
      batches,
      alerts: this.#ctx.monitor.alerts(repos),
      costs: this.#host.store.runCosts(runs.map((run) => run.id)),
    };
  }

  /**
   * Le brief « pendant votre absence » de `client` sur les dépôts qu'il voit : depuis `since`, sinon
   * depuis la dernière fois qu'il l'a vu (`POST /v1/brief/seen`), sinon sur 24 heures. `owner` : le
   * client voit tous les dépôts — sa lecture bornée à un espace (`?space=`) compte aussi ses propositions.
   */
  briefView(client: string, since: number | null, repos: RepoFilter, now: number, owner: boolean): Brief {
    const seenAt = this.#host.store.getSetting<number>(briefSeenKey(client));
    return briefOf(this.#host.store, {
      since: since ?? seenAt ?? now - BRIEF_WINDOW_MS,
      until: now,
      seenAt,
      repos,
      heldBy: (run) => this.#hooks.heldBy(run),
      humanWait: (run) => this.#host.humanWait(run),
      proposals: this.#host.proposals.count(repos, owner),
    });
  }

  /** Le client a vu le brief : le prochain part de cet instant. */
  briefSeen(client: string, now: number): number {
    this.#host.store.setSetting(briefSeenKey(client), now, client);
    return now;
  }

  /**
   * Le direct de la session d'un run : ses dernières entrées, s'il est conduit en ce
   * moment, et le curseur du journal d'où suivre la suite (`/v1/events?run=…&live=1&after=…`).
   */
  sessionView(
    runId: string,
    repos: RepoFilter,
    page: { before?: number | null; limit?: number },
  ): Record<string, unknown> {
    const run = this.#host.visibleRun(runId, repos);
    const { entries, more } = this.#ctx.sessions.page(run.id, page.before ?? null, page.limit);
    return {
      runId: run.id,
      auditId: null,
      live: this.#hooks.live.has(run.id),
      cursor: this.#host.store.lastEventId(),
      entries,
      more,
    };
  }

  /** Le graphe de session d'un run : ce que l'agent a lu, cherché, testé, modifié et décidé. */
  graphView(runId: string, repos: RepoFilter): SessionGraphView {
    return this.#ctx.graphs.view(this.#host.visibleRun(runId, repos).id);
  }

  /** Le direct de l'analyse d'un audit, sous la même forme (`auditId` au lieu de `runId`). */
  auditSessionView(auditId: string, page: { before?: number | null; limit?: number }): Record<string, unknown> {
    const { entries, more } = this.#ctx.sessions.page(auditOwner(auditId), page.before ?? null, page.limit);
    return {
      runId: null,
      auditId,
      live: this.#host.audits.isLive(auditId),
      cursor: this.#host.store.lastEventId(),
      entries,
      more,
    };
  }

  /**
   * Une entrée du direct d'un run et son détail : pour un outil, ses arguments complets
   * (`args`) et sa sortie entière (`output`, celle qui s'écrit s'il tourne encore) ;
   * pour un long paragraphe, son texte entier (`output`). 404 si l'entrée est inconnue.
   */
  sessionEntryView(runId: string, seq: number, repos: RepoFilter): Record<string, unknown> {
    const run = this.#host.visibleRun(runId, repos);
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
  timeline(runId: string, repos: RepoFilter): Record<string, unknown> {
    return timelineOf(this.#ctx, this.#host.visibleRun(runId, repos), this.#hooks.live.has(runId));
  }

  /** Les fichiers touchés par un run (worktree, sinon commit squash). */
  changes(runId: string, repos: RepoFilter): Promise<Record<string, unknown>> {
    return changesOf(this.#ctx, this.#host.visibleRun(runId, repos));
  }

  /** Les différences d'un fichier touché par un run. */
  fileDiff(runId: string, file: string, repos: RepoFilter): Promise<Record<string, unknown>> {
    return fileDiffOf(this.#ctx, this.#host.visibleRun(runId, repos), file);
  }

  /** La sortie des derniers jobs de tests d'un run, en cours compris. */
  liveTests(runId: string, repos: RepoFilter): Record<string, unknown> {
    const run = this.#host.visibleRun(runId, repos);
    return { runId: run.id, cursor: this.#host.store.lastEventId(), jobs: this.#ctx.tests.jobs(run.id) };
  }

  /** Les preuves d'un run (le dossier d'un dépôt invisible n'est jamais lu : 404 avant). */
  proofsView(runId: string, repos: RepoFilter): { runId: string; proofs: Proof[] } {
    const run = this.#host.visibleRun(runId, repos);
    return { runId: run.id, proofs: this.#ctx.proofs.list(run.id) };
  }

  /** Le contenu d'une preuve par son rang. */
  proofContent(runId: string, n: number, repos: RepoFilter): { proof: Proof; data: Buffer } {
    return this.#ctx.proofs.read(this.#host.visibleRun(runId, repos).id, n);
  }

  status(repos: RepoFilter): Record<string, unknown> {
    const load = loadOf(this.#host.store, repos, new Set(this.#hooks.live.keys()));
    // Un client borné ne voit que les libellés (ids de run ou d'audit) de ses dépôts ; les compteurs restent globaux.
    const visible = (label: string): boolean => {
      if (repos === null) return true;
      const id = label.split(":")[0] ?? "";
      const repo = this.#host.store.getRun(id)?.repo ?? this.#host.store.getAudit(id)?.repo ?? null;
      return repo !== null && repos.includes(repo);
    };
    const snapshot = this.#ctx.scheduler.snapshot();
    return {
      runs: load.runs,
      byRepo: load.byRepo,
      live: [...this.#hooks.live.keys()].filter(visible),
      scheduler: {
        ...snapshot,
        runner: { ...snapshot.runner, labels: snapshot.runner.labels.filter(visible) },
        heavy: { ...snapshot.heavy, labels: snapshot.heavy.labels.filter(visible) },
      },
      // La pause globale (« Tout suspendre ») : rien n'est admis tant qu'elle tient (`GET /v1/pause` dit par qui).
      paused: this.#hooks.paused(),
      // Ce qui, dans la configuration, mêle la mémoire de plusieurs dépôts (config.ts `configWarnings`) ;
      // un lecteur borné ne lit que les avertissements qui ne nomment que ses dépôts.
      warnings: configWarnings(this.#ctx.config)
        .filter((warning) => repos === null || warning.repos.every((repo) => repos.includes(repo)))
        .map((warning) => warning.text)
        // Les cibles de notification bornées à un espace inconnu, et les espaces dont la connexion Atlassian
        // partage son site avec une autre (isolation `shared_atlassian_site`) : au seul lecteur qui voit tout.
        .concat(
          repos === null ? [...this.#ctx.notifier.spaceWarnings(), ...this.#host.spaces.sharedSiteWarnings()] : [],
        ),
      // La file : combien de runs dus sont retenus, par cause, et ce qui retient le plus.
      queue: this.#host.queueWaits(repos),
      repos: this.#ctx.config.repos
        .filter((repo) => repos === null || repos.includes(repo.name))
        .map((repo) => ({ name: repo.name, scope: repo.scope, maxParallel: repo.maxParallel })),
    };
  }

  /** L'état de la mémoire du projet : configurée, joignable, et les écritures perdues depuis le démarrage. */
  async oracleStatus(): Promise<{ configured: boolean; ok: boolean; lostWrites: LostWrites }> {
    const lostWrites = this.#ctx.oracle.lostWrites();
    if (!this.#ctx.config.oracle) return { configured: false, ok: false, lostWrites };
    // La santé déjà lue par l'observabilité (gardée 30 s) : `/v1/status` ne fait plus attendre ses lecteurs sur memory.
    return { configured: true, ok: (await this.#ctx.observability.memoryStatus()).ok, lostWrites };
  }
}
