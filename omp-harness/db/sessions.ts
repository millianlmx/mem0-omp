// Le direct des sessions : les entrées du fil d'un runner, gardées pour la reprise
// d'un client qui se reconnecte.
import { ProviderStore } from "./providers.ts";
import type { SessionEntry } from "../session-feed.ts";
import { str, strOrNull, num } from "./sql.ts";
import type { Row } from "./sql.ts";

export class SessionStore extends ProviderStore {
  putSessionEntry(owner: string, entry: SessionEntry): void {
    this.execute(
      `INSERT INTO session_entries (owner, seq, at, step, kind, text, tool, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner, seq) DO UPDATE SET text = excluded.text, status = excluded.status, detail = excluded.detail`,
      owner,
      entry.seq,
      entry.at,
      entry.step,
      entry.kind,
      entry.text,
      entry.tool,
      entry.status,
      entry.detail,
    );
  }

  sessionEntries(owner: string, before: number | null, limit: number): SessionEntry[] {
    return this.selectAll(
      `SELECT * FROM (SELECT * FROM session_entries WHERE owner = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?)
       ORDER BY seq`,
      owner,
      before,
      before,
      limit,
    ).map((row) => ({
      seq: num(row, "seq"),
      at: num(row, "at"),
      step: strOrNull(row, "step"),
      kind: str(row, "kind") as SessionEntry["kind"],
      text: str(row, "text"),
      tool: strOrNull(row, "tool"),
      status: strOrNull(row, "status") as SessionEntry["status"],
      detail: strOrNull(row, "detail"),
    }));
  }

  lastSessionSeq(owner: string): number {
    return num(
      this.selectOne("SELECT COALESCE(MAX(seq), 0) AS seq FROM session_entries WHERE owner = ?", owner) as Row,
      "seq",
    );
  }

  /** La rétention du direct, celle du journal : les entrées plus vieilles que `before` partent. */
  pruneSessions(before: number): number {
    return Number(this.execute("DELETE FROM session_entries WHERE at < ?", before).changes);
  }
}
