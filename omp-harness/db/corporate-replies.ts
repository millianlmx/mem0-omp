// Le pont corpo ↔ usine, la réponse au collègue : un brouillon rédigé par le serveur après la
// fusion (`final`) ou l'échec (`attente`) d'un run lié, une ligne par run et par sorte
// (`UNIQUE (run_id, kind)` : l'unicité tient au redémarrage). Les règles (gabarit, états,
// envoi par une demande du poste) vivent dans corporate/replies.ts.
import { WatchStore } from "./watch-items.ts";
import { num, numOrNull, str, strOrNull } from "./sql.ts";
import type { Row, SqlValue } from "./sql.ts";

export const REPLY_KINDS = ["final", "attente"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

/** `draft` est dans « À traiter », `pending` attend l'envoi de la demande du poste, `sent` est parti, `archived` est classé. */
export const REPLY_STATES = ["draft", "pending", "sent", "archived"] as const;
export type ReplyState = (typeof REPLY_STATES)[number];

export type ReplyRow = {
  id: string;
  createdAt: number;
  updatedAt: number;
  runId: string;
  signalId: string;
  kind: ReplyKind;
  state: ReplyState;
  text: string;
  requestId: string | null;
  sendSeq: number | null;
  error: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
  sentAt: number | null;
  archivedBy: string | null;
  archivedAt: number | null;
};

export type NewReply = Pick<ReplyRow, "id" | "runId" | "signalId" | "kind" | "text">;

export type ReplyPatch = Partial<Omit<ReplyRow, "id" | "createdAt" | "updatedAt" | "runId" | "signalId" | "kind">>;

/** Un run lié terminé, tel que la réconciliation le lit. `latest` : aucun run plus récent de la même origine. */
export type LinkedRun = { runId: string; signalId: string; runState: string; latest: boolean };

const COLUMNS: Record<keyof ReplyPatch, string> = {
  state: "state",
  text: "text",
  requestId: "request_id",
  sendSeq: "send_seq",
  error: "error",
  approvedBy: "approved_by",
  approvedAt: "approved_at",
  sentAt: "sent_at",
  archivedBy: "archived_by",
  archivedAt: "archived_at",
};

function replyOf(row: Row): ReplyRow {
  return {
    id: str(row, "id"),
    createdAt: num(row, "created_at"),
    updatedAt: num(row, "updated_at"),
    runId: str(row, "run_id"),
    signalId: str(row, "signal_id"),
    kind: str(row, "kind") as ReplyKind,
    state: str(row, "state") as ReplyState,
    text: str(row, "text"),
    requestId: strOrNull(row, "request_id"),
    sendSeq: numOrNull(row, "send_seq"),
    error: strOrNull(row, "error"),
    approvedBy: strOrNull(row, "approved_by"),
    approvedAt: numOrNull(row, "approved_at"),
    sentAt: numOrNull(row, "sent_at"),
    archivedBy: strOrNull(row, "archived_by"),
    archivedAt: numOrNull(row, "archived_at"),
  };
}

export class CorporateReplyStore extends WatchStore {
  /** Écrit un brouillon ; `null` si le run en a déjà un de cette sorte (unicité par run et par sorte). */
  insertReply(input: NewReply): ReplyRow | null {
    const at = this.now();
    const result = this.execute(
      `INSERT OR IGNORE INTO corporate_replies (id, created_at, updated_at, run_id, signal_id, kind, state, text)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?)`,
      input.id,
      at,
      at,
      input.runId,
      input.signalId,
      input.kind,
      input.text,
    );
    return Number(result.changes) > 0 ? this.getReply(input.id) : null;
  }

  getReply(id: string): ReplyRow | null {
    const row = this.selectOne("SELECT * FROM corporate_replies WHERE id = ?", id);
    return row ? replyOf(row) : null;
  }

  /** Les brouillons d'un run (au plus un par sorte). */
  repliesOfRun(runId: string): ReplyRow[] {
    return this.selectAll("SELECT * FROM corporate_replies WHERE run_id = ? ORDER BY created_at, id", runId).map(
      replyOf,
    );
  }

  /** Les brouillons des états donnés (tous si la liste est vide), récents d'abord. */
  listReplies(options: { states?: readonly ReplyState[]; limit?: number } = {}): ReplyRow[] {
    const states = options.states ?? [];
    const where = states.length > 0 ? `WHERE state IN (${states.map(() => "?").join(", ")})` : "";
    return this.selectAll(
      `SELECT * FROM corporate_replies ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...states,
      options.limit ?? 50,
    ).map(replyOf);
  }

  /** Le brouillon que la demande du poste `requestId` envoie (la dernière approbation). */
  replyOfRequest(requestId: string): ReplyRow | null {
    const row = this.selectOne("SELECT * FROM corporate_replies WHERE request_id = ?", requestId);
    return row ? replyOf(row) : null;
  }

  /** Les brouillons « en attente d'approbation » : l'envoi que leur demande du poste porte reste à suivre. */
  pendingReplies(): ReplyRow[] {
    return this.selectAll("SELECT * FROM corporate_replies WHERE state = 'pending' ORDER BY created_at, id").map(
      replyOf,
    );
  }

  /** Les brouillons `attente` encore à l'état « brouillon » : ceux que le classement automatique peut retirer. */
  draftAttentes(): ReplyRow[] {
    return this.selectAll(
      "SELECT * FROM corporate_replies WHERE state = 'draft' AND kind = 'attente' ORDER BY created_at, id",
    ).map(replyOf);
  }

  /** Applique un patch si le brouillon est encore dans l'un des états `expected` ; `null` sinon. */
  updateReplyIf(id: string, expected: readonly ReplyState[], patch: ReplyPatch): ReplyRow | null {
    const sets: string[] = ["updated_at = ?"];
    const params: SqlValue[] = [this.now()];
    for (const [key, column] of Object.entries(COLUMNS) as [keyof ReplyPatch, string][]) {
      const value = patch[key];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    const result = this.execute(
      `UPDATE corporate_replies SET ${sets.join(", ")} WHERE id = ? AND state IN (${expected.map(() => "?").join(", ")})`,
      ...params,
      id,
      ...expected,
    );
    return Number(result.changes) > 0 ? this.getReply(id) : null;
  }

  /** Marque l'action d'envoi (`seq`) du brouillon que la demande envoie ; sans brouillon `pending`, rien. */
  markReplySend(requestId: string, seq: number): void {
    this.execute(
      "UPDATE corporate_replies SET send_seq = ?, updated_at = ? WHERE request_id = ? AND state = 'pending'",
      seq,
      this.now(),
      requestId,
    );
  }

  /** Les runs liés à une origine et terminés (fusionnés, échoués, annulés), avec leur rang dans l'origine. */
  linkedRunsToReconcile(): LinkedRun[] {
    return this.selectAll(
      `SELECT l.run_id AS run_id, l.signal_id AS signal_id, r.state AS run_state,
              NOT EXISTS (
                SELECT 1 FROM corporate_signal_runs o
                WHERE o.signal_id = l.signal_id
                  AND (o.created_at > l.created_at OR (o.created_at = l.created_at AND o.rowid > l.rowid))
              ) AS latest
       FROM corporate_signal_runs l JOIN runs r ON r.id = l.run_id
       WHERE r.state IN ('merged', 'failed', 'cancelled')
       ORDER BY l.created_at, l.rowid`,
    ).map((row) => ({
      runId: str(row, "run_id"),
      signalId: str(row, "signal_id"),
      runState: str(row, "run_state"),
      latest: num(row, "latest") === 1,
    }));
  }

  /** Aucun run plus récent ne porte la même origine que ce run lié (`true` aussi s'il n'est lié à rien). */
  isLatestLinkedRun(runId: string): boolean {
    const row = this.selectOne(
      `SELECT NOT EXISTS (
                SELECT 1 FROM corporate_signal_runs o JOIN corporate_signal_runs l ON l.run_id = ? AND o.signal_id = l.signal_id
                WHERE o.created_at > l.created_at OR (o.created_at = l.created_at AND o.rowid > l.rowid)
              ) AS latest`,
      runId,
    );
    return row !== undefined && num(row, "latest") === 1;
  }
}
