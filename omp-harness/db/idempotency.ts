// Les réponses gardées pour l'idempotence des créations (`Idempotency-Key`, idempotency.ts). Table
// `idempotency_keys` : une ligne par (client, clé), la réponse 2xx telle qu'elle est partie.
import { LocalSessionStore } from "./local-sessions.ts";
import { num, str } from "./sql.ts";

/** La réponse gardée d'une création : de quoi la rejouer à l'identique. */
export type StoredReply = {
  fingerprint: string;
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

export class IdempotencyStore extends LocalSessionStore {
  /** La réponse gardée à cette clé de ce client si elle date de `since` ou après ; `null` sinon (absente ou périmée). */
  idempotentReply(client: string, key: string, since: number): StoredReply | null {
    const row = this.selectOne(
      "SELECT * FROM idempotency_keys WHERE client = ? AND key = ? AND created_at >= ?",
      client,
      key,
      since,
    );
    if (!row) return null;
    return {
      fingerprint: str(row, "fingerprint"),
      status: num(row, "status"),
      headers: JSON.parse(str(row, "headers")) as Record<string, string>,
      body: JSON.parse(str(row, "body")) as unknown,
    };
  }

  /** Garde la réponse, datée de `at` ; une ligne périmée qui portait la même clé est remplacée. */
  rememberReply(client: string, key: string, reply: StoredReply, at: number): void {
    this.execute(
      `INSERT OR REPLACE INTO idempotency_keys (client, key, fingerprint, status, headers, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      client,
      key,
      reply.fingerprint,
      reply.status,
      JSON.stringify(reply.headers),
      JSON.stringify(reply.body),
      at,
    );
  }

  /** Efface les réponses gardées avant `before` ; rend leur nombre. */
  pruneIdempotency(before: number): number {
    return Number(this.execute("DELETE FROM idempotency_keys WHERE created_at < ?", before).changes);
  }
}
