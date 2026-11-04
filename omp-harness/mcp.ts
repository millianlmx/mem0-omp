// Le serveur MCP du harness (`POST /v1/mcp`, transport « Streamable HTTP » en réponses
// JSON, sans flux serveur) : les issues GitHub des dépôts déclarés et leur lancement en
// run pour que le dépôt se corrige lui-même, puis le lancement, la lecture et le pilotage
// des runs, avec les mêmes contrôles que l'API REST.
//
// Même jeton, même client que le reste de l'API : `tools/list` est ouvert à tout client,
// un outil qui lance du travail exige `operator`, et un dépôt que le client ne voit pas
// est traité comme non déclaré. Une erreur d'outil (dépôt non déclaré, `gh` non connecté,
// issue fermée, run terminal) est un résultat `isError`, lisible par l'agent ; une erreur
// de protocole est une erreur JSON-RPC.
import type { Client, Role } from "./auth.ts";
import { allows, canSeeRepo } from "./auth.ts";
import type { RepoConfig } from "./config.ts";
import type { Actor } from "./context.ts";
import type { RepoFilter } from "./db.ts";
import { HarnessError } from "./errors.ts";
import { escalationAnswers, integer, newRunInput, priorityInput, stringList, text } from "./input.ts";
import type { FixOutcome, IssueDesk } from "./issues.ts";
import type { RunState } from "./machine.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { escalationBatches } from "./queries.ts";

/** Les versions du protocole comprises, la plus récente d'abord. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export type McpCall = {
  client: Client;
  actor: Actor;
  desk: IssueDesk;
  repos: () => RepoConfig[];
  /** L'orchestrateur : les runs, leurs gestes et leur lecture. */
  orchestrator: Orchestrator;
  /** Les dépôts que le client voit (`null` : tous). */
  visible: RepoFilter;
  version: string;
};

type JsonRpcId = string | number | null;

type ToolArgs = Record<string, unknown>;

type Tool = {
  name: string;
  title: string;
  description: string;
  role: Role;
  readOnly: boolean;
  properties: Record<string, unknown>;
  required: string[];
  run: (call: McpCall, args: ToolArgs) => Promise<Record<string, unknown>>;
};

const REPO_PROPERTY = {
  type: "string",
  description:
    "Le dépôt : son nom dans la liste des dépôts du harness, ou `owner/name` sur GitHub. Facultatif si le client ne voit qu'un dépôt.",
};

function optionalText(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new HarnessError(400, `${key} : chaîne attendue`);
  return value;
}

/** Le dépôt déclaré visé par un outil : celui nommé, ou le seul que le client voit. */
async function targetRepo(call: McpCall, args: ToolArgs): Promise<RepoConfig> {
  const visible = (name: string) => canSeeRepo(call.client, name);
  const ref = optionalText(args, "repo")?.trim();
  if (ref) return call.desk.resolve(ref, visible);
  const repos = call.repos().filter((repo) => visible(repo.name));
  if (repos.length === 1) return repos[0] as RepoConfig;
  throw new HarnessError(
    400,
    repos.length === 0
      ? "aucun dépôt déclaré visible : ajoute d'abord le dépôt à la liste des dépôts du harness (`harness.sh add <url>`)"
      : `repo : précise le dépôt (${repos.map((repo) => repo.name).join(", ")})`,
  );
}

function launched(outcome: FixOutcome): Record<string, unknown> {
  return {
    issue: outcome.issue,
    status: outcome.status,
    run: { id: outcome.run.id, slug: outcome.run.slug, state: outcome.run.state, title: outcome.run.title },
  };
}

const RUN_STATES = [
  "queued",
  "running",
  "escalated",
  "awaiting_human",
  "merging",
  "merged",
  "failed",
  "cancelled",
] as const satisfies readonly RunState[];

const RUN_ID_PROPERTY = { type: "string", description: "L'id du run (rendu par run_start ou runs_list)." };

const REV_PROPERTY = {
  type: "integer",
  minimum: 0,
  description:
    "Facultatif : la révision du run que tu as lue (run_get). Si le run a changé depuis, le geste est refusé sans rien faire : relis-le.",
};

function runArg(args: ToolArgs): string {
  return text(args, "id");
}

/**
 * L'auteur d'un geste et la révision qu'il a lue : l'argument `rev` de l'appel, jamais
 * l'en-tête `If-Match` de la requête (qui vaudrait pour tous les appels d'un lot).
 */
function gestureActor(call: McpCall, args: ToolArgs): Actor {
  const rev = args.rev;
  if (rev === undefined || rev === null) return { by: call.actor.by };
  if (!Number.isInteger(rev) || (rev as number) < 0)
    throw new HarnessError(400, "rev : la révision du run (entier ≥ 0) attendue");
  return { by: call.actor.by, rev: rev as number };
}

export const MCP_TOOLS: readonly Tool[] = [
  {
    name: "repos_list",
    title: "Dépôts déclarés",
    description:
      "Les dépôts de la liste du harness que ce client voit, avec leur dépôt GitHub. Seul un dépôt déclaré peut lancer des pipelines depuis ses issues.",
    role: "viewer",
    readOnly: true,
    properties: {},
    required: [],
    run: async (call) => ({
      repos: await Promise.all(
        call
          .repos()
          .filter((repo) => canSeeRepo(call.client, repo.name))
          .map(async (repo) => ({ name: repo.name, github: await call.desk.github(repo).catch(() => null) })),
      ),
    }),
  },
  {
    name: "issues_list",
    title: "Issues ouvertes",
    description:
      "Les issues GitHub ouvertes du dépôt (origin du clone du harness), chacune avec le run qui la corrige s'il y en a un.",
    role: "viewer",
    readOnly: true,
    properties: {
      repo: REPO_PROPERTY,
      label: { type: "string", description: "Ne garder que les issues qui portent ce label." },
      limit: { type: "integer", minimum: 1, maximum: 100, description: "Au plus ce nombre d'issues (100 par défaut)." },
    },
    required: [],
    run: async (call, args) => {
      const repo = await targetRepo(call, args);
      const label = optionalText(args, "label");
      const limit = args.limit;
      if (limit !== undefined && !Number.isInteger(limit)) throw new HarnessError(400, "limit : entier attendu");
      const issues = await call.desk.list(repo, {
        ...(label ? { label } : {}),
        ...(limit !== undefined ? { limit: limit as number } : {}),
      });
      return { repo: repo.name, issues };
    },
  },
  {
    name: "issue_fix",
    title: "Corriger une issue",
    description:
      "Lance un pipeline du harness qui corrige l'issue GitHub donnée. Une issue déjà portée par un run vivant ou mergé n'est pas relancée ; elle l'est si ce run a échoué ou a été annulé.",
    role: "operator",
    readOnly: false,
    properties: {
      repo: REPO_PROPERTY,
      number: { type: "integer", minimum: 1, description: "Le numéro de l'issue." },
    },
    required: ["number"],
    run: async (call, args) => {
      const repo = await targetRepo(call, args);
      if (!Number.isInteger(args.number)) throw new HarnessError(400, "number : numéro d'issue attendu");
      return { repo: repo.name, ...launched(await call.desk.fix(repo, args.number as number, call.actor)) };
    },
  },
  {
    name: "issues_fix_labeled",
    title: "Corriger les issues d'un label",
    description:
      "Lance un pipeline pour chaque issue ouverte qui porte le label (celui de la configuration par défaut) et qu'aucun run ne porte encore, les plus anciennes d'abord, dans la limite de `issues.maxLaunch` par appel.",
    role: "operator",
    readOnly: false,
    properties: {
      repo: REPO_PROPERTY,
      label: { type: "string", description: "Le label des issues à corriger." },
    },
    required: [],
    run: async (call, args) => {
      const repo = await targetRepo(call, args);
      const outcome = await call.desk.fixLabeled(repo, optionalText(args, "label"), call.actor);
      return { repo: repo.name, ...outcome, launched: outcome.launched.map(launched) };
    },
  },
  {
    name: "run_start",
    title: "Lancer un run",
    description:
      "Lance un pipeline du harness sur un dépôt déclaré à partir d'un titre et d'une demande libres, sans passer par GitHub. Le run part en file (`queued`) : suis-le avec run_get.",
    role: "operator",
    readOnly: false,
    properties: {
      repo: { type: "string", description: "Le nom du dépôt dans la liste du harness (repos_list)." },
      title: { type: "string", description: "Le titre du run." },
      request: { type: "string", description: "La demande, en texte libre." },
      slug: { type: "string", description: "Facultatif : le slug du run." },
      req: {
        type: "string",
        description: "Facultatif : un compte rendu de besoins déjà établi, avec `## Besoins` : le run part de /specs.",
      },
      modules: {
        type: "array",
        items: { type: "string" },
        description: "Facultatif : les chemins que le run touchera.",
      },
      priority: {
        type: "integer",
        minimum: -1000,
        maximum: 1000,
        description: "Facultatif : plus grand = admis avant les autres.",
      },
    },
    required: ["repo", "title", "request"],
    run: async (call, args) => ({
      run: call.orchestrator.createRun(newRunInput(args, call.client), { by: call.actor.by }),
    }),
  },
  {
    name: "run_get",
    title: "État d'un run",
    description:
      "Le run (état, étape, verdict, révision `run.rev`), ses étapes, décisions, escalades, tests, artefacts, coûts et alertes : le corps de `GET /v1/runs/{id}`.",
    role: "viewer",
    readOnly: true,
    properties: { id: RUN_ID_PROPERTY },
    required: ["id"],
    run: async (call, args) => ({ ...call.orchestrator.runView(runArg(args), call.visible) }),
  },
  {
    name: "runs_list",
    title: "Runs",
    description: "Les runs que ce client voit, filtrables par état et par dépôt : `GET /v1/runs`.",
    role: "viewer",
    readOnly: true,
    properties: {
      state: {
        type: "array",
        items: { type: "string", enum: RUN_STATES },
        description: "Ne garder que les runs dans l'un de ces états.",
      },
      repo: { type: "string", description: "Ne garder que les runs de ce dépôt (son nom dans la liste du harness)." },
    },
    required: [],
    run: async (call, args) => {
      const state = stringList(args.state, "state");
      const repo = optionalText(args, "repo");
      return {
        runs: call.orchestrator.store.listRuns({
          ...(state && state.length > 0 ? { state: state as RunState[] } : {}),
          ...(repo ? { repo } : {}),
          repos: call.visible,
        }),
      };
    },
  },
  {
    name: "run_cancel",
    title: "Annuler un run",
    description:
      "Annule un run qui n'est pas terminé : `POST /v1/runs/{id}/cancel`. Un run déjà terminal est refusé (409).",
    role: "operator",
    readOnly: false,
    properties: { id: RUN_ID_PROPERTY, rev: REV_PROPERTY },
    required: ["id"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      return { run: await call.orchestrator.cancel(id, gestureActor(call, args)) };
    },
  },
  {
    name: "run_priority",
    title: "Changer la priorité d'un run",
    description: "Change la priorité d'un run qui n'est pas terminé : `POST /v1/runs/{id}/priority`.",
    role: "operator",
    readOnly: false,
    properties: {
      id: RUN_ID_PROPERTY,
      priority: {
        type: "integer",
        minimum: -1000,
        maximum: 1000,
        description: "Plus grand = admis avant les autres ; 0 par défaut.",
      },
      rev: REV_PROPERTY,
    },
    required: ["id", "priority"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      const priority = priorityInput(args);
      return { run: await call.orchestrator.setPriority(id, priority, gestureActor(call, args)) };
    },
  },
  {
    name: "run_validate",
    title: "Valider ou refuser un run en attente",
    description:
      "Sort un run de `awaiting_human` : `POST /v1/runs/{id}/validate`. Selon l'étape du run, valide les specs (avant /impl) ou le verdict de revue ; `approve: false` le renvoie en reprise et porte sa raison (`reason`, obligatoire pour un refus). Un run qui n'attend pas de validation est refusé (409).",
    role: "operator",
    readOnly: false,
    properties: {
      id: RUN_ID_PROPERTY,
      approve: { type: "boolean", description: "`true` : valider ; `false` : refuser (la raison est alors obligatoire)." },
      reason: {
        type: "string",
        description: "Obligatoire pour un refus (`approve: false`) : elle repart à l'agent qui reprend le run.",
      },
      rev: REV_PROPERTY,
    },
    required: ["id", "approve"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      if (typeof args.approve !== "boolean") throw new HarnessError(400, "approve : booléen attendu");
      const reason = text(args, "reason", false);
      return { run: await call.orchestrator.validate(id, args.approve, reason, gestureActor(call, args)) };
    },
  },
  {
    name: "run_retry",
    title: "Relancer un run",
    description:
      "Relance un run `failed` ou `awaiting_human`, même étape, tout de suite : `POST /v1/runs/{id}/retry`. Un autre état est refusé (409).",
    role: "operator",
    readOnly: false,
    properties: { id: RUN_ID_PROPERTY, rev: REV_PROPERTY },
    required: ["id"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      return { run: await call.orchestrator.retry(id, gestureActor(call, args)) };
    },
  },
  {
    name: "run_revert",
    title: "Reverter un run mergé",
    description:
      "Défait le commit d'un run sur `main` et ouvre un run de suite : `POST /v1/runs/{id}/revert`. Seul un run `merged` est accepté (409 sinon). Ne vérifie pas la révision du run.",
    role: "operator",
    readOnly: false,
    properties: { id: RUN_ID_PROPERTY },
    required: ["id"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      return { run: await call.orchestrator.revert(id, { by: call.actor.by }) };
    },
  },
  {
    name: "run_decisions_accept",
    title: "Accepter les décisions prises seules d'un run",
    description:
      "Accepte d'un geste les décisions d'un run au statut `auto` ou `auto_timeout` : `POST /v1/runs/{id}/decisions/accept`. Rend le nombre de décisions acceptées (0 s'il n'y en a pas).",
    role: "operator",
    readOnly: false,
    properties: { id: RUN_ID_PROPERTY, rev: REV_PROPERTY },
    required: ["id"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      return { ...(await call.orchestrator.acceptAllDecisions(id, gestureActor(call, args))) };
    },
  },
  {
    name: "run_decision_accept",
    title: "Accepter une décision d'un run",
    description:
      "Accepte la décision n° `n` d'un run : `POST /v1/runs/{id}/decisions/{n}/accept`. Une décision inconnue est refusée (404) ; une décision déjà acceptée ou renversée est rendue telle quelle.",
    role: "operator",
    readOnly: false,
    properties: {
      id: RUN_ID_PROPERTY,
      n: { type: "integer", minimum: 1, description: "Le numéro de la décision dans le run (seq, rendu par run_get)." },
      rev: REV_PROPERTY,
    },
    required: ["id", "n"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      const n = integer(args.n, "n");
      if (n === undefined) throw new HarnessError(400, "n : entier attendu");
      return { decision: await call.orchestrator.acceptDecision(id, n, gestureActor(call, args)) };
    },
  },
  {
    name: "run_answer_escalation",
    title: "Répondre aux escalades d'un run",
    description:
      "Répond aux escalades ouvertes d'un run `escalated` : `POST /v1/runs/{id}/escalations`. Les ids sont ceux des escalades ouvertes que run_get rend ; le run reprend son étape quand toutes ses escalades sont répondues. Un run qui n'attend pas de réponse est refusé (409).",
    role: "operator",
    readOnly: false,
    properties: {
      id: RUN_ID_PROPERTY,
      answers: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "integer", description: "L'id de l'escalade ouverte (run_get)." },
            answer: { type: "string", description: "La réponse, non vide." },
            reason: { type: "string", description: "Facultatif : le motif de la réponse." },
          },
          required: ["id", "answer"],
        },
        description: "Les réponses, une par escalade ouverte à laquelle tu réponds.",
      },
      rev: REV_PROPERTY,
    },
    required: ["id", "answers"],
    run: async (call, args) => {
      const id = call.orchestrator.visibleRun(runArg(args), call.visible).id;
      const answers = escalationAnswers(args);
      return { run: await call.orchestrator.answerEscalations(id, answers, gestureActor(call, args)) };
    },
  },
  {
    name: "inbox",
    title: "La boîte de l'humain",
    description:
      "Ce qui attend l'humain, d'un seul appel : `GET /v1/inbox`. Les escalades groupées par run, les verdicts à valider (`awaiting`), les décisions prises seules, les features en cours, les audits, les alertes, les coûts et le `cursor` du journal. C'est le premier appel pour savoir ce qui attend une décision.",
    role: "viewer",
    readOnly: true,
    properties: {},
    required: [],
    run: async (call) => call.orchestrator.inboxView(call.visible),
  },
  {
    name: "escalations_list",
    title: "Les escalades, groupées par run",
    description:
      "Les escalades groupées par run : `GET /v1/escalations`. Les ouvertes par défaut, les répondues avec `status: \"answered\"`.",
    role: "viewer",
    readOnly: true,
    properties: {
      status: { type: "string", enum: ["open", "answered"], description: "Facultatif : `open` (par défaut) ou `answered`." },
    },
    required: [],
    run: async (call, args) => {
      const status = optionalText(args, "status") ?? "open";
      if (status !== "open" && status !== "answered") throw new HarnessError(400, "status : « open » ou « answered » attendu");
      return escalationBatches(call.orchestrator.store, status, call.visible);
    },
  },
];

function rpcError(id: JsonRpcId, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function callTool(call: McpCall, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === params.name);
  if (!tool) throw new McpError(-32602, `outil inconnu : ${String(params.name)}`);
  const args = params.arguments ?? {};
  if (args === null || typeof args !== "object" || Array.isArray(args))
    throw new McpError(-32602, "arguments : objet attendu");
  try {
    if (!allows(call.client.role, tool.role))
      throw new HarnessError(403, `le rôle ${call.client.role} ne permet pas ${tool.name} (${tool.role} requis)`);
    const result = await tool.run(call, args as ToolArgs);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  } catch (err) {
    if (!(err instanceof HarnessError)) throw err;
    return { content: [{ type: "text", text: err.message }], isError: true };
  }
}

class McpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Un message JSON-RPC reçu : la réponse à rendre, ou `null` pour une notification ou une
 * réponse du client (rien à rendre). Une erreur imprévue remonte (500, journalisée).
 */
export async function handleMcp(message: unknown, call: McpCall): Promise<Record<string, unknown> | null> {
  if (message === null || typeof message !== "object" || Array.isArray(message))
    return rpcError(null, -32600, "requête JSON-RPC invalide");
  const request = message as Record<string, unknown>;
  const id = request.id;
  const hasId = typeof id === "string" || typeof id === "number";
  if (typeof request.method !== "string") {
    // La réponse du client à une requête du serveur : ce serveur n'en émet aucune.
    if (!hasId || "result" in request || "error" in request) return null;
    return rpcError(id, -32600, "requête JSON-RPC invalide");
  }
  if (request.jsonrpc !== "2.0") return hasId ? rpcError(id, -32600, "jsonrpc : « 2.0 » attendu") : null;
  if (!hasId) return null;
  const params =
    request.params !== null && typeof request.params === "object" && !Array.isArray(request.params)
      ? (request.params as Record<string, unknown>)
      : {};
  try {
    switch (request.method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const protocolVersion = MCP_PROTOCOL_VERSIONS.find((version) => version === asked) ?? MCP_PROTOCOL_VERSIONS[0];
        return {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "omp-harness", title: "OMP harness", version: call.version },
            instructions:
              "Lis les issues GitHub d'un dépôt déclaré dans le harness et lance des pipelines qui les corrigent, ou lance un run libre (run_start) ; suis-le (run_get, runs_list) et pilote-le (run_cancel, run_priority). Débloque un run : run_validate pour un run en awaiting_human, run_answer_escalation pour un run escalated, run_retry, run_revert, run_decisions_accept et run_decision_accept. Supervise ce qui attend l'humain avec inbox et escalations_list. Un geste (sauf run_revert) peut porter `rev`, la révision lue par run_get : si le run a changé depuis, il est refusé. Un dépôt absent de la liste du harness est refusé : il faut d'abord le déclarer.",
          },
        };
      }
      case "ping":
        return { jsonrpc: "2.0", id, result: {} };
      case "tools/list":
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: MCP_TOOLS.map((tool) => ({
              name: tool.name,
              title: tool.title,
              description: tool.description,
              inputSchema: { type: "object", properties: tool.properties, required: tool.required },
              annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: true },
            })),
          },
        };
      case "tools/call":
        return { jsonrpc: "2.0", id, result: await callTool(call, params) };
      default:
        return rpcError(id, -32601, `méthode inconnue : ${request.method}`);
    }
  } catch (err) {
    if (err instanceof McpError) return rpcError(id, err.code, err.message);
    throw err;
  }
}
