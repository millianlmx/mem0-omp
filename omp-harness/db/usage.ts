// La consommation : une ligne par message d'agent (tokens et coût), et ses sommes
// par run, par étape, par modèle ou depuis un instant.
import { SessionStore } from "./sessions.ts";
import { str, strOrNull, num } from "./sql.ts";
import type { SqlValue, Row, RepoFilter } from "./sql.ts";

/**
 * Une ligne de consommation : un message d'agent d'un run, d'un audit ou d'un job sans dépôt.
 * `spaceId` : l'espace auquel un job SANS dépôt est imputé (Demande, poste) ; celui d'une ligne qui a
 * un dépôt se déduit de ce dépôt, il n'est pas écrit ici.
 */
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
  spaceId: string | null;
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
    spaceId: strOrNull(row, "space_id"),
    at: num(row, "at"),
  };
}

/** Le modèle d'une ligne de consommation : `fournisseur/modèle`, ou ce qui en est connu. */
export function modelKey(row: Pick<UsageRow, "provider" | "model">): string {
  if (row.provider && row.model) return `${row.provider}/${row.model}`;
  return row.model ?? row.provider ?? "?";
}

function emptyTotals(): UsageTotals {
  return { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addRow(total: UsageTotals, row: UsageRow): void {
  total.messages++;
  total.input += row.input;
  total.output += row.output;
  total.cacheRead += row.cacheRead;
  total.cacheWrite += row.cacheWrite;
  total.cost += row.cost;
}

/** La somme d'une liste de lignes de consommation. */
export function sumUsage(rows: readonly UsageRow[]): UsageTotals {
  const total = emptyTotals();
  for (const row of rows) addRow(total, row);
  total.cost = Math.round(total.cost * 1e6) / 1e6;
  return total;
}

/**
 * Les sommes par clé (étape, modèle, jour…), cumulées au fil des lignes : linéaire. Copier la liste de son
 * groupe à chaque ligne coûtait le carré du nombre de lignes — 100 s pour 100 000 lignes d'un seul modèle,
 * pendant lesquelles le service, synchrone, ne répondait plus à personne.
 */
export function groupUsage(rows: readonly UsageRow[], key: (row: UsageRow) => string): Record<string, UsageTotals> {
  const groups = new Map<string, UsageTotals>();
  for (const row of rows) {
    const name = key(row);
    let total = groups.get(name);
    if (total === undefined) {
      total = emptyTotals();
      groups.set(name, total);
    }
    addRow(total, row);
  }
  for (const total of groups.values()) total.cost = Math.round(total.cost * 1e6) / 1e6;
  return Object.fromEntries(groups);
}

export class UsageStore extends SessionStore {
  addUsage(row: Omit<UsageRow, "at" | "spaceId"> & { spaceId?: string | null }): void {
    this.execute(
      `INSERT INTO usage (run_id, audit_id, repo, step, provider, model, input, output, cache_read, cache_write, cost, space_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      row.spaceId ?? null,
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

  /**
   * Les sommes de consommation depuis `since`, calculées en base, par `by` : `repo` (`?` sans dépôt), `model`
   * (`modelKey`), `day` (UTC, `2026-10-24`) ou `all` (la seule clé `*`). Une ligne par groupe : les statistiques
   * ne chargent plus chaque ligne d'usage en mémoire (des centaines de milliers sur un serveur de quelques mois).
   */
  usageGroups(
    by: "repo" | "model" | "day" | "all",
    since: number,
    repos: RepoFilter = null,
  ): Record<string, UsageTotals> {
    if (repos !== null && repos.length === 0) return by === "all" ? { "*": emptyTotals() } : {};
    const where = ["at >= ?"];
    const params: SqlValue[] = [since];
    if (repos !== null) {
      where.push(`repo IN (${repos.map(() => "?").join(", ")})`);
      params.push(...repos);
    }
    const keyed =
      by === "repo"
        ? { select: "COALESCE(repo, '?') AS k", group: "GROUP BY k" }
        : by === "day"
          ? { select: "strftime('%Y-%m-%d', at / 1000, 'unixepoch') AS k", group: "GROUP BY k" }
          : by === "model"
            ? { select: "provider, model", group: "GROUP BY provider, model" }
            : { select: "'*' AS k", group: "" };
    const rows = this.selectAll(
      `SELECT ${keyed.select}, COUNT(*) AS messages, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cache_read,
              SUM(cache_write) AS cache_write, SUM(cost) AS cost
       FROM usage WHERE ${where.join(" AND ")} ${keyed.group}`,
      ...params,
    );
    const groups: Record<string, UsageTotals> = by === "all" ? { "*": emptyTotals() } : {};
    for (const row of rows) {
      const key =
        by === "model"
          ? modelKey({ provider: strOrNull(row, "provider"), model: strOrNull(row, "model") })
          : String(row.k ?? "?");
      const total = groups[key] ?? emptyTotals();
      total.messages += Number(row.messages ?? 0);
      total.input += Number(row.input ?? 0);
      total.output += Number(row.output ?? 0);
      total.cacheRead += Number(row.cache_read ?? 0);
      total.cacheWrite += Number(row.cache_write ?? 0);
      total.cost += Number(row.cost ?? 0);
      groups[key] = total;
    }
    for (const total of Object.values(groups)) total.cost = Math.round(total.cost * 1e6) / 1e6;
    return groups;
  }

  /**
   * Les consommations d'un espace sur [since, until[ : celles de ses dépôts et, quand `spaceId` est donné,
   * celles sans dépôt qui lui sont imputées (`space_id` : Demande, poste).
   */
  spaceUsage(repos: readonly string[], spaceId: string | null, since: number, until: number): UsageRow[] {
    const scopes: string[] = [];
    const params: SqlValue[] = [since, until];
    if (repos.length > 0) {
      scopes.push(`repo IN (${repos.map(() => "?").join(", ")})`);
      params.push(...repos);
    }
    if (spaceId !== null) {
      scopes.push("(repo IS NULL AND space_id = ?)");
      params.push(spaceId);
    }
    if (scopes.length === 0) return [];
    return this.selectAll(
      `SELECT * FROM usage WHERE at >= ? AND at < ? AND (${scopes.join(" OR ")}) ORDER BY id`,
      ...params,
    ).map(usageOf);
  }
}
