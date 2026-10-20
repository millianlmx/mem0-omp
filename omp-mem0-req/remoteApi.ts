// Le PROTOCOLE DISTANT du VPS (S-2, socle de S-3) : le routeur `/v1` que l'app iOS
// et omp-console parlent au VPS, avec la garde du Mac (`RemoteGuard.swift`) et la
// forme d'erreur du Mac (`HTTPStatus.swift`) — un client appairé au VPS ne doit pas
// pouvoir dire de quelle machine il reçoit une réponse, hors du champ `machine`.
//
// Ce module est le SOCLE : garde, appairage, `version`, `devices`. Les routes de
// parité (S-3) s'y ajoutent par `RemoteApiDeps.routes`, sans toucher à la garde.
//
// Web standard (`Request` → `Response`), SANS `Bun` : la suite de tests l'exerce
// sous `node --test`. L'adresse source vient de l'hôte (`server.requestIP`) et
// entre en argument — ce module ne lit aucun socket.
import * as net from "node:net";
import { DeviceRegistryError, isWellFormedPairingCode, normalizePairingCode, DEVICE_NAME_MAX } from "./remoteDevices.ts";
import type { DeviceRecord, DeviceRegistry } from "./remoteDevices.ts";


/** La version du protocole distant : celle du Mac (`ConsoleAPI.protocolVersion`). */
export const REMOTE_PROTOCOL_VERSION = 3;

/** L'en-tête de version, requête comme réponse (`ConsoleAPI.Service.protocolHeader`). */
export const REMOTE_PROTOCOL_HEADER = "X-Console-Protocol-Version";

/** Borne du corps d'une requête : au-delà, 400 — jamais un fichier avalé. */
export const REMOTE_BODY_MAX = 1024 * 1024;

/** Le jeton Bearer d'un appareil ne dépasse jamais 512 octets (`RemoteGuard.authorize`). */
const BEARER_MAX_BYTES = 512;


// --- erreurs : la table de `HTTPStatus.swift` ------------------------------------

export type RemoteErrorCode =
  | "bad_request"
  | "unauthorized"
  | "incompatible_protocol"
  | "not_found"
  | "conflict"
  | "unavailable"
  | "outdated_service"
  | "server"
  | "decoding";

const STATUS_BY_CODE: Record<RemoteErrorCode, number> = {
  bad_request: 400,
  incompatible_protocol: 400,
  unauthorized: 401,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  outdated_service: 503,
  server: 500,
  decoding: 500,
};

/** Une erreur du protocole distant : un code STABLE, un message lisible (absent pour `unauthorized`). */
export class RemoteError extends Error {
  readonly code: RemoteErrorCode;
  readonly status: number;
  /** `unauthorized` ne porte pas de message : la clé `message` est alors OMISE du corps. */
  readonly hasMessage: boolean;

  constructor(code: RemoteErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RemoteError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.hasMessage = message !== undefined;
  }
}



// --- JSON à clés triées -----------------------------------------------------------

/**
 * Le JSON des réponses : clés triées à tous les niveaux (deux réponses de même
 * contenu sont octet pour octet identiques — `HTTPJSON.encoder`), `undefined`
 * omis (un optionnel `nil` du Mac n'a pas de clé). Écrit à la main plutôt que par
 * `JSON.stringify` d'un objet retrié : un objet JS réordonne les clés qui ressemblent
 * à des entiers, ce qui casserait l'ordre d'une table indexée par des nombres.
 */
export function sortedJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(item => sortedJson(item === undefined ? null : item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const item = record[key];
    if (item !== undefined) parts.push(`${JSON.stringify(key)}:${sortedJson(item)}`);
  }
  return `{${parts.join(",")}}`;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

export function remoteJson(payload: unknown, status = 200): Response {
  return new Response(sortedJson(payload), { status, headers: { "Content-Type": JSON_CONTENT_TYPE } });
}

/** Le corps d'erreur : `{"error":{"code":…,"message":…}}`, `message` omis quand le cas n'en porte pas. */
function errorResponse(err: RemoteError): Response {
  const inner: Record<string, string> = { code: err.code };
  if (err.hasMessage) inner.message = err.message;
  return remoteJson({ error: inner }, err.status);
}


// --- la garde d'adresse source ------------------------------------------------------

/** Les 8 groupes d'une adresse IPv6 (zone et queue IPv4 comprises), ou `null`. */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!net.isIPv6(text)) return null;
  // Une queue IPv4 (`::ffff:100.64.0.1`) vaut deux groupes.
  const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/u.exec(text);
  if (tail !== null) {
    const [, a, b, c, d] = tail.map(Number);
    const high = ((a ?? 0) << 8) | (b ?? 0);
    const low = ((c ?? 0) << 8) | (d ?? 0);
    text = `${text.slice(0, tail.index)}${high.toString(16)}:${low.toString(16)}`;
  }
  const halves = text.split("::");
  const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
  const rest = halves.length === 2 ? (halves[1] === "" ? [] : (halves[1] ?? "").split(":")) : [];
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (fill < 0) return null;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...rest].map(group => Number.parseInt(group, 16));
  return groups.length === 8 && groups.every(group => Number.isInteger(group)) ? groups : null;
}

/** 127.0.0.0/8 (boucle locale) et 100.64.0.0/10 (Tailscale, IPv4). */
function trustedIPv4(address: string): boolean {
  const octets = address.split(".").map(Number);
  const [a, b] = octets;
  if (a === 127) return true;
  return a === 100 && b !== undefined && b >= 64 && b <= 127;
}

/**
 * La source est-elle locale ou du tailnet ? 127.0.0.0/8, 100.64.0.0/10,
 * fd7a:115c:a1e0::/48 (l'IPv6 de Tailscale) et `::1` ; une IPv4 mappée en IPv6
 * est jugée sur sa partie IPv4. Toute autre adresse — ou aucune — est refusée.
 * Défense EN PROFONDEUR : le pare-feu n'ouvre déjà le port que sur `tailscale0`.
 */
export function isTrustedSource(address: string | null): boolean {
  if (address === null) return false;
  if (net.isIPv4(address)) return trustedIPv4(address);
  const groups = ipv6Groups(address);
  if (groups === null) return false;
  const [g0, g1, g2] = groups;
  if (g0 === 0xfd7a && g1 === 0x115c && g2 === 0xa1e0) return true;
  if (groups.slice(0, 7).every(group => group === 0) && groups[7] === 1) return true;
  if (groups.slice(0, 5).every(group => group === 0) && groups[5] === 0xffff) {
    const high = groups[6] ?? 0;
    const low = groups[7] ?? 0;
    return trustedIPv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }
  return false;
}


// --- la garde (même ordre que `RemoteGuard.evaluate`) -------------------------------

/** La forme décimale canonique : des chiffres, pas de signe, pas de zéro de tête (`0` accepté). */
function canonicalInteger(raw: string): number | null {
  if (!/^[0-9]+$/u.test(raw)) return null;
  if (raw.length > 1 && raw.startsWith("0")) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/** La version de protocole : en-tête UNIQUE, entier canonique, égal à celle du socle. */
function versionRefusal(req: Request): RemoteError | null {
  const raw = req.headers.get(REMOTE_PROTOCOL_HEADER);
  // `Headers.get` joint les valeurs répétées par une virgule : « multiple » se lit là.
  if (raw === null || raw.includes(",")) {
    return new RemoteError("bad_request", `en-tête ${REMOTE_PROTOCOL_HEADER} absent ou multiple`);
  }
  const received = canonicalInteger(raw.trim());
  if (received === null) return new RemoteError("bad_request", "version de protocole mal formée");
  if (received !== REMOTE_PROTOCOL_VERSION) {
    return new RemoteError(
      "incompatible_protocol",
      `version de protocole ${received} refusée (supportée : ${REMOTE_PROTOCOL_VERSION})`,
    );
  }
  return null;
}

/** Le jeton Bearer d'un appareil appairé, ou le refus. */
function authorize(req: Request, devices: DeviceRegistry): DeviceRecord {
  const header = req.headers.get("Authorization");
  if (header === null) throw new RemoteError("unauthorized");
  if (header.includes(",")) throw new RemoteError("bad_request", "en-têtes Authorization multiples");
  const space = header.indexOf(" ");
  if (space < 0 || header.slice(0, space).toLowerCase() !== "bearer") throw new RemoteError("unauthorized");
  const token = header.slice(space + 1);
  if (token === "" || Buffer.byteLength(token, "utf8") > BEARER_MAX_BYTES) throw new RemoteError("unauthorized");
  const device = devices.authenticate(token);
  if (device === null) throw new RemoteError("unauthorized");
  return device;
}


// --- les routes ---------------------------------------------------------------------

/** Ce qu'un gestionnaire de route reçoit. */
export type RemoteRouteContext = {
  req: Request;
  /** L'appareil du jeton ; `null` sur la seule route d'appairage. */
  device: DeviceRecord | null;
  /** Les segments `:nom` du chemin, décodés. */
  params: Record<string, string>;
  /** Le corps JSON, borné à 1 Mio : absent ou illisible ⇒ 400. */
  body: () => Promise<unknown>;
};

export type RemoteRoute = {
  method: string;
  /** Segments littéraux et `:nom`, préfixe `v1` compris : `v1/cards/:id/answer`. */
  path: string;
  handle: (ctx: RemoteRouteContext) => Response | Promise<Response>;
};

/** La machine qui répond : `{kind:"vps", name}` (S-3). */
export type RemoteMachine = { kind: "mac" | "vps"; name: string };

export type RemoteApiDeps = {
  devices: DeviceRegistry;
  machine: RemoteMachine;
  /** Les routes de parité de S-3, ajoutées au socle. */
  routes?: RemoteRoute[];
};

/** La seule route non authentifiée : `POST /v1/pair`, méthode ET chemin. */
function isPairing(method: string, segments: string[]): boolean {
  return method === "POST" && segments.length === 2 && segments[0] === "v1" && segments[1] === "pair";
}

/** `/v1/mem0/*` : le proxy mémoire (S-7) n'exige pas d'en-tête de version, mais le Bearer. */
function isMem0Proxy(segments: string[]): boolean {
  return segments[0] === "v1" && segments[1] === "mem0";
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new RemoteError("bad_request", "chemin mal encodé");
  }
}

async function readBody(req: Request): Promise<unknown> {
  const announced = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(announced) && announced > REMOTE_BODY_MAX) throw new RemoteError("bad_request", "corps trop volumineux");
  const text = await req.text();
  if (Buffer.byteLength(text, "utf8") > REMOTE_BODY_MAX) throw new RemoteError("bad_request", "corps trop volumineux");
  if (text === "") throw new RemoteError("bad_request", "corps JSON absent");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new RemoteError("bad_request", "corps JSON illisible");
  }
}

function matchRoute(
  routes: RemoteRoute[],
  method: string,
  segments: string[],
): { route: RemoteRoute; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const pattern = route.path.split("/");
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < pattern.length; i += 1) {
      const expected = pattern[i] ?? "";
      const actual = segments[i] ?? "";
      if (expected.startsWith(":")) params[expected.slice(1)] = actual;
      else if (expected !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) return { route, params };
  }
  return null;
}

/** Le corps de `POST /v1/pair` : `code` et `name` en chaînes, `deviceKey` en chaîne ou absent. */
function pairRequest(body: unknown): { code: string; name: string; deviceKey: string | undefined } {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RemoteError("bad_request", "corps JSON illisible");
  }
  const record = body as Record<string, unknown>;
  const deviceKey = record.deviceKey;
  if (typeof record.code !== "string" || typeof record.name !== "string") {
    throw new RemoteError("bad_request", "corps JSON illisible");
  }
  if (deviceKey !== undefined && deviceKey !== null && typeof deviceKey !== "string") {
    throw new RemoteError("bad_request", "corps JSON illisible");
  }
  const code = normalizePairingCode(record.code);
  if (!isWellFormedPairingCode(code)) throw new RemoteError("bad_request", "code d'appairage mal formé");
  const name = record.name.trim();
  if (name === "" || [...name].length > DEVICE_NAME_MAX) throw new RemoteError("bad_request", "nom d'appareil invalide");
  let key: string | undefined;
  if (typeof deviceKey === "string") {
    key = deviceKey.trim();
    if (key === "" || [...key].length > DEVICE_NAME_MAX) {
      throw new RemoteError("bad_request", "identifiant d'appareil invalide");
    }
  }
  return { code, name, deviceKey: key };
}

/** Un refus du registre devient l'erreur du protocole : 503 `unavailable` ou 401 indiscernable. */
function registryFailure(err: DeviceRegistryError): RemoteError {
  return err.kind === "unavailable" ? new RemoteError("unavailable", err.message) : new RemoteError("unauthorized");
}

function coreRoutes(deps: RemoteApiDeps): RemoteRoute[] {
  const { devices, machine } = deps;
  return [
    {
      method: "GET",
      path: "v1/version",
      handle: () => remoteJson({ protocolVersion: REMOTE_PROTOCOL_VERSION, machine }),
    },
    {
      method: "POST",
      path: "v1/pair",
      handle: async ctx => {
        const { code, name, deviceKey } = pairRequest(await ctx.body());
        try {
          const paired = devices.pair(code, name, deviceKey);
          return remoteJson({
            deviceId: paired.device.id,
            token: paired.token,
            protocolVersion: REMOTE_PROTOCOL_VERSION,
          });
        } catch (err) {
          if (err instanceof DeviceRegistryError) throw registryFailure(err);
          throw err;
        }
      },
    },
    {
      method: "GET",
      path: "v1/devices",
      handle: () => remoteJson({ devices: devices.list() }),
    },
    {
      // Route authentifiée : seul l'appareil du jeton est révoqué, flux compris.
      method: "DELETE",
      path: "v1/devices/self",
      handle: ctx => {
        if (ctx.device === null) throw new RemoteError("unauthorized");
        devices.revoke(ctx.device.id);
        return remoteJson({ accepted: true });
      },
    },
  ];
}

/**
 * Le gestionnaire du protocole distant : garde, routage, erreurs. Ne lève jamais —
 * toute `RemoteError` devient sa réponse, toute autre erreur un 500 `server`.
 * `sourceAddress` est l'adresse du pair telle que l'hôte la lit (`null` si inconnue).
 * Toute réponse porte `X-Console-Protocol-Version`.
 */
export function createRemoteRequestHandler(deps: RemoteApiDeps) {
  const routes = [...coreRoutes(deps), ...(deps.routes ?? [])];
  return async function handle(req: Request, sourceAddress: string | null): Promise<Response> {
    let response: Response;
    try {
      response = await dispatch(req, sourceAddress);
    } catch (err) {
      response = err instanceof RemoteError ? errorResponse(err) : errorResponse(new RemoteError("server", "erreur inattendue"));
    }
    response.headers.set(REMOTE_PROTOCOL_HEADER, String(REMOTE_PROTOCOL_VERSION));
    return response;
  };

  async function dispatch(req: Request, sourceAddress: string | null): Promise<Response> {
    // (0) la source : hors tailnet et boucle locale, rien n'est lu de la requête.
    if (!isTrustedSource(sourceAddress)) throw new RemoteError("unauthorized");
    const method = req.method.toUpperCase();
    const segments = new URL(req.url).pathname
      .split("/")
      .filter(part => part !== "")
      .map(decodeSegment);
    // (1) la version, sauf pour le proxy mémoire.
    if (!isMem0Proxy(segments)) {
      const refusal = versionRefusal(req);
      if (refusal !== null) throw refusal;
    }
    // (2) l'appairage est exempté du jeton ; (3) tout le reste exige un appareil appairé.
    let device: DeviceRecord | null = null;
    if (!isPairing(method, segments)) {
      const unavailable = deps.devices.unavailableReason;
      if (unavailable !== null) throw new RemoteError("unavailable", unavailable);
      device = authorize(req, deps.devices);
      deps.devices.touch(device.id);
    }
    const matched = matchRoute(routes, method, segments);
    if (matched === null) throw new RemoteError("not_found", "route inconnue");
    return matched.route.handle({ req, device, params: matched.params, body: () => readBody(req) });
  }
}
