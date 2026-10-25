// Le journal d'événements : écrit en base et rejoué par le flux SSE, ou éphémère
// (poussé en direct, jamais écrit). Un événement porte le dépôt de son run, qui sert
// au filtrage par client.
import { RunStore } from "./runs.ts";
import { str, strOrNull, num, json } from "./sql.ts";
import type { SqlValue, Row, RepoFilter } from "./sql.ts";

/**
 * Un événement du journal. `repo` sert au filtrage par client (un client ne voit que
 * ses dépôts). Un événement ÉPHÉMÈRE (`id` 0) est poussé en direct, jamais stocké.
 */
export type EventRow = {
  id: number;
  at: number;
  runId: string | null;
  repo: string | null;
  type: string;
  payload: Record<string, unknown>;
  ephemeral?: true;
};

function eventOf(row: Row): EventRow {
  return {
    id: num(row, "id"),
    at: num(row, "at"),
    runId: strOrNull(row, "run_id"),
    repo: strOrNull(row, "repo"),
    type: str(row, "type"),
    payload: json<Record<string, unknown>>(row, "payload", {}),
  };
}

export class JournalStore extends RunStore {
  /**
   * Écrit un événement au journal et l'annonce aux abonnés (au COMMIT s'il est écrit
   * dans une transaction). `repo` est déduit du run quand il n'est pas donné.
   */
  appendEvent(
    type: string,
    runId: string | null,
    payload: Record<string, unknown> = {},
    repo: string | null = null,
  ): EventRow {
    const at = this.now();
    const owner =
      repo ??
      (runId !== null ? (this.getRun(runId)?.repo ?? null) : typeof payload.repo === "string" ? payload.repo : null);
    const result = this.execute(
      "INSERT INTO events (at, run_id, repo, type, payload) VALUES (?, ?, ?, ?, ?)",
      at,
      runId,
      owner,
      type,
      JSON.stringify(payload),
    );
    const event: EventRow = { id: Number(result.lastInsertRowid), at, runId, repo: owner, type, payload };
    this.emit(event);
    return event;
  }

  /**
   * Un événement ÉPHÉMÈRE : poussé aux abonnés en direct, jamais écrit (activité des
   * outils, attente d'admission). Il ne fait pas avancer le curseur du journal.
   */
  publish(
    type: string,
    runId: string | null,
    payload: Record<string, unknown> = {},
    repo: string | null = null,
  ): EventRow {
    const owner =
      repo ??
      (runId !== null ? (this.getRun(runId)?.repo ?? null) : typeof payload.repo === "string" ? payload.repo : null);
    const event: EventRow = { id: 0, at: this.now(), runId, repo: owner, type, payload, ephemeral: true };
    this.notify(event);
    return event;
  }

  eventsSince(afterId: number, runId: string | null = null, limit = 500, repos: RepoFilter = null): EventRow[] {
    const where = ["id > ?"];
    const params: SqlValue[] = [afterId];
    if (runId !== null) {
      where.push("run_id = ?");
      params.push(runId);
    }
    if (repos !== null) {
      if (repos.length === 0) return [];
      where.push(`repo IN (${repos.map(() => "?").join(", ")})`);
      params.push(...repos);
    }
    return this.selectAll(
      `SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id LIMIT ?`,
      ...params,
      limit,
    ).map(eventOf);
  }

  /** Les événements d'un type, des dépôts que voit le lecteur (le journal garde `events.retentionDays`). */
  eventsOfType(type: string, repos: RepoFilter = null): EventRow[] {
    if (repos !== null && repos.length === 0) return [];
    const where = ["type = ?"];
    const params: SqlValue[] = [type];
    if (repos !== null) {
      where.push(`repo IN (${repos.map(() => "?").join(", ")})`);
      params.push(...repos);
    }
    return this.selectAll(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id`, ...params).map(eventOf);
  }

  /** Le dernier identifiant du journal (0 s'il est vide) : le curseur d'un abonnement qui ne veut que la suite. */
  lastEventId(): number {
    return num(this.selectOne("SELECT COALESCE(MAX(id), 0) AS id FROM events") as Row, "id");
  }

  /**
   * La rétention du journal : les événements plus vieux que `before` (ms) partent,
   * sauf le dernier (le curseur ne recule jamais). Rend le nombre d'événements purgés.
   */
  pruneEvents(before: number): number {
    const result = this.execute(
      "DELETE FROM events WHERE at < ? AND id < (SELECT COALESCE(MAX(id), 0) FROM events)",
      before,
    );
    return Number(result.changes);
  }
}
