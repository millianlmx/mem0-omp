// L'API du service : REST + SSE, l'UNIQUE point d'entrée des clients (macOS, iOS, web,
// plugin omp) — plusieurs clients à la fois.
//
// Écoute en local (127.0.0.1) ; Tailscale ou un reverse proxy TLS la publie. Chaque
// requête porte `Authorization: Bearer <jeton>` : le jeton désigne un CLIENT (auth.ts),
// son rôle et les dépôts qu'il voit. Un client ne voit ni ne touche les runs d'un
// dépôt qui ne lui est pas permis (404, comme s'ils n'existaient pas).
//
// Les gestes acceptent `If-Match: <rev>` : la révision du run lue par le client. Si
// un autre client a agi entre-temps, le geste est refusé (412) au lieu d'agir sur une
// vue périmée. `GET /v1/runs/{id}` rend la révision en `ETag`.
//
// Le flux `GET /v1/events` rejoue le journal depuis `Last-Event-ID` : un client qui
// se reconnecte ne perd aucun événement. `live=1` y ajoute l'activité des runners
// et le direct de leurs sessions (éphémères, jamais rejoués : `GET /v1/runs/{id}/session`
// rend le tampon des dernières entrées d'un run).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type * as http from "node:http";
import type { Client, Role } from "./auth.ts";
import { ClientRegistry, ROLES, allows, canSeeRepo, repoFilter } from "./auth.ts";
import type { Actor } from "./context.ts";
import type { DecisionStatus, EventRow, RepoFilter } from "./db.ts";
import { HarnessError } from "./errors.ts";
import type { RunState } from "./machine.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { ModelChains, ProviderInput } from "./providers.ts";
import { COMPATIBLE, COMPATIBLE_APIS, KNOWN_PROVIDERS, OAUTH } from "./providers.ts";
import { escalationBatches, inboxOf, projectsOf } from "./queries.ts";
import { computeStats } from "./stats.ts";

export const API_VERSION = 1;

/** Ce que ce serveur sait faire en plus de l'API 1 d'origine (les clients s'y adaptent). */
export const API_FEATURES = [
  "clients",
  "priority",
  "if-match",
  "live-events",
  "repos",
  "reload",
  "providers",
  "providers-oauth",
  "retry",
  "revert",
  "accept-all",
  "answer-reason",
  "session-feed",
  "session-replay",
  "audit-session",
  "usage",
  "alerts",
  "timeline",
  "changes",
  "live-tests",
  "metrics",
  "push-activities",
] as const;

/** La version du service, lue dans son `package.json`. */
export const HARNESS_VERSION: string = (() => {
  try {
    return String(
      (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version?: unknown }).version ??
        "0.0.0",
    );
  } catch {
    return "0.0.0";
  }
})();

const MAX_BODY = 1024 * 1024;
const PING_MS = 15_000;

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(json),
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(json);
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HarnessError(413, "corps trop gros (1 Mio max)");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HarnessError(400, "JSON invalide");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HarnessError(400, "un objet JSON est attendu");
  return parsed as Record<string, unknown>;
}

function text(body: Record<string, unknown>, key: string, required = true): string {
  const value = body[key];
  if (typeof value === "string") return value;
  if (!required && value === undefined) return "";
  throw new HarnessError(400, `${key} : chaîne attendue`);
}

function stringList(value: unknown, key: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
    throw new HarnessError(400, `${key} : liste de chaînes attendue`);
  return value as string[];
}

function integer(value: unknown, key: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new HarnessError(400, `${key} : entier attendu`);
  return value as number;
}

const DECISION_STATUSES: readonly DecisionStatus[] = ["auto", "auto_timeout", "accepted", "reversed", "superseded"];

function isDecisionStatus(value: string): value is DecisionStatus {
  return DECISION_STATUSES.some((status) => status === value);
}

/** Le corps d'un `PUT /v1/providers/{name}` : les types vérifiés ici, les valeurs par providers.ts. */
function providerInput(body: Record<string, unknown>): ProviderInput {
  const nullableInteger = (key: string): number | null | undefined =>
    body[key] === null ? null : integer(body[key], key);
  const nullableText = (key: string): string | null | undefined => {
    const value = body[key];
    if (value === undefined || value === null) return value;
    return text(body, key);
  };
  if (body.models !== undefined && !Array.isArray(body.models))
    throw new HarnessError(400, "models : liste de { id, contextWindow?, maxTokens? } attendue");
  return {
    kind: text(body, "kind"),
    baseUrl: nullableText("baseUrl"),
    api: nullableText("api"),
    models: body.models as ProviderInput["models"],
    apiKey: body.apiKey === undefined ? undefined : text(body, "apiKey"),
    capacity: nullableInteger("capacity"),
    refillPerMinute: nullableInteger("refillPerMinute"),
  };
}

/** `If-Match: 12`, `"12"` ou `W/"12"` → 12 ; absent → `undefined`. */
export function ifMatch(req: http.IncomingMessage): number | undefined {
  const header = req.headers["if-match"];
  if (typeof header !== "string" || header.trim() === "" || header.trim() === "*") return undefined;
  const value = Number(header.trim().replace(/^W\//, "").replace(/^"|"$/g, ""));
  if (!Number.isInteger(value) || value < 0)
    throw new HarnessError(400, "If-Match : la révision du run (entier) attendue");
  return value;
}

function sseFrame(event: EventRow): string {
  // Un éphémère n'a pas d'`id:` : il ne déplace pas le curseur de reprise du client.
  return `${event.ephemeral ? "" : `id: ${event.id}\n`}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export type HttpOptions = {
  orchestrator: Orchestrator;
  /** Le jeton historique : le client `admin` (ignoré si `clients` est donné). */
  token?: string;
  /** Les clients nommés ; par défaut, le seul jeton historique. */
  clients?: ClientRegistry;
  version?: string;
  /** Le journal du service : la cause d'une erreur interne y va, jamais dans la réponse. */
  log?: (line: string) => void;
};

type Call = {
  match: RegExpExecArray;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  client: Client;
  /** Les dépôts que le client voit (`null` : tous). */
  repos: RepoFilter;
  /** L'auteur du geste et la révision qu'il a lue. */
  actor: Actor;
};

export type Route = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  role: Role;
  pattern: RegExp;
  handle: (call: Call) => Promise<void> | void;
};

/** Les routes de l'API, avec le rôle minimal de chacune : la table que documente le README du harness. */
export function apiRoutes(orchestrator: Orchestrator, clients: ClientRegistry): Route[] {
  const store = orchestrator.store;
  const route = (method: Route["method"], path: string, role: Role, handle: Route["handle"]): Route => ({
    method,
    path,
    role,
    // `{id}` et `{name}` : un segment ; `{n}` : un entier.
    pattern: new RegExp(`^${path.replace(/\{n\}/g, "(\\d+)").replace(/\{(id|name)\}/g, "([\\w.-]+)")}$`),
    handle,
  });
  const requireRepo = (call: Call, repo: string): void => {
    if (!canSeeRepo(call.client, repo))
      throw new HarnessError(403, `le client ${call.client.name} n'a pas accès au dépôt ${repo}`);
  };
  const visibleAudit = (call: Call, id: string) => {
    const audit = store.getAudit(id);
    if (!audit || !canSeeRepo(call.client, audit.repo)) throw new HarnessError(404, `audit inconnu : ${id}`);
    return audit;
  };
  const runId = (call: Call): string => orchestrator.visibleRun(call.match[1] as string, call.repos).id;
  /** Une page du direct : `before` (la seq à partir de laquelle remonter) et `limit` (1 à 1000). */
  const pageOf = (url: URL): { before: number | null; limit?: number } => {
    const before = Number(url.searchParams.get("before"));
    const limit = Number(url.searchParams.get("limit"));
    return {
      before: Number.isInteger(before) && before > 0 ? before : null,
      ...(Number.isInteger(limit) && limit > 0 ? { limit: Math.min(limit, 1000) } : {}),
    };
  };
  const providersView = () => {
    const { models, source } = orchestrator.providers.chains();
    return {
      providers: orchestrator.providers.list(),
      models,
      modelsSource: source,
      kinds: [...Object.keys(KNOWN_PROVIDERS), COMPATIBLE, OAUTH],
      apis: COMPATIBLE_APIS,
    };
  };

  return [
    route("GET", "/v1/me", "viewer", (call) => send(call.res, 200, { client: call.client })),
    route("GET", "/v1/status", "viewer", async (call) =>
      send(call.res, 200, { ...orchestrator.status(call.repos), oracle: await orchestrator.oracleStatus() }),
    ),
    route("GET", "/v1/repos", "viewer", (call) =>
      send(call.res, 200, {
        repos: orchestrator.config.repos
          .filter((repo) => canSeeRepo(call.client, repo.name))
          .map((repo) => ({
            name: repo.name,
            scope: repo.scope,
            mainBranch: repo.mainBranch,
            merge: repo.merge,
            maxParallel: repo.maxParallel,
          })),
      }),
    ),
    route("GET", "/v1/runs", "viewer", (call) => {
      const state = call.url.searchParams.get("state");
      const repo = call.url.searchParams.get("repo");
      const runs = store.listRuns({
        ...(state ? { state: state.split(",") as RunState[] } : {}),
        ...(repo ? { repo } : {}),
        repos: call.repos,
      });
      send(call.res, 200, { runs });
    }),
    route("POST", "/v1/runs", "operator", async (call) => {
      const body = await readBody(call.req);
      const modules = stringList(body.modules, "modules");
      const slug = text(body, "slug", false);
      const needs = text(body, "req", false);
      const priority = integer(body.priority, "priority");
      const repo = text(body, "repo");
      requireRepo(call, repo);
      const run = orchestrator.createRun(
        {
          repo,
          title: text(body, "title"),
          request: text(body, "request"),
          ...(slug ? { slug } : {}),
          ...(needs ? { req: needs } : {}),
          ...(modules ? { modules } : {}),
          ...(priority !== undefined ? { priority } : {}),
        },
        call.actor,
      );
      send(call.res, 201, { run }, { ETag: `"${run.rev}"` });
    }),
    route("GET", "/v1/runs/{id}", "viewer", (call) => {
      const view = orchestrator.runView(call.match[1] as string, call.repos);
      send(call.res, 200, view, { ETag: `"${(view.run as { rev: number }).rev}"` });
    }),
    route("GET", "/v1/runs/{id}/timeline", "viewer", (call) =>
      send(call.res, 200, orchestrator.timeline(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/changes", "viewer", async (call) =>
      send(call.res, 200, await orchestrator.changes(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/diff", "viewer", async (call) => {
      const file = call.url.searchParams.get("path");
      if (!file) throw new HarnessError(400, "path manquant");
      send(call.res, 200, await orchestrator.fileDiff(call.match[1] as string, file, call.repos));
    }),
    route("GET", "/v1/runs/{id}/tests/live", "viewer", (call) =>
      send(call.res, 200, orchestrator.liveTests(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/session", "viewer", (call) =>
      send(call.res, 200, orchestrator.sessionView(call.match[1] as string, call.repos, pageOf(call.url))),
    ),
    route("POST", "/v1/runs/{id}/cancel", "operator", async (call) =>
      send(call.res, 200, { run: await orchestrator.cancel(runId(call), call.actor) }),
    ),
    route("POST", "/v1/runs/{id}/priority", "operator", async (call) => {
      const body = await readBody(call.req);
      const priority = integer(body.priority, "priority");
      if (priority === undefined) throw new HarnessError(400, "priority : entier attendu");
      send(call.res, 200, { run: await orchestrator.setPriority(runId(call), priority, call.actor) });
    }),
    route("POST", "/v1/runs/{id}/escalations", "operator", async (call) => {
      const body = await readBody(call.req);
      if (!Array.isArray(body.answers)) throw new HarnessError(400, "answers : liste de { id, answer } attendue");
      const answers = body.answers.map((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        if (typeof record.id !== "number" || typeof record.answer !== "string")
          throw new HarnessError(400, "answers : { id: nombre, answer: chaîne, reason?: chaîne }");
        if (record.reason !== undefined && typeof record.reason !== "string")
          throw new HarnessError(400, "answers[].reason : chaîne attendue");
        return {
          id: record.id,
          answer: record.answer,
          ...(typeof record.reason === "string" && record.reason.trim() !== "" ? { reason: record.reason } : {}),
        };
      });
      send(call.res, 200, { run: await orchestrator.answerEscalations(runId(call), answers, call.actor) });
    }),
    // La relance d'un run échoué ou en attente de l'humain : même étape, tout de suite.
    route("POST", "/v1/runs/{id}/retry", "operator", async (call) =>
      send(call.res, 200, { run: await orchestrator.retry(runId(call), call.actor) }),
    ),
    // Toutes les décisions prises seules d'un run, acceptées d'un geste.
    route("POST", "/v1/runs/{id}/decisions/accept", "operator", async (call) =>
      send(call.res, 200, await orchestrator.acceptAllDecisions(runId(call), call.actor)),
    ),
    // Le revert d'un run mergé : son commit est défait sur main, un run de suite est ouvert.
    route("POST", "/v1/runs/{id}/revert", "operator", async (call) =>
      send(call.res, 200, { run: await orchestrator.revert(runId(call), call.actor) }),
    ),
    route("POST", "/v1/runs/{id}/decisions/{n}/accept", "operator", async (call) =>
      send(call.res, 200, {
        decision: await orchestrator.acceptDecision(runId(call), Number(call.match[2]), call.actor),
      }),
    ),
    route("POST", "/v1/runs/{id}/decisions/{n}/reverse", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, {
        run: await orchestrator.reverseDecision(
          runId(call),
          Number(call.match[2]),
          text(body, "option"),
          text(body, "reason"),
          call.actor,
        ),
      });
    }),
    route("POST", "/v1/runs/{id}/validate", "operator", async (call) => {
      const body = await readBody(call.req);
      if (typeof body.approve !== "boolean") throw new HarnessError(400, "approve : booléen attendu");
      send(call.res, 200, {
        run: await orchestrator.validate(runId(call), body.approve, text(body, "reason", false), call.actor),
      });
    }),
    // Les escalades ouvertes, BATCHÉES par run : l'écran iOS les traite d'un geste.
    route("GET", "/v1/escalations", "viewer", (call) =>
      send(
        call.res,
        200,
        escalationBatches(store, call.url.searchParams.get("status") === "answered" ? "answered" : "open", call.repos),
      ),
    ),
    // La boîte de l'humain, d'un seul appel (apps Mac et iOS) : escalades batchées,
    // verdicts à valider, décisions prises seules, features en cours, et le
    // curseur du journal à partir duquel s'abonner au flux.
    route("GET", "/v1/inbox", "viewer", (call) => {
      const inbox = inboxOf(store, call.repos);
      const runs = (inbox.runs as { id: string }[]).map((run) => run.id);
      send(call.res, 200, { ...inbox, alerts: orchestrator.monitor.alerts(call.repos), costs: store.runCosts(runs) });
    }),
    // La relecture du matin : les décisions prises seules (par l'agent, ou à l'échéance d'une escalade), pas encore relues.
    route("GET", "/v1/decisions", "viewer", (call) => {
      const status = (call.url.searchParams.get("status") ?? "auto,auto_timeout").split(",").filter(isDecisionStatus);
      send(call.res, 200, { decisions: store.listDecisions({ status, repos: call.repos }) });
    }),
    // Chaque projet avec le décompte de ses runs par état (la liste des apps).
    route("GET", "/v1/projects", "viewer", (call) => send(call.res, 200, { projects: projectsOf(store, call.repos) })),
    route("POST", "/v1/projects", "operator", async (call) => {
      const body = await readBody(call.req);
      if (!Array.isArray(body.features)) throw new HarnessError(400, "features : liste attendue");
      const features = body.features.map((item) => {
        const record = (item ?? {}) as Record<string, unknown>;
        const modules = stringList(record.modules, "features[].modules");
        const slug = text(record, "slug", false);
        return {
          title: text(record, "title"),
          request: text(record, "request"),
          ...(slug ? { slug } : {}),
          ...(modules ? { modules } : {}),
        };
      });
      const repo = text(body, "repo");
      requireRepo(call, repo);
      const priority = integer(body.priority, "priority");
      send(
        call.res,
        201,
        await orchestrator.createProject(
          { repo, title: text(body, "title"), features, ...(priority !== undefined ? { priority } : {}) },
          call.actor,
        ),
      );
    }),
    route("GET", "/v1/projects/{id}", "viewer", (call) => {
      const project = store.getProject(call.match[1] as string);
      if (!project || !canSeeRepo(call.client, project.repo))
        throw new HarnessError(404, `projet inconnu : ${call.match[1]}`);
      send(call.res, 200, { project, runs: store.listRuns({ projectId: project.id }) });
    }),
    route("GET", "/v1/audits", "viewer", (call) => send(call.res, 200, { audits: store.listAudits([], call.repos) })),
    route("POST", "/v1/audits", "operator", async (call) => {
      const body = await readBody(call.req);
      const repo = text(body, "repo");
      requireRepo(call, repo);
      const audit = orchestrator.audits.create(repo, text(body, "focus", false), call.actor);
      void orchestrator.tick();
      send(call.res, 201, { audit });
    }),
    route("GET", "/v1/audits/{id}", "viewer", (call) =>
      send(call.res, 200, { audit: visibleAudit(call, call.match[1] as string) }),
    ),
    route("GET", "/v1/audits/{id}/session", "viewer", (call) =>
      send(
        call.res,
        200,
        orchestrator.auditSessionView(visibleAudit(call, call.match[1] as string).id, pageOf(call.url)),
      ),
    ),
    // Les propositions retenues (index dans `proposals`) partent en projet.
    route("POST", "/v1/audits/{id}/launch", "operator", async (call) => {
      const audit = visibleAudit(call, call.match[1] as string);
      const body = await readBody(call.req);
      if (!Array.isArray(body.items) || body.items.some((item) => !Number.isInteger(item)))
        throw new HarnessError(400, "items : liste d'index attendue");
      send(
        call.res,
        201,
        await orchestrator.audits.launch(audit.id, body.items as number[], text(body, "title", false), call.actor),
      );
    }),
    route("POST", "/v1/audits/{id}/cancel", "operator", async (call) =>
      send(call.res, 200, {
        audit: await orchestrator.audits.cancel(visibleAudit(call, call.match[1] as string).id, call.actor),
      }),
    ),
    // Le jeton push d'une Live Activity de l'app iOS, pour un run que le client voit.
    route("POST", "/v1/push/activities", "viewer", async (call) => {
      const body = await readBody(call.req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      const runId = typeof body.runId === "string" ? body.runId : "";
      if (!/^[0-9a-f]{16,512}$/i.test(token)) throw new HarnessError(400, "token : hexadécimal attendu");
      const run = orchestrator.visibleRun(runId, call.repos);
      store.putPushToken({ token, kind: "activity", runId: run.id, client: call.client.name });
      send(call.res, 201, { registered: true, pushes: orchestrator.config.apns !== null });
    }),
    // Un client ne retire que SES jetons (un admin, tous) ; un jeton d'un autre est laissé sans le dire.
    route("DELETE", "/v1/push/activities/{name}", "viewer", (call) => {
      const owner = allows(call.client.role, "admin") ? null : call.client.name;
      send(call.res, 200, { removed: store.deletePushToken(call.match[1] as string, owner) });
    }),
    route("GET", "/v1/metrics", "viewer", (call) => {
      const since = Number(call.url.searchParams.get("since"));
      send(call.res, 200, {
        sampleSec: orchestrator.config.monitoring.sampleSec,
        samples: orchestrator.metrics.samples(Number.isFinite(since) && since > 0 ? since : 0, call.repos),
      });
    }),
    route("GET", "/v1/stats", "viewer", (call) =>
      send(call.res, 200, {
        ...computeStats(store, Date.now(), call.repos),
        scheduler: orchestrator.status(call.repos).scheduler,
      }),
    ),
    // La gestion des clients : admin seulement. Le jeton n'est montré qu'à la création.
    route("GET", "/v1/clients", "admin", (call) => send(call.res, 200, { clients: clients.list() })),
    route("POST", "/v1/clients", "admin", async (call) => {
      const body = await readBody(call.req);
      const role = text(body, "role", false) || "operator";
      if (!(ROLES as readonly string[]).includes(role)) throw new HarnessError(400, `role : ${ROLES.join(" | ")}`);
      const repos = body.repos === undefined || body.repos === "*" ? "*" : stringList(body.repos, "repos");
      try {
        const { client, token } = clients.add(text(body, "name"), role as Role, repos ?? "*");
        send(call.res, 201, { client, token });
      } catch (err) {
        throw new HarnessError(400, err instanceof Error ? err.message : String(err));
      }
    }),
    route("DELETE", "/v1/clients/{name}", "admin", (call) => {
      if (!clients.revoke(call.match[1] as string)) throw new HarnessError(404, `client inconnu : ${call.match[1]}`);
      send(call.res, 200, { revoked: call.match[1] });
    }),
    // Les fournisseurs LLM et les chaînes de modèles : admin seulement. Une clé entre, jamais ne sort.
    route("GET", "/v1/providers", "admin", (call) => send(call.res, 200, providersView())),
    route("PUT", "/v1/providers/{name}", "admin", async (call) => {
      const provider = orchestrator.providers.put(
        call.match[1] as string,
        providerInput(await readBody(call.req)),
        call.actor.by,
      );
      send(call.res, 200, { provider });
    }),
    route("DELETE", "/v1/providers/{name}", "admin", (call) => {
      orchestrator.providers.remove(call.match[1] as string, call.actor.by);
      send(call.res, 200, { removed: call.match[1] });
    }),
    // Les connexions OAuth (abonnements) : omp les mène chez les runners, l'app relaie le lien
    // et le code. Les identifiants ne passent jamais par ici.
    route("GET", "/v1/oauth", "admin", async (call) =>
      send(call.res, 200, {
        providers: await orchestrator.logins.providers(),
        login: orchestrator.logins.active(),
      }),
    ),
    route("POST", "/v1/oauth/{name}/login", "admin", (call) =>
      send(call.res, 201, { login: orchestrator.logins.start(call.match[1] as string, call.actor.by) }),
    ),
    route("GET", "/v1/oauth/logins/{id}", "admin", (call) =>
      send(call.res, 200, { login: orchestrator.logins.view(call.match[1] as string) }),
    ),
    route("POST", "/v1/oauth/logins/{id}/answer", "admin", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, { login: orchestrator.logins.answer(call.match[1] as string, text(body, "value")) });
    }),
    route("DELETE", "/v1/oauth/logins/{id}", "admin", async (call) =>
      send(call.res, 200, { login: await orchestrator.logins.cancel(call.match[1] as string) }),
    ),
    route("PUT", "/v1/models", "admin", async (call) => {
      const body = await readBody(call.req);
      if (body.models !== null && (typeof body.models !== "object" || Array.isArray(body.models)))
        throw new HarnessError(400, "models : { fast, standard, heavy } attendu, ou null (retour à la configuration)");
      orchestrator.providers.setChains(body.models as ModelChains | null, call.actor.by);
      send(call.res, 200, providersView());
    }),
  ];
}

/** Le gestionnaire de requêtes (sans serveur) : testable par `http.createServer`. */
export function createHandler(options: HttpOptions): http.RequestListener {
  const { orchestrator } = options;
  const store = orchestrator.store;
  const clients = options.clients ?? new ClientRegistry(null, options.token ?? null);
  const routes = apiRoutes(orchestrator, clients);
  const log = options.log ?? ((line: string) => console.error(`[omp-harness] ${line}`));

  function events(req: http.IncomingMessage, res: http.ServerResponse, url: URL, repos: RepoFilter): void {
    const runId = url.searchParams.get("run");
    const auditId = url.searchParams.get("audit");
    const live = url.searchParams.get("live") === "1";
    const header = req.headers["last-event-id"];
    let cursor = Number((typeof header === "string" ? header : null) ?? url.searchParams.get("after") ?? "0") || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const visible = (event: EventRow): boolean =>
      (runId === null || event.runId === runId) &&
      (auditId === null || event.payload.auditId === auditId) &&
      (repos === null || (event.repo !== null && repos.includes(event.repo)));
    // Rejeu, puis le direct : l'abonnement est posé AVANT la lecture, le curseur écarte les doublons.
    const pending: EventRow[] = [];
    let replaying = true;
    const write = (event: EventRow): void => {
      if (!visible(event)) return;
      if (event.ephemeral) {
        if (live && !replaying) res.write(sseFrame(event));
        return;
      }
      if (event.id <= cursor) return;
      cursor = event.id;
      res.write(sseFrame(event));
    };
    const unsubscribe = store.onEvent((event) => (replaying ? pending.push(event) : write(event)));
    for (
      let batch = store.eventsSince(cursor, runId, 500, repos);
      batch.length > 0;
      batch = store.eventsSince(cursor, runId, 500, repos)
    )
      batch.forEach(write);
    replaying = false;
    pending.filter((event) => !event.ephemeral).forEach(write);
    const ping = setInterval(() => res.write(": ping\n\n"), PING_MS);
    ping.unref?.();
    req.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });
  }

  return (req, res) => {
    void (async () => {
      try {
        // Dans le try : une ligne de requête illisible (`GET http://[x/`) est un 400, jamais un crash.
        let url: URL;
        try {
          url = new URL(req.url ?? "/", "http://harness");
        } catch {
          throw new HarnessError(400, "URL illisible");
        }
        if (req.method === "GET" && url.pathname === "/v1/health") {
          send(res, 200, {
            ok: true,
            api: API_VERSION,
            version: options.version ?? HARNESS_VERSION,
            features: API_FEATURES,
          });
          return;
        }
        const auth = req.headers.authorization ?? "";
        const client = clients.authenticate(auth.startsWith("Bearer ") ? auth.slice(7) : "");
        if (!client) {
          send(res, 401, { error: "jeton absent ou invalide" });
          return;
        }
        const repos = repoFilter(client);
        if (req.method === "GET" && url.pathname === "/v1/events") {
          events(req, res, url, repos);
          return;
        }
        let matchedPath = false;
        for (const route of routes) {
          const match = route.pattern.exec(url.pathname);
          if (!match) continue;
          matchedPath = true;
          if (route.method !== req.method) continue;
          if (!allows(client.role, route.role))
            throw new HarnessError(
              403,
              `le rôle ${client.role} ne permet pas ${route.method} ${route.path} (${route.role} requis)`,
            );
          await route.handle({ match, req, res, url, client, repos, actor: { by: client.name, rev: ifMatch(req) } });
          return;
        }
        send(res, matchedPath ? 405 : 404, { error: matchedPath ? "méthode non permise" : "route inconnue" });
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HarnessError) send(res, err.status, { error: err.message });
        else {
          // Une erreur imprévue peut citer un chemin, une commande ou un secret : elle reste au
          // journal, la réponse n'en porte que la référence.
          const ref = randomBytes(4).toString("hex");
          log(
            `${req.method} ${req.url} : erreur interne ${ref} — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
          );
          send(res, 500, { error: `erreur interne (réf. ${ref})` });
        }
      }
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "erreur interne" });
      else res.end();
    });
  };
}
