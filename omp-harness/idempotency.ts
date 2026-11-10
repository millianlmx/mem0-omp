// L'idempotence des créations : un client qui rejoue une requête (réseau coupé après l'envoi, relance
// d'un script, geste en double d'un téléphone) ne crée pas deux fois la même chose, et chaque run coûte
// des dollars. Il pose l'en-tête `Idempotency-Key` ; la première réponse 2xx est gardée 24 h et rendue
// telle quelle (en-tête `Idempotent-Replay: true`) à la même clé du MÊME client. Les clés des clients ne
// se mélangent jamais.
//
// - Même clé, autre requête (autre route ou autre corps) : 422, rien n'est créé.
// - Même clé pendant que la première requête court encore : 409, le client réessaie.
// - Une requête refusée ou en échec n'est pas gardée : la relance repart de zéro.
// - Sans en-tête : rien ne change.
import { createHash } from "node:crypto";
import type http from "node:http";
import type { Store } from "./db.ts";
import { HarnessError } from "./errors.ts";

/** La durée pendant laquelle une réponse gardée est rejouée. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const KEY = /^[\w.:-]{1,128}$/;

/** Une réponse prête à partir (ou rejouée). */
export type Reply = { status: number; body: unknown; headers?: Record<string, string> };

/** L'en-tête `Idempotency-Key` de la requête : `null` s'il est absent, 400 s'il est mal formé. */
export function idempotencyKey(req: http.IncomingMessage): string | null {
  const header = req.headers["idempotency-key"];
  if (header === undefined) return null;
  if (typeof header !== "string" || !KEY.test(header.trim()))
    throw new HarnessError(
      400,
      "Idempotency-Key : 1 à 128 caractères parmi lettres, chiffres, « . », « _ », « : » et « - »",
    );
  return header.trim();
}

/** L'empreinte d'une requête : sa méthode, son chemin et son corps JSON. */
export function fingerprintOf(method: string, path: string, body: unknown): string {
  return createHash("sha256")
    .update(`${method} ${path}\n${JSON.stringify(body)}`)
    .digest("hex");
}

export class IdempotencyGuard {
  readonly #store: Store;
  readonly #now: () => number;
  readonly #inflight = new Set<string>();

  constructor(store: Store, now: () => number = Date.now) {
    this.#store = store;
    this.#now = now;
  }

  /**
   * Fait la création, ou rejoue sa réponse. `key` `null` : `make` seul. `replayed` dit si la réponse
   * vient du magasin.
   */
  async run(
    client: string,
    key: string | null,
    fingerprint: string,
    make: () => Promise<Reply> | Reply,
  ): Promise<Reply & { replayed: boolean }> {
    if (key === null) return { ...(await make()), replayed: false };
    const kept = this.#store.idempotentReply(client, key, this.#now() - IDEMPOTENCY_TTL_MS);
    if (kept) {
      if (kept.fingerprint !== fingerprint)
        throw new HarnessError(422, "Idempotency-Key déjà employée pour une autre requête : prends une nouvelle clé");
      return { status: kept.status, body: kept.body, headers: kept.headers, replayed: true };
    }
    const slot = `${client}\u0000${key}`;
    if (this.#inflight.has(slot))
      throw new HarnessError(409, "une requête de même Idempotency-Key est en cours : réessaie dans un instant");
    this.#inflight.add(slot);
    try {
      const reply = await make();
      if (reply.status >= 200 && reply.status < 300)
        this.#store.rememberReply(
          client,
          key,
          { fingerprint, status: reply.status, headers: reply.headers ?? {}, body: reply.body },
          this.#now(),
        );
      return { ...reply, replayed: false };
    } finally {
      this.#inflight.delete(slot);
    }
  }
}
