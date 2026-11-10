// L'appairage par QR code : un ticket à usage unique, court, qui s'échange contre le jeton d'UN appareil.
//
// Le code `omp1:` (harness.sh pair) porte le jeton historique : le même pour tous les appareils, jamais
// révocable seul. Un ticket remplace ce partage : un client connecté (l'app Mac, ou `harness.sh pair-qr`)
// crée un ticket, l'affiche en QR code (`ompconsole://pair?u=<adresse>&t=<ticket>`), l'iPhone le scanne
// avec l'appareil photo, l'échange (`POST /v1/pair/redeem`, sans jeton : le ticket est le secret) et
// reçoit le jeton d'un client NOMMÉ à lui, qui se révoque seul (`DELETE /v1/clients/{nom}`).
//
// - Le ticket tient en mémoire, jamais en base ni dans un fichier : un redémarrage l'invalide, et la
//   mémoire du projet (adresse et jeton, facultatifs) qu'il porte n'est jamais écrite. Seule son empreinte
//   SHA-256 sert de clé.
// - 10 minutes, une seule fois : l'échange le consomme AVANT de créer le client.
// - Un appareil approbateur (celui qui tranche les envois du poste) ne s'obtient que d'un client lui-même
//   approbateur : le droit se délègue, il ne se crée pas par l'API (auth.ts).
// - Les échecs d'échange sont plafonnés (`FAILURES_PER_MINUTE`, tous appelants confondus) : un ticket
//   de 256 bits ne se devine pas, mais la route est publique.
import { createHash, randomBytes } from "node:crypto";
import type { Client, ClientRegistry } from "./auth.ts";
import { HarnessError } from "./errors.ts";

/** La durée de vie d'un ticket. */
export const TICKET_TTL_MS = 10 * 60 * 1000;
/** Les tickets vivants au plus : au-delà, 409 (un humain n'en a pas besoin de plus). */
export const MAX_TICKETS = 10;
/** Les échecs d'échange tolérés par minute, avant 429. */
export const FAILURES_PER_MINUTE = 20;
/** La plus longue étiquette d'appareil, en caractères. */
export const LABEL_MAX = 40;

/** La mémoire du projet qu'un ticket transmet à l'appareil (l'iPhone la lit comme celle du code `omp1:`). */
export type TicketMemory = { url: string; token: string };

type Ticket = { label: string; approver: boolean; memory: TicketMemory | null; createdBy: string; expiresAt: number };

export type PairingTicket = { ticket: string; expiresAt: number; ttlSec: number; approver: boolean };

export type Redeemed = {
  client: Pick<Client, "name" | "role" | "repos" | "approver">;
  token: string;
  memory: TicketMemory | null;
};

function key(ticket: string): string {
  return createHash("sha256").update(ticket, "utf8").digest("hex");
}

/** Une étiquette d'appareil devenue un morceau de nom de client : minuscules, chiffres, `-`. */
function slug(label: string): string {
  const flat = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return flat === "" ? "appareil" : flat;
}

export class PairingDesk {
  readonly #clients: ClientRegistry;
  readonly #now: () => number;
  readonly #tickets = new Map<string, Ticket>();
  #failures: number[] = [];

  constructor(clients: ClientRegistry, now: () => number = Date.now) {
    this.#clients = clients;
    this.#now = now;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [id, ticket] of this.#tickets) if (ticket.expiresAt <= now) this.#tickets.delete(id);
  }

  /**
   * Crée un ticket pour `creator`, un client qui voit tous les dépôts, admin, qui n'est pas un agent.
   * `approver` exige que `creator` le soit lui-même (403 sinon).
   */
  create(creator: Client, input: { label?: string; approver?: boolean; memory?: TicketMemory | null }): PairingTicket {
    if (creator.role !== "admin" || creator.repos !== "*" || creator.pilot)
      throw new HarnessError(403, "l'appairage d'un appareil est réservé au propriétaire (admin, tous les dépôts)");
    const approver = input.approver === true;
    if (approver && !creator.approver)
      throw new HarnessError(
        403,
        "seul l'appareil approbateur peut en appairer un autre comme approbateur (code de `harness.sh approver`)",
      );
    const label = (input.label ?? "").trim();
    if (label.length > LABEL_MAX) throw new HarnessError(400, `label : ${LABEL_MAX} caractères au plus`);
    this.#sweep();
    if (this.#tickets.size >= MAX_TICKETS)
      throw new HarnessError(409, `${MAX_TICKETS} tickets d'appairage sont déjà en attente : attends qu'ils expirent`);
    const ticket = randomBytes(32).toString("base64url");
    const expiresAt = this.#now() + TICKET_TTL_MS;
    this.#tickets.set(key(ticket), {
      label,
      approver,
      memory: input.memory ?? null,
      createdBy: creator.name,
      expiresAt,
    });
    return { ticket, expiresAt, ttlSec: TICKET_TTL_MS / 1000, approver };
  }

  /** Échange un ticket contre le jeton d'un client neuf. Un ticket inconnu, périmé ou déjà échangé : 401. */
  redeem(ticket: string): Redeemed {
    const now = this.#now();
    this.#failures = this.#failures.filter((at) => at > now - 60_000);
    if (this.#failures.length >= FAILURES_PER_MINUTE)
      throw new HarnessError(429, "trop d'échanges refusés : réessaie dans une minute");
    this.#sweep();
    const found = this.#tickets.get(key(ticket));
    if (!found) {
      this.#failures.push(now);
      throw new HarnessError(401, "ticket inconnu, expiré ou déjà utilisé");
    }
    // Consommé avant tout : un échec plus bas ne le rend pas rejouable.
    this.#tickets.delete(key(ticket));
    const name = `${slug(found.label)}-${randomBytes(3).toString("hex")}`;
    try {
      const { client, token } = this.#clients.add(name, "admin", "*", found.approver);
      return {
        client: { name: client.name, role: client.role, repos: client.repos, approver: client.approver },
        token,
        memory: found.memory,
      };
    } catch (err) {
      throw new HarnessError(409, err instanceof Error ? err.message : String(err));
    }
  }

  /** Les tickets vivants (pour les tests et la supervision). */
  pending(): number {
    this.#sweep();
    return this.#tickets.size;
  }
}
