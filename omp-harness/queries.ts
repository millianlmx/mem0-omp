// Les lectures de l'API : ce que voient les apps et le plugin, filtré par dépôts.
//
// Fonctions PURES sur la base (et l'état vivant qu'on leur passe) : un client ne voit
// que les dépôts que son jeton permet (`repos`, `null` : tous).
import type { RepoFilter, RunRow, Store } from "./db.ts";
import { isTerminal } from "./machine.ts";

/**
 * Une question avec l'étape qui l'a posée (`req`, `specs`, `impl`…) : les apps la
 * situent (dépôt › feature › étape) sans relire la vue du run.
 */
function withStep<T extends { stepId: number }>(store: Store, items: readonly T[]): (T & { step: string | null })[] {
  const kinds = new Map<number, string | null>();
  return items.map((item) => {
    if (!kinds.has(item.stepId)) kinds.set(item.stepId, store.getStep(item.stepId)?.kind ?? null);
    return { ...item, step: kinds.get(item.stepId) ?? null };
  });
}

/**
 * La boîte de l'humain, d'un seul appel : escalades batchées, validations, décisions prises
 * seules, features en cours, audits. `pendingCount` compte ce qui BLOQUE un run (escalades
 * ouvertes, runs en attente de validation) ; les décisions `auto`/`auto_timeout` sont à
 * relire, pas bloquantes : listées à part, chacune avec son `status`.
 */
export function inboxOf(store: Store, repos: RepoFilter = null): Record<string, unknown> {
  const runs = store.listRuns({ repos });
  const byId = new Map(runs.map((run) => [run.id, run]));
  const byRun = new Map<string, unknown[]>();
  let openEscalations = 0;
  for (const item of withStep(store, store.listEscalations({ status: "open", repos }))) {
    openEscalations += 1;
    byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item]);
  }
  const awaiting = runs.filter((run) => run.state === "awaiting_human");
  const decisions = withStep(store, store.listDecisions({ status: ["auto", "auto_timeout"], repos }));
  const referenced = new Set([...byRun.keys(), ...decisions.map((decision) => decision.runId)]);
  return {
    pendingCount: openEscalations + awaiting.length,
    batches: [...byRun].map(([runId, items]) => ({ run: byId.get(runId) ?? store.getRun(runId), items })),
    awaiting,
    decisions,
    runs: runs.filter((run) => !isTerminal(run.state) || referenced.has(run.id)),
    audits: store.listAudits(["queued", "analysing", "proposed"], repos),
    cursor: store.lastEventId(),
  };
}

/** Les escalades d'un statut, batchées par run (l'écran iOS les traite d'un geste). */
export function escalationBatches(
  store: Store,
  status: "open" | "answered",
  repos: RepoFilter = null,
): Record<string, unknown> {
  const byRun = new Map<string, unknown[]>();
  for (const item of withStep(store, store.listEscalations({ status, repos })))
    byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item]);
  return { batches: [...byRun].map(([runId, items]) => ({ run: store.getRun(runId), items })) };
}

/** La vue complète d'un run : étapes, décisions, escalades, tests, artefacts. */
export function runView(store: Store, run: RunRow, live: boolean): Record<string, unknown> {
  return {
    run,
    live,
    steps: store.listSteps(run.id),
    decisions: store.listDecisions({ runId: run.id }),
    escalations: store.listEscalations({ runId: run.id }),
    tests: store.listTestRuns(run.id),
    artifacts: store.listArtifacts(run.id).filter((artifact) => !artifact.name.startsWith("_")),
  };
}

/** Chaque projet avec le décompte de ses runs par état (la liste des apps). */
export function projectsOf(store: Store, repos: RepoFilter = null): Record<string, unknown>[] {
  const runs = store.listRuns({ repos });
  return store.listProjects(repos).map((project) => {
    const own = runs.filter((run) => run.projectId === project.id);
    const byState: Record<string, number> = {};
    for (const run of own) byState[run.state] = (byState[run.state] ?? 0) + 1;
    return { ...project, runs: { total: own.length, byState } };
  });
}

/** Les compteurs par état et, par dépôt, ce qui vit et ce qui attend : la charge du serveur. */
export function loadOf(
  store: Store,
  repos: RepoFilter,
  live: ReadonlySet<string>,
): { runs: Record<string, number>; byRepo: Record<string, Record<string, number>> } {
  const counts: Record<string, number> = {};
  const byRepo: Record<string, Record<string, number>> = {};
  for (const run of store.listRuns({ repos })) {
    counts[run.state] = (counts[run.state] ?? 0) + 1;
    byRepo[run.repo] ??= {};
    const own = byRepo[run.repo] as Record<string, number>;
    own[run.state] = (own[run.state] ?? 0) + 1;
    if (live.has(run.id)) own.live = (own.live ?? 0) + 1;
  }
  return { runs: counts, byRepo };
}
