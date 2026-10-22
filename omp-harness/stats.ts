// Les statistiques du harness (`GET /v1/stats`) : ce que le VPS a produit et ce qu'il
// en a coûté — runs par état, étapes et leurs durées, corrections, tests heavy,
// décisions, audits. Fonction PURE sur la base : rien n'est tenu à part.
import type { RepoFilter, Store } from "./db.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

/** Les statistiques des dépôts que le lecteur voit (`repos`, `null` : tous). */
export function computeStats(store: Store, now = Date.now(), repos: RepoFilter = null): Record<string, unknown> {
  const runs = store.listRuns({ repos });
  const ids = new Set(runs.map((run) => run.id));
  const mine = <T extends { runId: string }>(items: T[]): T[] =>
    repos === null ? items : items.filter((item) => ids.has(item.runId));
  const merged = runs.filter((run) => run.state === "merged");
  const finished = runs.filter((run) => run.state === "merged" || run.state === "failed");
  const steps = mine(store.allSteps());
  const tests = mine(store.allTestRuns());
  const byKind: Record<string, { count: number; failed: number; medianSec: number | null }> = {};
  for (const kind of new Set(steps.map((step) => step.kind))) {
    const ofKind = steps.filter((step) => step.kind === kind);
    byKind[kind] = {
      count: ofKind.length,
      failed: ofKind.filter((step) => step.status === "failed").length,
      medianSec: median(
        ofKind
          .filter((step) => step.endedAt !== null)
          .map((step) => Math.round(((step.endedAt as number) - step.startedAt) / 1000)),
      ),
    };
  }
  return {
    runs: {
      total: runs.length,
      byState: countBy(runs, (run) => run.state),
      mergedLast7Days: merged.filter((run) => now - run.updatedAt <= 7 * DAY_MS).length,
      /** La part des runs terminés qui sont mergés (les annulés ne comptent pas). */
      mergeRate: finished.length === 0 ? null : merged.length / finished.length,
      /** De la création au merge, en secondes. */
      medianLeadSec: median(merged.map((run) => Math.round((run.updatedAt - run.createdAt) / 1000))),
      fixesPerMerged: merged.length === 0 ? null : merged.reduce((sum, run) => sum + run.fixes, 0) / merged.length,
    },
    steps: byKind,
    tests: {
      total: tests.length,
      cached: tests.filter((test) => test.cached).length,
      byOutcome: countBy(tests, (test) => test.outcome),
      /** Les jobs relancés après un OOM. */
      retried: tests.filter((test) => test.attempts > 1).length,
    },
    decisions: countBy(store.listDecisions({ repos }), (decision) => decision.status),
    escalations: countBy(store.listEscalations({ repos }), (item) => item.status),
    audits: countBy(store.listAudits([], repos), (audit) => audit.state),
    projects: countBy(store.listProjects(repos), (project) => project.status),
  };
}
