// Les lectures de l'API : ce que voient les apps et le plugin, filtré par dépôts.
//
// Fonctions PURES sur la base (et l'état vivant qu'on leur passe) : un client ne voit
// que les dépôts que son jeton permet (`repos`, `null` : tous).
import type { EscalationRow, RepoFilter, RunRow, Store } from "./db.ts";
import { autoAnswerOf } from "./gestures.ts";
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
 * Chaque escalade avec son échéance : `autoAt`, l'instant où l'option recommandée s'appliquera seule, et
 * `autoAnswer`, cette option — `null` si elle ne le fera jamais (gestures.ts `autoAnswerOf`). `timeoutSec` :
 * `review.escalationTimeoutSec`.
 */
function withDeadline<T extends EscalationRow>(
  store: Store,
  items: readonly T[],
  timeoutSec: number | null,
): (T & { autoAt: number | null; autoAnswer: string | null })[] {
  const runs = new Map<string, RunRow | null>();
  return items.map((item) => {
    if (!runs.has(item.runId)) runs.set(item.runId, store.getRun(item.runId));
    return { ...item, ...autoAnswerOf(item, runs.get(item.runId) ?? null, timeoutSec) };
  });
}

/**
 * La boîte de l'humain, d'un seul appel : escalades batchées, validations, décisions prises
 * seules, features en cours, audits. `pendingCount` compte ce qui BLOQUE un run (escalades
 * ouvertes, runs en attente de validation) ; les décisions `auto`/`auto_timeout` sont à
 * relire, pas bloquantes : listées à part, chacune avec son `status`. Une escalade restée
 * ouverte sur un run terminé (annulé, fusionné, en échec) ne bloque plus rien et ne peut
 * plus recevoir de réponse : elle n'entre ni dans la boîte ni dans le compte. `timeoutSec` :
 * l'échéance des escalades (`review.escalationTimeoutSec`), dite sur chacune (`autoAt`, `autoAnswer`).
 */
export function inboxOf(
  store: Store,
  repos: RepoFilter = null,
  timeoutSec: number | null = null,
): Record<string, unknown> {
  const runs = store.listRuns({ repos });
  const byId = new Map(runs.map((run) => [run.id, run]));
  const byRun = new Map<string, unknown[]>();
  let openEscalations = 0;
  const open = withDeadline(store, store.listEscalations({ status: "open", repos }), timeoutSec);
  for (const item of withStep(store, open)) {
    const run = byId.get(item.runId) ?? store.getRun(item.runId);
    if (run && isTerminal(run.state)) continue;
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

/**
 * Les escalades d'un statut, batchées par run (l'écran iOS les traite d'un geste). `shown` : le run tel
 * que l'API le rend (`Orchestrator.withWait` : pourquoi il attend, ce qui le retient).
 */
export function escalationBatches(
  store: Store,
  status: "open" | "answered",
  repos: RepoFilter = null,
  timeoutSec: number | null = null,
  shown: (run: RunRow) => RunRow = (run) => run,
): Record<string, unknown> {
  const byRun = new Map<string, unknown[]>();
  for (const item of withStep(store, withDeadline(store, store.listEscalations({ status, repos }), timeoutSec)))
    byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item]);
  return {
    batches: [...byRun].map(([runId, items]) => {
      const run = store.getRun(runId);
      return { run: run === null ? null : shown(run), items };
    }),
  };
}

/** La vue complète d'un run : étapes, décisions, escalades (avec leur échéance, `timeoutSec`), tests, artefacts. */
export function runView(
  store: Store,
  run: RunRow,
  live: boolean,
  timeoutSec: number | null = null,
): Record<string, unknown> {
  return {
    run,
    live,
    steps: store.listSteps(run.id),
    decisions: store.listDecisions({ runId: run.id }),
    escalations: withDeadline(store, store.listEscalations({ runId: run.id }), timeoutSec),
    tests: store.listTestRuns(run.id),
    artifacts: store.listArtifacts(run.id).filter((artifact) => !artifact.name.startsWith("_")),
  };
}

/** Les validations prises seules par l'autonomie des dépôts visibles, créées dans la fenêtre : les plus récentes d'abord, 100 au plus. */
export function autonomyValidations(store: Store, windowDays: number, now: number, repos: RepoFilter = null) {
  const since = now - windowDays * 86_400_000;
  const decisions = store
    .listDecisions({ repos })
    .filter((decision) => decision.autonomy !== null && decision.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq)
    .slice(0, 100);
  return withStep(store, decisions);
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
