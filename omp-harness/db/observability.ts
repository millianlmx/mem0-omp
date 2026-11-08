// L'observabilité : les erreurs remontées par les clients, les points de santé de
// `GET /v1/metrics` (gardés `metrics.retentionDays` jours), et les sommes que
// `GET /metrics` expose (runs par état, durées d'étapes, coût et jetons).
import { ScheduleStore } from "./schedules.ts";
import { json, num, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export const CLIENT_SOURCES = ["mac", "ios", "chrome", "omp", "vigie"] as const;

export type ClientSource = (typeof CLIENT_SOURCES)[number];

/** Une erreur remontée par un client (contrat C2). */
export type ClientErrorRow = {
  id: number;
  at: number;
  /** Le client authentifié qui l'a remontée. */
  client: string;
  source: ClientSource;
  version: string;
  kind: string;
  message: string;
  context: Record<string, unknown> | null;
};

/** Les durées d'étapes terminées : une ligne par (dépôt, étape, issue). */
export type StepDurations = { repo: string; step: string; status: string; seconds: number[] };

/** Les sommes de consommation par dépôt et modèle, depuis toujours. */
export type UsageByModel = {
  repo: string;
  model: string;
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

function clientErrorOf(row: Row): ClientErrorRow {
  return {
    id: num(row, "id"),
    at: num(row, "at"),
    client: str(row, "client"),
    source: str(row, "source") as ClientSource,
    version: str(row, "version"),
    kind: str(row, "kind"),
    message: str(row, "message"),
    context: json<Record<string, unknown> | null>(row, "context", null),
  };
}

export class ObservabilityStore extends ScheduleStore {
  addClientError(input: Omit<ClientErrorRow, "id" | "at">): ClientErrorRow {
    const at = this.now();
    const result = this.execute(
      "INSERT INTO client_errors (at, client, source, version, kind, message, context) VALUES (?, ?, ?, ?, ?, ?, ?)",
      at,
      input.client,
      input.source,
      input.version,
      input.kind,
      input.message,
      input.context === null ? null : JSON.stringify(input.context),
    );
    return { id: Number(result.lastInsertRowid), at, ...input };
  }

  /** Les erreurs des clients depuis `since`, les plus récentes d'abord ; `client` : celles de ce seul client. */
  listClientErrors(
    filter: { since?: number; source?: ClientSource; client?: string; limit?: number } = {},
  ): ClientErrorRow[] {
    const where = ["at >= ?"];
    const params: SqlValue[] = [filter.since ?? 0];
    if (filter.source) {
      where.push("source = ?");
      params.push(filter.source);
    }
    if (filter.client) {
      where.push("client = ?");
      params.push(filter.client);
    }
    return this.selectAll(
      `SELECT * FROM client_errors WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`,
      ...params,
      filter.limit ?? 200,
    ).map(clientErrorOf);
  }

  pruneClientErrors(before: number): number {
    return Number(this.execute("DELETE FROM client_errors WHERE at < ?", before).changes);
  }

  /** Un point de santé de `GET /v1/metrics` (un second point au même instant le remplace). */
  addMetricSample(at: number, sample: Record<string, unknown>): void {
    this.execute("INSERT OR REPLACE INTO metric_samples (at, sample) VALUES (?, ?)", at, JSON.stringify(sample));
  }

  /** Les `limit` derniers points depuis `since`, les plus anciens d'abord. */
  listMetricSamples<T>(since: number, limit: number): T[] {
    return this.selectAll(
      "SELECT sample FROM (SELECT at, sample FROM metric_samples WHERE at >= ? ORDER BY at DESC LIMIT ?) ORDER BY at",
      since,
      limit,
    ).map((row) => json<T>(row, "sample", {} as T));
  }

  pruneMetricSamples(before: number): number {
    return Number(this.execute("DELETE FROM metric_samples WHERE at < ?", before).changes);
  }

  /** Les runs par dépôt et par état. */
  runCountsByRepoState(): { repo: string; state: string; count: number }[] {
    return this.selectAll("SELECT repo, state, COUNT(*) AS n FROM runs GROUP BY repo, state ORDER BY repo, state").map(
      (row) => ({ repo: str(row, "repo"), state: str(row, "state"), count: num(row, "n") }),
    );
  }

  /** Les durées (secondes) des étapes terminées, par dépôt, étape et issue. */
  stepDurations(): StepDurations[] {
    const groups = new Map<string, StepDurations>();
    for (const row of this.selectAll(
      `SELECT r.repo AS repo, s.kind AS kind, s.status AS status, s.ended_at - s.started_at AS ms
       FROM steps s JOIN runs r ON r.id = s.run_id WHERE s.ended_at IS NOT NULL`,
    )) {
      const key = `${str(row, "repo")}\u0000${str(row, "kind")}\u0000${str(row, "status")}`;
      let group = groups.get(key);
      if (!group) {
        group = { repo: str(row, "repo"), step: str(row, "kind"), status: str(row, "status"), seconds: [] };
        groups.set(key, group);
      }
      group.seconds.push(Math.max(0, num(row, "ms")) / 1000);
    }
    return [...groups.values()];
  }

  /** Coût et jetons par dépôt et modèle (`fournisseur/modèle`), depuis la première ligne. */
  usageByRepoModel(): UsageByModel[] {
    return this.selectAll(
      `SELECT repo, provider, model, SUM(cost) AS cost, SUM(input) AS input, SUM(output) AS output,
              SUM(cache_read) AS cache_read, SUM(cache_write) AS cache_write
       FROM usage GROUP BY repo, provider, model`,
    ).map((row) => {
      const provider = strOrNull(row, "provider");
      const model = strOrNull(row, "model");
      return {
        repo: strOrNull(row, "repo") ?? "",
        model: provider && model ? `${provider}/${model}` : (model ?? provider ?? "?"),
        cost: num(row, "cost"),
        input: num(row, "input"),
        output: num(row, "output"),
        cacheRead: num(row, "cache_read"),
        cacheWrite: num(row, "cache_write"),
      };
    });
  }
}
