// Les contextes de navigation des outils MCP `browser_*` : un contexte (un contexte de Moli, sur
// sa connexion CDP) appartient au client qui l'a ouvert, et à lui seul. Bornés par client et au
// total, fermés (contexte supprimé dans Moli) après inactivité et à l'arrêt. Le journal ne reçoit
// que des noms de classe et de méthode : jamais d'URL, d'hôte, de message de Moli ni de texte de page.
import { randomBytes } from "node:crypto";
import type { Client } from "../auth.ts";
import type { HarnessConfig } from "../config.ts";
import { HarnessError } from "../errors.ts";
import type { LogLine } from "../logger.ts";
import { untrusted } from "../workstation-guards.ts";
import { CdpClosedError, CdpConnectError, CdpError, CdpTimeoutError } from "./cdp.ts";
import { GuardRefusal, checkUrl } from "./guard.ts";
import type { Lookup } from "./guard.ts";
import { BrowserSession, BrowserUsageError, UnknownRef } from "./session.ts";
import type { SessionTarget } from "./session.ts";
import type { PageSnapshot } from "./snapshot.ts";

export type BrowserConfig = HarnessConfig["browser"];

const MAX_DETAIL = 500;
const SWEEP_MAX_MS = 60_000;

const detail = (text: string): string =>
  untrusted("navigateur (Moli)", text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text);

/**
 * L'erreur que l'agent reçoit. Tout texte venu de la page ou de Moli (hôte, URL, raison de
 * refus, message CDP, exception) est enveloppé comme contenu non fiable, rogné ; le libellé
 * fixe du harness reste dehors. Une erreur inattendue remonte telle quelle (500).
 */
export function browserError(error: unknown): HarnessError {
  if (error instanceof HarnessError) return error;
  if (error instanceof GuardRefusal) return new HarnessError(403, `adresse refusée :\n${detail(error.reason)}`);
  if (error instanceof CdpError)
    return new HarnessError(
      502,
      error.remote
        ? `navigateur : ${error.method} :\n${detail(error.message)}`
        : `navigateur : ${error.method} : ${error.message}`,
    );
  if (error instanceof BrowserUsageError) return new HarnessError(400, error.message);
  if (error instanceof UnknownRef)
    return new HarnessError(400, `référence inconnue : ${error.ref} (reprends browser_snapshot)`);
  if (error instanceof CdpTimeoutError) return new HarnessError(504, `navigateur : ${error.message} — contexte fermé`);
  if (error instanceof CdpConnectError) return new HarnessError(502, error.message);
  if (error instanceof CdpClosedError) return new HarnessError(502, "navigateur : connexion perdue — contexte fermé");
  throw error;
}

type Context = {
  id: string;
  owner: string;
  session: BrowserSession;
  lastUsedAt: number;
  /** Les opérations d'un contexte passent l'une après l'autre. */
  queue: Promise<unknown>;
};

export class BrowserDesk {
  readonly #config: () => BrowserConfig;
  readonly #log: LogLine;
  readonly #lookup: Lookup | undefined;
  readonly #contexts = new Map<string, Context>();
  /** Les ouvertures en cours, par client : elles comptent dans les bornes avant même d'aboutir. */
  readonly #opening = new Map<string, number>();
  #openingTotal = 0;
  #sweeper: NodeJS.Timeout | undefined;

  constructor(config: () => BrowserConfig, deps: { log: LogLine; lookup?: Lookup }) {
    this.#config = config;
    this.#log = deps.log;
    this.#lookup = deps.lookup;
  }

  /** Ouvre un contexte sur `url` : son id et son snapshot. */
  async open(client: Client, url: string): Promise<{ id: string; snapshot: PageSnapshot }> {
    const config = this.#config();
    if (config.url === null) throw new HarnessError(503, "navigateur non configuré (browser.url)");
    const own = [...this.#contexts.values()].filter((context) => context.owner === client.name).length;
    if (own + (this.#opening.get(client.name) ?? 0) >= config.maxContextsPerClient)
      throw new HarnessError(
        429,
        `trop de contextes ouverts : ${config.maxContextsPerClient} au plus par client — ferme-en un (browser_close)`,
      );
    if (this.#contexts.size + this.#openingTotal >= config.maxContexts)
      throw new HarnessError(429, `navigateur saturé : ${config.maxContexts} contextes ouverts`);
    // Réservé avant le premier await : deux ouvertures simultanées ne passent pas la borne ensemble.
    this.#opening.set(client.name, (this.#opening.get(client.name) ?? 0) + 1);
    this.#openingTotal += 1;
    try {
      const guard = {
        allowPrivateNetwork: config.allowPrivateNetwork,
        ...(this.#lookup ? { lookup: this.#lookup } : {}),
      };
      const verdict = await checkUrl(url, guard);
      if (!verdict.ok) throw new GuardRefusal(verdict.reason);
      const target: SessionTarget = {
        url: config.url,
        token: config.token,
        allowPrivateNetwork: config.allowPrivateNetwork,
        callTimeoutMs: config.callTimeoutSec * 1000,
        ...(this.#lookup ? { lookup: this.#lookup } : {}),
      };
      const session = await BrowserSession.open(target);
      let snapshot: PageSnapshot;
      try {
        await session.navigate(url);
        snapshot = await session.snapshot();
      } catch (error) {
        await session.close();
        throw error;
      }
      const id = `bx_${randomBytes(8).toString("hex")}`;
      this.#contexts.set(id, { id, owner: client.name, session, lastUsedAt: Date.now(), queue: Promise.resolve() });
      this.#log(`navigateur : contexte ${id} ouvert (client ${client.name})`);
      this.#startSweeper(config);
      return { id, snapshot };
    } finally {
      const left = (this.#opening.get(client.name) ?? 1) - 1;
      if (left === 0) this.#opening.delete(client.name);
      else this.#opening.set(client.name, left);
      this.#openingTotal -= 1;
    }
  }

  /** Une opération sur un contexte du client ; un délai, une connexion perdue ou un refus le ferment. */
  async use<T>(client: Client, id: string, fn: (session: BrowserSession) => Promise<T>): Promise<T> {
    const context = this.#find(client, id);
    const run = context.queue.then(async () => {
      if (this.#contexts.get(id) !== context) throw unknown(id);
      context.lastUsedAt = Date.now();
      try {
        return await fn(context.session);
      } catch (error) {
        if (error instanceof CdpTimeoutError || error instanceof CdpClosedError || error instanceof GuardRefusal)
          await this.#drop(context, "erreur", error);
        throw error;
      } finally {
        context.lastUsedAt = Date.now();
      }
    });
    context.queue = run.catch(() => undefined);
    return run;
  }

  async close(client: Client, id: string): Promise<void> {
    const context = this.#find(client, id);
    const done = context.queue.then(() => this.#drop(context, "close"));
    context.queue = done;
    await done;
  }

  async stop(): Promise<void> {
    clearInterval(this.#sweeper);
    this.#sweeper = undefined;
    await Promise.all([...this.#contexts.values()].map((context) => this.#drop(context, "arrêt")));
  }

  /** Même message pour un id inconnu, celui d'un autre client et un contexte expiré. */
  #find(client: Client, id: string): Context {
    const context = this.#contexts.get(id);
    if (context === undefined || context.owner !== client.name) throw unknown(id);
    if (Date.now() - context.lastUsedAt > this.#config().idleSec * 1000) {
      void this.#drop(context, "idle");
      throw unknown(id);
    }
    return context;
  }

  /** Retire le contexte ; la promesse rendue est sa suppression dans Moli (elle ne lève jamais). */
  #drop(context: Context, reason: string, error?: unknown): Promise<void> {
    if (!this.#contexts.delete(context.id)) return Promise.resolve();
    const closed = context.session.close();
    const cause =
      error instanceof Error
        ? ` (${error.name}${error instanceof CdpError || error instanceof CdpTimeoutError ? ` ${error.method}` : ""})`
        : "";
    this.#log(`navigateur : contexte ${context.id} fermé, ${reason}${cause} (client ${context.owner})`);
    return closed;
  }

  #startSweeper(config: BrowserConfig): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(
      () => {
        const idleMs = this.#config().idleSec * 1000;
        for (const context of [...this.#contexts.values()])
          if (Date.now() - context.lastUsedAt > idleMs) void this.#drop(context, "idle");
      },
      Math.min((config.idleSec * 1000) / 2, SWEEP_MAX_MS),
    );
    this.#sweeper.unref();
  }
}

function unknown(id: string): HarnessError {
  return new HarnessError(404, `contexte inconnu : ${id}`);
}
