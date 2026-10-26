// Le direct des sessions : les entrées du fil d'un runner, gardées pour la reprise
// d'un client qui se reconnecte, et leur détail (arguments et sortie complets d'un
// outil, texte entier d'un long paragraphe), lu à part.
import { ProviderStore } from "./providers.ts";
import type { SessionDetails, SessionEntry } from "../session-feed.ts";
import { str, strOrNull, num, numOrNull } from "./sql.ts";
import type { Row } from "./sql.ts";

/** Les colonnes d'une entrée compacte : jamais son détail, qui peut peser cent fois plus. */
const ENTRY_COLUMNS = `owner, seq, at, step, kind, text, tool, status, detail, call, ended_at,
  (args IS NOT NULL OR output IS NOT NULL) AS has_details`;

function entryOf(row: Row): SessionEntry {
  return {
    seq: num(row, "seq"),
    at: num(row, "at"),
    step: strOrNull(row, "step"),
    kind: str(row, "kind") as SessionEntry["kind"],
    text: str(row, "text"),
    tool: strOrNull(row, "tool"),
    status: strOrNull(row, "status") as SessionEntry["status"],
    detail: strOrNull(row, "detail"),
    call: strOrNull(row, "call"),
    endedAt: numOrNull(row, "ended_at"),
    hasDetails: num(row, "has_details") === 1,
  };
}

export class SessionStore extends ProviderStore {
  putSessionEntry(owner: string, entry: SessionEntry): void {
    this.execute(
      `INSERT INTO session_entries (owner, seq, at, step, kind, text, tool, status, detail, call, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner, seq) DO UPDATE SET text = excluded.text, status = excluded.status, detail = excluded.detail,
         ended_at = excluded.ended_at`,
      owner,
      entry.seq,
      entry.at,
      entry.step,
      entry.kind,
      entry.text,
      entry.tool,
      entry.status,
      entry.detail,
      entry.call,
      entry.endedAt,
    );
  }

  sessionEntries(owner: string, before: number | null, limit: number): SessionEntry[] {
    return this.selectAll(
      `SELECT * FROM (SELECT ${ENTRY_COLUMNS} FROM session_entries WHERE owner = ? AND (? IS NULL OR seq < ?)
       ORDER BY seq DESC LIMIT ?) ORDER BY seq`,
      owner,
      before,
      before,
      limit,
    ).map(entryOf);
  }

  lastSessionSeq(owner: string): number {
    return num(
      this.selectOne("SELECT COALESCE(MAX(seq), 0) AS seq FROM session_entries WHERE owner = ?", owner) as Row,
      "seq",
    );
  }

  putSessionDetails(owner: string, seq: number, details: SessionDetails): void {
    this.execute(
      "UPDATE session_entries SET args = COALESCE(?, args), output = COALESCE(?, output) WHERE owner = ? AND seq = ?",
      details.args,
      details.output,
      owner,
      seq,
    );
  }

  sessionEntry(owner: string, seq: number): { entry: SessionEntry; details: SessionDetails } | null {
    const row = this.selectOne(
      `SELECT ${ENTRY_COLUMNS}, args, output FROM session_entries WHERE owner = ? AND seq = ?`,
      owner,
      seq,
    );
    if (!row) return null;
    return { entry: entryOf(row), details: { args: strOrNull(row, "args"), output: strOrNull(row, "output") } };
  }

  /** La rétention du direct, celle du journal : les entrées plus vieilles que `before` partent. */
  pruneSessions(before: number): number {
    return Number(this.execute("DELETE FROM session_entries WHERE at < ?", before).changes);
  }
}
