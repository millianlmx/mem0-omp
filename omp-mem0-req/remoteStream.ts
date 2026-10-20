// Le FLUX TEMPS RÉEL `GET /v1/stream` : le portage de `RemoteStreamHub`
// (`omp-console/Sources/OMPConsole/Remote/RemoteStream.swift`, S-13). Un seul jeu de
// sources pour tous les abonnés (magasin, journal, appareils, conduite, faits de PR,
// session hébergée) et un battement de cœur pour tous les flux.
//
// Format SSE (`SSE.frame`) : `event: <nom>\ndata: <json>\n\n` ; battement `: ping\n\n`.
// Ordre d'ouverture (S-13, S-4, S-6) : `hello`, `store`, `conduite`, `devices`,
// `components`, `journal`, `pull-request-states`. La trame `devices` d'ouverture n'est
// pas écrite ici : `markConnected` la publie par `changeHandler`, comme sur le Mac.
// Ensuite, la charge COMPLÈTE de la source qui change — jamais un delta.
//
// Révocation : `close(deviceId)` coupe TOUS les flux de l'appareil AVANT de rendre la
// main (le registre l'appelle par `revokeHandler`). Client lent : au-delà de 64 trames
// en attente sur une connexion, la trame est ABANDONNÉE pour ce client — jamais de
// blocage du serveur, jamais de coupure des autres flux.
import * as fs from "node:fs";
import { REMOTE_PROTOCOL_VERSION, RemoteError, sortedJson } from "./remoteApi.ts";
import type { RemoteMachine, RemoteRoute } from "./remoteApi.ts";
import type { Feed, RemoteContext } from "./remoteContext.ts";
import type { DeviceRegistry } from "./remoteDevices.ts";
import type { GestureJournal } from "./remoteJournal.ts";
import { componentsPayload } from "./remoteStore.ts";
import type { StoreSource } from "./remoteStore.ts";
import { readSessionFile, remoteEntry } from "./remoteSessions.ts";
import type { RemoteConversationEntry } from "./remoteSessions.ts";

/** `RemoteStreamHub.backlogLimit` : au-delà, la trame est abandonnée pour ce client. */
export const STREAM_BACKLOG_LIMIT = 64;
/** Le filet de sondage des fichiers de session (la veille `fs.watch` peut manquer un évènement). */
export const SESSION_POLL_MS = 1000;
/** `RemoteStreamHub.heartbeatSeconds`. */
export const STREAM_HEARTBEAT_MS = 15_000;

export type StreamHubOptions = {
  machine: RemoteMachine;
  devices: DeviceRegistry;
  store: StoreSource;
  journal: GestureJournal;
  /** L'horloge du contexte : les trames ne portent aucun horodatage, elle n'est pas lue. */
  now?: () => number;
  env: Record<string, string | undefined>;
  /** Les faits de PR : trame `pull-request-states`, à l'ouverture puis à chaque changement. */
  pullRequestStates: Feed<unknown>;
  /** L'état de la conduite de projet : trame `conduite`, à l'ouverture puis à chaque changement. */
  conduite: Feed<unknown>;
  /** La session hébergée : trame `hosted`, SEULEMENT sur changement (aucune trame à l'ouverture, comme le Mac). */
  hosted?: Feed<unknown>;
  /** Le battement de cœur (15 s) ; réglable pour les tests. */
  heartbeatMs?: number;
};

type Subscriber = {
  id: number;
  deviceId: string;
  controller: ReadableStreamDefaultController<Uint8Array>;
  active: boolean;
};

const encoder = new TextEncoder();
const HEARTBEAT = encoder.encode(": ping\n\n");

/** `SSE.frame` : `event:`, `data:` puis une ligne vide qui dispatche. */
export function sseFrame(event: string, payload: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${sortedJson(payload)}\n\n`);
}

/**
 * Le curseur d'UN fichier de session (`SessionReader.read()` du Mac, à curseur en mémoire) : ce
 * qu'un appel a AJOUTÉ depuis le précédent, ou `replaced` (autre fichier au même chemin) /
 * `truncated` (taille sous la dernière observée). Le premier appel rend tout le fichier. Un
 * fichier absent ou illisible ne publie rien (seuls `truncated` et `replaced` font une trame).
 */
class SessionTail {
  private count = 0;
  private identity: string | undefined;
  private size = 0;
  private reported: "replaced" | "truncated" | undefined;

  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): { added: RemoteConversationEntry[]; issue?: "replaced" | "truncated" } {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch {
      return { added: [] };
    }
    const identity = `${stat.dev}:${stat.ino}`;
    if (this.identity !== undefined) {
      const issue = identity !== this.identity ? "replaced" : stat.size < this.size ? "truncated" : undefined;
      if (issue !== undefined) {
        // Le sondage relit ce fichier chaque seconde : un incident n'est publié qu'UNE fois.
        const fresh = issue !== this.reported;
        this.reported = issue;
        return fresh ? { added: [], issue } : { added: [] };
      }
      this.reported = undefined;
      if (stat.size === this.size) return { added: [] };
    }
    const conversation = readSessionFile(this.file);
    if (conversation.issue !== undefined) return { added: [] };
    const added = conversation.entries.slice(this.count).map(remoteEntry);
    this.count = conversation.entries.length;
    this.size = stat.size;
    this.identity = identity;
    return { added };
  }
}

export class StreamHub {
  private readonly options: StreamHubOptions;
  private readonly subscribers = new Map<number, Subscriber>();
  private nextId = 1;
  private sources: Array<() => void> = [];
  private heartbeat: NodeJS.Timeout | undefined;
  private tailPoll: NodeJS.Timeout | undefined;
  /** La veille des fichiers de session des runs VIVANTS : un curseur et un `fs.watch` par fichier. */
  private readonly tails = new Map<string, { tail: SessionTail; watcher: fs.FSWatcher | null }>();

  constructor(options: StreamHubOptions) {
    this.options = options;
    // Le registre publie `devices` et coupe les flux d'un appareil révoqué/remplacé ; ces
    // deux crochets n'ont qu'un propriétaire : ce concentrateur.
    options.devices.changeHandler = () => this.broadcastDevices();
    options.devices.revokeHandler = id => this.close(id);
  }

  /** `subscribe` + `activate` : la réponse SSE d'UNE connexion, ouverte par ses trames d'ouverture. */
  subscribe(deviceId: string): Response {
    const id = this.nextId++;
    const stream = new ReadableStream<Uint8Array>(
      {
        start: controller => {
          const subscriber: Subscriber = { id, deviceId, controller, active: true };
          this.subscribers.set(id, subscriber);
          this.startSources();
          this.open(subscriber);
        },
        cancel: () => this.unsubscribe(id),
      },
      new CountQueuingStrategy({ highWaterMark: STREAM_BACKLOG_LIMIT }),
    );
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
  }

  /** Les appareils qui ont au moins un flux ouvert. */
  connectedDeviceIds(): Set<string> {
    return new Set([...this.subscribers.values()].map(subscriber => subscriber.deviceId));
  }

  /** Coupe TOUS les flux d'un appareil — avant que la révocation rende la main. */
  close(deviceId: string): void {
    const doomed = [...this.subscribers.values()].filter(subscriber => subscriber.deviceId === deviceId);
    for (const subscriber of doomed) {
      this.subscribers.delete(subscriber.id);
      this.end(subscriber);
    }
    if (doomed.length > 0) {
      this.options.devices.markConnected(deviceId, false);
      this.stopSourcesIfIdle();
    }
  }

  /** Ferme tous les flux, les sources et le battement. */
  closeAll(): void {
    for (const subscriber of this.subscribers.values()) this.end(subscriber);
    this.subscribers.clear();
    this.stopSources();
    this.options.devices.changeHandler = null;
    this.options.devices.revokeHandler = null;
  }

  /** `activate` : `hello`, `store`, `conduite`, puis `devices` (par `markConnected`), `components`, `journal`, `pull-request-states`. */
  private open(subscriber: Subscriber): void {
    const { options } = this;
    this.deliver(subscriber, sseFrame("hello", { protocolVersion: REMOTE_PROTOCOL_VERSION, machine: options.machine }));
    this.deliver(subscriber, sseFrame("store", options.store.snapshot()));
    this.deliver(subscriber, sseFrame("conduite", options.conduite.payload()));
    options.devices.markConnected(subscriber.deviceId, true);
    this.deliver(subscriber, sseFrame("components", componentsPayload(options.env)));
    this.deliver(subscriber, sseFrame("journal", { entries: options.journal.list() }));
    this.deliver(subscriber, sseFrame("pull-request-states", options.pullRequestStates.payload()));
    this.refreshWatchedRuns();
  }

  private unsubscribe(id: number): void {
    const subscriber = this.subscribers.get(id);
    if (subscriber === undefined) return;
    this.subscribers.delete(id);
    // Plusieurs flux par appareil : il reste connecté tant qu'un autre flux est ouvert.
    const stillOpen = [...this.subscribers.values()].some(other => other.deviceId === subscriber.deviceId);
    if (!stillOpen) this.options.devices.markConnected(subscriber.deviceId, false);
    this.stopSourcesIfIdle();
  }

  /** Les sources, armées à la première connexion : un seul abonnement par évènement pour tous les flux. */
  private startSources(): void {
    if (this.sources.length > 0) return;
    const { options } = this;
    this.sources = [
      options.store.onChange(() => {
        this.broadcast(sseFrame("store", options.store.snapshot()));
        this.refreshWatchedRuns();
      }),
      options.journal.onChange(() => this.broadcast(sseFrame("journal", { entries: options.journal.list() }))),
      options.conduite.onChange(() => this.broadcast(sseFrame("conduite", options.conduite.payload()))),
      options.pullRequestStates.onChange(() =>
        this.broadcast(sseFrame("pull-request-states", options.pullRequestStates.payload())),
      ),
    ];
    const hosted = options.hosted;
    if (hosted !== undefined) {
      this.sources.push(hosted.onChange(() => this.broadcast(sseFrame("hosted", hosted.payload()))));
    }
    this.heartbeat = setInterval(() => this.broadcast(HEARTBEAT), options.heartbeatMs ?? STREAM_HEARTBEAT_MS);
    this.heartbeat.unref();
    // Filet de la veille de fichiers (évènement perdu ou veille non armée à temps) : un `stat` par fichier.
    this.tailPoll = setInterval(() => {
      for (const file of [...this.tails.keys()]) this.publishSession(file);
    }, SESSION_POLL_MS);
    this.tailPoll.unref();
  }

  private stopSourcesIfIdle(): void {
    if (this.subscribers.size === 0) this.stopSources();
  }

  private stopSources(): void {
    for (const unsubscribe of this.sources) unsubscribe();
    this.sources = [];
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    clearInterval(this.tailPoll);
    this.tailPoll = undefined;
    for (const { watcher } of this.tails.values()) watcher?.close();
    this.tails.clear();
  }

  /**
   * La veille des fichiers de session des runs VIVANTS du magasin : c'est ce qui donne au fil de
   * l'iPad les ajouts d'un run en cours. Un fichier qui apparaît entre sous surveillance, un
   * fichier qui quitte l'ensemble en sort (`refreshWatchedRuns`).
   */
  private refreshWatchedRuns(): void {
    const live = new Set(this.options.store.liveSessionFiles());
    for (const file of live) {
      const known = this.tails.get(file);
      if (known?.watcher) continue;
      const tail = known?.tail ?? new SessionTail(file);
      let watcher: fs.FSWatcher | null = null;
      try {
        watcher = fs.watch(file, { persistent: false }, () => this.publishSession(file));
        watcher.on("error", () => watcher?.close());
      } catch {
        /* fichier pas encore créé : la prochaine passe réarme la veille */
      }
      this.tails.set(file, { tail, watcher });
    }
    for (const [file, { watcher }] of [...this.tails]) {
      if (live.has(file)) continue;
      watcher?.close();
      this.tails.delete(file);
    }
  }

  /** `publish` : ce qu'un fichier de session a produit depuis la dernière lecture, en trame `sessions`. */
  private publishSession(file: string): void {
    const read = this.tails.get(file)?.tail.read();
    if (read === undefined) return;
    if (read.issue !== undefined) {
      this.broadcast(sseFrame("sessions", { file, issue: read.issue }));
      return;
    }
    if (read.added.length > 0) this.broadcast(sseFrame("sessions", { file, added: read.added }));
  }

  /** `broadcastDevices` : la liste complète, à chaque changement du registre. */
  private broadcastDevices(): void {
    if (this.subscribers.size === 0) return;
    this.broadcast(sseFrame("devices", { devices: this.options.devices.list() }));
  }

  private broadcast(data: Uint8Array): void {
    for (const subscriber of [...this.subscribers.values()]) {
      if (subscriber.active) this.deliver(subscriber, data);
    }
  }

  /** `deliver` : au-delà de 64 trames en attente, la trame est abandonnée pour ce client. */
  private deliver(subscriber: Subscriber, data: Uint8Array): void {
    if ((subscriber.controller.desiredSize ?? 0) <= 0) return;
    try {
      subscriber.controller.enqueue(data);
    } catch {
      /* flux déjà fermé par le client : `cancel` désabonne */
    }
  }

  private end(subscriber: Subscriber): void {
    subscriber.active = false;
    try {
      subscriber.controller.close();
    } catch {
      /* déjà fermé */
    }
  }
}

export function streamRoutes(ctx: RemoteContext): RemoteRoute[] {
  return [
    {
      method: "GET",
      path: "v1/stream",
      handle: route => {
        // `RemoteRouter` : sans appareil authentifié, « flux indisponible ».
        if (route.device === null) throw new RemoteError("bad_request", "flux indisponible");
        return ctx.streams.subscribe(route.device.id);
      },
    },
  ];
}
