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
import { statfsSync } from "node:fs";
import * as path from "node:path";
import type * as http from "node:http";
import type { Client } from "./auth.ts";
import { ClientRegistry, allows, repoFilter } from "./auth.ts";
import type { Actor } from "../runs/context.ts";
import type { EventRow, RepoFilter, Space } from "../db/db.ts";
import { HarnessError } from "./errors.ts";
import { text } from "./input.ts";
import type { Orchestrator } from "../runs/orchestrator.ts";
import type { ConfigAdmin } from "../config/repos.ts";
import { HARNESS_COMMIT } from "../operations/build-info.ts";
import type { LogLine } from "../operations/logger.ts";
import { PairingDesk } from "./pairing.ts";
import { INVALID_LINK } from "../atlassian/desk.ts";
import { isLocalSessionEvent } from "../sessions/local-sessions.ts";
import { HARNESS_VERSION, readBody, send } from "./http-io.ts";
import { apiRoutes } from "./route-table.ts";

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
  "atlassian",
  "local-sessions",
  "push-answer",
  "push-start",
  "intake-context",
  "os-loop",
  "os-autonomy",
  "pause",
  "spaces",
  "brief",
  "scoreboard",
  "proposals",
  "idempotency",
  "schedule-payload",
  "pairing-ticket",
  "space-scope",
  "space-knowledge",
  "space-policy",
  "space-workstation",
  "run-facts",
  "repo-settings",
  "pulse",
  "events-latest",
] as const;

/** La route publique qui échange un ticket d'appairage contre le jeton d'un appareil. */
const REDEEM_PATH = "/v1/pair/redeem";

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

/** La longueur gardée du texte d'un paragraphe envoyé au pouls (`pulse=1`) : le pouls n'en montre qu'une ligne. */
export const PULSE_TEXT = 600;

/**
 * La trame d'un événement pour le pouls (`pulse=1`), ou `null` : une `activity`, telle quelle ; un `session` qui est un
 * paragraphe de l'agent (`kind: text`), réduit à `{seq, at, step, kind, text}` et son texte rogné ; rien d'autre.
 */
export function pulseFrame(event: EventRow): string | null {
  if (!event.ephemeral) return null;
  if (event.type === "activity") return sseFrame(event);
  if (event.type !== "session") return null;
  const entry = event.payload.entry as { seq?: unknown; at?: unknown; step?: unknown; kind?: unknown; text?: unknown };
  if (entry?.kind !== "text" || typeof entry.text !== "string") return null;
  const { entry: _full, ...rest } = event.payload;
  const slim = {
    seq: entry.seq,
    at: entry.at,
    step: entry.step ?? null,
    kind: "text",
    text: entry.text.slice(0, PULSE_TEXT),
  };
  return sseFrame({ ...event, payload: { ...rest, entry: slim } });
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

/**
 * La page du retour de consentement : 200 branché, 400 lien invalide ou expiré, 502 refus d'Atlassian.
 * Aucun paramètre de la requête n'y figure, ni au journal (le code et le state sont des secrets).
 */
async function atlassianCallback(
  orchestrator: Orchestrator,
  url: URL,
  res: http.ServerResponse,
  log: LogLine,
): Promise<void> {
  let status = 200;
  let message = "Atlassian est branché, tu peux fermer cet onglet.";
  try {
    // Le `state` porte l'espace : la connexion par défaut rend le retour à celle qui a demandé ce consentement.
    await orchestrator.atlassian.complete({ code: url.searchParams.get("code"), state: url.searchParams.get("state") });
  } catch (error) {
    status = error instanceof HarnessError && error.status === 400 ? 400 : 502;
    message =
      status === 400 ? INVALID_LINK : "Atlassian a refusé la connexion : relance-la depuis l'app (Poste › Atlassian).";
    if (status !== 400)
      log(`retour Atlassian : ${error instanceof Error ? error.message : String(error)}`, { level: "warn" });
  }
  const html = `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><title>Atlassian</title></head><body><p>${message}</p></body></html>\n`;
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'",
    "Referrer-Policy": "no-referrer",
  });
  res.end(html);
}

/** Le gestionnaire de requêtes (sans serveur) : testable par `http.createServer`. */
export function createHandler(options: HttpOptions): http.RequestListener {
  const { orchestrator } = options;
  const store = orchestrator.store;
  const clients = options.clients ?? new ClientRegistry(null, options.token ?? null);
  // Un client borné à des espaces voit leurs dépôts du moment : relus ici à chaque lecture du registre.
  clients.useSpaces((ids) => orchestrator.spaces.reposOf(ids));
  const pairing = new PairingDesk(clients);
  const routes = apiRoutes(orchestrator, clients, options.admin ?? null, pairing);
  const log: LogLine = options.log ?? ((line: string) => console.error(`[omp-harness] ${line}`));
  const stats = orchestrator.observability.http;
  /** L'étiquette `route` d'une requête : le motif de sa route, jamais l'URL brute (cardinalité bornée). */
  const routeLabel = (pathname: string): string => {
    if (pathname === "/v1/health" || pathname === "/v1/events" || pathname === REDEEM_PATH) return pathname;
    return routes.find((candidate) => candidate.pattern.test(pathname))?.path ?? "inconnue";
  };

  /**
   * La portée d'une requête : les dépôts du client, croisés avec ceux de l'espace de `?space=<id|nom>`
   * quand il est donné (`resolve` rend l'espace déjà réduit aux dépôts du client ; 404 s'il est inconnu ou
   * si le client n'y voit aucun dépôt). Sans le paramètre : la portée du client, comme avant les espaces.
   */
  const scopeOf = (client: Client, url: URL): { repos: RepoFilter; space: Space | null } => {
    const wanted = url.searchParams.get("space");
    if (wanted === null) return { repos: repoFilter(client), space: null };
    const space = orchestrator.spaces.resolve(wanted, repoFilter(client));
    return { repos: space.repos, space };
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
    scope: { repos: RepoFilter; space: Space | null },
  ): Promise<void> {
    const { repos, space } = scope;
    /** Le client voit tous les dépôts : ce qui n'a pas de dépôt lui revient (dans un espace : ce qui est de l'espace). */
    const whole = client.repos === "*";
    const runId = url.searchParams.get("run");
    const auditId = url.searchParams.get("audit");
    // Le pouls des apps (`pulse=1`) : l'activité éphémère des agents seulement — ni rejeu du journal, ni événement
    // journalisé, et un `session` réduit à un paragraphe de l'agent, rogné. Le pouls n'en lit pas plus.
    const pulse = url.searchParams.get("pulse") === "1";
    const live = pulse || url.searchParams.get("live") === "1";
    const header = req.headers["last-event-id"];
    // `after=latest` : à partir du dernier événement écrit, sans rien rejouer — un client qui ne connaît pas encore
    // son curseur (sa boîte pas encore lue) ne télécharge pas tout le journal pour l'ignorer.
    const after = url.searchParams.get("after");
    let cursor =
      typeof header === "string"
        ? Number(header) || 0
        : after === "latest"
          ? store.lastEventId()
          : Number(after ?? "0") || 0;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    // Les en-têtes partent tout de suite, suivis d'un commentaire : un relais qui retient les en-têtes
    // jusqu'au premier octet du corps les rend aussi, et le client sait son flux ouvert avant le premier événement.
    res.flushHeaders();
    res.write(": ok\n\n");
    stats.sseClients++;
    // Un `intake_state` sans dépôt (demande pas encore classée sur un dépôt) va aussi à son
    // auteur : la règle de lecture de `GET /v1/intake`, au direct comme au rejeu. Dans un espace
    // (`?space=`), seulement si la demande est de cet espace.
    const authorOf = (event: EventRow): boolean => {
      if (event.type !== "intake_state" || event.repo !== null || typeof event.payload.intakeId !== "string")
        return false;
      const intake = store.getIntake(event.payload.intakeId);
      if (!intake || (space !== null && intake.spaceId !== space.id)) return false;
      return whole || intake.createdBy === client.name;
    };
    // Dans un espace, ce qui n'a pas de dépôt mais parle de LUI (sa pause, ses changements) reste au propriétaire.
    const ofSpace = (event: EventRow): boolean =>
      space !== null &&
      whole &&
      event.repo === null &&
      ((event.type === "pause" && event.payload.space === space.id) ||
        (event.type === "space" && event.payload.id === space.id));
    // Les événements d'une session locale (son état, l'intention de ses outils) sont au propriétaire :
    // sans dépôt, ils échappent déjà aux clients restreints ; un client pilote ne les reçoit pas non plus.
    const visible = (event: EventRow): boolean =>
      (runId === null || event.runId === runId) &&
      (auditId === null || event.payload.auditId === auditId) &&
      (repos === null || (event.repo !== null && repos.includes(event.repo)) || authorOf(event) || ofSpace(event)) &&
      !(client.pilot && isLocalSessionEvent(event));
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
      if (pulse) {
        const frame = pulseFrame(event);
        if (frame !== null && !replaying) push(frame);
        return;
      }
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
      if (pulse) break;
      // Le propriétaire qui suit un espace relit tout le journal : `visible` y garde aussi la pause et les
      // changements de l'espace, que le filtre SQL par dépôt écarterait.
      const batch = store.eventsSince(read, runId, REPLAY_BATCH, whole && space !== null ? null : repos);
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
      // La révocation (ou un changement de dépôts, du client comme de l'espace suivi) vaut aussi pour un flux déjà ouvert.
      let still: Client | null = null;
      let now: { repos: RepoFilter; space: Space | null } | null = null;
      try {
        still = clients.authenticate(token);
        now = still ? scopeOf(still, url) : null;
      } catch {
        still = null;
      }
      if (
        !still ||
        !now ||
        still.name !== client.name ||
        JSON.stringify(now.repos) !== JSON.stringify(repos) ||
        (now.space?.id ?? null) !== (space?.id ?? null)
      ) {
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
        // L'échange d'un ticket d'appairage : public (l'appareil n'a pas encore de jeton), le ticket EST le secret.
        if (req.method === "POST" && url.pathname === REDEEM_PATH) {
          const redeemed = pairing.redeem(text(await readBody(req), "ticket"));
          log(
            `appairage : ${redeemed.client.name} appairé par ticket${redeemed.client.approver ? " (approbateur)" : ""}`,
          );
          send(res, 200, redeemed);
          return;
        }
        // Le retour du consentement Atlassian par le navigateur de l'humain : public (il n'a pas de jeton),
        // protégé par le `state` à usage unique ; la page ne cite aucun paramètre.
        if (req.method === "GET" && url.pathname === "/v1/atlassian/callback" && orchestrator.atlassian.enabled()) {
          await atlassianCallback(orchestrator, url, res, log);
          return;
        }
        const auth = req.headers.authorization ?? "";
        const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
        const client = clients.authenticate(token);
        if (!client) {
          send(res, 401, { error: "jeton absent ou invalide" });
          return;
        }
        // `?space=` est résolu ICI, une fois : toutes les routes lisent `call.repos` déjà borné à l'espace.
        const { repos, space } = scopeOf(client, url);
        if (req.method === "GET" && url.pathname === "/v1/events") {
          await events(req, res, url, token, client, { repos, space });
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
          await route.handle({ match, req, res, url, client, repos, space, actor });
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
