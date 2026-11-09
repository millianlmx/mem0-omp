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
import { readFileSync, statfsSync } from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";
import type { Client, Role } from "./auth.ts";
import { ClientRegistry, ROLES, allows, canSeeRepo, repoFilter } from "./auth.ts";
import type { Actor } from "./context.ts";
import type { TestJudge } from "./config.ts";
import { TEST_JUDGES, testsJudge } from "./config.ts";
import type { ActionState, ClientSource, DecisionStatus, EventRow, RepoFilter, SignalState } from "./db.ts";
import { ACTION_STATES, CLIENT_SOURCES, SIGNAL_STATES } from "./db.ts";
import { HarnessError } from "./errors.ts";
import {
  budgetInput,
  escalationAnswers,
  instructionsInput,
  integer,
  newRunInput,
  priorityInput,
  requireRepo,
  stringList,
  text,
} from "./input.ts";
import { intakeView, parseIntakeStates, visibleIntake } from "./intake.ts";
import type { RunState } from "./machine.ts";
import type { Orchestrator } from "./orchestrator.ts";
import type { ModelChains, ProviderInput } from "./providers.ts";
import { PROOF_MIMES } from "./proofs.ts";
import { COMPATIBLE, COMPATIBLE_APIS, KNOWN_PROVIDERS, OAUTH } from "./providers.ts";
import { autonomyValidations, escalationBatches, projectsOf } from "./queries.ts";
import type { ConfigAdmin } from "./repos.ts";
import { computeStats } from "./stats.ts";
import { autonomyProposals } from "./autonomy-learning.ts";
import { HARNESS_COMMIT } from "./build-info.ts";
import { DIGEST_WINDOW_MS, digestOf } from "./digest.ts";
import type { LogLine } from "./logger.ts";
import { renderMetrics } from "./prometheus.ts";
import { scheduleEdit, scheduleInput } from "./schedules.ts";
import type { BrowserHello, SessionJob, Workstation } from "./workstation.ts";
import type { VigieStatus } from "./db.ts";
import { VIGIE_STATUSES } from "./db.ts";
import { handleMcp } from "./mcp.ts";
import { parseLoginInput } from "./browser/vps-login.ts";
import {
  MAX_WAIT_SEC,
  SESSION_JOBS,
  approverFor,
  parseActionInput,
  parseBrowserHello,
  parseRequestStates,
  workstationFor,
} from "./workstation.ts";

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
  "session-details",
  "usage",
  "alerts",
  "timeline",
  "changes",
  "live-tests",
  "metrics",
  "push-activities",
  "workstation",
  "workstation-requests",
  "workstation-browsers",
  "workstation-stop",
  "workstation-session",
  "workstation-captures",
  "workstation-files",
  "workstation-vps",
  "mcp",
  "digest",
  "instructions",
  "run-budget",
  "admin-repos",
  "schedules",
  "client-errors",
  "prometheus",
  "vigie",
  "push-alerts",
  "autonomy",
  "corporate-signals",
  "intake",
  "proofs",
  "session-graph",
  "repo-tests",
] as const;

/** Le refus d'un geste du poste (ou d'un signalement de collègue) à un client restreint à des dépôts. */
const OWNER_ONLY = "le poste est réservé au propriétaire";

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
/** Les octets qu'un flux SSE peut garder en attente d'un client qui ne lit plus : au-delà, il est coupé. */
const SSE_MAX_BUFFER = 4 * 1024 * 1024;
/** Les événements relus par lot au rejeu ; la boucle d'événements respire entre deux lots. */
const REPLAY_BATCH = 500;

export type HealthCheck = { ok: boolean };

/** Ce que `GET /v1/health` vérifie : la base lisible, le scheduling qui tourne, le disque qui n'est pas plein. */
export type HealthChecks = {
  db: HealthCheck;
  /** `ageSec` : depuis la fin du dernier tour (`null` : service pas encore démarré). */
  scheduler: HealthCheck & { ageSec: number | null };
  /** `freeMiB` : le moins libre des systèmes de fichiers de `dataDir` et `worktreesDir`. */
  disk: HealthCheck & { freeMiB: number | null };
};

/** Les Mio libres (pour un non-root) du système de fichiers de `dir`, ou de son plus proche parent existant. */
function freeMiB(dir: string): number | null {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    try {
      const stats = statfsSync(current);
      return Math.floor((stats.bavail * stats.bsize) / (1024 * 1024));
    } catch {
      if (path.dirname(current) === current) return null;
    }
  }
}

/** Les vérifications de santé, sans jamais lever : un échec est un `ok: false`, jamais un détail interne. */
export function healthChecks(orchestrator: Orchestrator, now = Date.now()): { ok: boolean; checks: HealthChecks } {
  const { config, store } = orchestrator;
  let db = true;
  try {
    store.db.prepare("SELECT id FROM runs LIMIT 1").get();
  } catch {
    db = false;
  }
  const last = orchestrator.lastTickAt;
  const ageSec = last === null ? null : Math.max(0, Math.round((now - last) / 1000));
  const free = [config.dataDir, config.worktreesDir].map(freeMiB);
  const freeLeast = free.some((value) => value === null) ? null : Math.min(...(free as number[]));
  const checks: HealthChecks = {
    db: { ok: db },
    scheduler: { ok: ageSec === null || ageSec <= config.health.tickStaleSec, ageSec },
    disk: { ok: freeLeast !== null && freeLeast >= config.health.minFreeMiB, freeMiB: freeLeast },
  };
  return { ok: checks.db.ok && checks.scheduler.ok && checks.disk.ok, checks };
}

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

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HarnessError(413, "corps trop gros (1 Mio max)");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HarnessError(400, "JSON invalide");
  }
}

async function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = await readJson(req);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HarnessError(400, "un objet JSON est attendu");
  return parsed as Record<string, unknown>;
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

/** Attend que le client ait lu ce qui lui est envoyé (`drain`), ou qu'il soit parti. */
function drained(res: http.ServerResponse): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => {
      res.off("drain", done);
      res.off("close", done);
      resolve();
    };
    res.on("drain", done);
    res.on("close", done);
  });
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
  /** Le fichier de configuration administré à chaud (`POST /v1/reload`, `POST /v1/repos`) ; absent : 409. */
  admin?: ConfigAdmin | null;
  /** Le commit rendu par `/v1/health` ; défaut : `OMP_HARNESS_COMMIT` (build-info.ts). */
  commit?: string | null;
  /** Le journal du service : la cause d'une erreur interne y va, jamais dans la réponse. */
  log?: LogLine;
  /** La cadence des pings du flux SSE, et de la relecture du jeton de chaque flux ouvert. */
  pingMs?: number;
  /** Les octets en attente au-delà desquels un flux SSE est coupé (le client reprend par `Last-Event-ID`). */
  sseMaxBuffer?: number;
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
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  role: Role;
  pattern: RegExp;
  handle: (call: Call) => Promise<void> | void;
};

/**
 * Les routes de l'API, avec le rôle minimal de chacune : la table que documente le README du harness.
 * `admin` : le fichier de configuration administré à chaud (`null` : ces routes rendent 409).
 */
export function apiRoutes(
  orchestrator: Orchestrator,
  clients: ClientRegistry,
  admin: ConfigAdmin | null = null,
): Route[] {
  const store = orchestrator.store;
  const route = (method: Route["method"], path: string, role: Role, handle: Route["handle"]): Route => ({
    method,
    path,
    role,
    // `{id}` et `{name}` : un segment ; `{n}` : un entier.
    pattern: new RegExp(`^${path.replace(/\{n\}/g, "(\\d+)").replace(/\{(id|name)\}/g, "([\\w.-]+)")}$`),
    handle,
  });
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
  /** Le poste de travail est au propriétaire (workstation.ts `workstationFor`). */
  const workstationOf = (call: Call): Workstation => workstationFor(orchestrator.workstation, call.client);
  /**
   * Les signalements des collègues et l'origine d'un run sont au propriétaire, comme tout le poste : un
   * client restreint (403) ou pilote (403, la vigie est un agent) n'y a pas accès. Sans le 404 « poste
   * désactivé » : ils restent lisibles et confirmables quand le poste est coupé.
   */
  const ownerOf = (call: Call, pilotRefusal: string): void => {
    if (call.repos !== null) throw new HarnessError(403, OWNER_ONLY);
    if (call.client.pilot) throw new HarnessError(403, pilotRefusal);
  };
  const READS_SIGNALS = "réservé à l'humain — un client pilote ne lit pas les signalements";
  const ACTS_ON_SIGNALS = "geste réservé à l'humain — un client pilote ne confirme pas de signalement";
  /** Approuver, refuser ou régler le poste : l'appareil approbateur seulement (`approverFor`). */
  const approverOf = (call: Call): Workstation => approverFor(orchestrator.workstation, call.client);
  /** La présentation de l'extension appelante : son navigateur (`X-OMP-Browser`), son libellé et sa version. */
  const helloOf = (call: Call): BrowserHello =>
    parseBrowserHello(
      call.req.headers["x-omp-browser"],
      call.req.headers["x-omp-browser-label"],
      call.req.headers["x-omp-extension"],
    );
  /** Les routes d'écriture de la vigie : son client pilote seulement (son jeton, jamais un autre). */
  const pilotOf = (call: Call): void => {
    if (!call.client.pilot)
      throw new HarnessError(403, "réservé au client pilote de la vigie (`main.ts --add-client vigie --pilot`)");
  };
  /** `?wait=` : les secondes d'un long-poll, bornées à 30 ; absent ou illisible : aucune attente. */
  const waitOf = (url: URL): number => {
    const wait = Number(url.searchParams.get("wait"));
    return Number.isFinite(wait) && wait > 0 ? Math.min(wait, MAX_WAIT_SEC) : 0;
  };
  /** Un signal levé quand le client part avant la réponse : un long-poll s'arrête alors sans rien louer. */
  const departure = (res: http.ServerResponse): AbortSignal => {
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    return abort.signal;
  };
  const limitOf = (url: URL, fallback: number, max: number): number => {
    const limit = Number(url.searchParams.get("limit"));
    return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : fallback;
  };
  /** La configuration du serveur est au propriétaire : un client restreint à des dépôts n'y touche pas. */
  const adminOf = (call: Call): ConfigAdmin => {
    if (call.repos !== null) throw new HarnessError(403, "la configuration du serveur est réservée au propriétaire");
    if (admin === null)
      throw new HarnessError(409, "service lancé sans fichier de configuration (--config) : rien à relire ni à écrire");
    return admin;
  };

  return [
    route("GET", "/v1/me", "viewer", (call) => send(call.res, 200, { client: call.client })),
    route("GET", "/v1/status", "viewer", async (call) => {
      const [oracle, memory] = await Promise.all([
        orchestrator.oracleStatus(),
        orchestrator.observability.memoryStatus(),
      ]);
      send(call.res, 200, {
        ...orchestrator.status(call.repos),
        oracle,
        memory,
        backups: orchestrator.observability.backupStatus(),
      });
    }),
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
            judge: testsJudge(repo),
          })),
      }),
    ),
    // `--add-repo` par l'API : clé du dépôt, clone, écriture éprouvée, configuration écrite et rechargée.
    route("POST", "/v1/repos", "admin", async (call) => {
      const target = adminOf(call);
      const body = await readBody(call.req);
      const name = text(body, "name", false).trim();
      const declared = await target.declare(text(body, "url"), name === "" ? undefined : name);
      send(call.res, declared.added ? 201 : 200, declared);
    }),
    // Qui juge la suite complète d'un dépôt (`tests.judge`, `tests.ciTimeoutSec`) : écrit, validé, rechargé à chaud.
    route("PATCH", "/v1/repos/{name}", "admin", async (call) => {
      const target = adminOf(call);
      const body = await readBody(call.req);
      const tests = body.tests;
      if (typeof tests !== "object" || tests === null || Array.isArray(tests))
        throw new HarnessError(400, "tests : un objet { judge?, ciTimeoutSec? } attendu");
      const fields = tests as Record<string, unknown>;
      const unknown = Object.keys(fields).filter((key) => key !== "judge" && key !== "ciTimeoutSec");
      if (unknown.length > 0)
        throw new HarnessError(400, `tests : champ(s) non modifiable(s) ici : ${unknown.join(", ")}`);
      const { judge, ciTimeoutSec } = fields;
      if (judge !== undefined && judge !== null && !(TEST_JUDGES as readonly unknown[]).includes(judge))
        throw new HarnessError(400, `tests.judge : ${TEST_JUDGES.map((value) => `"${value}"`).join(" | ")} ou null`);
      if (
        ciTimeoutSec !== undefined &&
        ciTimeoutSec !== null &&
        !(Number.isInteger(ciTimeoutSec) && (ciTimeoutSec as number) >= 1)
      )
        throw new HarnessError(400, "tests.ciTimeoutSec : entier ≥ 1 (secondes) ou null");
      const name = call.match[1] as string;
      send(
        call.res,
        200,
        await target.setTests(name, {
          ...(judge !== undefined ? { judge: judge as TestJudge | null } : {}),
          ...(ciTimeoutSec !== undefined ? { ciTimeoutSec: ciTimeoutSec as number | null } : {}),
        }),
      );
    }),
    // SIGHUP par l'API : la configuration relue, les dépôts rechargés ; invalide, 400 et rien ne change.
    route("POST", "/v1/reload", "admin", async (call) => send(call.res, 200, { reload: await adminOf(call).reload() })),
    route("GET", "/v1/runs", "viewer", (call) => {
      const state = call.url.searchParams.get("state");
      const repo = call.url.searchParams.get("repo");
      const runs = store.listRuns({
        ...(state ? { state: state.split(",") as RunState[] } : {}),
        ...(repo ? { repo } : {}),
        repos: call.repos,
      });
      // En file, la raison d'un run dit ce qui le retient (Orchestrator.withWait).
      send(call.res, 200, { runs: runs.map((run) => orchestrator.withWait(run)) });
    }),
    route("POST", "/v1/runs", "operator", async (call) => {
      const body = await readBody(call.req);
      const run = orchestrator.createRun(newRunInput(body, call.client, { typed: true }), call.actor);
      send(call.res, 201, { run }, { ETag: `"${run.rev}"` });
    }),
    route("GET", "/v1/runs/{id}", "viewer", (call) => {
      const view = orchestrator.runView(call.match[1] as string, call.repos);
      send(call.res, 200, view, { ETag: `"${(view.run as { rev: number }).rev}"` });
    }),
    // Le pont corpo ↔ usine : les signalements des collègues et leurs propositions (propriétaire seul ;
    // confirmer et écarter : l'appareil approbateur). L'origine d'un run se lit ici et nulle part ailleurs.
    route("GET", "/v1/signals", "viewer", (call) => {
      ownerOf(call, READS_SIGNALS);
      const asked = (call.url.searchParams.get("state") ?? "proposed").split(",").filter((state) => state !== "");
      const states = asked.filter((state): state is SignalState =>
        (SIGNAL_STATES as readonly string[]).includes(state),
      );
      if (states.length !== asked.length) throw new HarnessError(400, `state : ${SIGNAL_STATES.join(" | ")}`);
      send(call.res, 200, { signals: orchestrator.signals.list({ states, limit: limitOf(call.url, 50, 200) }) });
    }),
    route("GET", "/v1/signals/{id}", "viewer", (call) => {
      ownerOf(call, READS_SIGNALS);
      send(call.res, 200, { signal: orchestrator.signals.get(call.match[1] as string) });
    }),
    route("POST", "/v1/signals/{id}/preview", "viewer", async (call) => {
      ownerOf(call, READS_SIGNALS);
      send(call.res, 200, await orchestrator.signals.preview(call.match[1] as string, await readBody(call.req)));
    }),
    route("POST", "/v1/signals/{id}/confirm", "operator", async (call) => {
      ownerOf(call, ACTS_ON_SIGNALS);
      const result = await orchestrator.signals.confirm(
        call.match[1] as string,
        await readBody(call.req),
        call.client,
        call.actor,
      );
      send(call.res, 201, result);
      void orchestrator.tick();
    }),
    route("POST", "/v1/signals/{id}/dismiss", "operator", async (call) => {
      ownerOf(call, ACTS_ON_SIGNALS);
      send(call.res, 200, {
        signal: orchestrator.signals.dismiss(call.match[1] as string, await readBody(call.req), call.client),
      });
    }),
    route("GET", "/v1/runs/{id}/origin", "viewer", (call) => {
      const id = runId(call);
      ownerOf(call, READS_SIGNALS);
      send(call.res, 200, { origin: orchestrator.signals.originOf(id) });
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
    route("GET", "/v1/runs/{id}/session/{n}", "viewer", (call) =>
      send(call.res, 200, orchestrator.sessionEntryView(call.match[1] as string, Number(call.match[2]), call.repos)),
    ),
    route("GET", "/v1/runs/{id}/graph", "viewer", (call) =>
      send(call.res, 200, orchestrator.graphView(call.match[1] as string, call.repos)),
    ),
    route("GET", "/v1/runs/{id}/proofs", "viewer", (call) =>
      send(call.res, 200, orchestrator.proofsView(call.match[1] as string, call.repos)),
    ),
    // Le contenu brut d'une preuve : le type déclaré, jamais deviné ; le fichier se retrouve par son rang seul.
    route("GET", "/v1/runs/{id}/proofs/{n}", "viewer", (call) => {
      const { proof, data } = orchestrator.proofContent(call.match[1] as string, Number(call.match[2]), call.repos);
      const ext = PROOF_MIMES[proof.kind][proof.mime];
      call.res.writeHead(200, {
        "Content-Type": proof.mime,
        "Content-Length": data.length,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": `inline; filename="preuve-${proof.n}.${ext}"`,
      });
      call.res.end(data);
    }),
    route("POST", "/v1/runs/{id}/cancel", "operator", async (call) =>
      send(call.res, 200, { run: await orchestrator.cancel(runId(call), call.actor) }),
    ),
    // Une consigne au run : injectée dans le prompt en cours de sa session, sinon gardée pour le suivant.
    route("POST", "/v1/runs/{id}/instructions", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, await orchestrator.instruct(runId(call), instructionsInput(body, "text"), call.actor));
    }),
    // Le budget propre du run (`null` : celui de la configuration).
    route("POST", "/v1/runs/{id}/budget", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, await orchestrator.setBudget(runId(call), budgetInput(body), call.actor));
    }),
    route("POST", "/v1/runs/{id}/priority", "operator", async (call) => {
      const body = await readBody(call.req);
      send(call.res, 200, { run: await orchestrator.setPriority(runId(call), priorityInput(body), call.actor) });
    }),
    route("POST", "/v1/runs/{id}/escalations", "operator", async (call) => {
      const body = await readBody(call.req);
      const answers = escalationAnswers(body);
      send(call.res, 200, { run: await orchestrator.answerEscalations(runId(call), answers, call.actor) });
    }),
    // La relance d'un run échoué ou en attente de l'humain : même étape, tout de suite, avec une consigne facultative.
    route("POST", "/v1/runs/{id}/retry", "operator", async (call) => {
      const body = await readBody(call.req);
      const instructions = instructionsInput(body, "instructions", false);
      send(call.res, 200, { run: await orchestrator.retry(runId(call), call.actor, instructions) });
    }),
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
    route("GET", "/v1/inbox", "viewer", (call) => send(call.res, 200, orchestrator.inboxView(call.repos))),
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
      requireRepo(call.client, repo);
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
    route("GET", "/v1/dreams", "viewer", (call) =>
      send(call.res, 200, { dreams: orchestrator.dreams.list(call.repos) }),
    ),
    // Un rêve demandé : le dépôt est examiné au prochain tour, sans seuil de faits ni attente du repos.
    route("POST", "/v1/dreams", "operator", async (call) => {
      const body = await readBody(call.req);
      const repo = text(body, "repo");
      requireRepo(call.client, repo);
      orchestrator.dreams.request(repo, call.actor);
      void orchestrator.tick();
      send(call.res, 202, { repo, requested: true });
    }),
    route("GET", "/v1/audits", "viewer", (call) => send(call.res, 200, { audits: store.listAudits([], call.repos) })),
    route("POST", "/v1/audits", "operator", async (call) => {
      const body = await readBody(call.req);
      const repo = text(body, "repo");
      requireRepo(call.client, repo);
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
    route("GET", "/v1/audits/{id}/session/{n}", "viewer", (call) =>
      send(
        call.res,
        200,
        orchestrator.auditSessionEntryView(visibleAudit(call, call.match[1] as string).id, Number(call.match[2])),
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
    // Les Demandes (intake.ts) : une phrase libre, classée en plan ; rien n'est créé avant `confirm`.
    route("GET", "/v1/intake", "viewer", (call) =>
      send(call.res, 200, {
        intakes: store
          .listIntakes({
            states: parseIntakeStates(call.url.searchParams.get("state")),
            viewer: { repos: call.repos, name: call.client.name },
            limit: limitOf(call.url, 50, 200),
          })
          .map(intakeView),
      }),
    ),
    route("POST", "/v1/intake", "operator", async (call) => {
      const intake = orchestrator.intake.create(await readBody(call.req), call.client, call.actor);
      void orchestrator.tick();
      send(call.res, 201, { intake: intakeView(intake) });
    }),
    route("GET", "/v1/intake/{id}", "viewer", (call) =>
      send(call.res, 200, { intake: intakeView(visibleIntake(store, call.client, call.match[1] as string)) }),
    ),
    route("POST", "/v1/intake/{id}/confirm", "operator", async (call) => {
      const body = await readBody(call.req);
      const intake = orchestrator.intake.confirm(call.match[1] as string, call.client, call.actor, body);
      void orchestrator.tick();
      send(call.res, 201, { intake: intakeView(intake) });
    }),
    route("POST", "/v1/intake/{id}/cancel", "operator", async (call) =>
      send(call.res, 200, {
        intake: intakeView(await orchestrator.intake.cancel(call.match[1] as string, call.client, call.actor)),
      }),
    ),
    route("POST", "/v1/intake/{id}/answer", "operator", async (call) => {
      const body = await readBody(call.req);
      const intake = orchestrator.intake.answer(call.match[1] as string, call.client, call.actor, body);
      void orchestrator.tick();
      send(call.res, 200, { intake: intakeView(intake) });
    }),
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
    // Un appareil iOS et ses alertes push : il reçoit ce que voit le client qui l'enregistre.
    route("POST", "/v1/push/devices", "viewer", async (call) => {
      const body = await readBody(call.req);
      const token = typeof body.token === "string" ? body.token.trim() : "";
      if (!/^[0-9a-f]{16,512}$/i.test(token)) throw new HarnessError(400, "token : hexadécimal attendu");
      if (body.platform !== "ios") throw new HarnessError(400, "platform : « ios » attendu");
      const environment = body.environment;
      if (environment !== "sandbox" && environment !== "production")
        throw new HarnessError(400, "environment : « sandbox » ou « production » attendu");
      const added = store.putPushDevice({ token, client: call.client.name, platform: "ios", environment });
      send(call.res, added ? 201 : 200, { registered: true, pushes: orchestrator.config.apns !== null });
    }),
    // Comme les jetons d'activité : un client n'oublie que SES appareils (un admin, tous).
    route("DELETE", "/v1/push/devices/{name}", "viewer", (call) => {
      const owner = allows(call.client.role, "admin") ? null : call.client.name;
      send(call.res, 200, { removed: store.deletePushDevice(call.match[1] as string, owner) });
    }),
    // La santé au fil du temps : `?since=` (ms) rend les points depuis cet instant (gardés
    // `metrics.retentionDays` jours), sinon les `monitoring.keep` derniers.
    route("GET", "/v1/metrics", "viewer", (call) => {
      const since = Number(call.url.searchParams.get("since"));
      send(call.res, 200, {
        sampleSec: orchestrator.config.monitoring.sampleSec,
        samples: orchestrator.metrics.samples(Number.isFinite(since) && since > 0 ? since : null, call.repos),
      });
    }),
    // L'exposition Prometheus (deploy/monitoring/prometheus.yml la scrute avec le jeton d'un
    // viewer) : coûts et runs de tous les dépôts, donc un client qui les voit tous.
    route("GET", "/metrics", "viewer", (call) => {
      if (call.repos !== null)
        throw new HarnessError(403, "/metrics est réservé aux clients qui voient tous les dépôts");
      const body = renderMetrics(orchestrator, HARNESS_VERSION);
      call.res.writeHead(200, {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Cache-Control": "no-store",
      });
      call.res.end(body);
    }),
    // Les erreurs des clients (apps, extension, omp, vigie) : 202, au plus 60 par minute et par client.
    route("POST", "/v1/client-errors", "viewer", async (call) => {
      const row = orchestrator.observability.recordClientError(call.client, await readBody(call.req));
      send(call.res, 202, { id: row.id });
    }),
    // Un client borné à des dépôts ne relit que ses propres erreurs.
    route("GET", "/v1/client-errors", "viewer", (call) => {
      const since = Number(call.url.searchParams.get("since") ?? 0);
      if (!Number.isInteger(since) || since < 0) throw new HarnessError(400, "since : instant en ms (epoch) attendu");
      const source = call.url.searchParams.get("source");
      if (source !== null && !(CLIENT_SOURCES as readonly string[]).includes(source))
        throw new HarnessError(400, `source : ${CLIENT_SOURCES.join(" | ")}`);
      send(call.res, 200, {
        errors: store.listClientErrors({
          since,
          ...(source !== null ? { source: source as ClientSource } : {}),
          ...(call.repos !== null ? { client: call.client.name } : {}),
          limit: limitOf(call.url, 200, 1000),
        }),
      });
    }),
    route("GET", "/v1/stats", "viewer", (call) =>
      send(call.res, 200, {
        ...computeStats(store, Date.now(), call.repos),
        scheduler: orchestrator.status(call.repos).scheduler,
      }),
    ),
    // L'autonomie par paliers, en lecture seule : les règles de chaque dépôt visible, ce qui a été validé seul
    // (avec sa règle et ses preuves) et les propositions de palier. Aucune route n'écrit une règle.
    route("GET", "/v1/autonomy", "viewer", (call) => {
      const now = Date.now();
      const { config } = orchestrator;
      send(call.res, 200, {
        repos: config.repos
          .filter((repo) => call.repos === null || call.repos.includes(repo.name))
          .map((repo) => ({ repo: repo.name, rules: repo.autonomy?.rules ?? [] })),
        validations: autonomyValidations(store, config.autonomyLearning.windowDays, now, call.repos),
        proposals: autonomyProposals(store, config, now, call.repos),
      });
    }),
    // Le rapport du matin : ce qui s'est fait seul depuis `since` (epoch ms ; défaut : 24 h).
    route("GET", "/v1/digest", "viewer", (call) => {
      const now = Date.now();
      const raw = call.url.searchParams.get("since");
      const since = raw === null ? now - DIGEST_WINDOW_MS : Number(raw);
      if (!Number.isInteger(since) || since < 0) throw new HarnessError(400, "since : instant en ms (epoch) attendu");
      send(
        call.res,
        200,
        digestOf(store, since, now, call.repos, HARNESS_COMMIT, orchestrator.observability.digestHealth()),
      );
    }),
    // Les planifications récurrentes (schedules.ts) : celles des dépôts que le client voit.
    route("GET", "/v1/schedules", "viewer", (call) => send(call.res, 200, orchestrator.schedules.view(call.repos))),
    route("POST", "/v1/schedules", "operator", async (call) => {
      const schedule = orchestrator.schedules.create(scheduleInput(await readBody(call.req), call.client), call.actor);
      send(call.res, 201, { schedule }, { ETag: `"${schedule.rev}"` });
    }),
    route("PUT", "/v1/schedules/{id}", "operator", async (call) => {
      const body = await readBody(call.req);
      const schedule = orchestrator.schedules.update(
        call.match[1] as string,
        scheduleEdit(body, call.client),
        call.actor,
        call.repos,
      );
      send(call.res, 200, { schedule }, { ETag: `"${schedule.rev}"` });
    }),
    route("DELETE", "/v1/schedules/{id}", "operator", (call) => {
      orchestrator.schedules.delete(call.match[1] as string, call.actor, call.repos);
      send(call.res, 200, { deleted: true });
    }),
    route("POST", "/v1/schedules/{id}/run", "operator", async (call) => {
      const fired = await orchestrator.schedules.runNow(call.match[1] as string, call.actor, call.repos);
      void orchestrator.tick();
      send(call.res, 201, fired, { ETag: `"${fired.schedule.rev}"` });
    }),
    // Le poste de travail (extension Chrome, outils OMP, apps) : propriétaire seulement.
    route("GET", "/v1/workstation", "viewer", (call) => send(call.res, 200, workstationOf(call).status())),
    route("PUT", "/v1/workstation/settings", "operator", async (call) => {
      const workstation = approverOf(call);
      send(call.res, 200, workstation.updateSettings(await readBody(call.req), call.actor));
    }),
    route("POST", "/v1/workstation/observations", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, { stored: workstation.recordObservations(await readBody(call.req), helloOf(call)) });
    }),
    route("GET", "/v1/workstation/observations", "viewer", (call) => {
      const workstation = workstationOf(call);
      const since = Number(call.url.searchParams.get("since"));
      send(call.res, 200, {
        observations: workstation.listObservations({
          since: Number.isFinite(since) && since > 0 ? since : 0,
          limit: limitOf(call.url, 500, 500),
        }),
      });
    }),
    // Le long-poll de l'extension : 200 `{ action }` (passée `running`), ou 204 après l'attente.
    route("GET", "/v1/workstation/next", "operator", async (call) => {
      const workstation = workstationOf(call);
      // Louer une action en remet les `params` : jamais à un client pilote.
      if (call.client.pilot) throw new HarnessError(403, "le client pilote n'est pas l'extension du poste");
      const hello = helloOf(call);
      const signal = departure(call.res);
      const agentTabs = call.req.headers["x-omp-agent-tabs"];
      const action = await workstation.next(
        waitOf(call.url),
        signal,
        hello,
        typeof agentTabs === "string" ? agentTabs : undefined,
      );
      if (action) send(call.res, 200, { action });
      else if (!signal.aborted) {
        call.res.writeHead(204, { "Cache-Control": "no-store" });
        call.res.end();
      }
    }),
    route("POST", "/v1/workstation/actions", "operator", async (call) => {
      const workstation = workstationOf(call);
      // Un envoi du poste est un geste réservé à l'humain : jamais un agent pilote (la vigie).
      if (call.client.pilot)
        throw new HarnessError(403, "geste réservé à l'humain — un client pilote n'agit pas sur le poste");
      const input = parseActionInput(await readBody(call.req));
      send(call.res, 201, { action: workstation.createAction(input, "session", call.actor.by) });
    }),
    route("GET", "/v1/workstation/actions", "viewer", (call) => {
      const workstation = workstationOf(call);
      const states = (call.url.searchParams.get("state") ?? "").split(",").filter((state) => state !== "");
      if (states.some((state) => !(ACTION_STATES as readonly string[]).includes(state)))
        throw new HarnessError(400, `state : ${ACTION_STATES.join(" | ")}`);
      const before = Number(call.url.searchParams.get("before"));
      send(call.res, 200, {
        actions: workstation.listActions({
          states: states as ActionState[],
          limit: limitOf(call.url, 50, 200),
          ...(Number.isInteger(before) && before > 0 ? { before } : {}),
        }),
      });
    }),
    // `?wait=` : rend dès que l'action quitte la file et l'extension (l'image d'une capture, en mémoire seulement).
    route("GET", "/v1/workstation/actions/{n}", "viewer", async (call) => {
      const workstation = workstationOf(call);
      const seq = Number(call.match[1]);
      const signal = departure(call.res);
      const view = await workstation.waitAction(seq, waitOf(call.url), signal);
      if (!signal.aborted) send(call.res, 200, view);
    }),
    route("POST", "/v1/workstation/actions/{n}/result", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, {
        action: workstation.submitResult(Number(call.match[1]), await readBody(call.req), helloOf(call)),
      });
    }),
    route("GET", "/v1/workstation/actions/{n}/capture", "viewer", (call) => {
      const workstation = workstationOf(call);
      const seq = Number(call.match[1]);
      send(call.res, 200, workstation.capture(seq));
    }),
    // Le fichier d'un `upload` en cours, lu dans le dossier d'envoi du poste : pour l'extension qui l'exécute.
    route("GET", "/v1/workstation/actions/{n}/file", "operator", (call) =>
      send(call.res, 200, workstationOf(call).uploadFile(Number(call.match[1]))),
    ),
    // Annuler une action qui n'a pas abouti (en file, en cours, en attente) : `refused`, sa raison dans `error`.
    route("POST", "/v1/workstation/actions/{n}/cancel", "operator", (call) =>
      send(call.res, 200, { action: workstationOf(call).cancel(Number(call.match[1]), call.actor) }),
    ),
    // L'arrêt d'urgence : tout client du poste, viewer compris (arrêter est toujours permis).
    route("POST", "/v1/workstation/stop", "viewer", async (call) => {
      const stopped = workstationOf(call).stop(call.actor);
      await orchestrator.workstationAgent.halt("interrompu : arrêt d'urgence");
      send(call.res, 200, stopped);
    }),
    // Le navigateur du poste sur le VPS (`moli-poste`) : le mirroir de la session du Chrome source
    // (l'extension choisie par `mirrorBrowser`) et la connexion interactive (approbateur seulement).
    route("GET", "/v1/workstation/vps/mirror", "operator", async (call) => {
      workstationOf(call);
      send(call.res, 200, await orchestrator.vps.mirrorStatus(helloOf(call)));
    }),
    route("POST", "/v1/workstation/vps/cookies", "operator", async (call) => {
      workstationOf(call);
      send(call.res, 200, await orchestrator.vps.acceptMirror(helloOf(call), await readBody(call.req)));
    }),
    route("POST", "/v1/workstation/vps/login", "operator", async (call) => {
      approverOf(call);
      const body = await readBody(call.req);
      send(call.res, 201, { login: await orchestrator.vps.login.start(body.url) });
    }),
    route("GET", "/v1/workstation/vps/login", "operator", (call) => {
      approverOf(call);
      send(call.res, 200, { login: orchestrator.vps.login.view() });
    }),
    route("GET", "/v1/workstation/vps/login/frame", "operator", async (call) => {
      approverOf(call);
      send(call.res, 200, await orchestrator.vps.login.frame());
    }),
    route("POST", "/v1/workstation/vps/login/input", "operator", async (call) => {
      approverOf(call);
      await orchestrator.vps.login.input(parseLoginInput(await readBody(call.req)));
      send(call.res, 200, { sent: true });
    }),
    route("DELETE", "/v1/workstation/vps/login", "operator", async (call) => {
      approverOf(call);
      send(call.res, 200, { closed: await orchestrator.vps.login.finish() });
    }),
    route("GET", "/v1/workstation/session", "viewer", (call) => {
      const workstation = workstationOf(call);
      const job = call.url.searchParams.get("job") ?? "";
      if (!Object.hasOwn(SESSION_JOBS, job))
        throw new HarnessError(400, `job : ${Object.keys(SESSION_JOBS).join(" | ")}`);
      const sinceRaw = call.url.searchParams.get("since");
      const since = sinceRaw === null ? null : Number(sinceRaw);
      if (since !== null && !(Number.isInteger(since) && since >= 0))
        throw new HarnessError(400, "since : le numéro (seq) de la dernière entrée lue attendu");
      const live = orchestrator.workstationAgent.isLive(SESSION_JOBS[job as SessionJob]);
      send(call.res, 200, workstation.sessionView(job as SessionJob, live, { ...pageOf(call.url), since }));
    }),
    route("POST", "/v1/workstation/actions/{n}/approve", "operator", (call) =>
      send(call.res, 200, { action: approverOf(call).approve(Number(call.match[1]), call.actor) }),
    ),
    route("POST", "/v1/workstation/actions/{n}/refuse", "operator", async (call) => {
      const workstation = approverOf(call);
      const body = await readBody(call.req);
      send(call.res, 200, {
        action: workstation.refuse(Number(call.match[1]), text(body, "reason", false), call.actor),
      });
    }),
    route("GET", "/v1/workstation/profile", "viewer", (call) => send(call.res, 200, workstationOf(call).profileView())),
    route("POST", "/v1/workstation/profile/rebuild", "operator", (call) => {
      workstationOf(call).profileRequested = true;
      void orchestrator.tick();
      send(call.res, 202, { queued: true });
    }),
    route("POST", "/v1/workstation/meetings", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 201, { meeting: workstation.createMeeting(await readBody(call.req), helloOf(call)) });
    }),
    route("POST", "/v1/workstation/meetings/{id}/segments", "operator", async (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, {
        stored: workstation.addSegments(call.match[1] as string, await readBody(call.req), helloOf(call)),
      });
    }),
    route("POST", "/v1/workstation/meetings/{id}/end", "operator", (call) => {
      const meeting = workstationOf(call).endMeeting(call.match[1] as string, helloOf(call));
      void orchestrator.tick();
      send(call.res, 200, { meeting });
    }),
    route("GET", "/v1/workstation/meetings", "viewer", (call) =>
      send(call.res, 200, { meetings: workstationOf(call).listMeetings(limitOf(call.url, 50, 200)) }),
    ),
    route("GET", "/v1/workstation/meetings/{id}", "viewer", (call) =>
      send(call.res, 200, workstationOf(call).meetingView(call.match[1] as string)),
    ),
    // Les demandes de l'humain au poste (une consigne exécutée par le job `poste-demande`, sans
    // run ni pipeline) et les automatisations : lectures au propriétaire, gestes à l'approbateur.
    route("POST", "/v1/workstation/requests", "operator", async (call) => {
      const workstation = approverOf(call);
      const request = workstation.createRequest(await readBody(call.req), call.actor);
      send(call.res, 201, { request });
      void orchestrator.tick();
    }),
    route("GET", "/v1/workstation/requests", "viewer", (call) => {
      const workstation = workstationOf(call);
      const states = parseRequestStates(call.url.searchParams.get("state"));
      const requests = workstation.listRequests({ states, limit: limitOf(call.url, 50, 200) });
      send(call.res, 200, { requests });
    }),
    route("GET", "/v1/workstation/requests/{id}", "viewer", (call) => {
      const workstation = workstationOf(call);
      send(call.res, 200, workstation.requestView(call.match[1] as string));
    }),
    route("POST", "/v1/workstation/requests/{id}/cancel", "operator", (call) => {
      const request = approverOf(call).cancelRequest(call.match[1] as string, call.actor);
      send(call.res, 200, { request });
      void orchestrator.tick();
    }),
    route("GET", "/v1/workstation/automations", "viewer", (call) =>
      send(call.res, 200, { automations: workstationOf(call).listAutomations() }),
    ),
    route("POST", "/v1/workstation/automations", "operator", async (call) => {
      const workstation = approverOf(call);
      const { automation, created } = workstation.createAutomation(await readBody(call.req), call.actor);
      // Son `schedule` devient une planification liée, déclenchée par le planificateur.
      if (created) orchestrator.schedules.linkAutomation(automation, call.actor);
      send(call.res, created ? 201 : 200, { automation });
    }),
    route("POST", "/v1/workstation/automations/{id}/launch", "operator", (call) => {
      const request = approverOf(call).runAutomation(call.match[1] as string, call.actor);
      send(call.res, 201, { request });
      void orchestrator.tick();
    }),
    route("DELETE", "/v1/workstation/automations/{id}", "operator", (call) => {
      const removed = approverOf(call).deleteAutomation(call.match[1] as string);
      orchestrator.schedules.unlinkAutomation(removed);
      send(call.res, 200, { removed });
    }),
    // La vigie (vigie/) : ses réglages (admin), son battement de cœur et ses incidents (son client pilote).
    route("GET", "/v1/vigie", "viewer", (call) => send(call.res, 200, orchestrator.vigie.view(call.repos, Date.now()))),
    route("PUT", "/v1/vigie", "admin", async (call) =>
      send(call.res, 200, { settings: orchestrator.vigie.updateSettings(await readBody(call.req), call.actor) }),
    ),
    route("POST", "/v1/vigie/heartbeat", "operator", async (call) => {
      pilotOf(call);
      send(call.res, 200, orchestrator.vigie.heartbeat(await readBody(call.req), call.client, Date.now()));
    }),
    route("GET", "/v1/vigie/incidents", "viewer", (call) => {
      const statuses = (call.url.searchParams.get("status") ?? "").split(",").filter((status) => status !== "");
      if (statuses.some((status) => !(VIGIE_STATUSES as readonly string[]).includes(status)))
        throw new HarnessError(400, `status : ${VIGIE_STATUSES.join(" | ")}`);
      send(call.res, 200, {
        incidents: orchestrator.vigie.list(
          { statuses: statuses as VigieStatus[], limit: limitOf(call.url, 100, 1000) },
          call.repos,
        ),
      });
    }),
    route("POST", "/v1/vigie/incidents", "operator", async (call) => {
      pilotOf(call);
      const outcome = await orchestrator.vigie.report(await readBody(call.req), Date.now());
      send(call.res, outcome.known ? 200 : 201, outcome);
    }),
    // La gestion des clients : admin seulement. Le jeton n'est montré qu'à la création.
    route("GET", "/v1/clients", "admin", (call) => send(call.res, 200, { clients: clients.list() })),
    route("POST", "/v1/clients", "admin", async (call) => {
      const body = await readBody(call.req);
      // L'approbateur du poste ne se frappe qu'en ligne de commande sur le serveur.
      if ("approver" in body)
        throw new HarnessError(
          400,
          "approver : un approbateur ne se crée qu'en ligne de commande sur le serveur (harness.sh approver)",
        );
      if (body.pilot !== undefined && typeof body.pilot !== "boolean") throw new HarnessError(400, "pilot : booléen");
      const role = text(body, "role", false) || "operator";
      if (!(ROLES as readonly string[]).includes(role)) throw new HarnessError(400, `role : ${ROLES.join(" | ")}`);
      const repos = body.repos === undefined || body.repos === "*" ? "*" : stringList(body.repos, "repos");
      try {
        const { client, token } = clients.add(
          text(body, "name"),
          role as Role,
          repos ?? "*",
          false,
          body.pilot === true,
        );
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
    // MCP (« Streamable HTTP », réponses JSON) : un message ou un lot JSON-RPC ; sans requête
    // à rendre (notifications seules), 202. Pas de flux serveur : `GET` reste un 405.
    route("POST", "/v1/mcp", "viewer", async (call) => {
      let body: unknown;
      try {
        body = await readJson(call.req);
      } catch (err) {
        if (!(err instanceof HarnessError) || err.status !== 400) throw err;
        send(call.res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON invalide" } });
        return;
      }
      const mcp = {
        client: call.client,
        actor: call.actor,
        desk: orchestrator.issues,
        repos: () => orchestrator.config.repos,
        orchestrator,
        visible: call.repos,
        version: HARNESS_VERSION,
      };
      const replies = await Promise.all(
        (Array.isArray(body) ? body : [body]).map((message) => handleMcp(message, mcp)),
      );
      const answered = replies.filter((reply) => reply !== null);
      if (answered.length === 0) {
        call.res.writeHead(202, { "Cache-Control": "no-store" });
        call.res.end();
        return;
      }
      send(call.res, 200, Array.isArray(body) ? answered : answered[0]);
    }),
  ];
}

/** Le gestionnaire de requêtes (sans serveur) : testable par `http.createServer`. */
export function createHandler(options: HttpOptions): http.RequestListener {
  const { orchestrator } = options;
  const store = orchestrator.store;
  const clients = options.clients ?? new ClientRegistry(null, options.token ?? null);
  const routes = apiRoutes(orchestrator, clients, options.admin ?? null);
  const log: LogLine = options.log ?? ((line: string) => console.error(`[omp-harness] ${line}`));
  const stats = orchestrator.observability.http;
  /** L'étiquette `route` d'une requête : le motif de sa route, jamais l'URL brute (cardinalité bornée). */
  const routeLabel = (pathname: string): string => {
    if (pathname === "/v1/health" || pathname === "/v1/events") return pathname;
    return routes.find((candidate) => candidate.pattern.test(pathname))?.path ?? "inconnue";
  };

  const pingMs = options.pingMs ?? PING_MS;
  const maxBuffer = options.sseMaxBuffer ?? SSE_MAX_BUFFER;

  /**
   * Le flux d'un client. Trois bornes : un client qui ne lit plus est coupé dès que
   * `maxBuffer` octets l'attendent (il reprend par `Last-Event-ID`, rien n'est perdu) ;
   * le jeton est relu à chaque ping (un client révoqué, ou dont les droits ont changé,
   * perd son flux) ; le rejeu va par lots, en rendant la main entre deux et en
   * attendant que le client ait lu.
   */
  async function events(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    token: string,
    client: Client,
  ): Promise<void> {
    const repos = repoFilter(client);
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
    // Les en-têtes partent tout de suite : le client sait son flux ouvert avant le premier événement.
    res.flushHeaders();
    stats.sseClients++;
    // Un `intake_state` sans dépôt (demande pas encore classée sur un dépôt) va aussi à son
    // auteur : la règle de lecture de `GET /v1/intake`, au direct comme au rejeu.
    const authorOf = (event: EventRow): boolean =>
      event.type === "intake_state" &&
      event.repo === null &&
      typeof event.payload.intakeId === "string" &&
      store.getIntake(event.payload.intakeId)?.createdBy === client.name;
    const visible = (event: EventRow): boolean =>
      (runId === null || event.runId === runId) &&
      (auditId === null || event.payload.auditId === auditId) &&
      (repos === null || (event.repo !== null && repos.includes(event.repo)) || authorOf(event));
    let closed = false;
    let ping: NodeJS.Timeout | undefined;
    let unsubscribe = (): void => {};
    /** `cut` : coupé net, ce qui attend un client qui ne lit plus est libéré tout de suite ; sinon une fin propre. */
    const close = (cut: boolean): void => {
      if (closed) return;
      closed = true;
      stats.sseClients--;
      clearInterval(ping);
      unsubscribe();
      if (cut) res.destroy();
      else res.end();
    };
    // Rejeu, puis le direct : l'abonnement est posé AVANT la lecture, le curseur écarte les doublons.
    const pending: EventRow[] = [];
    let replaying = true;
    const push = (frame: string): void => {
      if (closed) return;
      res.write(frame);
      // Le rejeu attend le client (plus bas) ; le direct, lui, n'attend personne : au-delà du plafond, le flux est coupé.
      if (!replaying && res.writableLength > maxBuffer) close(true);
    };
    const write = (event: EventRow): void => {
      if (!visible(event)) return;
      if (event.ephemeral) {
        if (live && !replaying) push(sseFrame(event));
        return;
      }
      if (event.id <= cursor) return;
      cursor = event.id;
      push(sseFrame(event));
    };
    unsubscribe = store.onEvent((event) => (replaying ? pending.push(event) : write(event)));
    req.on("close", () => close(true));
    // Le curseur de lecture avance sur chaque ligne lue, visible ou non : un lot filtré
    // (`audit=`) qui ne garde rien n'est pas relu indéfiniment.
    let read = cursor;
    for (;;) {
      const batch = store.eventsSince(read, runId, REPLAY_BATCH, repos);
      if (batch.length === 0) break;
      for (const event of batch) {
        write(event);
        read = event.id;
        // Un client qui lit lentement : on attend qu'il ait lu ce qui lui est envoyé.
        if (res.writableNeedDrain) await drained(res);
        if (closed) return;
      }
      // Entre deux lots, la main aux autres requêtes.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (closed) return;
    }
    replaying = false;
    pending.filter((event) => !event.ephemeral).forEach(write);
    if (closed) return;
    ping = setInterval(() => {
      // La révocation (ou un changement de dépôts) vaut aussi pour un flux déjà ouvert.
      let still: Client | null = null;
      try {
        still = clients.authenticate(token);
      } catch {
        still = null;
      }
      if (!still || still.name !== client.name || JSON.stringify(repoFilter(still)) !== JSON.stringify(repos)) {
        close(false);
        return;
      }
      push(": ping\n\n");
    }, pingMs);
    ping.unref?.();
  }

  return (req, res) => {
    const started = process.hrtime.bigint();
    res.on("close", () => {
      let pathname = "";
      try {
        pathname = new URL(req.url ?? "/", "http://harness").pathname;
      } catch {
        pathname = "";
      }
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(req.method ?? "")
        ? (req.method as string)
        : "AUTRE";
      stats.record(routeLabel(pathname), method, res.statusCode, Number(process.hrtime.bigint() - started) / 1e9);
    });
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
          // 503 au moindre échec : la sonde du compose (et toute supervision) lit le code ; le corps garde la version.
          const health = healthChecks(orchestrator);
          send(res, health.ok ? 200 : 503, {
            ok: health.ok,
            api: API_VERSION,
            version: options.version ?? HARNESS_VERSION,
            // Le commit construit (null : image ou service lancés sans OMP_HARNESS_COMMIT).
            commit: options.commit === undefined ? HARNESS_COMMIT : options.commit,
            features: API_FEATURES,
            checks: health.checks,
          });
          return;
        }
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const client = clients.authenticate(token);
        if (!client) {
          send(res, 401, { error: "jeton absent ou invalide" });
          return;
        }
        const repos = repoFilter(client);
        if (req.method === "GET" && url.pathname === "/v1/events") {
          await events(req, res, url, token, client);
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
          const actor: Actor = { by: client.name, rev: ifMatch(req), ...(client.pilot ? { pilot: true } : {}) };
          await route.handle({ match, req, res, url, client, repos, actor });
          return;
        }
        send(res, matchedPath ? 405 : 404, { error: matchedPath ? "méthode non permise" : "route inconnue" });
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HarnessError) send(res, err.status, { error: err.message }, err.headers);
        else {
          // Une erreur imprévue peut citer un chemin, une commande ou un secret : elle reste au
          // journal, la réponse n'en porte que la référence.
          const ref = randomBytes(4).toString("hex");
          log(
            `${req.method} ${req.url} : erreur interne ${ref} — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
            { level: "error" },
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
