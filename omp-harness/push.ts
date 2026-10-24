// Les Live Activities de l'app iOS, tenues à jour app fermée : l'app enregistre le
// jeton push de chaque activité qu'elle démarre (`POST /v1/push/activities`), et le
// service lui pousse l'état de la feature par APNs (`config.apns`) — à chaque
// changement d'état ou d'étape tout de suite, l'outil en cours au plus une fois par
// PUSH_TOOL_EVERY_MS (Apple borne le nombre de mises à jour). Une feature terminée
// reçoit `end` (l'activité reste une heure sur l'écran verrouillé), et ses jetons
// partent. Sans `apns`, rien ne part : l'app met son activité à jour elle-même tant
// qu'elle est ouverte.
//
// Le jeton d'authentification APNs est un JWT ES256 signé par la clé `.p8` d'Apple,
// renouvelé toutes les 50 minutes. Un jeton d'activité refusé (410, BadDeviceToken)
// est oublié.
import { createPrivateKey, sign } from "node:crypto";
import * as fs from "node:fs";
import * as http2 from "node:http2";
import type { ApnsConfig } from "./config.ts";
import type { EventRow, RunRow, Store } from "./db.ts";
import { isTerminal } from "./machine.ts";

/** L'intervalle minimal entre deux mises à jour d'une activité pour un simple changement d'outil. */
export const PUSH_TOOL_EVERY_MS = 30_000;
/** La durée de vie d'un JWT APNs avant renouvellement (Apple : moins d'une heure). */
const JWT_TTL_MS = 50 * 60 * 1000;
/** Une activité finie reste sur l'écran verrouillé pendant ce temps. */
const DISMISS_AFTER_SEC = 3600;

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

export type PushDeps = {
  store: Store;
  config: () => ApnsConfig | null;
  /** Ce que montre l'activité d'un run (état, étape, outil, alerte, coût). */
  content: (run: RunRow) => ActivityContent;
  transport?: ApnsTransport;
  log?: (line: string) => void;
  now?: () => number;
  /** La clé `.p8` (tests : sans fichier). */
  readKey?: (file: string) => string;
};

export class ActivityPusher {
  readonly #deps: PushDeps;
  readonly #now: () => number;
  readonly #transport: ApnsTransport;
  readonly #lastToolPush = new Map<string, number>();
  #jwt: { token: string; at: number } | null = null;
  readonly #inFlight = new Set<Promise<void>>();

  constructor(deps: PushDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#transport = deps.transport ?? http2Transport;
  }

  /** L'abonnement au journal : rendu pour pouvoir le défaire. */
  subscribe(): () => void {
    return this.#deps.store.onEvent((event) => this.handle(event));
  }

  /** Attend les envois en cours (arrêt du service, tests). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#inFlight]);
  }

  /** Un événement du journal (ou éphémère) : une mise à jour des activités du run, si elle est due. */
  handle(event: EventRow): void {
    if (event.runId === null || this.#deps.config() === null) return;
    const toolOnly = event.type === "activity";
    if (!toolOnly && !STATE_EVENTS.has(event.type)) return;
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

  async #send(tokens: string[], content: ActivityContent, ended: boolean): Promise<void> {
    const config = this.#deps.config();
    if (!config) return;
    let jwt: string;
    try {
      jwt = this.#authorization(config);
    } catch (err) {
      this.#deps.log?.(`apns : clé illisible (${err instanceof Error ? err.message : String(err)})`);
      return;
    }
    const nowSec = Math.floor(this.#now() / 1000);
    const body = JSON.stringify({
      aps: {
        timestamp: nowSec,
        event: ended ? "end" : "update",
        "content-state": content,
        ...(ended ? { "dismissal-date": nowSec + DISMISS_AFTER_SEC } : { "stale-date": nowSec + 4 * 3600 }),
      },
    });
    const host = config.sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
    for (const token of tokens) {
      const reply = await this.#transport({
        host,
        path: `/3/device/${token}`,
        headers: {
          authorization: `bearer ${jwt}`,
          "apns-topic": `${config.topic}.push-type.liveactivity`,
          "apns-push-type": "liveactivity",
          "apns-priority": ended ? "10" : "5",
          "content-type": "application/json",
        },
        body,
      });
      if (reply.status === 410 || reply.reason === "BadDeviceToken" || reply.reason === "Unregistered" || ended)
        this.#deps.store.deletePushToken(token);
      else if (reply.status !== 200) this.#deps.log?.(`apns : ${reply.status} ${reply.reason ?? ""}`.trim());
    }
  }

  #authorization(config: ApnsConfig): string {
    const now = this.#now();
    if (this.#jwt && now - this.#jwt.at < JWT_TTL_MS) return this.#jwt.token;
    const key = (this.#deps.readKey ?? ((file: string) => fs.readFileSync(file, "utf8")))(config.keyFile);
    this.#jwt = { token: apnsJwt(config, key, Math.floor(now / 1000)), at: now };
    return this.#jwt.token;
  }
}
