// Les montages des tests de l'autonomie par paliers : un harness dont le serveur compte 30 lignes de
// diff au plus, une règle de revue `bug` à 50 lignes, et les scénarios de runner qui produisent un
// diff de N lignes avec (ou sans) un test de reproduction.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les tests l'importent.
import type { AutonomyRule } from "../../omp-harness/autonomy-rules.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import type { EventRow, RunRow } from "../../omp-harness/db.ts";
import { OK, fakeWorld, waitFor } from "./harness-fixtures.ts";
import type { FakeWorld } from "./harness-fixtures.ts";

/** La règle de revue de référence : `bug`, jusqu'à 50 lignes, test de reproduction et suite verte exigés. */
export const BUG_REVIEW_RULE: AutonomyRule = {
  match: { kind: "bug", maxDiffLines: 50 },
  require: { reproTest: true, greenChecks: true },
  gates: { specs: "human", review: "auto" },
};

/** Les règles d'un dépôt `demo` et un serveur qui compte 30 lignes de diff au plus. */
export function configure(rules: AutonomyRule[] | null, patch: (config: HarnessConfig) => void = () => {}) {
  return (config: HarnessConfig): void => {
    config.review.maxDiffLines = 30;
    const repo = config.repos.find((r) => r.name === "demo");
    if (repo && rules !== null) repo.autonomy = { rules };
    patch(config);
  };
}

/** `count` lignes de code (le diff compté par le serveur ne porte que le code, pas les tests ni la doc). */
export function lines(count: number): string {
  return Array.from({ length: count }, (_, i) => `export const v${i} = ${i};`).join("\n") + "\n";
}

/** /impl : un diff de `diff` lignes de code, et un test de reproduction si `test`. */
export function implOf(diff: number, test: "none" | "added" = "added") {
  return [
    { write: "src/api/export.ts", content: lines(diff) },
    ...(test === "added"
      ? [{ write: "test/export.test.ts", content: "import test from 'node:test';\ntest('export', () => {});\n" }]
      : []),
    { tool: "run_tests", args: { scope: "touched" } },
    { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\n## Reste\n" },
  ];
}

/** La revue standard de `OK`, sur mesure : un verdict `args` modifié. */
export function reviewOf(args: Record<string, unknown> = {}) {
  const verdict = OK.review[1];
  const files = ["src/api/export.ts", "test/export.test.ts"];
  return [OK.review[0], { tool: "review_verdict", args: { ...(verdict?.args as Record<string, unknown>), files, ...args } }];
}

/** Un monde dont le seul run déclaré `bug` va jusqu'à l'attente de verdict (sans autonomie, sinon le merge). */
export function bugWorld(options: {
  rules: AutonomyRule[] | null;
  diff?: number;
  test?: "none" | "added";
  review?: unknown[];
  patch?: (config: HarnessConfig) => void;
}): FakeWorld {
  return fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [implOf(options.diff ?? 40, options.test ?? "added")],
      review: [options.review ?? reviewOf()],
    },
    { patch: configure(options.rules, options.patch) },
  );
}

export function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

/**
 * Attend un état parmi `states`. Une attente que l'autonomie retient (`hold` encore ouvert) n'est pas
 * un état d'arrêt : elle est validée ou rendue à l'humain (`defer`) au tour suivant.
 */
export async function until(world: FakeWorld, runId: string, states: string[], timeoutMs = 60_000): Promise<RunRow> {
  const held = (): boolean => {
    const hold = world.store.lastRunEvent(runId, "autonomy");
    if (hold === null || hold.payload.action !== "hold") return false;
    const state = world.store.lastRunEvent(runId, "run_state");
    return state === null || state.id < hold.id;
  };
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? "") && !held(),
    () => stateOf(world, runId),
    timeoutMs,
  );
  return world.store.getRun(runId) as RunRow;
}

export function eventsOf(world: FakeWorld, runId: string, type: string): EventRow[] {
  return world.store.eventsSince(0, runId).filter((event) => event.type === type);
}

/** Les décisions d'autonomie (`autonomy !== null`) d'un run. */
export function autonomyDecisions(world: FakeWorld, runId: string) {
  return world.store.listDecisions({ runId }).filter((decision) => decision.autonomy !== null);
}
