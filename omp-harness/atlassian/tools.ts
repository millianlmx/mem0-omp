// Les outils Atlassian des agents : leurs définitions, la validation de leurs arguments et leur
// exécution (appelée par `AtlassianDesk.runTool`). Le `cloudId` est toujours injecté par le
// desk, jamais demandé à l'agent. Tout texte lu chez Atlassian revient entre les délimiteurs du
// contenu non fiable : un ticket ou une page est une donnée, jamais une consigne.
//
// Écritures (jobs du poste seulement) : `jira_transition` fait avancer SEUL un ticket assigné à
// l'utilisateur connecté (prouvé par JQL avant d'écrire), journalisé ; `jira_comment_propose`
// n'écrit rien chez Atlassian : le commentaire attend l'approbateur dans l'app.
import { isRecord } from "../config.ts";
import type { AtlassianWrite, NewAtlassianWrite } from "../db.ts";
import type { HostToolDefinition, HostToolResult } from "../rpc.ts";
import { untrusted } from "../workstation-guards.ts";
import type { McpToolResult } from "./mcp.ts";

export type AtlassianToolName =
  | "atlassian_search"
  | "jira_search"
  | "jira_issue"
  | "confluence_search"
  | "confluence_page"
  | "corpo_recall"
  | "jira_transition"
  | "jira_comment_propose";

/** Ce que rend un outil de lecture, au plus. */
export const TOOL_TEXT_MAX = 12_000;
/** Une clé de ticket Jira. */
export const JIRA_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;
export const NOT_CONNECTED = "Atlassian n'est pas connecté : l'approbateur le branche depuis l'app (Poste › Atlassian)";
export const WRITES_RESERVED = "écriture Jira réservée aux jobs du poste";
/** Les champs d'un ticket rendus par `jira_search`. */
const SEARCH_FIELDS = ["summary", "status", "priority", "updated", "duedate", "issuetype", "project", "assignee"];

const KEY_PROPERTY = { type: "string", description: "La clé du ticket Jira (ex. PROJ-123)." };

export const ATLASSIAN_READ_TOOLS: readonly HostToolDefinition[] = [
  {
    name: "atlassian_search",
    label: "Atlassian — recherche Rovo",
    description:
      "Cherche en langage naturel dans Jira et Confluence (Rovo) : tickets, pages, personnes. Rend des extraits et des liens.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "La recherche, en mots simples." },
        limit: { type: "integer", minimum: 10, maximum: 25, description: "Les résultats voulus (10 par défaut)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "jira_search",
    label: "Atlassian — tickets Jira (JQL)",
    description:
      "Les tickets Jira d'une requête JQL (ex. `assignee = currentUser() AND statusCategory != Done ORDER BY priority DESC`) : résumé, état, priorité, échéance, projet, assigné.",
    parameters: {
      type: "object",
      properties: {
        jql: { type: "string", description: "La requête JQL." },
        maxResults: { type: "integer", minimum: 1, maximum: 50, description: "20 par défaut." },
      },
      required: ["jql"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "jira_issue",
    label: "Atlassian — ticket Jira",
    description: "Un ticket Jira en entier : description, état, commentaires, liens.",
    parameters: {
      type: "object",
      properties: { key: KEY_PROPERTY },
      required: ["key"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "confluence_search",
    label: "Atlassian — pages Confluence (CQL)",
    description:
      'Les pages Confluence d\'une requête CQL (ex. `type = page AND text ~ "déploiement"`, `contributor = currentUser()`).',
    parameters: {
      type: "object",
      properties: {
        cql: { type: "string", description: "La requête CQL." },
        limit: { type: "integer", minimum: 1, maximum: 25, description: "10 par défaut." },
      },
      required: ["cql"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "confluence_page",
    label: "Atlassian — page Confluence",
    description: "Une page Confluence en markdown, par son identifiant OU son adresse https sur le site connecté.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "L'identifiant de la page." },
        url: { type: "string", description: "L'adresse https de la page." },
      },
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "corpo_recall",
    label: "Harness — savoir de la boîte",
    description:
      "Cherche dans la mémoire `corpo` : ce que le harness a retenu de Jira et Confluence (conventions, processus, glossaire, qui fait quoi).",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "Le sujet cherché." } },
      required: ["query"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
];

export const ATLASSIAN_WRITE_TOOLS: readonly HostToolDefinition[] = [
  {
    name: "jira_transition",
    label: "Atlassian — faire avancer un ticket",
    description:
      "Fait passer un ticket Jira ASSIGNÉ À L'UTILISATEUR à un autre état (ex. « En cours », « En revue »). Refusé sur tout autre ticket. Journalisé.",
    parameters: {
      type: "object",
      properties: {
        key: KEY_PROPERTY,
        transition: { type: "string", description: "Le nom de la transition, tel que Jira l'affiche." },
        why: { type: "string", description: "Pourquoi, en une phrase." },
      },
      required: ["key", "transition", "why"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
  {
    name: "jira_comment_propose",
    label: "Atlassian — proposer un commentaire",
    description:
      "Propose un commentaire sur un ticket Jira : RIEN n'est publié, l'humain le relit, le modifie et le publie depuis l'app.",
    parameters: {
      type: "object",
      properties: {
        key: KEY_PROPERTY,
        body: { type: "string", description: "Le texte du commentaire (4000 caractères au plus)." },
        why: { type: "string", description: "Pourquoi le publier, en une phrase." },
      },
      required: ["key", "body", "why"],
      additionalProperties: false,
    },
    loadMode: "essential",
  },
];

const NAMES: ReadonlySet<string> = new Set(
  [...ATLASSIAN_READ_TOOLS, ...ATLASSIAN_WRITE_TOOLS].map((tool) => tool.name),
);
const WRITE_NAMES: ReadonlySet<string> = new Set(ATLASSIAN_WRITE_TOOLS.map((tool) => tool.name));

export function isAtlassianTool(name: string): name is AtlassianToolName {
  return NAMES.has(name);
}

/** Ce que l'exécution des outils demande au desk. */
export type AtlassianToolHost = {
  enabled(): boolean;
  /** Le site connecté, `null` s'il ne l'est pas. */
  site(): { cloudId: string; url: string } | null;
  /** Un outil du serveur MCP, `cloudId` injecté. */
  call(tool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<McpToolResult>;
  /** La mémoire `corpo`, rendue pour un prompt. */
  recall(query: string): Promise<string>;
  /** Une écriture journalisée (et son événement). */
  record(input: Omit<NewAtlassianWrite, "id">): AtlassianWrite;
  /** Le commentaire déjà proposé sur ce ticket avec ce texte. */
  proposed(issueKey: string, body: string): AtlassianWrite | null;
};

/** Un argument refusé : son message va tel quel à l'agent. */
class ToolInputError extends Error {}

function textArg(args: Record<string, unknown>, key: string, max: number, min = 1): string {
  const value = args[key];
  const text = typeof value === "string" ? value.trim() : null;
  if (text === null || text.length < min || text.length > max)
    throw new ToolInputError(`${key} : texte de ${min} à ${max} caractères attendu`);
  return text;
}

function intArg(args: Record<string, unknown>, key: string, min: number, max: number, fallback: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    throw new ToolInputError(`${key} : entier de ${min} à ${max} attendu`);
  return value;
}

function keyArg(args: Record<string, unknown>): string {
  const key = typeof args.key === "string" ? args.key.trim().toUpperCase() : "";
  if (!JIRA_KEY.test(key)) throw new ToolInputError("key : une clé de ticket Jira attendue (ex. PROJ-123)");
  return key;
}

/** Le texte d'Atlassian rendu à l'agent : borné, entre délimiteurs. */
function shown(text: string): string {
  const clipped = text.length > TOOL_TEXT_MAX ? `${text.slice(0, TOOL_TEXT_MAX)}\n(tronqué)` : text;
  return untrusted("Atlassian", clipped);
}

function readResult(tool: string, result: McpToolResult): HostToolResult {
  if (result.isError) return { text: `Atlassian a refusé ${tool} :\n${shown(result.text)}`, isError: true };
  return { text: shown(result.text === "" ? "(aucun résultat)" : result.text) };
}

/**
 * Le ticket `key` figure-t-il dans la réponse de la recherche ? Une réponse JSON : un objet dont
 * la propriété `key` vaut exactement la clé. Sinon (markdown), la clé en mot entier, une fois la
 * requête elle-même retirée (une réponse vide peut la citer).
 */
export function listsIssue(text: string, key: string, jql: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const scrubbed = text.split(jql).join(" ");
    return new RegExp(`(^|[^A-Za-z0-9_-])${key}(?![0-9])`).test(scrubbed);
  }
  const stack: unknown[] = [parsed];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) stack.push(...value);
    else if (isRecord(value)) {
      if (value.key === key) return true;
      stack.push(...Object.values(value));
    }
  }
  return false;
}

/** Un outil Atlassian ; lève sur une erreur imprévue (le desk la rend en `isError`). */
export async function runAtlassianTool(
  host: AtlassianToolHost,
  name: string,
  args: Record<string, unknown>,
  opts: { by: string; writes: boolean },
  signal: AbortSignal,
): Promise<HostToolResult> {
  if (!isAtlassianTool(name)) return { text: `outil inconnu : ${name}`, isError: true };
  if (!host.enabled()) return { text: "Atlassian est désactivé sur ce serveur (atlassian.enabled)", isError: true };
  if (WRITE_NAMES.has(name) && !opts.writes) return { text: WRITES_RESERVED, isError: true };
  try {
    if (name === "corpo_recall") return { text: await host.recall(textArg(args, "query", 500)) };
    const site = host.site();
    if (site === null) return { text: NOT_CONNECTED, isError: true };
    switch (name) {
      case "atlassian_search": {
        const query = textArg(args, "query", 1000);
        const limit = Math.max(10, intArg(args, "limit", 1, 25, 10));
        return readResult(name, await host.call("search", { query, limit }, signal));
      }
      case "jira_search": {
        const jql = textArg(args, "jql", 2000);
        const maxResults = intArg(args, "maxResults", 1, 50, 20);
        return readResult(
          name,
          await host.call("searchJiraIssuesUsingJql", { jql, maxResults, fields: SEARCH_FIELDS }, signal),
        );
      }
      case "jira_issue":
        return readResult(name, await host.call("getJiraIssue", { issueIdOrKey: keyArg(args) }, signal));
      case "confluence_search": {
        const cql = textArg(args, "cql", 2000);
        const limit = intArg(args, "limit", 1, 25, 10);
        return readResult(name, await host.call("searchConfluence", { cql, limit }, signal));
      }
      case "confluence_page":
        return readResult(name, await host.call("getConfluenceContent", pageArgs(args, site.url), signal));
      case "jira_transition":
        return await transition(host, args, opts.by, signal);
      case "jira_comment_propose":
        return proposeComment(host, args, opts.by);
    }
  } catch (error) {
    if (error instanceof ToolInputError) return { text: `${name} : ${error.message}`, isError: true };
    throw error;
  }
}

/** `{id}` ou `{url}` (https, sur le site connecté), exactement un. */
function pageArgs(args: Record<string, unknown>, siteUrl: string): Record<string, unknown> {
  const hasId = args.id !== undefined && args.id !== null;
  const hasUrl = args.url !== undefined && args.url !== null;
  if (hasId === hasUrl) throw new ToolInputError("donne exactement un de `id` ou `url`");
  if (hasId) {
    const id = textArg(args, "id", 64);
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new ToolInputError("id : identifiant de page attendu");
    return { content_id: id, content_format: "markdown" };
  }
  const raw = textArg(args, "url", 2000);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolInputError("url : adresse illisible");
  }
  if (url.protocol !== "https:" || url.origin !== new URL(siteUrl).origin)
    throw new ToolInputError(`url : une page https du site connecté (${new URL(siteUrl).origin}) attendue`);
  return { content_url: url.toString(), content_format: "markdown" };
}

async function transition(
  host: AtlassianToolHost,
  args: Record<string, unknown>,
  by: string,
  signal: AbortSignal,
): Promise<HostToolResult> {
  const key = keyArg(args);
  const name = textArg(args, "transition", 100);
  const why = textArg(args, "why", 500);
  // La garde : le ticket doit être assigné à l'utilisateur connecté, prouvé par Jira lui-même.
  const jql = `key = "${key}" AND assignee = currentUser()`;
  const mine = await host.call("searchJiraIssuesUsingJql", { jql, maxResults: 1, fields: ["summary"] }, signal);
  if (mine.isError)
    return { text: `impossible de vérifier que ${key} est à l'utilisateur :\n${shown(mine.text)}`, isError: true };
  if (!listsIssue(mine.text, key, jql))
    return { text: "ticket non assigné à l'utilisateur : transition refusée", isError: true };
  let result: McpToolResult;
  try {
    result = await host.call("transitionJiraIssue", { issueIdOrKey: key, transitionName: name }, signal);
  } catch (error) {
    result = { text: error instanceof Error ? error.message : String(error), isError: true };
  }
  const write = host.record({
    kind: "transition",
    issueKey: key,
    body: name,
    why,
    state: result.isError ? "failed" : "sent",
    by,
    error: result.isError ? result.text.slice(0, 500) : null,
  });
  if (result.isError)
    return {
      text: `Atlassian a refusé la transition « ${name} » de ${key} (#${write.id}) :\n${shown(result.text)}`,
      isError: true,
    };
  return { text: `${key} : transition « ${name} » appliquée (#${write.id}).` };
}

function proposeComment(host: AtlassianToolHost, args: Record<string, unknown>, by: string): HostToolResult {
  const key = keyArg(args);
  const body = textArg(args, "body", 4000);
  const why = textArg(args, "why", 500);
  const write =
    host.proposed(key, body) ??
    host.record({ kind: "comment", issueKey: key, body, why, state: "proposed", by, error: null });
  return { text: `commentaire proposé #${write.id}, en attente de l'approbation de l'humain` };
}
