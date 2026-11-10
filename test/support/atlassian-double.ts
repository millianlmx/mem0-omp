// La doublure d'Atlassian des tests : les métadonnées OAuth, l'enregistrement du client (DCR),
// le point de jeton (code et rafraîchissement, jetons qui tournent) et le serveur MCP Streamable
// HTTP (session, `tools/call` des outils du connecteur, `assignee = currentUser()` reconnu dans
// la JQL). Aucun réseau : c'est un `fetch` (AtlassianFetch) à passer à `fakeWorld({ atlassian })`.
//
// Ce module n'est pas un fichier de test : seuls les tests l'importent.
import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LOOPBACK_REDIRECT } from "../../omp-harness/config.ts";
import { spaceTokenFile } from "../../omp-harness/atlassian/oauth.ts";
import type { AtlassianFetch, AtlassianResponse, AtlassianTokens } from "../../omp-harness/atlassian/oauth.ts";
import type { FakeWorld } from "./harness-fixtures.ts";

export const FAKE_MCP_URL = "https://mcp.atlassian.com/v2/mcp";
export const FAKE_AS = "https://auth.atlassian.com/tenant-test";
export const FAKE_AUTHORIZE = "https://auth.atlassian.com/authorize";
export const FAKE_TOKEN_URL = "https://auth.atlassian.com/oauth/token";
export const FAKE_CLOUD_ID = "cloud-0000-test";
export const FAKE_SITE = "https://exemple.atlassian.net";
export const FAKE_ACCOUNT = "712020:compte-test";
/** Le code que le consentement rend (tout autre est refusé). */
export const FAKE_CODE = "code-ok";
/** Les jetons valides au départ (ceux que range `connectAtlassian`). */
export const FAKE_ACCESS_TOKEN = "at-0";
export const FAKE_REFRESH_TOKEN = "rt-0";

export type FakeIssue = {
  key: string;
  summary: string;
  status: string;
  /** `me` : assigné à l'utilisateur connecté. */
  assignee: "me" | "other" | null;
  comments: string[];
};

export type FakeRequest = { url: string; method: string; headers: Record<string, string>; body: string };

export type AtlassianDouble = {
  fetch: AtlassianFetch;
  /** Les `tools/call` reçus, dans l'ordre. */
  calls: { tool: string; args: Record<string, unknown> }[];
  /** Toutes les requêtes reçues. */
  requests: FakeRequest[];
  issues: FakeIssue[];
  /** Les corps (form) reçus par le point de jeton. */
  tokenForms: Record<string, string>[];
  registrations: number;
  refreshes: number;
  initializes: number;
  /** Le jeton d'accès accepté par le serveur MCP. */
  access: string;
  refresh: string;
  /** Réponses MCP en SSE (sinon JSON). */
  sse: boolean;
  /** Un outil MCP qui rend `isError` avec ce texte. */
  failTools: Map<string, string>;
  /** Le rafraîchissement refusé (400 invalid_grant). */
  revoked: boolean;
  /** L'attente du point de jeton pendant un rafraîchissement (concurrence). */
  refreshDelayMs: number;
  /** Le jeton d'accès courant n'est plus accepté (401 jusqu'au rafraîchissement). */
  expire(): void;
  /** Le serveur oublie ses sessions (404 jusqu'à la prochaine `initialize`). */
  dropSessions(): void;
};

function response(status: number, body: string, headers: Record<string, string> = {}): AtlassianResponse {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body) as unknown,
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
  };
}

function json(status: number, value: unknown, headers: Record<string, string> = {}): AtlassianResponse {
  return response(status, JSON.stringify(value), { "Content-Type": "application/json", ...headers });
}

/** La doublure, avec trois tickets (deux à l'utilisateur) par défaut. */
export function fakeAtlassian(opts: { sse?: boolean; issues?: FakeIssue[] } = {}): AtlassianDouble {
  const sessions = new Set<string>();
  let counter = 0;
  const double: AtlassianDouble = {
    fetch: async (url, init) => handle(url, init),
    calls: [],
    requests: [],
    issues: opts.issues ?? [
      { key: "PROJ-1", summary: "Livrer le module de paiement", status: "À faire", assignee: "me", comments: [] },
      { key: "PROJ-2", summary: "Revue du schéma", status: "En cours", assignee: "me", comments: [] },
      { key: "PROJ-3", summary: "Ticket d'un collègue", status: "À faire", assignee: "other", comments: [] },
    ],
    tokenForms: [],
    registrations: 0,
    refreshes: 0,
    initializes: 0,
    access: FAKE_ACCESS_TOKEN,
    refresh: FAKE_REFRESH_TOKEN,
    sse: opts.sse ?? false,
    failTools: new Map(),
    revoked: false,
    refreshDelayMs: 0,
    expire: () => {
      double.access = `${double.access}-expiré`;
    },
    dropSessions: () => sessions.clear(),
  };

  const issueView = (issue: FakeIssue) => ({
    key: issue.key,
    fields: {
      summary: issue.summary,
      status: { name: issue.status },
      assignee:
        issue.assignee === "me"
          ? { accountId: FAKE_ACCOUNT }
          : issue.assignee === "other"
            ? { accountId: "autre" }
            : null,
    },
  });

  const tool = (name: string, args: Record<string, unknown>): { text: string; isError?: boolean } => {
    const failure = double.failTools.get(name);
    if (failure !== undefined) return { text: failure, isError: true };
    const needsCloud = !["getAccessibleAtlassianResources", "atlassianUserInfo", "discover"].includes(name);
    if (needsCloud && args.cloudId !== FAKE_CLOUD_ID)
      return { text: "MCP error -32602: cloudId manquant ou inconnu", isError: true };
    switch (name) {
      case "getAccessibleAtlassianResources":
        return {
          text: JSON.stringify({
            data: {
              resources: [{ cloudId: FAKE_CLOUD_ID, url: FAKE_SITE, products: [{ id: "jira", access: "read-write" }] }],
            },
          }),
        };
      case "atlassianUserInfo":
        return { text: JSON.stringify({ data: { accountId: FAKE_ACCOUNT } }) };
      case "search":
        return { text: `Résultats Rovo pour « ${String(args.query)} » (${String(args.limit)})` };
      case "searchJiraIssuesUsingJql": {
        const jql = String(args.jql);
        const key = /key\s*=\s*"?([A-Z][A-Z0-9_]+-\d+)"?/.exec(jql)?.[1];
        const mine = /assignee\s*=\s*currentUser\(\)/i.test(jql);
        const issues = double.issues
          .filter((issue) => (key === undefined || issue.key === key) && (!mine || issue.assignee === "me"))
          .slice(0, typeof args.maxResults === "number" ? args.maxResults : 50);
        return { text: JSON.stringify({ issues: issues.map(issueView), isLast: true }) };
      }
      case "getJiraIssue": {
        const issue = double.issues.find((candidate) => candidate.key === args.issueIdOrKey);
        if (!issue) return { text: `Issue does not exist: ${String(args.issueIdOrKey)}`, isError: true };
        return { text: `# ${issue.key} — ${issue.summary}\nÉtat : ${issue.status}` };
      }
      case "searchConfluence":
        return { text: JSON.stringify({ results: [{ id: "123", title: `Page (${String(args.cql)})` }] }) };
      case "getConfluenceContent":
        return { text: `# Page ${String(args.content_id ?? args.content_url)}\nContenu.` };
      case "transitionJiraIssue": {
        const issue = double.issues.find((candidate) => candidate.key === args.issueIdOrKey);
        if (!issue) return { text: "Issue does not exist", isError: true };
        issue.status = String(args.transitionName);
        return { text: `Transition « ${issue.status} » appliquée à ${issue.key}` };
      }
      case "addOrEditJiraIssueComment": {
        const issue = double.issues.find((candidate) => candidate.key === args.issueIdOrKey);
        if (!issue) return { text: "Issue does not exist", isError: true };
        issue.comments.push(String(args.commentBody));
        return { text: JSON.stringify({ id: `c${issue.comments.length}` }) };
      }
      default:
        return { text: `MCP error -32602: Tool ${name} not found`, isError: true };
    }
  };

  const mcp = (init: { headers: Record<string, string>; body?: string }): AtlassianResponse => {
    if (init.headers.Authorization !== `Bearer ${double.access}`) return json(401, { error: "invalid_token" });
    const message = JSON.parse(init.body ?? "{}") as { id?: number; method?: string; params?: Record<string, unknown> };
    if (message.method === "initialize") {
      double.initializes++;
      const session = `sess-${++counter}`;
      sessions.add(session);
      return json(
        200,
        { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } },
        { "Mcp-Session-Id": session },
      );
    }
    const session = init.headers["Mcp-Session-Id"];
    if (session === undefined || !sessions.has(session)) return json(404, { error: "session inconnue" });
    if (message.id === undefined) return response(202, "");
    if (message.method !== "tools/call")
      return json(200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "méthode inconnue" } });
    const name = String(message.params?.name);
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    double.calls.push({ tool: name, args });
    const result = tool(name, args);
    const reply = {
      jsonrpc: "2.0",
      id: message.id,
      result: { content: [{ type: "text", text: result.text }], isError: result.isError === true },
    };
    if (!double.sse) return json(200, reply);
    return response(200, `event: message\ndata: ${JSON.stringify(reply)}\n\n`, { "Content-Type": "text/event-stream" });
  };

  const token = async (body: string): Promise<AtlassianResponse> => {
    const form = Object.fromEntries(new URLSearchParams(body));
    double.tokenForms.push(form);
    if (form.grant_type === "authorization_code") {
      if (form.code !== FAKE_CODE || !form.code_verifier || !form.client_id)
        return json(400, { error: "invalid_grant" });
      counter++;
      double.access = `at-${counter}`;
      double.refresh = `rt-${counter}`;
      return json(200, {
        access_token: double.access,
        refresh_token: double.refresh,
        expires_in: 28_800,
        scope: "read:jira",
      });
    }
    if (form.grant_type === "refresh_token") {
      double.refreshes++;
      if (double.refreshDelayMs > 0) await sleep(double.refreshDelayMs);
      if (double.revoked || form.refresh_token !== double.refresh) return json(400, { error: "invalid_grant" });
      counter++;
      double.access = `at-${counter}`;
      double.refresh = `rt-${counter}`;
      return json(200, { access_token: double.access, refresh_token: double.refresh, expires_in: 28_800 });
    }
    return json(400, { error: "unsupported_grant_type" });
  };

  async function handle(
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  ): Promise<AtlassianResponse> {
    double.requests.push({ url, method: init.method, headers: init.headers, body: init.body ?? "" });
    if (init.signal?.aborted) throw new Error("requête annulée");
    if (init.method === "GET" && url === "https://mcp.atlassian.com/.well-known/oauth-protected-resource/v2/mcp")
      return json(200, { resource: FAKE_MCP_URL, authorization_servers: [FAKE_AS], scopes_supported: ["read:jira"] });
    if (init.method === "GET" && url === `${FAKE_AS}/.well-known/oauth-authorization-server`)
      return json(200, {
        issuer: FAKE_AS,
        authorization_endpoint: FAKE_AUTHORIZE,
        token_endpoint: FAKE_TOKEN_URL,
        registration_endpoint: `${FAKE_AS}/dcr/register`,
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
      });
    if (init.method === "POST" && url === `${FAKE_AS}/dcr/register`) {
      double.registrations++;
      const body = JSON.parse(init.body ?? "{}") as { token_endpoint_auth_method?: string };
      if (body.token_endpoint_auth_method !== "none") return json(400, { error: "invalid_client_metadata" });
      return json(201, { client_id: `client-${double.registrations}` });
    }
    if (init.method === "POST" && url === FAKE_TOKEN_URL) return token(init.body ?? "");
    if (init.method === "POST" && url === FAKE_MCP_URL) return mcp(init);
    return json(404, { error: `inconnu : ${init.method} ${url}` });
  }

  return double;
}

/**
 * Range des jetons valides (site et compte compris) : un test « déjà branché », sans danse OAuth.
 * `space` : la connexion de cet espace (son fichier `atlassian-<espaceId>.json`) ; absent : celle par défaut.
 */
export function connectAtlassian(
  world: Pick<FakeWorld, "config">,
  patch: Partial<AtlassianTokens> = {},
  space?: string,
): AtlassianTokens {
  const now = Date.now();
  const tokens: AtlassianTokens = {
    clientId: "client-0",
    redirectUri: LOOPBACK_REDIRECT,
    accessToken: FAKE_ACCESS_TOKEN,
    refreshToken: FAKE_REFRESH_TOKEN,
    expiresAt: now + 8 * 3600 * 1000,
    scope: "read:jira",
    cloudId: FAKE_CLOUD_ID,
    siteUrl: FAKE_SITE,
    accountId: FAKE_ACCOUNT,
    connectedAt: now,
    connectedBy: "admin",
    ...patch,
  };
  const { atlassian } = world.config;
  const file = space === undefined ? atlassian.tokenFile : spaceTokenFile(atlassian, space);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(tokens), { mode: 0o600 });
  return tokens;
}
