// La consommation : une ligne par message d'agent (tokens et coût), et ses sommes
// par run, par étape, par modèle ou depuis un instant.
import { SessionStore } from "./sessions.ts";
import { str, strOrNull, num } from "./sql.ts";
import type { SqlValue, Row, RepoFilter } from "./sql.ts";

/** Une ligne de consommation : un message d'agent d'un run ou d'un audit. */
export type UsageRow = {
  runId: string | null;
  auditId: string | null;
  repo: string | null;
  step: string | null;
  provider: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  at: number;
};

/** Une somme de consommation. */
export type UsageTotals = {
  messages: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

function usageOf(row: Row): UsageRow {
  return {
    runId: strOrNull(row, "run_id"),
    auditId: strOrNull(row, "audit_id"),
    repo: strOrNull(row, "repo"),
    step: strOrNull(row, "step"),
    provider: strOrNull(row, "provider"),
    model: strOrNull(row, "model"),
    input: num(row, "input"),
    output: num(row, "output"),
    cacheRead: num(row, "cache_read"),
    cacheWrite: num(row, "cache_write"),
    cost: num(row, "cost"),
    at: num(row, "at"),
  };
}

/** Le modèle d'une ligne de consommation : `fournisseur/modèle`, ou ce qui en est connu. */
export function modelKey(row: Pick<UsageRow, "provider" | "model">): string {
  if (row.provider && row.model) return `${row.provider}/${row.model}`;
  return row.model ?? row.provider ?? "?";
}

/** La somme d'une liste de lignes de consommation. */
export function sumUsage(rows: readonly UsageRow[]): UsageTotals {
  const total: UsageTotals = { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const row of rows) {
    total.messages++;
    total.input += row.input;
    total.output += row.output;
    total.cacheRead += row.cacheRead;
    total.cacheWrite += row.cacheWrite;
    total.cost += row.cost;
  }
  total.cost = Math.round(total.cost * 1e6) / 1e6;
  return total;
}

/** Les sommes par clé (étape, modèle, jour…). */
export function groupUsage(rows: readonly UsageRow[], key: (row: UsageRow) => string): Record<string, UsageTotals> {
  const groups = new Map<string, UsageRow[]>();
  for (const row of rows) {
    const name = key(row);
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  return Object.fromEntries([...groups].map(([name, list]) => [name, sumUsage(list)]));
}

export class UsageStore extends SessionStore {
  addUsage(row: Omit<UsageRow, "at">): void {
    this.execute(
      `INSERT INTO usage (run_id, audit_id, repo, step, provider, model, input, output, cache_read, cache_write, cost, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.runId,
      row.auditId,
      row.repo,
      row.step,
      row.provider,
      row.model,
      row.input,
      row.output,
      row.cacheRead,
      row.cacheWrite,
      row.cost,
      this.now(),
    );
  }

  /** La consommation d'un run : son total, par étape et par modèle. */
  runUsage(runId: string): {
    total: UsageTotals;
    byStep: Record<string, UsageTotals>;
    byModel: Record<string, UsageTotals>;
  } {
    const rows = this.selectAll("SELECT * FROM usage WHERE run_id = ? ORDER BY id", runId).map(usageOf);
    return {
      total: sumUsage(rows),
      byStep: groupUsage(rows, (row) => row.step ?? "?"),
      byModel: groupUsage(rows, (row) => modelKey(row)),
    };
  }

  /** Le coût d'un run, en dollars. */
  runCost(runId: string): number {
    return num(
      this.selectOne("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage WHERE run_id = ?", runId) as Row,
      "cost",
    );
  }

  /** Ce que tout le serveur a dépensé depuis `since` (runs et audits). */
  costSince(since: number): number {
    return num(this.selectOne("SELECT COALESCE(SUM(cost), 0) AS cost FROM usage WHERE at >= ?", since) as Row, "cost");
  }

  /** Le coût de chaque run de la liste qui a consommé quelque chose. */
  runCosts(runIds: readonly string[]): Record<string, number> {
    if (runIds.length === 0) return {};
    const rows = this.selectAll(
      `SELECT run_id, SUM(cost) AS cost FROM usage WHERE run_id IN (${runIds.map(() => "?").join(", ")}) GROUP BY run_id`,
      ...runIds,
    );
    return Object.fromEntries(rows.map((row) => [str(row, "run_id"), Math.round(num(row, "cost") * 1e6) / 1e6]));
  }

  /** Les lignes de consommation depuis `since` (ms), filtrées par dépôt. */
  usageSince(since: number, repos: RepoFilter = null): UsageRow[] {
    if (repos !== null && repos.length === 0) return [];
    const where = ["at >= ?"];
    const params: SqlValue[] = [since];
    if (repos !== null) {
      where.push(`repo IN (${repos.map(() => "?").join(", ")})`);
      params.push(...repos);
    }
    return this.selectAll(`SELECT * FROM usage WHERE ${where.join(" AND ")} ORDER BY id`, ...params).map(usageOf);
  }
}
