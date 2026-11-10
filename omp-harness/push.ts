// Les Live Activities de l'app iOS, tenues à jour app fermée : l'app enregistre le
// jeton push de chaque activité qu'elle démarre (`POST /v1/push/activities`), et le
// service lui pousse l'état de la feature par APNs (`config.apns`) — à chaque
// changement d'état ou d'étape tout de suite, l'outil en cours au plus une fois par
// PUSH_TOOL_EVERY_MS (Apple borne le nombre de mises à jour). Une feature terminée
// reçoit `end` (l'activité reste une heure sur l'écran verrouillé), et ses jetons
// partent. Sans `apns`, rien ne part : l'app met son activité à jour elle-même tant
// qu'elle est ouverte.
//
// Le serveur démarre aussi l'activité lui-même (push-to-start) : chaque appareil enregistre son
// jeton de démarrage au nom de son client (`POST /v1/push/activities/start`), et quand un run que
// ce client voit se met au travail pour la première fois, ou attend l'humain (`awaiting_human`,
// `escalated`), APNs reçoit `event: start` avec les attributs de l'activité (`runId`, `title`,
// `repo`) et le même `content-state` que les mises à jour — jamais si une activité est déjà
// enregistrée pour ce run et ce client, une seule fois par run et par client
// (PUSH_START_MEMORY_MS), PUSH_START_MAX_PER_HOUR par client et par heure. Les droits du client
// sont relus à chaque démarrage ; le jeton d'un client révoqué est oublié.
//
// Le jeton d'authentification APNs est un JWT ES256 signé par la clé `.p8` d'Apple,
// renouvelé toutes les 50 minutes, partagé avec les alertes des appareils (`ApnsClient`,
// push-alerts.ts). Un jeton refusé (410, BadDeviceToken) est oublié.
import { createPrivateKey, sign } from "node:crypto";
import * as fs from "node:fs";
import * as http2 from "node:http2";
import type { Client } from "./auth.ts";
import { canSeeRepo } from "./auth.ts";
import type { ApnsConfig } from "./config.ts";
import type { EventRow, PushStartTokenRow, RunRow, Store } from "./db.ts";
import type { LogLine } from "./logger.ts";
import { isTerminal } from "./machine.ts";

/** L'intervalle minimal entre deux mises à jour d'une activité pour un simple changement d'outil. */
export const PUSH_TOOL_EVERY_MS = 30_000;
/** La durée de vie d'un JWT APNs avant renouvellement (Apple : moins d'une heure). */
const JWT_TTL_MS = 50 * 60 * 1000;
/** Une activité finie reste sur l'écran verrouillé pendant ce temps. */
const DISMISS_AFTER_SEC = 3600;
/** Le serveur démarre au plus tant de Live Activities par client et par heure. */
export const PUSH_START_MAX_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;
/** Un run ne démarre qu'une activité par client pendant ce temps. */
export const PUSH_START_MEMORY_MS = 12 * HOUR_MS;
/** Au-delà de ce nombre de démarrages retenus, les expirés sont oubliés. */
const START_PRUNE_AT = 512;
/** Le type des attributs de l'activité côté iOS (`OMPRunActivityAttributes`, HarnessLiveActivity.swift). */
export const ACTIVITY_ATTRIBUTES_TYPE = "OMPRunActivityAttributes";
/** Les états d'un run qui démarrent une activité : il se met au travail, ou il attend l'humain. */
const START_STATES: ReadonlySet<string> = new Set(["running", "awaiting_human", "escalated"]);

/** Les événements qui changent ce que montre une activité. */
const STATE_EVENTS: ReadonlySet<string> = new Set([
  "run_state",
  "step_started",
  "escalations",
  "specs_ready",
  "verdict",
  "merged",
  "run_failed",
  "stalled",
  "budget_exceeded",
  "alert_cleared",
]);

/** L'état que montre une Live Activity : la forme exacte de `OMPRunActivityAttributes.ContentState` côté iOS. */
export type ActivityContent = {
  state: string;
  step: string | null;
  tool: string | null;
  /** Une alerte en cours (`stalled`, `budget_exceeded`…), sinon `null`. */
  alert: string | null;
  cost: number;
  updatedAt: number;
};

/** Le registre des clients de l'API (auth.ts) : les droits y sont relus à chaque envoi. */
export type ClientList = { list(): Client[] };

export type ApnsReply = { status: number; reason: string | null };

/** L'envoi d'une requête à APNs ; doublé en test. */
export type ApnsTransport = (request: {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}) => Promise<ApnsReply>;

/** Le JWT ES256 d'APNs (`kid` = keyId, `iss` = teamId), signé par la clé `.p8`. */
export function apnsJwt(config: Pick<ApnsConfig, "keyId" | "teamId">, keyPem: string, nowSec: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: nowSec })}`;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key: createPrivateKey(keyPem),
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${signature.toString("base64url")}`;
}

/** Le transport de production : une session HTTP/2 par envoi, bornée à 10 s. */
export const http2Transport: ApnsTransport = (request) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (reply: ApnsReply) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(reply);
    };
    const client = http2.connect(`https://${request.host}`);
    client.on("error", (error) => done({ status: 0, reason: error.message }));
    const stream = client.request({ ":method": "POST", ":path": request.path, ...request.headers });
    stream.setTimeout(10_000, () => {
      stream.close();
      done({ status: 0, reason: "délai dépassé" });
    });
    let status = 0;
    let body = "";
    stream.on("response", (headers) => {
      status = Number(headers[":status"] ?? 0);
    });
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      body += chunk;
    });
    stream.on("end", () => {
      let reason: string | null = null;
      try {
        reason = body ? ((JSON.parse(body) as { reason?: string }).reason ?? null) : null;
      } catch {
        reason = null;
      }
      done({ status, reason });
    });
    stream.on("error", (error) => done({ status: 0, reason: error.message }));
    stream.end(request.body);
  });

/** Ce qu'il faut pour parler à APNs ; `transport`, `readKey` et `now` sont doublés en test. */
export type ApnsDeps = {
  config: () => ApnsConfig | null;
  transport?: ApnsTransport;
  log?: LogLine;
  now?: () => number;
  /** La clé `.p8` (tests : sans fichier). */
  readKey?: (file: string) => string;
};

/** Un envoi à un jeton, sur la passerelle de développement (`sandbox`) ou de production. */
export type ApnsSend = (request: {
  token: string;
  sandbox: boolean;
  headers: Record<string, string>;
  body: string;
}) => Promise<ApnsReply>;

/** Le jeton est mort pour Apple (app désinstallée, jeton d'une autre passerelle) : on l'oublie. */
export function tokenGone(reply: ApnsReply): boolean {
  return reply.status === 410 || reply.reason === "BadDeviceToken" || reply.reason === "Unregistered";
}

/**
 * Le client APNs du service, partagé par les Live Activities et les alertes : UN JWT
 * (Apple refuse qu'on le renouvelle trop souvent), renouvelé toutes les 50 minutes.
 */
export class ApnsClient {
  readonly #deps: ApnsDeps;
  readonly #now: () => number;
  readonly #transport: ApnsTransport;
  #jwt: { token: string; at: number } | null = null;

  constructor(deps: ApnsDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#transport = deps.transport ?? http2Transport;
  }

  get configured(): boolean {
    return this.#deps.config() !== null;
  }

  /** L'envoyeur du moment, ou `null` : APNs non configuré, ou clé illisible (journalisé). */
  sender(): ApnsSend | null {
    const config = this.#deps.config();
    if (!config) return null;
    let jwt: string;
    try {
      jwt = this.#authorization(config);
    } catch (err) {
      this.#deps.log?.(`apns : clé illisible (${err instanceof Error ? err.message : String(err)})`, {
        level: "error",
      });
      return null;
    }
    return (request) =>
      this.#transport({
        host: request.sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com",
        path: `/3/device/${request.token}`,
        headers: { authorization: `bearer ${jwt}`, ...request.headers },
        body: request.body,
      });
  }

  #authorization(config: ApnsConfig): string {
    const now = this.#now();
    if (this.#jwt && now - this.#jwt.at < JWT_TTL_MS) return this.#jwt.token;
    const key = (this.#deps.readKey ?? ((file: string) => fs.readFileSync(file, "utf8")))(config.keyFile);
    this.#jwt = { token: apnsJwt(config, key, Math.floor(now / 1000)), at: now };
    return this.#jwt.token;
  }
}

export type PushDeps = ApnsDeps & {
  store: Store;
  /** Ce que montre l'activité d'un run (état, étape, outil, alerte, coût). */
  content: (run: RunRow) => ActivityContent;
  /** Le client APNs partagé du service ; à défaut, un client propre bâti sur ces dépendances. */
  apns?: ApnsClient;
  /** Le registre des clients, ou `null` tant qu'il n'est pas donné : sans lui, le serveur ne démarre aucune activité (échec fermé). */
  clients?: () => ClientList | null;
};

export class ActivityPusher {
  readonly #deps: PushDeps;
  readonly #now: () => number;
  readonly #apns: ApnsClient;
  readonly #lastToolPush = new Map<string, number>();
  readonly #inFlight = new Set<Promise<void>>();
  /** « client\nrun » → instant du démarrage de l'activité par le serveur. */
  readonly #started = new Map<string, number>();

  constructor(deps: PushDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#apns = deps.apns ?? new ApnsClient(deps);
  }

  /** L'abonnement au journal : rendu pour pouvoir le défaire. */
  subscribe(): () => void {
    return this.#deps.store.onEvent((event) => this.handle(event));
  }

  /** Attend les envois en cours (arrêt du service, tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  /**
   * Un événement du journal (ou éphémère) : le démarrage d'une activité sur les appareils qui n'en ont
   * pas pour ce run, puis une mise à jour des activités du run, si elle est due.
   */
  handle(event: EventRow): void {
    if (event.runId === null || this.#deps.config() === null) return;
    const toolOnly = event.type === "activity";
    if (!toolOnly && !STATE_EVENTS.has(event.type)) return;
    if (event.type === "run_state") this.#start(event, event.runId);
    const tokens = this.#deps.store.listPushTokens({ kind: "activity", runId: event.runId });
    if (tokens.length === 0) return;
    if (toolOnly) {
      const last = this.#lastToolPush.get(event.runId) ?? 0;
      if (this.#now() - last < PUSH_TOOL_EVERY_MS) return;
    }
    this.#lastToolPush.set(event.runId, this.#now());
    const run = this.#deps.store.getRun(event.runId);
    if (!run) return;
    const content = this.#deps.content(run);
    if (toolOnly && typeof event.payload.tool === "string") content.tool = event.payload.tool;
    const ended = isTerminal(run.state);
    const send = this.#send(
      tokens.map((token) => token.token),
      content,
      ended,
    ).finally(() => this.#inFlight.delete(send));
    this.#inFlight.add(send);
    if (ended) this.#lastToolPush.delete(event.runId);
  }

  /**
   * Un run qui se met au travail pour la première fois, ou qui attend l'humain : une activité démarre
   * sur les appareils des clients qui le voient et n'en ont pas déjà une pour lui.
   */
  #start(event: EventRow, runId: string): void {
    const state = event.payload.state;
    if (typeof state !== "string" || !START_STATES.has(state)) return;
    const clients = this.#deps.clients?.() ?? null;
    if (clients === null) return;
    const { store } = this.#deps;
    const tokens = store.listPushStartTokens();
    if (tokens.length === 0) return;
    const run = store.getRun(runId);
    const send = this.#apns.sender();
    if (!run || send === null) return;
    // Une reprise (réponse donnée, relance) n'est pas un démarrage : le journal dit si le run a déjà travaillé.
    if (
      state === "running" &&
      store
        .eventsSince(0, runId)
        .some((earlier) => earlier.id < event.id && earlier.type === "run_state" && earlier.payload.state === "running")
    )
      return;
    const known = new Map(clients.list().map((client) => [client.name, client]));
    const served = new Set(store.listPushTokens({ kind: "activity", runId }).map((token) => token.client));
    const now = this.#now();
    const due = new Map<string, boolean>();
    const targets: PushStartTokenRow[] = [];
    for (const token of tokens) {
      const client = known.get(token.client);
      if (!client) {
        store.deletePushStartToken(token.token);
        continue;
      }
      if (!canSeeRepo(client, run.repo) || served.has(client.name)) continue;
      const admitted = due.get(client.name) ?? this.#admitStart(client.name, runId, now);
      due.set(client.name, admitted);
      if (admitted) targets.push(token);
    }
    if (targets.length === 0) return;
    const sending = this.#sendStart(send, run, targets).finally(() => this.#inFlight.delete(sending));
    this.#inFlight.add(sending);
  }

  /** Ce client reçoit-il un démarrage pour ce run ? Une fois par run, PUSH_START_MAX_PER_HOUR par heure ; un oui est retenu. */
  #admitStart(client: string, runId: string, now: number): boolean {
    const key = `${client}\n${runId}`;
    const last = this.#started.get(key);
    if (last !== undefined && now - last < PUSH_START_MEMORY_MS) return false;
    if (this.#started.size >= START_PRUNE_AT)
      for (const [known, at] of this.#started) if (now - at >= PUSH_START_MEMORY_MS) this.#started.delete(known);
    let recent = 0;
    for (const [known, at] of this.#started) if (now - at < HOUR_MS && known.startsWith(`${client}\n`)) recent += 1;
    if (recent >= PUSH_START_MAX_PER_HOUR) return false;
    this.#started.set(key, now);
    return true;
  }

  async #sendStart(send: ApnsSend, run: RunRow, targets: PushStartTokenRow[]): Promise<void> {
    const config = this.#deps.config();
    if (!config) return;
    const nowSec = Math.floor(this.#now() / 1000);
    const body = JSON.stringify({
      aps: {
        timestamp: nowSec,
        event: "start",
        "content-state": this.#deps.content(run),
        "attributes-type": ACTIVITY_ATTRIBUTES_TYPE,
        attributes: { runId: run.id, title: run.title, repo: run.repo },
        // Apple exige une alerte avec un démarrage ; sans `sound`, elle ne sonne pas (l'alerte push s'en charge).
        alert: { title: run.title, body: run.repo },
        "stale-date": nowSec + 4 * 3600,
        // L'activité démarrée reçoit son jeton de mise à jour, que l'app enregistre (`POST /v1/push/activities`).
        "input-push-token": 1,
      },
    });
    for (const target of targets) {
      const reply = await send({
        token: target.token,
        // La passerelle du jeton, pas celle de la configuration : une app installée depuis Xcode est en `development`.
        sandbox: target.environment === "development",
        headers: {
          "apns-topic": `${config.topic}.push-type.liveactivity`,
          "apns-push-type": "liveactivity",
          "apns-priority": "10",
          "content-type": "application/json",
        },
        body,
      });
      if (tokenGone(reply)) this.#deps.store.deletePushStartToken(target.token);
      else if (reply.status !== 200)
        this.#deps.log?.(`apns (démarrage) : ${reply.status} ${reply.reason ?? ""}`.trim(), { level: "warn" });
    }
  }

  async #send(tokens: string[], content: ActivityContent, ended: boolean): Promise<void> {
    const config = this.#deps.config();
    const send = this.#apns.sender();
    if (!config || !send) return;
    const nowSec = Math.floor(this.#now() / 1000);
    const body = JSON.stringify({
      aps: {
        timestamp: nowSec,
        event: ended ? "end" : "update",
        "content-state": content,
        ...(ended ? { "dismissal-date": nowSec + DISMISS_AFTER_SEC } : { "stale-date": nowSec + 4 * 3600 }),
      },
    });
    for (const token of tokens) {
      const reply = await send({
        token,
        sandbox: config.sandbox,
        headers: {
          "apns-topic": `${config.topic}.push-type.liveactivity`,
          "apns-push-type": "liveactivity",
          "apns-priority": ended ? "10" : "5",
          "content-type": "application/json",
        },
        body,
      });
      if (tokenGone(reply) || ended) this.#deps.store.deletePushToken(token);
      else if (reply.status !== 200)
        this.#deps.log?.(`apns : ${reply.status} ${reply.reason ?? ""}`.trim(), { level: "warn" });
    }
  }
}
