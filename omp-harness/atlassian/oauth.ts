// Le consentement OAuth 2.1 du harness auprès d'Atlassian (serveur Rovo MCP), à lui seul :
// un client enregistré par DCR (sans secret, `token_endpoint_auth_method: "none"`), PKCE S256,
// l'échange du code, puis le rafraîchissement — un seul en vol à la fois, le nouveau refresh
// token rangé s'il en vient un (Atlassian peut le faire tourner).
//
// Les jetons vivent dans `atlassian.tokenFile` (JSON, 0600, écrit par tmp + rename) : jamais en
// base, jamais au journal, jamais rendus par une route. Le consentement en attente (state,
// verifier) vit en mémoire seulement, un seul à la fois, dix minutes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import type { AtlassianConfig } from "../config.ts";
import { LOOPBACK_REDIRECT, isLoopbackUrl, isRecord } from "../config.ts";
import type { FetchResponse } from "../oracle.ts";
import { atomicWrite } from "../providers.ts";

/** Ce que le connecteur lit d'une réponse : celle de l'oracle, plus ses en-têtes (`Mcp-Session-Id`). */
export type AtlassianResponse = FetchResponse & { headers?: { get(name: string): string | null } };

/** Le `fetch` du connecteur : tout `FetchLike` (oracle.ts) convient, les en-têtes de réponse sont lus s'ils sont là. */
export type AtlassianFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<AtlassianResponse>;

/** Les portées demandées : lecture Jira, Confluence et Rovo ; écriture Jira (transitions, commentaires approuvés). */
export const ATLASSIAN_SCOPES: readonly string[] = [
  "offline_access",
  "read:me",
  "read:account",
  "email",
  "read:jira:agent-interface",
  "write:jira:agent-interface",
  "search:jira:agent-interface",
  "read:confluence:agent-interface",
  "search:confluence:agent-interface",
  "search:rovo:agent-interface",
];

/** Le consentement en attente expire après ce délai. */
export const CONSENT_TTL_MS = 10 * 60 * 1000;
/** Un jeton d'accès à moins de ce délai de sa fin est rafraîchi avant l'appel. */
const EXPIRY_SKEW_MS = 60 * 1000;
/** Le délai d'une requête OAuth (découverte, enregistrement, jeton). */
const OAUTH_TIMEOUT_MS = 30 * 1000;

/** Le fichier de jetons : `cloudId`, `siteUrl`, `accountId` null tant que le site n'est pas découvert. */
export type AtlassianTokens = {
  clientId: string;
  redirectUri: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string;
  cloudId: string | null;
  siteUrl: string | null;
  accountId: string | null;
  connectedAt: number;
  connectedBy: string;
};

export type PendingConsent = {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  expiresAt: number;
  authorizeUrl: string;
  /** Le client qui a lancé le branchement. */
  by: string;
};

/** Les points d'entrée du serveur d'autorisation. */
export type AuthServer = { authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string };

export type TokenGrant = { accessToken: string; refreshToken: string | null; expiresAt: number; scope: string | null };

/** Un refus d'Atlassian : `status` est le code HTTP (null : pas de réponse). */
export class AtlassianOAuthError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
  }
}

/** Aucun jeton rangé : l'approbateur doit brancher Atlassian. */
export class AtlassianNotConnected extends Error {}

export function redirectUriOf(config: AtlassianConfig): string {
  return config.redirectUri ?? LOOPBACK_REDIRECT;
}

/** Une boucle locale : le navigateur de l'humain ne joindra pas le serveur, il recolle l'adresse dans l'app. */
export function isPasteBack(redirectUri: string): boolean {
  try {
    return isLoopbackUrl(new URL(redirectUri));
  } catch {
    return false;
  }
}

/** PKCE S256 : un verifier de 64 octets aléatoires (base64url) et son empreinte SHA-256. */
export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/** Deux secrets égaux, comparés en temps constant. */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function httpsUrl(value: unknown, what: string): string {
  if (typeof value === "string") {
    try {
      if (new URL(value).protocol === "https:") return value;
    } catch {
      // illisible : refusé plus bas
    }
  }
  throw new AtlassianOAuthError(`${what} : URL https attendue dans les métadonnées d'Atlassian`, null);
}

async function request(
  fetch: AtlassianFetch,
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  what: string,
): Promise<unknown> {
  let response: AtlassianResponse;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) });
  } catch (error) {
    throw new AtlassianOAuthError(`${what} : ${error instanceof Error ? error.message : String(error)}`, null);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    // Le corps d'une erreur OAuth (`{error, error_description}`) ne porte pas de secret : sa raison seule.
    let reason = "";
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && typeof parsed.error === "string") reason = ` (${parsed.error})`;
    } catch {
      reason = "";
    }
    throw new AtlassianOAuthError(`${what} : HTTP ${response.status}${reason}`, response.status);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AtlassianOAuthError(`${what} : réponse illisible`, response.status);
  }
}

/**
 * La découverte : la ressource protégée (le serveur MCP) désigne son serveur d'autorisation,
 * dont les métadonnées donnent les points d'entrée. Seul PKCE S256 est admis.
 */
export async function discover(fetch: AtlassianFetch, mcpUrl: string): Promise<AuthServer> {
  const mcp = new URL(mcpUrl);
  const resource = await request(
    fetch,
    `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname === "/" ? "" : mcp.pathname}`,
    { method: "GET", headers: { Accept: "application/json" } },
    "métadonnées de la ressource MCP",
  );
  const servers = isRecord(resource) ? resource.authorization_servers : undefined;
  const issuer = httpsUrl(Array.isArray(servers) ? servers[0] : undefined, "serveur d'autorisation").replace(
    /\/+$/,
    "",
  );
  // Mesuré : `<serveur>/.well-known/oauth-authorization-server` ; la forme RFC 8414 (inséré avant le chemin) en repli.
  const parsed = new URL(issuer);
  const candidates = [`${issuer}/.well-known/oauth-authorization-server`];
  if (parsed.pathname !== "/" && parsed.pathname !== "")
    candidates.push(`${parsed.origin}/.well-known/oauth-authorization-server${parsed.pathname}`);
  let metadata: unknown = null;
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      metadata = await request(
        fetch,
        candidate,
        { method: "GET", headers: { Accept: "application/json" } },
        "métadonnées du serveur d'autorisation",
      );
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!isRecord(metadata)) throw lastError ?? new AtlassianOAuthError("métadonnées du serveur d'autorisation", null);
  const methods = metadata.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256"))
    throw new AtlassianOAuthError("le serveur d'autorisation n'offre pas PKCE S256", null);
  return {
    authorizationEndpoint: httpsUrl(metadata.authorization_endpoint, "authorization_endpoint"),
    tokenEndpoint: httpsUrl(metadata.token_endpoint, "token_endpoint"),
    registrationEndpoint: httpsUrl(metadata.registration_endpoint, "registration_endpoint"),
  };
}

/** L'enregistrement dynamique du client du harness (DCR), sans secret. */
export async function registerClient(fetch: AtlassianFetch, server: AuthServer, redirectUri: string): Promise<string> {
  const body = await request(
    fetch,
    server.registrationEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_name: "omp-harness",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    },
    "enregistrement du client OAuth",
  );
  if (!isRecord(body) || typeof body.client_id !== "string" || body.client_id === "")
    throw new AtlassianOAuthError("enregistrement du client OAuth : client_id absent", null);
  return body.client_id;
}

/** L'adresse de consentement : PKCE S256, state, portées, ressource MCP, consentement redemandé. */
export function authorizeUrl(
  server: AuthServer,
  input: { clientId: string; redirectUri: string; challenge: string; state: string; resource: string },
): string {
  const url = new URL(server.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("code_challenge", input.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", input.state);
  url.searchParams.set("scope", ATLASSIAN_SCOPES.join(" "));
  url.searchParams.set("resource", input.resource);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

async function tokenRequest(
  fetch: AtlassianFetch,
  tokenEndpoint: string,
  form: Record<string, string>,
  what: string,
  now: number,
): Promise<TokenGrant> {
  const body = await request(
    fetch,
    tokenEndpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
    },
    what,
  );
  if (!isRecord(body) || typeof body.access_token !== "string" || body.access_token === "")
    throw new AtlassianOAuthError(`${what} : access_token absent`, null);
  const expiresIn = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" && body.refresh_token !== "" ? body.refresh_token : null,
    expiresAt: now + expiresIn * 1000,
    scope: typeof body.scope === "string" ? body.scope : null,
  };
}

function tokensOf(raw: unknown): AtlassianTokens | null {
  if (!isRecord(raw)) return null;
  const text = (key: string): string | null => (typeof raw[key] === "string" && raw[key] !== "" ? raw[key] : null);
  const clientId = text("clientId");
  const redirectUri = text("redirectUri");
  const accessToken = text("accessToken");
  const connectedBy = text("connectedBy");
  const { expiresAt, connectedAt } = raw;
  if (clientId === null || redirectUri === null || accessToken === null || connectedBy === null) return null;
  if (typeof expiresAt !== "number" || typeof connectedAt !== "number") return null;
  return {
    clientId,
    redirectUri,
    accessToken,
    refreshToken: text("refreshToken"),
    expiresAt,
    scope: text("scope") ?? "",
    cloudId: text("cloudId"),
    siteUrl: text("siteUrl"),
    accountId: text("accountId"),
    connectedAt,
    connectedBy,
  };
}

export type AtlassianAuthDeps = {
  fetch: AtlassianFetch;
  config: () => AtlassianConfig;
  now?: () => number;
  /** Atlassian a refusé le refresh token (révoqué, expiré) : les jetons sont oubliés. */
  onRevoked: (reason: string) => void;
};

/** Les jetons du harness, son consentement en attente et leur rafraîchissement. */
export class AtlassianAuth {
  readonly #fetch: AtlassianFetch;
  readonly #config: () => AtlassianConfig;
  readonly #now: () => number;
  readonly #onRevoked: (reason: string) => void;
  /** Le fichier lu, et la marque (chemin, date, taille) qui dit s'il faut le relire. */
  #cache: { stamp: string; tokens: AtlassianTokens | null } | null = null;
  #pending: PendingConsent | null = null;
  /** La découverte, faite une fois par adresse MCP. */
  #server: { mcpUrl: string; server: AuthServer } | null = null;
  /** Le dernier client enregistré, réutilisé tant que l'adresse de retour ne change pas. */
  #client: { clientId: string; redirectUri: string } | null = null;
  #refreshing: Promise<string> | null = null;

  constructor(deps: AtlassianAuthDeps) {
    this.#fetch = deps.fetch;
    this.#config = deps.config;
    this.#now = deps.now ?? Date.now;
    this.#onRevoked = deps.onRevoked;
  }

  /** Les jetons rangés, relus quand le fichier change ; `null` s'il n'y en a pas (ou s'il est illisible). */
  tokens(): AtlassianTokens | null {
    const file = this.#config().tokenFile;
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat === undefined) {
      this.#cache = null;
      return null;
    }
    const stamp = `${file}:${stat.mtimeMs}:${stat.size}`;
    if (this.#cache?.stamp === stamp) return this.#cache.tokens;
    let tokens: AtlassianTokens | null = null;
    try {
      tokens = tokensOf(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch {
      tokens = null;
    }
    this.#cache = { stamp, tokens };
    return tokens;
  }

  save(tokens: AtlassianTokens): void {
    const file = this.#config().tokenFile;
    atomicWrite(file, `${JSON.stringify(tokens, null, 2)}\n`, 0o600);
    fs.chmodSync(file, 0o600);
    this.#cache = null;
  }

  forget(): void {
    fs.rmSync(this.#config().tokenFile, { force: true });
    this.#cache = null;
  }

  /** Le consentement en attente, s'il n'a pas expiré. */
  pending(): PendingConsent | null {
    if (this.#pending !== null && this.#pending.expiresAt <= this.#now()) this.#pending = null;
    return this.#pending;
  }

  async #authServer(): Promise<AuthServer> {
    const { mcpUrl } = this.#config();
    if (this.#server?.mcpUrl !== mcpUrl) this.#server = { mcpUrl, server: await discover(this.#fetch, mcpUrl) };
    return this.#server.server;
  }

  /** Un nouveau consentement (il remplace le précédent) : découverte, client, PKCE et adresse. */
  async begin(by: string): Promise<PendingConsent> {
    const config = this.#config();
    const server = await this.#authServer();
    const redirectUri = redirectUriOf(config);
    const stored = this.tokens();
    let clientId: string;
    if (stored?.redirectUri === redirectUri) clientId = stored.clientId;
    else if (this.#client?.redirectUri === redirectUri) clientId = this.#client.clientId;
    else clientId = await registerClient(this.#fetch, server, redirectUri);
    this.#client = { clientId, redirectUri };
    const { verifier, challenge } = pkce();
    const state = randomBytes(32).toString("base64url");
    this.#pending = {
      state,
      verifier,
      clientId,
      redirectUri,
      expiresAt: this.#now() + CONSENT_TTL_MS,
      authorizeUrl: authorizeUrl(server, { clientId, redirectUri, challenge, state, resource: config.mcpUrl }),
      by,
    };
    return this.#pending;
  }

  /** Le consentement de ce `state`, retiré (usage unique) ; `null` s'il est inconnu ou expiré. */
  take(state: unknown): PendingConsent | null {
    const pending = this.pending();
    if (pending === null || typeof state !== "string" || !sameSecret(pending.state, state)) return null;
    this.#pending = null;
    return pending;
  }

  /** Le code de retour échangé contre les jetons. */
  async exchange(pending: PendingConsent, code: string): Promise<TokenGrant> {
    const server = await this.#authServer();
    return tokenRequest(
      this.#fetch,
      server.tokenEndpoint,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: pending.redirectUri,
        client_id: pending.clientId,
        code_verifier: pending.verifier,
      },
      "échange du code",
      this.#now(),
    );
  }

  /** Le jeton d'accès, rafraîchi d'abord s'il arrive à sa fin. */
  async accessToken(): Promise<string> {
    const tokens = this.tokens();
    if (tokens === null) throw new AtlassianNotConnected("Atlassian n'est pas connecté");
    if (tokens.expiresAt - EXPIRY_SKEW_MS > this.#now()) return tokens.accessToken;
    return this.refresh(tokens.accessToken);
  }

  /**
   * Un nouveau jeton d'accès à la place de `stale` (refusé par Atlassian, ou à sa fin). Un seul
   * rafraîchissement en vol : les appels concurrents l'attendent, et un appel qui arrive après
   * avec l'ancien jeton reçoit le nouveau sans en relancer un.
   */
  refresh(stale: string): Promise<string> {
    if (this.#refreshing !== null) return this.#refreshing;
    const current = this.tokens();
    if (current === null) return Promise.reject(new AtlassianNotConnected("Atlassian n'est pas connecté"));
    if (current.accessToken !== stale && current.expiresAt - EXPIRY_SKEW_MS > this.#now())
      return Promise.resolve(current.accessToken);
    const refreshing = this.#refresh(current).finally(() => {
      this.#refreshing = null;
    });
    this.#refreshing = refreshing;
    return refreshing;
  }

  async #refresh(current: AtlassianTokens): Promise<string> {
    if (current.refreshToken === null) {
      this.#revoked("aucun refresh token (offline_access refusé ?) : rebranche Atlassian");
      throw new AtlassianNotConnected("Atlassian n'est plus connecté : rebranche-le depuis l'app");
    }
    const server = await this.#authServer();
    let grant: TokenGrant;
    try {
      grant = await tokenRequest(
        this.#fetch,
        server.tokenEndpoint,
        { grant_type: "refresh_token", refresh_token: current.refreshToken, client_id: current.clientId },
        "rafraîchissement du jeton",
        this.#now(),
      );
    } catch (error) {
      // 400/401 : refresh token refusé (révoqué, expiré) — les jetons ne servent plus.
      if (error instanceof AtlassianOAuthError && (error.status === 400 || error.status === 401)) {
        this.#revoked(error.message);
        throw new AtlassianNotConnected("Atlassian a refusé le jeton : rebranche-le depuis l'app");
      }
      throw error;
    }
    this.save({
      ...current,
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken ?? current.refreshToken,
      expiresAt: grant.expiresAt,
      scope: grant.scope ?? current.scope,
    });
    return grant.accessToken;
  }

  #revoked(reason: string): void {
    this.forget();
    this.#onRevoked(reason);
  }
}
