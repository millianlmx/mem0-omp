// Les STATISTIQUES de `GET /v1/stats` : portage de `RemoteReads.statistics`
// (omp-console/Sources/OMPConsole/Remote/RemoteReads.swift:163-207) et des fonctions pures du
// tableau macOS — `statsBoard`/`statsPlan`/`featureTotals`/`featureModel`/`featureLiveRuns`
// (Stats/StatsBoard.swift), `sessionMetrics`/`durationMs` (Stats/StatsMetrics.swift),
// `statsUnreadableReason` (Stats/StatsModels.swift), `storeRuns`/`statsRuns`/`storeRunIsLive`
// (ConsoleCore/Store/StoreRuns.swift) et `SessionMetricsCache.metrics` (Stats/SessionMetricsCache.swift).
//
// Le cache de lecteurs incrémentaux du Mac n'a pas d'équivalent : une requête relit les sessions
// du projet demandé depuis le début (même résultat qu'un lecteur neuf), et ne lit AUCUNE session
// des autres projets.
import os from "node:os";
import path from "node:path";
import { realpathOr } from "./git.ts";
import { readSessionFile } from "./remoteSessions.ts";
import type { SessionConversation } from "./remoteSessions.ts";
import type {
  WireHistoryEntry,
  WireLot,
  WireProject,
  WirePhase,
  WireRunningEntry,
  WireStoreSnapshot,
} from "./remoteWire.ts";

// --- les types de la charge utile (Payloads.swift) -----------------------------------------

export type RemoteStatsProject = { key: string; label: string };

export type RemoteStatsFeature = {
  slug: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  durationMs: number;
  liveRuns: number;
  model?: string;
};

export type RemoteStatsPayload = {
  projectKey?: string;
  project: string;
  projects: RemoteStatsProject[];
  features: RemoteStatsFeature[];
  hiddenPlanFeatures: number;
};

/** Ce que `GET /v1/sessions` sert pour un run : une entrée `running/` ou `history/` portant un `sessionFile`. */
export type StoreRun = {
  sessionFile: string;
  label: string;
  cwd: string;
  phase: WirePhase;
  phaseStartedAt: number;
  live?: WireRunningEntry;
  finalState?: WireHistoryEntry["finalState"];
};

// --- les runs du magasin (StoreRuns.swift) -----------------------------------------------

/** Tous les runs du magasin, `running/` puis `history/`, dédoublonnés par `sessionFile` (la première occurrence gagne). */
export function storeRuns(snapshot: WireStoreSnapshot): StoreRun[] {
  const runs: StoreRun[] = [];
  const seen = new Set<string>();
  for (const entry of snapshot.running.entries) {
    const file = entry.sessionFile;
    if (file === undefined || file === "" || seen.has(file)) continue;
    seen.add(file);
    runs.push({
      sessionFile: file,
      label: entry.label,
      cwd: entry.cwd,
      phase: entry.phase,
      phaseStartedAt: entry.phaseStartedAt,
      live: entry,
    });
  }
  for (const entry of snapshot.history.entries) {
    const file = entry.sessionFile;
    if (file === undefined || file === "" || seen.has(file)) continue;
    seen.add(file);
    runs.push({
      sessionFile: file,
      label: entry.label,
      cwd: entry.cwd,
      phase: entry.phase,
      phaseStartedAt: entry.phaseStartedAt,
      finalState: entry.finalState,
    });
  }
  return runs;
}

/** Les runs d'une feature : `cwd` réel == worktree réel, ordonnés par nom de fichier (l'horodatage ISO en tête) puis par chemin. */
function statsRuns(snapshot: WireStoreSnapshot, worktree: string): StoreRun[] {
  if (worktree === "") return [];
  const target = realpathOr(worktree);
  return storeRuns(snapshot)
    .filter(run => realpathOr(run.cwd) === target)
    .sort((left, right) => {
      const leftName = path.basename(left.sessionFile);
      const rightName = path.basename(right.sessionFile);
      if (leftName !== rightName) return leftName < rightName ? -1 : 1;
      if (left.sessionFile === right.sessionFile) return 0;
      return left.sessionFile < right.sessionFile ? -1 : 1;
    });
}

/** Vivant ⇔ entrée gagnante `running/` dont l'`ownerPid` est vivant. */
function storeRunIsLive(run: StoreRun, pidAlive: (pid: number) => boolean): boolean {
  const pid = run.live?.ownerPid;
  return pid !== undefined && pidAlive(pid);
}

// --- les métriques d'une session (StatsMetrics.swift) ------------------------------------------

export type SessionMetrics = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  turns: number;
  model?: string;
  firstMs?: number;
  lastMs?: number;
};

/** Réduit une conversation en ses métriques ; un tour = une entrée `user`. */
export function sessionMetrics(conversation: SessionConversation): SessionMetrics {
  const metrics: SessionMetrics = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
  for (const entry of conversation.entries) {
    const ts = entry.timestampMs;
    if (ts !== undefined) {
      metrics.firstMs = metrics.firstMs === undefined ? ts : Math.min(metrics.firstMs, ts);
      metrics.lastMs = metrics.lastMs === undefined ? ts : Math.max(metrics.lastMs, ts);
    }
    const kind = entry.kind;
    if (kind.type === "user") metrics.turns += 1;
    else if (kind.type === "assistant") {
      if (kind.usage !== undefined) {
        metrics.input += kind.usage.input;
        metrics.output += kind.usage.output;
        metrics.cacheRead += kind.usage.cacheRead;
        metrics.cacheWrite += kind.usage.cacheWrite;
      }
      if (kind.model !== undefined && kind.model !== "") metrics.model = kind.model;
    }
  }
  return metrics;
}

/** Durée murale : un run vivant court jusqu'à `nowMs`, un run clos va de sa première à sa dernière entrée horodatée. */
function durationMs(metrics: SessionMetrics, isLive: boolean, nowMs: number): number | null {
  if (metrics.firstMs === undefined) return null;
  const end = isLive ? nowMs : (metrics.lastMs ?? metrics.firstMs);
  return Math.max(0, end - metrics.firstMs);
}

type RunMetricsState = { measured: SessionMetrics } | { unreadable: string };

/** `SessionMetricsCache.metrics` : l'état des métriques d'un run, le motif d'illisibilité DÉJÀ formulé. */
function readMetrics(sessionFile: string): RunMetricsState {
  const conversation = readSessionFile(sessionFile);
  const issue = conversation.issue;
  if (issue?.type === "fileMissing") return { unreadable: "session introuvable" };
  if (issue?.type === "unreadable") return { unreadable: `session illisible : ${issue.message}` };
  return { measured: sessionMetrics(conversation) };
}

// --- le tableau (StatsBoard.swift) --------------------------------------------------------

type RunStats = { sessionFile: string; isLive: boolean; metrics: RunMetricsState };
type FeatureStats = { slug: string; runs: RunStats[] };
type StatsTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number; durationMs: number };

function measuredOf(run: RunStats): SessionMetrics | null {
  return "measured" in run.metrics ? run.metrics.measured : null;
}

function basenameOf(p: string): string {
  const name = path.basename(p);
  return name === "" ? p : name;
}

/** `ConsoleFormat.path(_, home:)` : « ~ » sous le dossier personnel, sinon le chemin tel quel. */
function displayPath(p: string, home: string | undefined): string {
  if (home === undefined || home === "") return p;
  let h = home;
  while (h.length > 1 && h.endsWith("/")) h = h.slice(0, -1);
  if (p === h) return "~";
  if (p.startsWith(`${h}/`)) return `~${p.slice(h.length)}`;
  return p;
}

function projectOrder(left: WireProject, right: WireProject): number {
  if (left.repoRoot !== right.repoRoot) return left.repoRoot < right.repoRoot ? -1 : 1;
  if (left.repoKey === right.repoKey) return 0;
  return left.repoKey < right.repoKey ? -1 : 1;
}

function lotOrder(left: WireLot, right: WireLot): number {
  if (left.repoRoot !== right.repoRoot) return left.repoRoot < right.repoRoot ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/** Les projets du magasin dans l'ordre `projectOrder`, avec leur libellé ; une collision de nom ajoute le dossier parent. */
function statsProjectOptions(snapshot: WireStoreSnapshot, home: string | undefined): RemoteStatsProject[] {
  const ordered = [...snapshot.projects.projects].sort(projectOrder);
  const counts = new Map<string, number>();
  for (const project of ordered) {
    const base = basenameOf(project.repoRoot);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return ordered.map(project => {
    const base = basenameOf(project.repoRoot);
    if ((counts.get(base) ?? 0) <= 1) return { key: project.repoKey, label: base };
    return { key: project.repoKey, label: `${base} (${displayPath(path.dirname(project.repoRoot), home)})` };
  });
}

/** L'ordre du plan déplié : par segment, les features vivantes puis les retirées. */
function statsPlanSlugs(project: WireProject): string[] {
  return project.segments.flatMap(segment => [
    ...segment.features.filter(f => f.status !== "removed").map(f => f.slug),
    ...segment.features.filter(f => f.status === "removed").map(f => f.slug),
  ]);
}

/** Chaque slug du plan avec ses runs (worktree de la feature de lot appariée par `(dépôt réel, slug)`). */
function statsPlan(snapshot: WireStoreSnapshot, project: WireProject): { slug: string; runs: StoreRun[] }[] {
  const projectReal = realpathOr(project.repoRoot);
  const lots = [...snapshot.lots.lots].sort(lotOrder);
  return statsPlanSlugs(project).map(slug => {
    let worktree: string | undefined;
    for (const lot of lots) {
      if (realpathOr(lot.repoRoot) !== projectReal) continue;
      const feature = lot.features.find(f => f.slug === slug);
      if (feature !== undefined) {
        worktree = feature.worktree;
        break;
      }
    }
    return { slug, runs: worktree === undefined ? [] : statsRuns(snapshot, worktree) };
  });
}

/** Le projet affiché : celui de `selectedKey`, sinon le premier de l'ordre `projectOrder`. */
function statsDisplayedProject(snapshot: WireStoreSnapshot, selectedKey: string | null): WireProject | null {
  const ordered = [...snapshot.projects.projects].sort(projectOrder);
  return ordered.find(p => p.repoKey === selectedKey) ?? ordered[0] ?? null;
}

function featureTotals(feature: FeatureStats, nowMs: number): StatsTotals {
  const totals: StatsTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, durationMs: 0 };
  for (const run of feature.runs) {
    const metrics = measuredOf(run);
    if (metrics === null) continue;
    totals.input += metrics.input;
    totals.output += metrics.output;
    totals.cacheRead += metrics.cacheRead;
    totals.cacheWrite += metrics.cacheWrite;
    totals.turns += metrics.turns;
    totals.durationMs += durationMs(metrics, run.isLive, nowMs) ?? 0;
  }
  return totals;
}

/** Le modèle du DERNIER run lisible de la feature qui en porte un non vide. */
function featureModel(feature: FeatureStats): string | undefined {
  for (let i = feature.runs.length - 1; i >= 0; i--) {
    const metrics = measuredOf(feature.runs[i] as RunStats);
    if (metrics?.model !== undefined && metrics.model !== "") return metrics.model;
  }
  return undefined;
}

/** Le nombre de runs lisibles ET vivants de la feature. */
function featureLiveRuns(feature: FeatureStats): number {
  return feature.runs.filter(run => run.isLive && measuredOf(run) !== null).length;
}

export type StatsDeps = {
  now: () => number;
  pidAlive: (pid: number) => boolean;
  /** Le dossier personnel annoncé dans les libellés de projets en collision (`HOME` du service). */
  home?: string;
};

/**
 * La charge utile de `GET /v1/stats` pour `projectKey` (absent, vide ou inconnu ⇒ le premier projet de
 * `projectOrder`). Une feature est LISTÉE ⇔ elle porte au moins un run lisible ; sinon elle n'entre que
 * dans `hiddenPlanFeatures`.
 */
export function statsPayload(snapshot: WireStoreSnapshot, projectKey: string | null, deps: StatsDeps): RemoteStatsPayload {
  const home = deps.home ?? os.homedir();
  const project = statsDisplayedProject(snapshot, projectKey);
  if (project === null) return { project: "", projects: [], features: [], hiddenPlanFeatures: 0 };

  const read = new Map<string, RunMetricsState>();
  const readOnce = (file: string): RunMetricsState => {
    let known = read.get(file);
    if (known === undefined) {
      known = readMetrics(file);
      read.set(file, known);
    }
    return known;
  };
  const features: FeatureStats[] = [];
  let hidden = 0;
  for (const planFeature of statsPlan(snapshot, project)) {
    const runs = planFeature.runs.map(run => ({
      sessionFile: run.sessionFile,
      isLive: storeRunIsLive(run, deps.pidAlive),
      metrics: readOnce(run.sessionFile),
    }));
    if (runs.some(run => measuredOf(run) !== null)) features.push({ slug: planFeature.slug, runs });
    else hidden += 1;
  }

  const options = statsProjectOptions(snapshot, home);
  const nowMs = deps.now();
  return {
    projectKey: project.repoKey,
    project: options.find(o => o.key === project.repoKey)?.label ?? basenameOf(project.repoRoot),
    projects: options,
    features: features.map(feature => {
      const totals = featureTotals(feature, nowMs);
      const model = featureModel(feature);
      return {
        slug: feature.slug,
        input: totals.input,
        output: totals.output,
        cacheRead: totals.cacheRead,
        cacheWrite: totals.cacheWrite,
        turns: totals.turns,
        durationMs: totals.durationMs,
        liveRuns: featureLiveRuns(feature),
        ...(model === undefined ? {} : { model }),
      };
    }),
    hiddenPlanFeatures: hidden,
  };
}
