// Le passage de lecture des canaux corpo, côté serveur : toutes les
// `workstation.channelReadEveryMin` minutes, hors pause du poste (arrêt d'urgence compris) et
// poste désactivé, il lit Gmail, l'Agenda et Slack (lecture-google.ts, lecture-slack.ts) par
// `Channels.request` et garde les contenus en base (db/channel-contents.ts). Il n'appelle
// jamais un runner ni un modèle.
//
// Un canal que `Channels.request` refuse (`disconnected`, `reconnect`, `blocked`) n'est pas
// lu ; un canal `error` l'est. Une limite de débit (429, `Retry-After`) suspend la lecture de
// CE canal jusqu'à l'échéance ; ses curseurs n'ayant avancé que sur des pages finies, la
// reprise ne perd ni ne double rien. Le journal ne porte que le canal et un code.
//
// Les routes des canaux Slack suivis passent aussi par ici : la liste des canaux de l'espace
// (lue en direct) et la case « suivi », que la lecture suivante applique.
import type { HarnessConfig } from "../config.ts";
import type { SlackConversationRow, Store } from "../db.ts";
import { HarnessError } from "../errors.ts";
import type { EventType } from "../events.ts";
import type { LogLine } from "../logger.ts";
import type { ChannelId, Channels } from "./channels.ts";
import {
  ChannelApiError,
  ChannelNetworkError,
  ChannelRateLimited,
  ChannelRefused,
  ChannelUnavailable,
} from "./errors.ts";
import { readCalendar, readGmail } from "./lecture-google.ts";
import type { ReadContext, ReadCounts } from "./lecture-google.ts";
import { listConversations, readSlack } from "./lecture-slack.ts";
import type { ListedConversation } from "./lecture-slack.ts";

export type ChannelReaderDeps = {
  config: HarnessConfig;
  store: Store;
  channels: Pick<Channels, "request" | "view">;
  event: (type: EventType, runId: string | null, payload?: Record<string, unknown>, repo?: string | null) => void;
  log: LogLine;
  /** Le poste est activé et n'est pas en pause. */
  active: () => boolean;
  now?: () => number;
};

/** Ce que la lecture d'un canal a donné dans un passage. */
export type ReadOutcome =
  | { channel: ChannelId; status: "read"; added: number; removed: number }
  | { channel: ChannelId; status: "skipped"; reason: "unavailable" | "suspended" }
  | { channel: ChannelId; status: "rate_limited"; until: number }
  | { channel: ChannelId; status: "failed"; code: string };

const CHANNELS: readonly ChannelId[] = ["gmail", "calendar", "slack"];
const READERS: Record<ChannelId, (ctx: ReadContext) => Promise<ReadCounts>> = {
  gmail: readGmail,
  calendar: readCalendar,
  slack: readSlack,
};
/** La fenêtre de la première lecture d'un canal (bornée par `workstation.retentionDays`). */
const FIRST_READ_DAYS = 7;

export class ChannelReader {
  readonly #deps: ChannelReaderDeps;
  readonly #now: () => number;
  /** L'échéance d'une limite de débit, par canal. */
  readonly #suspendedUntil: Record<ChannelId, number> = { gmail: 0, calendar: 0, slack: 0 };
  #lastPassAt: number | null = null;
  #running: Promise<ReadOutcome[]> | null = null;

  constructor(deps: ChannelReaderDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
  }

  /** Un tour de l'orchestrateur : un passage s'il est dû et qu'aucun ne tourne. */
  tick(now = this.#now()): void {
    if (this.#running !== null || !this.#deps.active()) return;
    const every = this.#deps.config.workstation.channelReadEveryMin * 60_000;
    if (this.#lastPassAt !== null && now - this.#lastPassAt < every) return;
    this.#lastPassAt = now;
    void this.pass(now);
  }

  /** Un passage sur les trois canaux (un seul à la fois) ; rend ce que chaque canal a donné. */
  pass(now = this.#now()): Promise<ReadOutcome[]> {
    if (this.#running !== null) return this.#running;
    const running = this.#pass(now).finally(() => {
      this.#running = null;
    });
    this.#running = running;
    return running;
  }

  /** Attend la fin du passage en cours (arrêt du service). */
  async stop(): Promise<void> {
    await this.#running?.catch(() => undefined);
  }

  async #pass(now: number): Promise<ReadOutcome[]> {
    const outcomes: ReadOutcome[] = [];
    const states = new Map(this.#deps.channels.view(false).channels.map((view) => [view.id, view.state]));
    for (const channel of CHANNELS) {
      const state = states.get(channel);
      if (state !== "connected" && state !== "error") {
        outcomes.push({ channel, status: "skipped", reason: "unavailable" });
        continue;
      }
      if (this.#suspendedUntil[channel] > now) {
        outcomes.push({ channel, status: "skipped", reason: "suspended" });
        continue;
      }
      outcomes.push(await this.#read(channel, now));
    }
    return outcomes;
  }

  async #read(channel: ChannelId, now: number): Promise<ReadOutcome> {
    try {
      const counts = await READERS[channel](this.#context());
      if (counts.added + counts.removed > 0)
        this.#deps.event("workstation_channel_read", null, { channel, ...counts }, null);
      return { channel, status: "read", ...counts };
    } catch (err) {
      if (err instanceof ChannelRateLimited) {
        const until = now + err.retryAfterMs;
        this.#suspendedUntil[channel] = until;
        this.#deps.log(`poste : lecture ${channel} suspendue ${Math.ceil(err.retryAfterMs / 1000)} s (429)`);
        return { channel, status: "rate_limited", until };
      }
      const code =
        err instanceof ChannelApiError
          ? err.code
          : err instanceof ChannelNetworkError
            ? err.code
            : err instanceof ChannelUnavailable
              ? err.state
              : err instanceof Error
                ? err.name
                : "inconnu";
      // Un refus de la liste blanche ou une exception imprévue est un défaut du harness ; le reste
      // (coupure, refus du fournisseur, canal devenu indisponible) se lit dans l'état du canal.
      const fault = err instanceof ChannelRefused || !(err instanceof Error && err.name.startsWith("Channel"));
      this.#deps.log(`poste : lecture ${channel} interrompue (${code})`, fault ? { level: "error" } : {});
      return { channel, status: "failed", code };
    }
  }

  #context(): ReadContext {
    return {
      request: (channel, req) => this.#deps.channels.request(channel, req),
      store: this.#deps.store,
      now: this.#now,
      firstReadDays: Math.max(1, Math.min(FIRST_READ_DAYS, Math.floor(this.#deps.config.workstation.retentionDays))),
    };
  }

  // -- canaux Slack suivis ------------------------------------------------------------------

  /** Les canaux publics et privés de l'espace, relus en direct, avec la case « suivi » de chacun. */
  async slackConversations(): Promise<{ conversations: SlackConversationRow[] }> {
    let listed: ListedConversation[];
    try {
      listed = await listConversations(this.#context(), "public_channel,private_channel");
    } catch (err) {
      throw httpError(err);
    }
    this.#deps.store.putSlackConversations(
      listed.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind === "group" ? "private" : "public",
        archived: c.archived,
      })),
      this.#now(),
    );
    return { conversations: this.#deps.store.listSlackConversations() };
  }

  /** Coche ou décoche un canal suivi (`{followed}`) : la lecture suivante l'inclut ou l'exclut. */
  followSlackConversation(id: string, body: Record<string, unknown>): { conversation: SlackConversationRow } {
    for (const key of Object.keys(body)) if (key !== "followed") throw new HarnessError(400, `${key} : clé inconnue`);
    if (typeof body.followed !== "boolean") throw new HarnessError(400, "followed : booléen attendu");
    const conversation = this.#deps.store.setSlackConversationFollowed(id, body.followed);
    if (conversation === null) throw new HarnessError(404, "conversation Slack inconnue : relisez la liste des canaux");
    this.#deps.event("workstation_channel_follow", null, { id, followed: conversation.followed }, null);
    return { conversation };
  }
}

/** Une erreur du client des canaux, en réponse HTTP (code seulement, jamais de contenu). */
function httpError(err: unknown): unknown {
  if (err instanceof ChannelUnavailable) return new HarnessError(409, `canal slack indisponible : ${err.state}`);
  if (err instanceof ChannelRateLimited)
    return new HarnessError(429, err.message, { "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)) });
  if (err instanceof ChannelApiError || err instanceof ChannelNetworkError) return new HarnessError(502, err.message);
  return err;
}
