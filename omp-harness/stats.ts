// Les statistiques du harness (`GET /v1/stats`) : ce que le VPS a produit et ce qu'il
// en a coûté — runs par état, étapes et leurs durées, corrections, tests heavy,
// décisions, audits, consommation des agents et comparaison des modèles. Fonction
// PURE sur la base : rien n'est tenu à part.
import type { RepoFilter, Store, UsageRow } from "./db.ts";
import { groupUsage, modelKey, sumUsage } from "./db.ts";

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
      flaky: flakyStats(store.eventsOfType("heavy_flaky", repos)),
    },
    decisions: countBy(store.listDecisions({ repos }), (decision) => decision.status),
    escalations: countBy(store.listEscalations({ repos }), (item) => item.status),
    audits: countBy(store.listAudits([], repos), (audit) => audit.state),
    projects: countBy(store.listProjects(repos), (project) => project.status),
    usage: usageStats(store.usageSince(0, repos), now),
    models: modelStats(runs, steps, store.usageSince(0, repos)),
  };
}

/**
 * Les tests instables : les commandes passées au vert après un rouge sur le même arbre
 * (`heavy_flaky`), regroupées par dépôt et commande, les plus fréquentes d'abord.
 */
function flakyStats(events: ReturnType<Store["eventsOfType"]>): Record<string, unknown>[] {
  const groups = new Map<string, { repo: string; scope: string; command: string; count: number; lastAt: number }>();
  for (const event of events) {
    const repo = event.repo ?? String(event.payload.repo ?? "?");
    const scope = String(event.payload.scope ?? "?");
    const command = String(event.payload.command ?? "?");
    const key = `${repo}\u0000${command}`;
    const group = groups.get(key) ?? { repo, scope, command, count: 0, lastAt: 0 };
    group.count++;
    group.lastAt = Math.max(group.lastAt, event.at);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}

/** Le jour (UTC) d'un instant : `2026-10-24`. */
function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** Ce que les agents ont consommé : en tout, sur 7 jours, jour par jour (14 derniers), par dépôt. */
function usageStats(rows: UsageRow[], now: number): Record<string, unknown> {
  const recent = rows.filter((row) => now - row.at <= 14 * DAY_MS);
  const byDay = groupUsage(recent, (row) => dayOf(row.at));
  return {
    total: sumUsage(rows),
    last7Days: sumUsage(rows.filter((row) => now - row.at <= 7 * DAY_MS)),
    byDay: Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, totals]) => ({ day, ...totals })),
    byRepo: groupUsage(rows, (row) => row.repo ?? "?"),
  };
}

/**
 * La comparaison des modèles : pour chacun, ses étapes (nombre, échecs, durée
 * médiane), la part de ses implémentations qu'une revue a renvoyées en correction,
 * les features fusionnées auxquelles il a contribué, et ce qu'il a coûté.
 */
function modelStats(
  runs: ReturnType<Store["listRuns"]>,
  steps: ReturnType<Store["allSteps"]>,
  usage: UsageRow[],
): Record<string, unknown>[] {
  const merged = new Set(runs.filter((run) => run.state === "merged").map((run) => run.id));
  const byRun = new Map<string, typeof steps>();
  for (const step of steps) byRun.set(step.runId, [...(byRun.get(step.runId) ?? []), step]);
  const costs = groupUsage(usage, (row) => modelKey(row));
  const models = new Set([...steps.map((step) => step.model).filter((model) => model !== null), ...Object.keys(costs)]);
  return [...models]
    .map((model) => {
      const own = steps.filter((step) => step.model === model);
      const impls = own.filter((step) => step.kind === "impl" && step.status === "done");
      const corrected = impls.filter((impl) =>
        (byRun.get(impl.runId) ?? []).some((other) => other.kind === "fix" && other.id > impl.id),
      );
      const total = costs[model as string];
      return {
        model,
        steps: own.length,
        failed: own.filter((step) => step.status === "failed").length,
        medianSec: median(
          own
            .filter((step) => step.endedAt !== null)
            .map((step) => Math.round(((step.endedAt as number) - step.startedAt) / 1000)),
        ),
        impls: impls.length,
        /** La part des implémentations de ce modèle qu'une revue a renvoyées en correction. */
        correctedRate: impls.length === 0 ? null : corrected.length / impls.length,
        mergedRuns: new Set(own.filter((step) => merged.has(step.runId)).map((step) => step.runId)).size,
        cost: total?.cost ?? 0,
        input: total?.input ?? 0,
        output: total?.output ?? 0,
        messages: total?.messages ?? 0,
      };
    })
    .sort((a, b) => b.steps - a.steps || String(a.model).localeCompare(String(b.model)));
}
