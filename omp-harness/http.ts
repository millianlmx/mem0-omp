// L'API du service : REST + SSE, l'UNIQUE point d'entrée des clients (macOS, iOS, web).
//
// Écoute en local (127.0.0.1) ; Tailscale ou un reverse proxy TLS la publie. Chaque
// requête porte `Authorization: Bearer <jeton>`, comparé en temps constant. Le flux
// `GET /v1/events` rejoue le journal depuis `Last-Event-ID` : un client qui se
// reconnecte ne perd aucun événement.
import { timingSafeEqual } from "node:crypto";
import * as http from "node:http";
import type { RunState } from "./machine.ts";
import type { EventRow } from "./db.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { HarnessError } from "./orchestrator.ts";


export const API_VERSION = 1;

const MAX_BODY = 1024 * 1024;
const PING_MS = 15_000;


function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}


function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(json), "Cache-Control": "no-store" });
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
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new HarnessError(400, "un objet JSON est attendu");
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
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new HarnessError(400, `${key} : liste de chaînes attendue`);
  return value as string[];
}


function sseFrame(event: EventRow): string {
  return `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}


export type HttpOptions = { orchestrator: Orchestrator; token: string; version?: string };


/** Le gestionnaire de requêtes (sans serveur) : testable par `http.createServer`. */
export function createHandler(options: HttpOptions): http.RequestListener {
  const { orchestrator, token } = options;
  const store = orchestrator.store;

  const routes: { method: string; pattern: RegExp; handle: (match: RegExpExecArray, req: http.IncomingMessage, res: http.ServerResponse, url: URL) => Promise<void> | void }[] = [
    {
      method: "GET",
      pattern: /^\/v1\/status$/,
      handle: async (_m, _req, res) => send(res, 200, { ...orchestrator.status(), oracle: await orchestrator.oracleStatus() }),
    },
    {
      method: "GET",
      pattern: /^\/v1\/runs$/,
      handle: (_m, _req, res, url) => {
        const state = url.searchParams.get("state");
        const repo = url.searchParams.get("repo");
        const runs = store.listRuns({ ...(state ? { state: state.split(",") as RunState[] } : {}), ...(repo ? { repo } : {}) });
        send(res, 200, { runs });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/runs$/,
      handle: async (_m, req, res) => {
        const body = await readBody(req);
        const modules = stringList(body.modules, "modules");
        const slug = text(body, "slug", false);
        const run = orchestrator.createRun({
          repo: text(body, "repo"),
          title: text(body, "title"),
          request: text(body, "request"),
          ...(slug ? { slug } : {}),
          ...(modules ? { modules } : {}),
        });
        send(res, 201, { run });
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/runs\/([\w-]+)$/,
      handle: (m, _req, res) => send(res, 200, orchestrator.runView(m[1] as string)),
    },
    {
      method: "POST",
      pattern: /^\/v1\/runs\/([\w-]+)\/cancel$/,
      handle: async (m, _req, res) => send(res, 200, { run: await orchestrator.cancel(m[1] as string) }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/runs\/([\w-]+)\/escalations$/,
      handle: async (m, req, res) => {
        const body = await readBody(req);
        if (!Array.isArray(body.answers)) throw new HarnessError(400, "answers : liste de { id, answer } attendue");
        const answers = body.answers.map(item => {
          const record = (item ?? {}) as Record<string, unknown>;
          if (typeof record.id !== "number" || typeof record.answer !== "string") throw new HarnessError(400, "answers : { id: nombre, answer: chaîne }");
          return { id: record.id, answer: record.answer };
        });
        send(res, 200, { run: await orchestrator.answerEscalations(m[1] as string, answers) });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/runs\/([\w-]+)\/decisions\/(\d+)\/accept$/,
      handle: (m, _req, res) => send(res, 200, { decision: orchestrator.acceptDecision(m[1] as string, Number(m[2])) }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/runs\/([\w-]+)\/decisions\/(\d+)\/reverse$/,
      handle: async (m, req, res) => {
        const body = await readBody(req);
        send(res, 200, { run: await orchestrator.reverseDecision(m[1] as string, Number(m[2]), text(body, "option"), text(body, "reason")) });
      },
    },
    {
      method: "POST",
      pattern: /^\/v1\/runs\/([\w-]+)\/validate$/,
      handle: async (m, req, res) => {
        const body = await readBody(req);
        if (typeof body.approve !== "boolean") throw new HarnessError(400, "approve : booléen attendu");
        send(res, 200, { run: await orchestrator.validate(m[1] as string, body.approve, text(body, "reason", false)) });
      },
    },
    {
      // Les escalades ouvertes, BATCHÉES par run : l'écran iOS les traite d'un geste.
      method: "GET",
      pattern: /^\/v1\/escalations$/,
      handle: (_m, _req, res, url) => {
        const status = url.searchParams.get("status") === "answered" ? "answered" : "open";
        const byRun = new Map<string, unknown[]>();
        for (const item of store.listEscalations({ status })) byRun.set(item.runId, [...(byRun.get(item.runId) ?? []), item]);
        send(res, 200, { batches: [...byRun].map(([runId, items]) => ({ run: store.getRun(runId), items })) });
      },
    },
    {
      // La relecture du matin : les décisions prises seules, pas encore relues.
      method: "GET",
      pattern: /^\/v1\/decisions$/,
      handle: (_m, _req, res, url) => {
        const status = (url.searchParams.get("status") ?? "auto").split(",") as ("auto" | "accepted" | "reversed" | "superseded")[];
        send(res, 200, { decisions: store.listDecisions({ status }) });
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/projects$/,
      handle: (_m, _req, res) => send(res, 200, { projects: store.listProjects() }),
    },
    {
      method: "POST",
      pattern: /^\/v1\/projects$/,
      handle: async (_m, req, res) => {
        const body = await readBody(req);
        if (!Array.isArray(body.features)) throw new HarnessError(400, "features : liste attendue");
        const features = body.features.map(item => {
          const record = (item ?? {}) as Record<string, unknown>;
          const modules = stringList(record.modules, "features[].modules");
          const slug = text(record, "slug", false);
          return { title: text(record, "title"), request: text(record, "request"), ...(slug ? { slug } : {}), ...(modules ? { modules } : {}) };
        });
        send(res, 201, await orchestrator.createProject({ repo: text(body, "repo"), title: text(body, "title"), features }));
      },
    },
    {
      method: "GET",
      pattern: /^\/v1\/projects\/([\w-]+)$/,
      handle: (m, _req, res) => {
        const project = store.getProject(m[1] as string);
        if (!project) throw new HarnessError(404, `projet inconnu : ${m[1]}`);
        send(res, 200, { project, runs: store.listRuns({ projectId: project.id }) });
      },
    },
  ];

  function events(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
    const runId = url.searchParams.get("run");
    const header = req.headers["last-event-id"];
    let cursor = Number((typeof header === "string" ? header : null) ?? url.searchParams.get("after") ?? "0") || 0;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    // Rejeu, puis le direct : l'abonnement est posé AVANT la lecture, le curseur écarte les doublons.
    const pending: EventRow[] = [];
    let replaying = true;
    const write = (event: EventRow): void => {
      if (event.id <= cursor || (runId !== null && event.runId !== runId)) return;
      cursor = event.id;
      res.write(sseFrame(event));
    };
    const unsubscribe = store.onEvent(event => (replaying ? pending.push(event) : write(event)));
    for (let batch = store.eventsSince(cursor, runId); batch.length > 0; batch = store.eventsSince(cursor, runId)) batch.forEach(write);
    replaying = false;
    pending.forEach(write);
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
          send(res, 200, { ok: true, api: API_VERSION, version: options.version ?? null });
          return;
        }
        const auth = req.headers.authorization ?? "";
        const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        if (!sameToken(given, token)) {
          send(res, 401, { error: "jeton absent ou invalide" });
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/events") {
          events(req, res, url);
          return;
        }
        let matchedPath = false;
        for (const route of routes) {
          const match = route.pattern.exec(url.pathname);
          if (!match) continue;
          matchedPath = true;
          if (route.method !== req.method) continue;
          await route.handle(match, req, res, url);
          return;
        }
        send(res, matchedPath ? 405 : 404, { error: matchedPath ? "méthode non permise" : "route inconnue" });
      } catch (err) {
        if (res.headersSent) {
          res.end();
          return;
        }
        if (err instanceof HarnessError) send(res, err.status, { error: err.message });
        else send(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })().catch(() => {
      if (!res.headersSent) send(res, 500, { error: "erreur interne" });
      else res.end();
    });
  };
}
