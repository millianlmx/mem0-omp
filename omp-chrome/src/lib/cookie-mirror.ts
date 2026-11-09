// Le miroir des cookies : TOUT le profil Chrome de l'utilisateur (tous les domaines, sans
// filtre) recopié en continu dans le navigateur du poste sur le VPS (obscura-poste), pour que
// l'agent y navigue avec les sessions de l'utilisateur. Sens unique Chrome → serveur, par le
// harness (TLS du tailnet).
//
// Le serveur annonce le miroir (`GET /v1/workstation/vps/mirror`) à la seule extension
// désignée comme source, avec une génération : une génération neuve veut dire que le pot de
// cookies du poste a été remis à zéro, et l'extension renvoie alors TOUT le profil. Ensuite,
// seuls les changements partent (`chrome.cookies.onChanged`), regroupés ; une copie complète
// toutes les 30 min rattrape ceux qu'un service worker mort a perdus (la file vit en mémoire).
//
// Module PUR : la source des cookies et le rangement de l'état sont injectés, testables sans
// Chrome. Les valeurs ne sont ni journalisées ni rangées ailleurs qu'en mémoire.

import type { HarnessTarget } from "./harness.ts";
import { HarnessError, harnessCall } from "./harness.ts";

export type SameSite = "no_restriction" | "lax" | "strict" | "unspecified";

/** Un cookie tel que le serveur le reçoit : les champs de `chrome.cookies.Cookie` qui le décrivent, rien d'autre. */
export type MirrorCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  sameSite: SameSite;
  /** Secondes depuis l'epoch, fractionnaires ; absente pour un cookie de session. */
  expirationDate?: number;
};

/** Un cookie tel que `chrome.cookies` le rend (`storeId`, `session`, `partitionKey`… ne partent pas). */
export type SourceCookie = MirrorCookie & { storeId?: string; partitionKey?: unknown };

/** L'information de `chrome.cookies.onChanged`. */
export type CookieChange = { removed: boolean; cookie: SourceCookie; cause: string };

export type CookieKey = { name: string; domain: string; path: string };

/** La génération du miroir en cours et l'heure (ms) de la dernière copie complète acceptée. */
export type MirrorState = { generation: string; fullAt: number };

export type MirrorDeps = {
  /** `chrome.cookies.getAll({})` : tous les cookies du profil. */
  getAll(): Promise<SourceCookie[]>;
  load(): Promise<MirrorState | null>;
  save(state: MirrorState | null): Promise<void>;
  now?: () => number;
  fetcher?: typeof fetch;
};

/** Le profil entier repart au moins toutes les 30 min. */
export const FULL_EVERY_MS = 30 * 60_000;
/** Bornes d'un envoi : le serveur refuse plus de 1000 entrées, ou un corps de plus de 1 Mio. */
export const MAX_CHUNK_ENTRIES = 1000;
export const MAX_CHUNK_BYTES = 512 * 1024;
/** Le magasin de cookies du profil (hors navigation privée). */
const DEFAULT_STORE = "0";
const CALL_TIMEOUT_MS = 20_000;

const MIRROR_ROUTE = "/v1/workstation/vps/mirror";
const COOKIES_ROUTE = "/v1/workstation/vps/cookies";

type Pending = { kind: "set"; cookie: MirrorCookie } | { kind: "removed"; key: CookieKey };

/** Le cookie réduit aux champs du contrat. */
export function mirrorCookie(cookie: SourceCookie): MirrorCookie {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    hostOnly: cookie.hostOnly,
    sameSite: cookie.sameSite,
    ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
  };
}

const encoder = new TextEncoder();

/** Découpe en lots d'au plus `MAX_CHUNK_ENTRIES` entrées et d'environ `MAX_CHUNK_BYTES` de JSON. */
function chunked<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = encoder.encode(JSON.stringify(item)).length + 1;
    if (chunk.length > 0 && (chunk.length >= MAX_CHUNK_ENTRIES || bytes + size > MAX_CHUNK_BYTES)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(item);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export class CookieMirror {
  readonly #deps: MirrorDeps;
  /** Les changements à envoyer, le dernier l'emporte par cookie (nom, domaine, chemin). */
  readonly #pending = new Map<string, Pending>();
  /** Un seul échange à la fois avec le serveur : une copie complète et un envoi de changements ne se croisent pas. */
  #chain: Promise<unknown> = Promise.resolve();

  constructor(deps: MirrorDeps) {
    this.#deps = deps;
  }

  /** Le nombre de changements en attente. */
  get pending(): number {
    return this.#pending.size;
  }

  /**
   * Range un changement de `chrome.cookies.onChanged`. Un retrait pour écrasement est
   * ignoré (la pose qui suit le remplace) ; la navigation privée et les cookies partitionnés,
   * que la copie complète ne lit pas, non plus.
   */
  recordChange(change: CookieChange): void {
    const { cookie } = change;
    if ((cookie.storeId ?? DEFAULT_STORE) !== DEFAULT_STORE || cookie.partitionKey !== undefined) return;
    if (change.removed && change.cause === "overwrite") return;
    const key = { name: cookie.name, domain: cookie.domain, path: cookie.path };
    this.#pending.set(
      JSON.stringify([key.name, key.domain, key.path]),
      change.removed ? { kind: "removed", key } : { kind: "set", cookie: mirrorCookie(cookie) },
    );
  }

  /**
   * Le tour du miroir : sans miroir pour ce navigateur, oublie la génération et les
   * changements ; génération neuve ou copie complète de plus de 30 min, renvoie tout le
   * profil ; puis envoie les changements. Lève sur un échec (le tour suivant reprend).
   */
  tick(target: HarnessTarget): Promise<void> {
    return this.#serial(async () => {
      const answer = await harnessCall<{ mirror: { generation: string } | null }>(
        target,
        "GET",
        MIRROR_ROUTE,
        undefined,
        this.#options(),
      );
      const generation = answer?.mirror?.generation;
      if (typeof generation !== "string") {
        this.#pending.clear();
        await this.#deps.save(null);
        return;
      }
      const state = await this.#deps.load();
      if (state?.generation !== generation || this.#now() - state.fullAt >= FULL_EVERY_MS)
        await this.#fullCopy(target, generation);
      await this.#flush(target);
    });
  }

  /** Envoie les changements en attente avec la génération rangée ; sans génération, ils sont abandonnés. */
  flush(target: HarnessTarget): Promise<void> {
    return this.#serial(() => this.#flush(target));
  }

  #serial(work: () => Promise<void>): Promise<void> {
    const next = this.#chain.then(work);
    this.#chain = next.catch(() => undefined);
    return next;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  #options() {
    return {
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      ...(this.#deps.fetcher === undefined ? {} : { fetcher: this.#deps.fetcher }),
    };
  }

  /** Un 409 : la génération est périmée, elle est oubliée et la copie complète repart au tour suivant. */
  async #post(target: HarnessTarget, body: Record<string, unknown>): Promise<void> {
    try {
      await harnessCall(target, "POST", COOKIES_ROUTE, body, this.#options());
    } catch (error) {
      if (error instanceof HarnessError && error.status === 409) await this.#deps.save(null);
      throw error;
    }
  }

  async #fullCopy(target: HarnessTarget, generation: string): Promise<void> {
    const startedAt = this.#now();
    // Le profil lu ici couvre tout changement déjà en attente ; ceux qui suivent partiront après.
    this.#pending.clear();
    const cookies = (await this.#deps.getAll()).map(mirrorCookie);
    const chunks = cookies.length === 0 ? [[]] : chunked(cookies);
    for (const [index, set] of chunks.entries()) {
      const last = index === chunks.length - 1;
      await this.#post(target, { generation, full: true, ...(last ? { last: true } : {}), set });
    }
    await this.#deps.save({ generation, fullAt: startedAt });
  }

  async #flush(target: HarnessTarget): Promise<void> {
    if (this.#pending.size === 0) return;
    const state = await this.#deps.load();
    if (state === null) {
      this.#pending.clear();
      return;
    }
    for (const chunk of chunked([...this.#pending.entries()])) {
      const set: MirrorCookie[] = [];
      const removed: CookieKey[] = [];
      for (const [, entry] of chunk) {
        if (entry.kind === "set") set.push(entry.cookie);
        else removed.push(entry.key);
      }
      await this.#post(target, {
        generation: state.generation,
        ...(set.length > 0 ? { set } : {}),
        ...(removed.length > 0 ? { removed } : {}),
      });
      // Un changement arrivé pendant l'envoi reste en attente.
      for (const [key, entry] of chunk) if (this.#pending.get(key) === entry) this.#pending.delete(key);
    }
  }
}
