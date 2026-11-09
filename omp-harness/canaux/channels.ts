// Les canaux du poste lus par API côté serveur : Gmail et Agenda (un compte Google), Slack
// (un espace). Ce module tient la connexion (OAuth + PKCE, URL de retour recollée par
// l'humain), le fichier des jetons (0600, hors base), l'état des canaux et le client HTTP
// `request`, SEUL chemin réseau des canaux : liste blanche exacte (allowlist.ts), aucun envoi.
//
// Les jetons et le secret du client ne sont tenus que dans des champs privés (`#…`) et
// dans `channels.json` : aucune méthode ni aucun export ne les rend, rien n'en va en base,
// en environnement, en événement, en log ou en réponse HTTP.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { HarnessConfig } from "../config.ts";
import { isRecord } from "../config.ts";
import type { Store } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { EventType } from "../events.ts";
import { newId } from "../ids.ts";
import type { LogLine } from "../logger.ts";
import { atomicWrite } from "../providers.ts";
import type { ChannelId, Method } from "./allowlist.ts";
import { allowed, ownedBy } from "./allowlist.ts";
import { ChannelApiError, ChannelNetworkError, ChannelRateLimited, ChannelUnavailable } from "./errors.ts";

export type { ChannelId, Method } from "./allowlist.ts";

export type Connection = "google" | "slack";
export type ChannelStateName = "disconnected" | "connected" | "reconnect" | "blocked" | "error";

export type ChannelView = {
  id: ChannelId;
  connection: Connection;
  state: ChannelStateName;
  account: string | null;
  lastReadAt: number | null;
  error: string | null;
};
export type LoginView = {
  id: string;
  connection: Connection;
  state: "waiting" | "done" | "failed";
  url: string | null;
  startedAt: number;
  expiresAt: number;
  error: string | null;
};
export type ConnectionView = {
  id: Connection;
  clientId: string | null;
  clientConfigured: boolean;
  login: LoginView | null;
};

/** Compatible avec `Response` : seul ce que le client lit. */
export type ChannelFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export type ChannelRequest = {
  method: Method;
  url: string;
  query?: Record<string, string | string[]>;
  json?: unknown;
  form?: Record<string, string>;
};

export type ChannelsDeps = {
  config: HarnessConfig;
  store: Store;
  event: (type: EventType, runId: string | null, payload?: Record<string, unknown>, repo?: string | null) => void;
  log: LogLine;
  fetch: ChannelFetch;
  now?: () => number;
};

type ChannelState = Pick<ChannelView, "state" | "account" | "lastReadAt" | "error">;
type TokenSet = { access: string; refresh: string; expiresAt: number; scopes: string[] };
type FileData = {
  version: 1;
  google?: { clientId: string; clientSecret: string; tokens?: TokenSet };
  slack?: { clientId: string; tokens?: TokenSet };
};
type Login = {
  id: string;
  connection: Connection;
  state: LoginView["state"];
  url: string;
  verifier: string;
  oauthState: string;
  startedAt: number;
  expiresAt: number;
  endedAt: number | null;
  error: string | null;
  channels: ChannelId[];
  /** Un échange est en vol : une seconde réponse n'en lance pas un deuxième. */
  exchanging: boolean;
};

const SETTINGS_KEY = "workstation.channels";
const CHANNEL_IDS: readonly ChannelId[] = ["gmail", "calendar", "slack"];
const CONNECTIONS: readonly Connection[] = ["google", "slack"];
const CHANNELS_OF: Record<Connection, readonly ChannelId[]> = { google: ["gmail", "calendar"], slack: ["slack"] };
const CONNECTION_OF: Record<ChannelId, Connection> = { gmail: "google", calendar: "google", slack: "slack" };

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/";
const GOOGLE_SCOPES = [
  `${GOOGLE_SCOPE}gmail.readonly`,
  `${GOOGLE_SCOPE}gmail.compose`,
  `${GOOGLE_SCOPE}calendar.readonly`,
];
const GOOGLE_SCOPES_OF: Record<"gmail" | "calendar", string[]> = {
  gmail: GOOGLE_SCOPES.slice(0, 2),
  calendar: GOOGLE_SCOPES.slice(2),
};
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_EXCHANGE_URL = "https://oauth2.googleapis.com/token";
const SLACK_AUTH_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_EXCHANGE_URL = "https://slack.com/api/oauth.v2.access";
const REDIRECT: Record<Connection, string> = {
  google: "http://127.0.0.1/omp-canaux",
  slack: "http://localhost/omp-canaux",
};
const BLOCK_CODES: Record<Connection, readonly string[]> = {
  google: ["admin_policy_enforced", "access_not_configured"],
  slack: ["unapproved_scope", "scope_not_allowed_on_enterprise"],
};
/** Slack : codes passagers (coupure), codes qui disent « à reconnecter », codes propres à une ressource. */
const SLACK_TRANSIENT = ["internal_error", "fatal_error", "service_unavailable", "request_timeout"];
const SLACK_RECONNECT = ["invalid_auth", "token_revoked", "account_inactive", "not_authed"];
const SLACK_RESOURCE = [
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "thread_not_found",
  "message_not_found",
  "user_not_found",
  "invalid_cursor",
  "invalid_arguments",
];

const BLOCKED_TEXT =
  "bloqué par l'administrateur de l'entreprise : la veille ne lit pas ce canal, le poste continue par le navigateur";
const UNREADABLE = "fichier des canaux illisible";
const LOGIN_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 30_000;
const RENEW_MARGIN_MS = 60_000;
const RETRY_AFTER_DEFAULT_MS = 60_000;
const MAX_ANSWER = 4096;
const STATE_WORDS = { reconnect: "à reconnecter", blocked: "bloqué", error: "en erreur" } as const;

let manifestScopes: string[] | null = null;
/** Les `user_scopes` attendus : lus dans le manifeste fourni (une seule source). */
function slackScopes(): string[] {
  if (manifestScopes === null) {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../deploy/slack-app-manifest.json", import.meta.url), "utf8"),
    ) as { oauth_config: { scopes: { user: string[] } } };
    manifestScopes = manifest.oauth_config.scopes.user;
  }
  return manifestScopes;
}

/** Un code de fournisseur recopié dans un message ou un journal : court, sans blanc ni contenu. */
const codeOf = (value: unknown, fallback: string): string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : fallback;

function onlyKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new HarnessError(400, `${key} : clé inconnue`);
}

const emptyState = (): ChannelState => ({ state: "disconnected", account: null, lastReadAt: null, error: null });

type Exchanged = { status: number; json: Record<string, unknown>; raw: string };

export class Channels {
  readonly #config: HarnessConfig;
  readonly #store: Store;
  readonly #event: ChannelsDeps["event"];
  readonly #log: LogLine;
  readonly #fetch: ChannelFetch;
  readonly #now: () => number;
  readonly #logins = new Map<Connection, Login>();
  readonly #renewing = new Map<Connection, Promise<void>>();

  constructor(deps: ChannelsDeps) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#event = deps.event;
    this.#log = deps.log;
    this.#fetch = deps.fetch;
    this.#now = deps.now ?? Date.now;
  }

  // -- vue ------------------------------------------------------------------------------------

  /** L'état des canaux et des connexions. `url` d'une connexion en cours : à l'appareil approbateur seul. */
  view(approver: boolean): { channels: ChannelView[]; connections: ConnectionView[] } {
    return { channels: this.#channels(), connections: CONNECTIONS.map((id) => this.#connection(id, approver)) };
  }

  #channels(): ChannelView[] {
    let unreadable = false;
    try {
      this.#read();
    } catch {
      unreadable = true;
    }
    const states = this.#states();
    return CHANNEL_IDS.map((id) => ({
      id,
      connection: CONNECTION_OF[id],
      ...(unreadable ? { ...emptyState(), state: "error" as const, error: UNREADABLE } : states[id]),
    }));
  }

  #connection(id: Connection, approver: boolean): ConnectionView {
    let clientId: string | null = null;
    try {
      clientId = this.#read()[id]?.clientId ?? null;
    } catch {
      clientId = null;
    }
    return { id, clientId, clientConfigured: clientId !== null, login: this.#loginView(id, approver) };
  }

  #loginView(connection: Connection, approver: boolean): LoginView | null {
    const login = this.#logins.get(connection);
    if (!login) return null;
    if (login.endedAt !== null && this.#now() - login.endedAt >= LOGIN_MS) {
      this.#logins.delete(connection);
      return null;
    }
    return {
      id: login.id,
      connection,
      state: login.state,
      url: approver && login.state === "waiting" ? login.url : null,
      startedAt: login.startedAt,
      expiresAt: login.expiresAt,
      error: login.error,
    };
  }

  // -- état non secret (settings) -------------------------------------------------------------

  #states(): Record<ChannelId, ChannelState> {
    const stored = this.#store.getSetting<Partial<Record<ChannelId, Partial<ChannelState>>>>(SETTINGS_KEY) ?? {};
    const out = { gmail: emptyState(), calendar: emptyState(), slack: emptyState() };
    for (const id of CHANNEL_IDS) Object.assign(out[id], stored[id] ?? {});
    return out;
  }

  /** Change l'état d'un canal ; événement et journal (canal, état, code) si l'état, le compte ou l'erreur bougent. */
  #set(id: ChannelId, patch: Partial<ChannelState>, code: string | null = null, by: string | null = null): void {
    const all = this.#states();
    const before = all[id];
    const next = { ...before, ...patch };
    if (
      next.state === before.state &&
      next.account === before.account &&
      next.error === before.error &&
      next.lastReadAt === before.lastReadAt
    )
      return;
    all[id] = next;
    this.#store.setSetting(SETTINGS_KEY, all, by);
    if (next.state === before.state && next.account === before.account && next.error === before.error) return;
    this.#event("workstation_channel", null, { id, state: next.state }, null);
    if (next.state !== before.state && next.state in STATE_WORDS)
      this.#log(`poste : canal ${id} ${STATE_WORDS[next.state as keyof typeof STATE_WORDS]} (${code ?? "inconnu"})`, {
        level: "warn",
      });
  }

  /** Les canaux d'une connexion ont changé de client ou de connexion : un événement par canal, avec son état. */
  #announce(connection: Connection): void {
    const states = this.#states();
    for (const id of CHANNELS_OF[connection])
      this.#event("workstation_channel", null, { id, state: states[id].state }, null);
  }

  // -- fichier des jetons (0600) --------------------------------------------------------------

  #read(): FileData {
    const file = this.#config.channelsFile;
    if (!fs.existsSync(file)) return { version: 1 };
    try {
      const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!isRecord(data) || data.version !== 1) throw new Error("version");
      return data as FileData;
    } catch {
      throw new HarnessError(500, UNREADABLE);
    }
  }

  #mutate(change: (data: FileData) => void): void {
    const data = this.#read();
    change(data);
    atomicWrite(this.#config.channelsFile, `${JSON.stringify(data, null, 2)}\n`, 0o600);
  }

  // -- client OAuth ---------------------------------------------------------------------------

  /** Saisit les identifiants du client d'une connexion (l'approbateur). */
  setClient(id: string, body: Record<string, unknown>, by: string | null): { connection: ConnectionView } {
    const connection = this.#connectionOf(id);
    let clientId: string;
    let clientSecret: string | null = null;
    if (connection === "google") {
      onlyKeys(body, ["clientId", "clientSecret", "json"]);
      if (body.json !== undefined) {
        if (body.clientId !== undefined || body.clientSecret !== undefined)
          throw new HarnessError(400, "json : à donner seul, sans clientId ni clientSecret");
        ({ clientId, clientSecret } = this.#desktopClient(body.json));
      } else {
        clientId = this.#bounded(body, "clientId");
        clientSecret = this.#bounded(body, "clientSecret");
      }
      if (!clientId.endsWith(".apps.googleusercontent.com"))
        throw new HarnessError(400, "clientId : identifiant se terminant par .apps.googleusercontent.com attendu");
    } else {
      onlyKeys(body, ["clientId", "clientSecret"]);
      if (body.clientSecret !== undefined) throw new HarnessError(400, "Slack en PKCE : aucun secret client");
      clientId = this.#bounded(body, "clientId");
      if (!/^\d+\.\d+$/.test(clientId))
        throw new HarnessError(400, "clientId : identifiant Slack attendu (chiffres.chiffres)");
    }
    let changed = false;
    this.#mutate((data) => {
      const known = data[connection];
      changed = known !== undefined && known.clientId !== clientId;
      const kept = known !== undefined && !changed && known.tokens !== undefined ? { tokens: known.tokens } : {};
      if (connection === "google") data.google = { clientId, clientSecret: clientSecret ?? "", ...kept };
      else data.slack = { clientId, ...kept };
    });
    if (changed) {
      this.#logins.delete(connection);
      for (const channel of CHANNELS_OF[connection]) this.#set(channel, emptyState(), null, by);
    }
    this.#announce(connection);
    return { connection: this.#connection(connection, true) };
  }

  #connectionOf(id: string): Connection {
    if (id !== "google" && id !== "slack") throw new HarnessError(404, "canal inconnu");
    return id;
  }

  #bounded(body: Record<string, unknown>, key: string): string {
    const value = body[key];
    if (typeof value !== "string" || value.trim() === "")
      throw new HarnessError(400, `${key} : chaîne non vide attendue`);
    if (value.length > 512) throw new HarnessError(400, `${key} : 512 caractères au plus`);
    return value.trim();
  }

  /** Le JSON téléchargé d'un client « Desktop » : `installed.client_id` et `installed.client_secret`. */
  #desktopClient(raw: unknown): { clientId: string; clientSecret: string } {
    let parsed = raw;
    if (typeof raw === "string") {
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new HarnessError(400, "json : JSON invalide");
      }
    }
    const installed = isRecord(parsed) ? parsed.installed : undefined;
    if (!isRecord(installed)) throw new HarnessError(400, "client « Desktop » attendu (clé installed)");
    return {
      clientId: this.#bounded({ clientId: installed.client_id }, "clientId"),
      clientSecret: this.#bounded({ clientSecret: installed.client_secret }, "clientSecret"),
    };
  }

  // -- connexion ------------------------------------------------------------------------------

  /** Démarre une connexion : l'URL d'autorisation (PKCE + state) que l'humain ouvre. */
  startLogin(id: string, body: Record<string, unknown>): { login: LoginView } {
    const connection = this.#connectionOf(id);
    onlyKeys(body, ["channels"]);
    const channels = this.#channelsOf(
      body.channels,
      CHANNELS_OF[connection],
      (list) => `channels : canaux de ${connection} attendus (${list})`,
    );
    const client = this.#read()[connection];
    if (!client) throw new HarnessError(409, `configurez d'abord le client de ${connection} dans l'écran Canaux`);
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const oauthState = randomBytes(16).toString("hex");
    const startedAt = this.#now();
    const params = new URLSearchParams({ client_id: client.clientId });
    if (connection === "google") {
      const scopes = GOOGLE_SCOPES.filter((scope) =>
        channels.some((channel) => this.#scopesOf(channel).includes(scope)),
      );
      params.set("redirect_uri", REDIRECT.google);
      params.set("response_type", "code");
      params.set("scope", scopes.join(" "));
    } else {
      params.set("user_scope", slackScopes().join(","));
      params.set("redirect_uri", REDIRECT.slack);
    }
    params.set("code_challenge", challenge);
    params.set("code_challenge_method", "S256");
    params.set("state", oauthState);
    if (connection === "google") {
      params.set("access_type", "offline");
      params.set("prompt", "consent");
      if (channels.length < CHANNELS_OF.google.length) params.set("include_granted_scopes", "true");
    }
    const login: Login = {
      id: newId("cx"),
      connection,
      state: "waiting",
      url: `${connection === "google" ? GOOGLE_AUTH_URL : SLACK_AUTH_URL}?${params}`,
      verifier,
      oauthState,
      startedAt,
      expiresAt: startedAt + LOGIN_MS,
      endedAt: null,
      exchanging: false,
      error: null,
      channels,
    };
    this.#logins.set(connection, login);
    this.#announce(connection);
    return { login: this.#loginView(connection, true) as LoginView };
  }

  #scopesOf(channel: ChannelId): string[] {
    return channel === "slack" ? [] : GOOGLE_SCOPES_OF[channel];
  }

  /** `channels` : tableau non vide, sans doublon, parmi `among` ; absent : `among`. */
  #channelsOf(value: unknown, among: readonly ChannelId[], message: (list: string) => string): ChannelId[] {
    if (value === undefined) return [...among];
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      new Set(value).size !== value.length ||
      value.some((item) => !among.includes(item as ChannelId))
    )
      throw new HarnessError(400, message(among.join(", ")));
    return value as ChannelId[];
  }

  /** Recolle la réponse : l'URL de retour, le code, le texte d'erreur affiché, ou la déclaration de blocage. */
  async answer(id: string, body: Record<string, unknown>): Promise<{ login: LoginView; channels: ChannelView[] }> {
    const connection = this.#connectionOf(id);
    onlyKeys(body, ["value", "blocked", "channels"]);
    if (body.value !== undefined && body.blocked !== undefined)
      throw new HarnessError(400, "value et blocked : un seul des deux");
    if (body.channels !== undefined && body.blocked !== true)
      throw new HarnessError(400, "channels : seulement avec blocked: true");
    if (body.blocked !== undefined && body.blocked !== true) throw new HarnessError(400, "blocked : true attendu");
    let value = "";
    if (body.blocked === undefined) {
      if (typeof body.value !== "string") throw new HarnessError(400, "value : le code ou l'URL de retour");
      value = body.value.trim();
      if (value === "" || value.length > MAX_ANSWER) throw new HarnessError(400, "value : le code ou l'URL de retour");
    }
    const login = this.#logins.get(connection);
    if (login?.state !== "waiting")
      throw new HarnessError(409, `aucune connexion en cours pour ${connection} : relancez-la`);
    const asked =
      body.blocked === true
        ? this.#channelsOf(
            body.channels,
            login.channels,
            (list) => `channels : canaux demandés par la connexion en cours attendus (${list})`,
          )
        : login.channels;
    if (this.#now() >= login.expiresAt) {
      this.#end(login, "connexion expirée");
      throw new HarnessError(400, "connexion expirée : relancez-la");
    }
    if (body.blocked === true) return this.#block(login, asked);
    if (BLOCK_CODES[connection].some((code) => value.includes(code))) return this.#block(login, login.channels);
    let code: string;
    if (/^https?:\/\//i.test(value)) {
      const params = this.#returnParams(value);
      if (params.get("state") !== login.oauthState)
        throw new HarnessError(400, "state étranger : cette URL de retour ne vient pas de la connexion en cours");
      const failure = params.get("error");
      if (failure !== null)
        this.#refuse(
          login,
          failure === "access_denied"
            ? "accès refusé dans le navigateur"
            : `refus du fournisseur : ${codeOf(failure, "inconnu")}`,
        );
      const given = params.get("code");
      if (given === null || given === "")
        throw new HarnessError(400, "code absent : recollez l'URL de retour complète");
      code = given;
    } else if (/^\S+$/.test(value)) {
      code = value;
    } else {
      throw new HarnessError(400, "texte non reconnu : recollez l'URL de retour ou déclarez le blocage");
    }
    if (login.exchanging) throw new HarnessError(409, "une réponse est déjà en cours de traitement");
    login.exchanging = true;
    try {
      return await this.#complete(login, code);
    } finally {
      login.exchanging = false;
    }
  }

  #returnParams(url: string): URLSearchParams {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HarnessError(400, "texte non reconnu : recollez l'URL de retour ou déclarez le blocage");
    }
    const params = new URLSearchParams(parsed.search);
    for (const [key, value] of new URLSearchParams(parsed.hash.replace(/^#/, ""))) {
      if (!params.has(key)) params.set(key, value);
    }
    return params;
  }

  #end(login: Login, error: string | null): void {
    login.state = error === null ? "done" : "failed";
    login.error = error;
    login.endedAt = this.#now();
  }

  /** Un refus : connexion `failed`, 409 ; les canaux demandés portent le message (`error` sans jetons au départ). */
  #refuse(login: Login, message: string): never {
    this.#end(login, message);
    const tokens = this.#read()[login.connection]?.tokens;
    for (const channel of login.channels) {
      const current = this.#states()[channel];
      if (current.state === "blocked") continue;
      this.#set(channel, { error: message, ...(tokens === undefined ? { state: "error" as const } : {}) }, "refus");
    }
    throw new HarnessError(409, message);
  }

  /** Blocage par l'administrateur : les canaux nommés passent `blocked`, la connexion en cours `failed`. */
  #block(login: Login, channels: readonly ChannelId[]): { login: LoginView; channels: ChannelView[] } {
    this.#end(login, "bloqué par l'administrateur");
    for (const channel of channels) this.#set(channel, { state: "blocked", error: BLOCKED_TEXT }, "administrateur");
    return { login: this.#loginView(login.connection, true) as LoginView, channels: this.#channels() };
  }

  /** L'échange du code, le contrôle des scopes, l'écriture des jetons et les sondes. */
  async #complete(login: Login, code: string): Promise<{ login: LoginView; channels: ChannelView[] }> {
    const connection = login.connection;
    const client = this.#read()[connection];
    if (!client) throw new HarnessError(409, `configurez d'abord le client de ${connection} dans l'écran Canaux`);
    const form: Record<string, string> = {
      client_id: client.clientId,
      code,
      code_verifier: login.verifier,
      redirect_uri: REDIRECT[connection],
    };
    if (connection === "google") {
      form.client_secret = this.#read().google?.clientSecret ?? "";
      form.grant_type = "authorization_code";
    }
    let reply: Exchanged;
    try {
      reply = await this.#exchange(connection, form);
    } catch (err) {
      if (err instanceof ChannelNetworkError || err instanceof ChannelRateLimited)
        throw new HarnessError(502, "le fournisseur ne répond pas : recollez de nouveau la réponse dans un instant");
      throw err;
    }
    if (BLOCK_CODES[connection].some((blocking) => reply.raw.includes(blocking)))
      return this.#block(login, login.channels);
    const failure = this.#failure(connection, reply);
    if (failure !== null) return this.#refuse(login, `échange refusé : ${failure}`);
    const accepted = connection === "google" ? this.#acceptGoogle(login, reply.json) : this.#acceptSlack(reply.json);
    if (typeof accepted === "string") return this.#refuse(login, accepted);
    const now = this.#now();
    this.#mutate((data) => {
      const entry = data[connection];
      if (entry) entry.tokens = { ...accepted.tokens, expiresAt: now + accepted.expiresInMs };
    });
    this.#end(login, null);
    for (const channel of CHANNELS_OF[connection]) {
      const asked = login.channels.includes(channel);
      if (!asked && this.#states()[channel].state === "blocked") continue;
      if (accepted.covered.includes(channel)) this.#set(channel, { state: "connected", error: null }, null);
      else if (login.channels.includes(channel))
        this.#set(
          channel,
          {
            state: "disconnected",
            account: null,
            lastReadAt: null,
            error: `scope non accordé : ${this.#scopesOf(channel).join(", ")} : relancez la connexion et cochez-le`,
          },
          null,
        );
      else
        this.#set(
          channel,
          {
            state: "disconnected",
            account: null,
            lastReadAt: null,
            error: "non demandé à la dernière connexion Google : relancez la connexion Google avec ce canal",
          },
          null,
        );
    }
    await this.#probe(connection);
    return { login: this.#loginView(connection, true) as LoginView, channels: this.#channels() };
  }

  /** Le code d'erreur d'une réponse du point de jeton, ou `null` si elle porte un jeton. */
  #failure(connection: Connection, reply: Exchanged): string | null {
    if (connection === "slack") return reply.json.ok === true ? null : codeOf(reply.json.error, String(reply.status));
    if (reply.status >= 200 && reply.status < 300 && typeof reply.json.access_token === "string") return null;
    return codeOf(reply.json.error, String(reply.status));
  }

  /** S-5 : scopes Google. Rend les canaux couverts et le jeton à écrire, ou le message de refus. */
  #acceptGoogle(
    login: Login,
    json: Record<string, unknown>,
  ): string | { tokens: Omit<TokenSet, "expiresAt">; expiresInMs: number; covered: ChannelId[] } {
    const granted = typeof json.scope === "string" ? json.scope.split(/\s+/).filter(Boolean) : [];
    const extra = granted.filter((scope) => !GOOGLE_SCOPES.includes(scope));
    if (extra.length > 0) return `scope en trop : ${extra.join(", ")}`;
    const covers = (channel: "gmail" | "calendar") =>
      GOOGLE_SCOPES_OF[channel].every((scope) => granted.includes(scope));
    const asked = login.channels.filter((channel): channel is "gmail" | "calendar" => channel !== "slack");
    if (!asked.some(covers)) {
      const missing = asked.flatMap((channel) => GOOGLE_SCOPES_OF[channel]).filter((scope) => !granted.includes(scope));
      return `scope manquant : ${missing.join(", ")}`;
    }
    const refresh = json.refresh_token;
    if (typeof refresh !== "string" || refresh === "") return "aucun jeton de rafraîchissement rendu";
    const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
    return {
      tokens: { access: json.access_token as string, refresh, scopes: granted },
      expiresInMs: expiresIn * 1000,
      covered: (["gmail", "calendar"] as const).filter(covers),
    };
  }

  /** S-6 : jeton Slack. Un jeton utilisateur seul, exactement les scopes du manifeste, avec rotation. */
  #acceptSlack(
    json: Record<string, unknown>,
  ): string | { tokens: Omit<TokenSet, "expiresAt">; expiresInMs: number; covered: ChannelId[] } {
    const user = json.authed_user;
    if (
      typeof (isRecord(user) ? user.access_token : null) !== "string" ||
      json.access_token !== undefined ||
      json.bot_user_id !== undefined ||
      json.token_type === "bot" ||
      !isRecord(user) ||
      user.token_type !== "user"
    )
      return "jeton de bot refusé : le harness n'accepte qu'un jeton utilisateur";
    const granted = typeof user.scope === "string" ? user.scope.split(",").filter(Boolean) : [];
    const expected = slackScopes();
    const extra = granted.filter((scope) => !expected.includes(scope));
    if (extra.length > 0) return `scope en trop : ${extra.join(", ")}`;
    const missing = expected.filter((scope) => !granted.includes(scope));
    if (missing.length > 0) return `scope manquant : ${missing.join(", ")}`;
    if (typeof user.refresh_token !== "string" || typeof user.expires_in !== "number")
      return "rotation des jetons absente : activez token_rotation_enabled";
    return {
      tokens: { access: user.access_token as string, refresh: user.refresh_token, scopes: granted },
      expiresInMs: user.expires_in * 1000,
      covered: ["slack"],
    };
  }

  /** S-7 : les sondes d'après connexion, par `request` (un échec n'annule pas la connexion). */
  async #probe(connection: Connection): Promise<void> {
    const probe = async (channel: ChannelId, url: string): Promise<unknown> => {
      if (this.#states()[channel].state !== "connected") return null;
      try {
        return await this.request(channel, { method: "GET", url });
      } catch {
        return null;
      }
    };
    if (connection === "slack") {
      const reply = await probe("slack", "https://slack.com/api/auth.test");
      if (isRecord(reply) && typeof reply.user === "string" && typeof reply.team === "string")
        this.#set("slack", { account: `${reply.user} @ ${reply.team}` });
      return;
    }
    const profile = await probe("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/profile");
    const email = isRecord(profile) && typeof profile.emailAddress === "string" ? profile.emailAddress : null;
    if (email !== null) this.#set("gmail", { account: email });
    const calendar = await probe("calendar", "https://www.googleapis.com/calendar/v3/calendars/primary");
    if (isRecord(calendar)) {
      const account = email ?? (typeof calendar.id === "string" ? calendar.id : null);
      if (account !== null) this.#set("calendar", { account });
    }
  }

  // -- client HTTP ----------------------------------------------------------------------------

  /**
   * L'appel d'un canal, seul chemin réseau : liste blanche (méthode, URL, canal propriétaire),
   * puis état, jeton renouvelé au besoin. Rend le JSON de la réponse (`null` pour 204).
   */
  async request(channel: ChannelId, req: ChannelRequest): Promise<unknown> {
    let url = req.url;
    if (req.query !== undefined) {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query))
        for (const item of Array.isArray(value) ? value : [value]) query.append(key, item);
      const text = query.toString();
      if (text !== "") url += `${url.includes("?") ? "&" : "?"}${text}`;
    }
    ownedBy(allowed(req.method, url), channel);
    const state = this.#states()[channel].state;
    if (state === "disconnected" || state === "reconnect" || state === "blocked") throw new ChannelUnavailable(state);
    try {
      this.#read();
    } catch {
      throw new ChannelUnavailable("error");
    }
    const connection = CONNECTION_OF[channel];
    if (this.#read()[connection]?.tokens === undefined) throw new ChannelUnavailable("disconnected");
    return this.#call(channel, connection, req, url, false);
  }

  async #call(
    channel: ChannelId,
    connection: Connection,
    req: ChannelRequest,
    url: string,
    retried: boolean,
  ): Promise<unknown> {
    const access = await this.#access(connection);
    const headers: Record<string, string> = { Authorization: `Bearer ${access}`, Accept: "application/json" };
    let body: string | undefined;
    if (req.form !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(req.form).toString();
    } else if (req.json !== undefined) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      body = JSON.stringify(req.json);
    }
    const reply = await this.#send(url, { method: req.method, headers, ...(body === undefined ? {} : { body }) });
    const where = `${req.method} ${new URL(url).pathname}`;
    const fail = (status: number, code: string, own: boolean): never => {
      if (!own) this.#set(channel, { state: "error", error: `${where} : ${code}` }, code);
      throw new ChannelApiError(status, code);
    };
    const status = reply.status;
    if (status === 429) throw new ChannelRateLimited(this.#retryAfter(reply.retryAfter));
    if (status >= 500) throw new ChannelNetworkError("server");
    if (status === 401 && connection === "google") {
      if (retried) return fail(401, "401", false);
      await this.#renew(connection);
      return this.#call(channel, connection, req, url, true);
    }
    if (status === 403 && connection === "google") {
      if (/"reason"\s*:\s*"(?:rateLimitExceeded|userRateLimitExceeded)"/.test(reply.body))
        throw new ChannelRateLimited(this.#retryAfter(reply.retryAfter));
      return fail(403, "403", false);
    }
    if (status < 200 || status >= 300) return fail(status, String(status), connection === "google" && status >= 400);
    if (status === 204) {
      this.#succeeded(channel);
      return null;
    }
    let json: unknown;
    try {
      json = JSON.parse(reply.body);
    } catch {
      throw new ChannelNetworkError("invalid_json");
    }
    if (connection === "slack" && isRecord(json) && json.ok === false) {
      const code = codeOf(json.error, "inconnu");
      if (code === "token_expired" && !retried) {
        await this.#renew(connection);
        return this.#call(channel, connection, req, url, true);
      }
      if (SLACK_TRANSIENT.includes(code)) throw new ChannelNetworkError("server");
      if (SLACK_RECONNECT.includes(code)) {
        this.#reconnect(connection, code);
        throw new ChannelUnavailable("reconnect");
      }
      return fail(200, code, SLACK_RESOURCE.includes(code));
    }
    this.#succeeded(channel);
    return json;
  }

  /** Un appel réussi : le canal est (re)connecté, sa date de dernière lecture avance. */
  #succeeded(channel: ChannelId): void {
    const current = this.#states()[channel];
    this.#set(channel, {
      lastReadAt: this.#now(),
      ...(current.state === "error" ? { state: "connected" as const, error: null } : {}),
    });
  }

  #retryAfter(header: string | null): number {
    const seconds = header === null ? Number.NaN : Number(header.trim());
    return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : RETRY_AFTER_DEFAULT_MS;
  }

  async #send(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; retryAfter: string | null; body: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const reply = await this.#fetch(url, { ...init, signal: controller.signal });
      const body = await reply.text();
      return { status: reply.status, retryAfter: reply.headers.get("retry-after"), body };
    } catch {
      throw new ChannelNetworkError(controller.signal.aborted ? "timeout" : "network");
    } finally {
      clearTimeout(timer);
    }
  }

  /** Le point de jeton d'une connexion (échange et renouvellement seulement, liste blanche comprise). */
  async #exchange(connection: Connection, form: Record<string, string>): Promise<Exchanged> {
    const url = connection === "google" ? GOOGLE_EXCHANGE_URL : SLACK_EXCHANGE_URL;
    allowed("POST", url);
    const reply = await this.#send(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    });
    if (reply.status === 429) throw new ChannelRateLimited(this.#retryAfter(reply.retryAfter));
    if (reply.status >= 500) throw new ChannelNetworkError("server");
    let json: unknown;
    try {
      json = JSON.parse(reply.body);
    } catch {
      throw new ChannelNetworkError("invalid_json");
    }
    if (!isRecord(json)) throw new ChannelNetworkError("invalid_json");
    return { status: reply.status, json, raw: reply.body };
  }

  /** Le jeton d'accès, renouvelé d'abord s'il échoit dans la minute. */
  async #access(connection: Connection): Promise<string> {
    const tokens = this.#read()[connection]?.tokens;
    if (tokens === undefined) throw new ChannelUnavailable("disconnected");
    if (tokens.expiresAt - RENEW_MARGIN_MS > this.#now()) return tokens.access;
    await this.#renew(connection);
    const renewed = this.#read()[connection]?.tokens;
    if (renewed === undefined) throw new ChannelUnavailable("disconnected");
    return renewed.access;
  }

  /** Un seul renouvellement en vol par connexion (indispensable avec la rotation de Slack). */
  #renew(connection: Connection): Promise<void> {
    let running = this.#renewing.get(connection);
    if (running === undefined) {
      running = this.#doRenew(connection).finally(() => this.#renewing.delete(connection));
      this.#renewing.set(connection, running);
    }
    return running;
  }

  async #doRenew(connection: Connection): Promise<void> {
    const entry = this.#read()[connection];
    const tokens = entry?.tokens;
    if (!entry || tokens === undefined) throw new ChannelUnavailable("disconnected");
    const form: Record<string, string> = {
      client_id: entry.clientId,
      grant_type: "refresh_token",
      refresh_token: tokens.refresh,
    };
    if (connection === "google") form.client_secret = this.#read().google?.clientSecret ?? "";
    const reply = await this.#exchange(connection, form);
    const blocking = BLOCK_CODES[connection].some((code) => reply.raw.includes(code));
    if (blocking) {
      const covered = CHANNELS_OF[connection].filter((channel) => this.#covered(channel, tokens.scopes));
      for (const channel of covered) this.#set(channel, { state: "blocked", error: BLOCKED_TEXT }, "administrateur");
      throw new ChannelUnavailable("blocked");
    }
    const failure = this.#failure(connection, reply);
    const source = connection === "slack" && isRecord(reply.json.authed_user) ? reply.json.authed_user : reply.json;
    const bot = connection === "slack" && (reply.json.token_type === "bot" || source.token_type === "bot");
    if (failure !== null || bot || typeof source.access_token !== "string") {
      if (failure !== null && connection === "slack" && SLACK_TRANSIENT.includes(failure))
        throw new ChannelNetworkError("server");
      const code = failure ?? "bot_token";
      this.#reconnect(connection, code);
      throw new ChannelUnavailable("reconnect");
    }
    const expiresIn = typeof source.expires_in === "number" ? source.expires_in : 3600;
    const refresh =
      typeof source.refresh_token === "string" && source.refresh_token !== "" ? source.refresh_token : tokens.refresh;
    const now = this.#now();
    this.#mutate((data) => {
      const current = data[connection];
      if (current)
        current.tokens = {
          access: source.access_token as string,
          refresh,
          expiresAt: now + expiresIn * 1000,
          scopes: tokens.scopes,
        };
    });
  }

  #covered(channel: ChannelId, scopes: string[]): boolean {
    if (channel === "slack") return scopes.length > 0;
    return GOOGLE_SCOPES_OF[channel].every((scope) => scopes.includes(scope));
  }

  /** Un refus du point de jeton : les canaux lisibles de la connexion passent « à reconnecter ». */
  #reconnect(connection: Connection, code: string): void {
    const states = this.#states();
    for (const channel of CHANNELS_OF[connection]) {
      if (states[channel].state === "connected" || states[channel].state === "error")
        this.#set(channel, { state: "reconnect", error: `à reconnecter : ${code}` }, code);
    }
  }
}
