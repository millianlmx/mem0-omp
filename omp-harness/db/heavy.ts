// Le cache des résultats heavy (clé : tree hash + commande + env) et l'historique
// des passes de tests de chaque run.
import { DecisionStore } from "./decisions.ts";
import type { TestScope } from "../heavy.ts";
import { str, num, numOrNull } from "./sql.ts";
import type { Row } from "./sql.ts";

export type CacheOutcome = "pass" | "fail";

export type CacheRow = {
  key: string;
  repo: string;
  tree: string;
  command: string;
  outcome: CacheOutcome;
  exitCode: number;
  output: string;
  durationMs: number;
  createdAt: number;
};

export type TestRunRow = {
  id: number;
  runId: string;
  stepId: number | null;
  scope: TestScope;
  key: string;
  tree: string;
  outcome: string;
  cached: boolean;
  attempts: number;
  at: number;
};

function cacheOf(row: Row): CacheRow {
  return {
    key: str(row, "key"),
    repo: str(row, "repo"),
    tree: str(row, "tree"),
    command: str(row, "command"),
    outcome: str(row, "outcome") as CacheOutcome,
    exitCode: num(row, "exit_code"),
    output: str(row, "output"),
    durationMs: num(row, "duration_ms"),
    createdAt: num(row, "created_at"),
  };
}

function testRunOf(row: Row): TestRunRow {
  return {
    id: num(row, "id"),
    runId: str(row, "run_id"),
    stepId: numOrNull(row, "step_id"),
    scope: str(row, "scope") as TestScope,
    key: str(row, "key"),
    tree: str(row, "tree"),
    outcome: str(row, "outcome"),
    cached: num(row, "cached") === 1,
    attempts: num(row, "attempts"),
    at: num(row, "at"),
  };
}

export class HeavyStore extends DecisionStore {
  cacheGet(key: string): CacheRow | null {
    const row = this.selectOne("SELECT * FROM cache WHERE key = ?", key);
    return row ? cacheOf(row) : null;
  }

  cachePut(entry: Omit<CacheRow, "createdAt">): void {
    this.execute(
      `INSERT INTO cache (key, repo, tree, command, outcome, exit_code, output, duration_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET outcome = excluded.outcome, exit_code = excluded.exit_code, output = excluded.output,
         duration_ms = excluded.duration_ms, created_at = excluded.created_at`,
      entry.key,
      entry.repo,
      entry.tree,
      entry.command,
      entry.outcome,
      entry.exitCode,
      entry.output,
      entry.durationMs,
      this.now(),
    );
  }

  addTestRun(input: Omit<TestRunRow, "id" | "at">): TestRunRow {
    const result = this.execute(
      "INSERT INTO test_runs (run_id, step_id, scope, key, tree, outcome, cached, attempts, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      input.runId,
      input.stepId,
      input.scope,
      input.key,
      input.tree,
      input.outcome,
      input.cached ? 1 : 0,
      input.attempts,
      this.now(),
    );
    return testRunOf(this.selectOne("SELECT * FROM test_runs WHERE id = ?", Number(result.lastInsertRowid)) as Row);
  }

  listTestRuns(runId: string): TestRunRow[] {
    return this.selectAll("SELECT * FROM test_runs WHERE run_id = ? ORDER BY id", runId).map(testRunOf);
  }

  allTestRuns(): TestRunRow[] {
    return this.selectAll("SELECT * FROM test_runs ORDER BY id").map(testRunOf);
  }
}
