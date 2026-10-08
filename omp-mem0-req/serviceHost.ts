// L'ASSEMBLAGE du service (S-2) : le routeur, les sessions, le pilotage et le
// cycle de vie réunis en une seule surface que l'extension démarre.
//
// Le service n'a AUCUNE fenêtre : c'est un process `omp -p` sans session dont la
// commande `/service start` ne rend jamais la main (Doc-1 §9), et dont le serveur
// HTTP retient la boucle d'évènements (Doc-2 §5).
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { GitResult, GitRunner } from "./git.ts";
import { badRequest } from "./serviceApi.ts";
import type { ServiceApi, SessionDescription } from "./serviceApi.ts";
import { createServicePilot } from "./servicePilot.ts";
import type { ServicePilot } from "./servicePilot.ts";
import { createSessionHost } from "./serviceSessions.ts";
import type { SessionHost } from "./serviceSessions.ts";
import { createMaillonRunner } from "./serviceRuns.ts";
import { startService } from "./service.ts";
import type { ServiceHandle, ServiceStartResult } from "./service.ts";
import { pipelineStateDir } from "./store.ts";
import { markServiceProcess, readServiceRecord, removeService, serviceRunning } from "./serviceState.ts";


export type ServiceHostOptions = {
  pi: ExtensionAPI;
  stateDir?: string;
  env?: Record<string, string | undefined>;
  /** Le chemin de CE plugin quand il n'est pas installé (`selfExtensionArg`). */
  selfPath: string | null;
  runGit: GitRunner;
  runGh?: (args: string[], cwd: string) => Promise<GitResult>;
  log?: (line: string) => void;
  now?: () => number;
  schedule?: (callback: () => void, ms: number) => () => void;
};


/** Le service assemblé : ce que la commande `/service` démarre et arrête. */
export interface ServiceHost {
  api: ServiceApi;
  sessions: SessionHost;
  pilot: ServicePilot;
  /** Démarre serveur + pilotage. `already-running` : un autre service vit déjà. */
  start: () => Promise<ServiceStartResult>;
  /** Arrêt propre : sessions libérées, runs coupés, `service.json` retiré. */
  stop: () => Promise<void>;
  stateDir: string;
}


/** `purpose` d'une session créée par l'API : les deux formes de S-6, jamais `run`. */
function asPurpose(raw: unknown): "session" | "project" {
  if (raw === undefined || raw === "session") return "session";
  if (raw === "project") return "project";
  throw badRequest(`purpose inconnu : ${String(raw)}`);
}


export function createServiceHost(options: ServiceHostOptions): ServiceHost {
  const stateDir = options.stateDir ?? pipelineStateDir();
  const log = options.log ?? (() => {});
  const sessions = createSessionHost({
    pi: options.pi,
    stateDir,
    selfPath: options.selfPath,
    log,
    now: options.now,
  });
  const pilot = createServicePilot({
    stateDir,
    host: sessions,
    run: createMaillonRunner({ host: sessions, log, now: options.now }),
    runGit: options.runGit,
    runGh: options.runGh,
    notify: text => log(`[service] ${text}`),
    toast: text => log(`[service] ${text}`),
    log,
    now: options.now,
    schedule: options.schedule,
    startedAt: (options.now ?? Date.now)(),
  });

  const api: ServiceApi = {
    health: () => pilot.health(),
    pilot: repo => pilot.pilot(repo),
    command: (repo, body) => pilot.command(repo, body),
    listSessions: () => sessions.list(),
    createSession: async body => {
      if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("corps attendu : {\"cwd\":\"…\"}");
      const record = body as { cwd?: unknown; resume?: unknown; purpose?: unknown };
      if (typeof record.cwd !== "string" || record.cwd.trim() === "") throw badRequest("champ « cwd » manquant");
      if (record.resume !== undefined && typeof record.resume !== "string") {
        throw badRequest("champ « resume » : chemin de fichier de session attendu");
      }
      const purpose = asPurpose(record.purpose);
      const hosted = await sessions.open({
        cwd: record.cwd,
        purpose,
        resume: typeof record.resume === "string" ? record.resume : null,
      });
      const description: SessionDescription = {
        id: hosted.id,
        cwd: hosted.cwd,
        purpose,
        state: hosted.state,
        sessionFile: hosted.sessionFile,
      };
      return description;
    },
    getSession: id => sessions.view(id),
    promptSession: (id, body) => sessions.prompt(id, body),
    abortSession: id => sessions.abort(id),
    answerDialog: (id, dialogId, body) => sessions.answer(id, dialogId, body),
    closeSession: id => sessions.close(id),
    startConduite: (repo, body) => pilot.startConduite(repo, body),
    stopConduite: repo => pilot.stopConduite(repo),
    subscribeSession: id => sessions.subscribe(id),
  };

  let handle: ServiceHandle | null = null;

  return {
    api,
    sessions,
    pilot,
    stateDir,
    async start() {
      const started = await startService({
        api,
        stateDir,
        env: options.env,
        log,
        now: options.now,
        onStop: async () => {
          pilot.stop();
          await sessions.disposeAll();
        },
      });
      if (started.kind === "already-running") return started;
      // Le process EST le service : marqué AVANT qu'une session hébergée ne
      // charge sa propre instance du plugin (S-3, S-6, S-7).
      markServiceProcess(true);
      handle = started.handle;
      pilot.start();
      return started;
    },
    async stop() {
      pilot.stop();
      await sessions.disposeAll();
      // Le serveur se ferme par son propre arrêt ; cette porte-ci est celle du
      // process qui a démarré le service dans SA session (`/service stop`).
      await handle?.stop();
      handle = null;
      removeService(stateDir);
      // Plus de service dans ce process : les sessions suivantes reprennent le
      // cours ordinaire (aucune ne doit se croire hébergée).
      markServiceProcess(false);
    },
  };
}


/** Le texte de `/service status` : l'état du fichier, jamais un port en dur (S-1). */
export function serviceStatusText(stateDir: string = pipelineStateDir()): string {
  const running = serviceRunning(stateDir);
  if (running !== null) return `en marche (pid ${running.pid}, port ${running.port})`;
  // Un fichier de forme valide dont le pid est mort est un RESTE d'arrêt brutal :
  // le dire évite de croire à un service jamais lancé (S-1, cas limites S-5).
  return readServiceRecord(stateDir) === null ? "arrêté" : "arrêté (enregistrement périmé)";
}
