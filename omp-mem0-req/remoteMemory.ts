// Les routes MÉMOIRE du protocole distant (S-3) : `GET /v1/memory/page`,
// `/v1/memory/search`, `/v1/memory/graph`. Portage de `RemoteReads.memoryPage` /
// `memorySearch` / `memoryGraph` (`omp-console/Sources/OMPConsole/Remote/RemoteReads.swift`),
// du client `HTTPMemoryService` (`OMPConsole/Memory/MemoryService.swift`), de
// `MemorySearch.select` (`MemorySearch.swift`), de `RemoteLimits` et des charges
// `RemoteMemory*Payload` (`Payloads.swift`). La mémoire est mem0-rs en BOUCLE LOCALE :
// `MEM0_HTTP_URL` (défaut http://localhost:8321) et `MEM0_HTTP_TOKEN` (en-tête
// `x-mem0-token`, absent si vide), lus dans `ctx.env`. Le proxy `/v1/mem0/*` n'est PAS ici.
//
// Écart assumé : le Mac résout une portée absente par le projet OUVERT de sa fenêtre
// (préférence utilisateur, sans équivalent sur le VPS) ; ici la portée absente se replie
// sur `MEM0_PROJECT_ID` (l'override de `MemoryScope.scope`), sinon « aucune portée ».
import { join } from "node:path";
import { RemoteError, remoteJson, sortedJson } from "./remoteApi.ts";
import type { RemoteRoute } from "./remoteApi.ts";
import type { RemoteContext } from "./remoteContext.ts";
import { loadMemoryLinks, graphLinks, graphNodes, MEMORY_LINKS_RELATIVE_PATH, wireNodeId } from "./remoteMemoryGraph.ts";
import type { MemoryGraphEdge, MemoryLink, MemoryRow } from "./remoteMemoryGraph.ts";
import { characters, trimWhitespacesAndNewlines } from "./remoteMemoryText.ts";

// --- RemoteLimits (Payloads.swift:13-25) ---------------------------------------------------

export const RemoteLimits = {
  responseBody: 2 * 1024 * 1024,
  /** La taille par défaut d'une page de mémoire. */
  memoryPageSize: 100,
  memoryLimitMax: 200,
  /** La borne d'octets PROPRE au graphe. */
  memoryGraphBody: 16 * 1024 * 1024,
} as const;

// --- MemorySearch (MemorySearch.swift) ---------------------------------------------------------

/** Plancher de pertinence du service (`SEARCH_THRESHOLD`). */
export const MEMORY_SEARCH_THRESHOLD = 0.55;
/** Plafond du pool demandé au service (`SEARCH_POOL_MAX`). */
export const MEMORY_SEARCH_POOL_MAX = 50;
/** La limite finale par défaut (celle de l'outil `mem0_search`). */
export const MEMORY_SEARCH_DEFAULT_LIMIT = 6;

/** Le pool sur-échantillonné demandé au serveur : `min(limit × 4, 50)`. */
export function searchPool(requested: number): number {
  return Math.min(requested * 4, MEMORY_SEARCH_POOL_MAX);
}

/**
 * `kept` = lignes dont le cosinus est ≥ `floor`, triées par cosinus décroissant (ordre
 * reçu à égalité) puis tronquées à `limit` ; `candidates` = lignes reçues ; `scored` =
 * lignes portant un cosinus.
 */
export function selectRelevant(
  rows: MemoryRow[],
  floor: number,
  limit: number,
): { kept: MemoryRow[]; candidates: number; scored: number } {
  const hits: { row: MemoryRow; score: number; index: number }[] = [];
  let scored = 0;
  rows.forEach((row, index) => {
    if (row.semanticScore === null) return;
    scored += 1;
    if (row.semanticScore >= floor) hits.push({ row, score: row.semanticScore, index });
  });
  hits.sort((left, right) => (left.score !== right.score ? right.score - left.score : left.index - right.index));
  return { kept: hits.slice(0, Math.max(0, limit)).map(hit => hit.row), candidates: rows.length, scored };
}

// --- MemoryJSON : les gardes de décodage (MemoryService.swift:158-250) ------------------------

type Json = unknown;

function isObject(json: Json): json is Record<string, Json> {
  return json !== null && typeof json === "object" && !Array.isArray(json);
}

/** La forme TEXTE d'une valeur JSON : une chaîne telle quelle, le reste sérialisé. */
function scalar(value: Json): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
}

function memoryJsonRows(json: Json): Json[] {
  if (Array.isArray(json)) return json;
  if (isObject(json) && Array.isArray(json.results)) return json.results as Json[];
  return [];
}

function memoryLine(json: Json): string {
  if (!isObject(json)) return scalar(json);
  if (json.memory !== undefined && json.memory !== null) return scalar(json.memory);
  if (json.text !== undefined && json.text !== null) return scalar(json.text);
  return scalar(json);
}

function memoryId(json: Json): string {
  if (!isObject(json)) return "?";
  const raw = json.id;
  if (typeof raw === "string") return raw;
  if (typeof raw === "number") return String(raw);
  return "?";
}

function memoryScore(json: Json): number | null {
  if (!isObject(json) || !isObject(json.score_details)) return null;
  const raw = json.score_details.semantic_score;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

function memoryTags(json: Json): string[] {
  if (!isObject(json) || !isObject(json.metadata)) return [];
  const raw = json.metadata.tags;
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map(part => part.replace(/^[\t\p{Zs}]+|[\t\p{Zs}]+$/gu, ""))
    .filter(tag => tag !== "");
}

function memoryRow(json: Json): MemoryRow {
  const object = isObject(json) ? json : null;
  const updated = object?.updated_at;
  const agent = object?.agent_id;
  return {
    id: memoryId(json),
    text: memoryLine(json),
    updatedAt: updated === undefined || updated === null ? null : scalar(updated),
    semanticScore: memoryScore(json),
    tags: memoryTags(json),
    agentId: typeof agent === "string" ? agent : null,
  };
}

/** `MemoryGraphEdges.decode` : une arête dont les extrémités ne sont pas deux chaînes et le score un nombre fini est ignorée. */
function decodeEdges(json: Json): MemoryGraphEdge[] {
  const raw = isObject(json) && Array.isArray(json.edges) ? (json.edges as Json[]) : [];
  const edges: MemoryGraphEdge[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) continue;
    const { source, target, score } = entry;
    if (typeof source !== "string" || typeof target !== "string") continue;
    if (typeof score !== "number" || !Number.isFinite(score)) continue;
    edges.push({ source, target, score });
  }
  return edges;
}

// --- le client mem0-rs (HTTPMemoryService) ----------------------------------------------------

/** Les budgets d'INACTIVITÉ du Mac : `HTTPMemoryService.searchTimeout` / `graphTimeout` / `otherTimeout`. */
const SEARCH_TIMEOUT_MS = 20_000;
const GRAPH_TIMEOUT_MS = 20_000;
const OTHER_TIMEOUT_MS = 10_000;

const DEFAULT_BASE_URL = "http://localhost:8321";

export type MemoryServiceConfig = { baseURL: string; token: string };

/** `MemoryServiceConfig.fromEnvironment` : une variable posée mais vide est absente ; une URL illisible retombe sur le défaut. */
export function memoryServiceConfig(env: Record<string, string | undefined>): MemoryServiceConfig {
  const raw = env.MEM0_HTTP_URL;
  const valid = raw !== undefined && raw !== "" && URL.canParse(raw);
  return { baseURL: valid ? raw : DEFAULT_BASE_URL, token: env.MEM0_HTTP_TOKEN ?? "" };
}

/** Les erreurs du client, chacune avec SON texte (`MemoryServiceError.userMessage`). */
class MemoryServiceError extends Error {
  readonly status: number | null;
  constructor(userMessage: string, status: number | null = null) {
    super(userMessage);
    this.name = "MemoryServiceError";
    this.status = status;
  }
}

/** `MemoryText.tokenRefused` / `unreadableResponse` / `unexpectedStatus` / `unavailableDetail`. */
const TOKEN_REFUSED = "jeton refusé (401)";
const UNREADABLE_RESPONSE = "réponse illisible";

function unexpectedStatus(code: number, detail: string): string {
  return `réponse ${code} du service (${detail})`;
}

function unavailableDetail(address: string, error: string): string {
  return error === "" ? address : `${address}\n${error}`;
}

/**
 * Le texte d'une panne de transport : la description localisée de `URLError` sur le Mac
 * (app en français : `CFBundleDevelopmentRegion = fr`).
 */
function transportMessage(error: unknown): string {
  const cause = (error as { cause?: { code?: string } } | null)?.cause;
  const code = cause?.code ?? "";
  const name = (error as { name?: string } | null)?.name ?? "";
  if (name === "TimeoutError" || name === "AbortError" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT") {
    return "La requête a expiré.";
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "Impossible de trouver un serveur avec le nom d’hôte spécifié.";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "Connexion réseau perdue.";
  return "Impossible de se connecter au serveur.";
}

/** Le début d'un corps en échec, borné à 300 caractères (`MemoryServiceError.detail`). */
function failureDetail(body: string): string {
  const text = trimWhitespacesAndNewlines(body);
  return text === "" ? "corps vide" : characters(text).slice(0, 300).join("");
}

async function send(
  config: MemoryServiceConfig,
  method: "GET" | "POST",
  path: string,
  options: { query?: Record<string, string>; body?: unknown; timeoutMs: number },
): Promise<Json> {
  const url = new URL(`${config.baseURL.replace(/\/+$/u, "")}${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (config.token !== "") headers["x-mem0-token"] = config.token;
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    text = await response.text();
  } catch (error) {
    throw new MemoryServiceError(transportMessage(error));
  }
  if (response.status < 200 || response.status > 299) {
    if (response.status === 401) throw new MemoryServiceError(TOKEN_REFUSED, 401);
    throw new MemoryServiceError(unexpectedStatus(response.status, failureDetail(text)), response.status);
  }
  let json: Json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MemoryServiceError(UNREADABLE_RESPONSE);
  }
  // `JSONSerialization` sans `.fragmentsAllowed` : seule une racine tableau ou objet est lisible.
  if (json === null || typeof json !== "object") throw new MemoryServiceError(UNREADABLE_RESPONSE);
  return json;
}

type MemoryPage = { total: number; rows: MemoryRow[] };

async function serviceAll(config: MemoryServiceConfig, scope: string): Promise<MemoryPage> {
  const json = await send(config, "GET", "/memory/all", { query: { agent_id: scope }, timeoutMs: OTHER_TIMEOUT_MS });
  const rows = memoryJsonRows(json).map(memoryRow);
  const total = isObject(json) && typeof json.total === "number" && Number.isInteger(json.total) ? json.total : rows.length;
  return { total, rows };
}

async function serviceSearch(config: MemoryServiceConfig, query: string, scope: string, pool: number): Promise<MemoryRow[]> {
  const json = await send(config, "POST", "/memory/search", {
    body: { query, limit: pool, filters: null, threshold: MEMORY_SEARCH_THRESHOLD, explain: true, agent_id: scope },
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  return memoryJsonRows(json).map(memoryRow);
}

async function serviceGraph(config: MemoryServiceConfig): Promise<MemoryGraphEdge[]> {
  return decodeEdges(await send(config, "GET", "/memory/graph", { timeoutMs: GRAPH_TIMEOUT_MS }));
}

// --- les erreurs de la route (RemoteReads.memoryError / graphError) -----------------------------

/** 503 `unavailable` : l'adresse RÉELLEMENT sondée puis le dernier échec, comme la coque. */
function memoryError(error: unknown, config: MemoryServiceConfig): RemoteError {
  if (!(error instanceof MemoryServiceError)) return new RemoteError("server", "mémoire indisponible");
  return new RemoteError("unavailable", unavailableDetail(config.baseURL, error.message));
}

/** Un 404 ou un 405 amont de `/memory/graph` = route absente côté mem0 : `outdated_service`. */
function graphError(error: unknown, config: MemoryServiceConfig): RemoteError {
  const translated = memoryError(error, config);
  if (error instanceof MemoryServiceError && (error.status === 404 || error.status === 405) && translated.code === "unavailable") {
    return new RemoteError("outdated_service", translated.message);
  }
  return translated;
}

// --- paramètres (RemoteReads.memoryLimit / memoryOffset) ----------------------------------------

/** `Int(String)` de Swift : signe facultatif puis chiffres, rien d'autre ; `null` sinon ou hors Int64. */
function swiftInt(raw: string): number | null {
  if (!/^[+-]?[0-9]+$/u.test(raw)) return null;
  const value = BigInt(raw);
  if (value > 9223372036854775807n || value < -9223372036854775808n) return null;
  return Number(value);
}

/** `limit` : entier FACULTATIF 1…200 ; absent ⇒ `null` ; hors bornes ⇒ 400. */
function memoryLimit(raw: string | null): number | null {
  if (raw === null || raw === "") return null;
  const value = swiftInt(raw);
  if (value === null || value < 1 || value > RemoteLimits.memoryLimitMax) throw new RemoteError("bad_request", "limit hors bornes");
  return value;
}

/** `offset` : entier FACULTATIF ≥ 0, 0 quand il est absent ; sinon 400. */
function memoryOffset(raw: string | null): number {
  if (raw === null || raw === "") return 0;
  const value = swiftInt(raw);
  if (value === null || value < 0) throw new RemoteError("bad_request", "offset hors bornes");
  return value;
}

/** Une portée explicite, sinon l'override `MEM0_PROJECT_ID` ; `null` quand aucune. */
function resolvedScope(scope: string | null, env: Record<string, string | undefined>): string | null {
  if (scope !== null && scope !== "") return scope;
  const override = env.MEM0_PROJECT_ID;
  return override !== undefined && override !== "" ? override : null;
}

// --- charges (Payloads.swift:264-329) ---------------------------------------------------------------

type WireMemoryRow = {
  id: string;
  text: string;
  updatedAt?: string;
  score?: number;
  tags: string[];
  agentId?: string;
};

function wireRow(row: MemoryRow): WireMemoryRow {
  return {
    id: row.id,
    text: row.text,
    updatedAt: row.updatedAt ?? undefined,
    score: row.semanticScore ?? undefined,
    tags: row.tags,
    agentId: row.agentId ?? undefined,
  };
}

function byteLength(payload: unknown): number {
  return Buffer.byteLength(sortedJson(payload), "utf8");
}

/** `RemoteReads.pagePayload` : la tranche `[offset, offset+limit)`, puis la borne d'octets (queue retirée par moitiés). */
export function pagePayload(scope: string, total: number, rows: MemoryRow[], offset: number, limit: number): Record<string, unknown> {
  const start = Math.min(Math.max(0, offset), rows.length);
  let kept = rows.slice(start, start + Math.max(1, limit)).map(wireRow);
  const page = (): Record<string, unknown> => {
    const next = start + kept.length;
    return { scope, total, offset, rows: kept, nextOffset: next < rows.length ? next : undefined };
  };
  let payload = page();
  while (byteLength(payload) > RemoteLimits.responseBody && kept.length > 1) {
    kept = kept.slice(0, kept.length - Math.max(1, Math.floor(kept.length / 2)));
    payload = page();
  }
  return payload;
}

function graphPayload(
  scope: string,
  rows: MemoryRow[],
  edges: MemoryGraphEdge[],
  manual: MemoryLink[],
  truncated: boolean,
): Record<string, unknown> {
  const nodes = graphNodes(rows);
  const links = graphLinks(rows, edges, manual);
  return {
    scope,
    nodes: nodes.map(node => ({
      id: wireNodeId(node.id),
      label: node.label,
      scope: node.scope ?? "",
      text: node.text ?? undefined,
      tags: node.text === null ? undefined : node.tags,
    })),
    links: links.map(link => ({
      a: wireNodeId(link.a),
      b: wireNodeId(link.b),
      kind: link.kind.kind,
      score: link.kind.kind === "semantic" ? link.kind.score : undefined,
    })),
    total: nodes.length,
    truncated,
  };
}

/** `RemoteReads.memoryGraph(scope:rows:edges:manual:bodyLimit:)` : borne d'octets seulement, chaque retrait RE-DÉRIVE nœuds et liens. */
export function boundedGraph(
  scope: string,
  rows: MemoryRow[],
  edges: MemoryGraphEdge[],
  manual: MemoryLink[],
  bodyLimit: number = RemoteLimits.memoryGraphBody,
): Record<string, unknown> {
  let kept = rows;
  let truncated = false;
  let payload = graphPayload(scope, kept, edges, manual, truncated);
  while (byteLength(payload) > bodyLimit && kept.length > 0) {
    kept = kept.slice(0, kept.length - Math.max(1, Math.floor(kept.length / 2)));
    truncated = true;
    payload = graphPayload(scope, kept, edges, manual, truncated);
  }
  return payload;
}

// --- les routes ------------------------------------------------------------------------------------

export function memoryRoutes(ctx: RemoteContext): RemoteRoute[] {
  const config = (): MemoryServiceConfig => memoryServiceConfig(ctx.env);
  const params = (url: string): URLSearchParams => new URL(url).searchParams;

  return [
    {
      method: "GET",
      path: "v1/memory/page",
      handle: async ({ req }) => {
        const query = params(req.url);
        const offset = memoryOffset(query.get("offset"));
        const limit = memoryLimit(query.get("limit")) ?? RemoteLimits.memoryPageSize;
        const scope = resolvedScope(query.get("scope"), ctx.env);
        if (scope === null) return remoteJson({ total: 0, offset: 0, rows: [] });
        const service = config();
        let page: MemoryPage;
        try {
          page = await serviceAll(service, scope);
        } catch (error) {
          throw memoryError(error, service);
        }
        return remoteJson(pagePayload(scope, page.total, page.rows, offset, limit));
      },
    },
    {
      method: "GET",
      path: "v1/memory/search",
      handle: async ({ req }) => {
        const query = params(req.url);
        const limit = memoryLimit(query.get("limit")) ?? MEMORY_SEARCH_DEFAULT_LIMIT;
        const text = query.get("q");
        if (text === null || trimWhitespacesAndNewlines(text) === "") throw new RemoteError("bad_request", "requête vide");
        const scope = resolvedScope(query.get("scope"), ctx.env);
        if (scope === null) throw new RemoteError("bad_request", "aucun projet ouvert");
        const service = config();
        try {
          const rows = await serviceSearch(service, text, scope, searchPool(limit));
          const selected = selectRelevant(rows, MEMORY_SEARCH_THRESHOLD, limit);
          return remoteJson({ rows: selected.kept.map(wireRow), candidates: selected.candidates, scored: selected.scored });
        } catch (error) {
          throw memoryError(error, service);
        }
      },
    },
    {
      method: "GET",
      path: "v1/memory/graph",
      handle: async ({ req }) => {
        const scope = resolvedScope(params(req.url).get("scope"), ctx.env);
        if (scope === null) return remoteJson({ nodes: [], links: [], total: 0, truncated: false });
        const service = config();
        let page: MemoryPage;
        try {
          page = await serviceAll(service, scope);
        } catch (error) {
          throw memoryError(error, service);
        }
        let edges: MemoryGraphEdge[];
        try {
          edges = await serviceGraph(service);
        } catch (error) {
          throw graphError(error, service);
        }
        const manual = loadMemoryLinks(join(ctx.stateDir, MEMORY_LINKS_RELATIVE_PATH));
        return remoteJson(boundedGraph(scope, page.rows, edges, manual));
      },
    },
  ];
}
