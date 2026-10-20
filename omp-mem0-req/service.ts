// L'hôte HTTP du service (S-1, S-2) : le seul endroit du plugin qui parle à `Bun`.
//
// Le CLI d'OMP est un bundle Bun et les extensions tournent dans ce process :
// `Bun.serve` est disponible (Doc-1 §11). Mais la suite de tests du dépôt tourne
// sous `node --test`, donc `Bun` n'est jamais REQUIS à l'import — il est lu
// paresseusement, derrière une déclaration locale (aucun type `Bun` n'existe,
// `tsconfig.json` ne déclare que `node`).
import {
  SERVICE_VERSION,
  newServiceToken,
  pipelineMachine,
  pipelineMachineName,
  remoteApiHost,
  remoteApiPort,
  servicePort,
  serviceFilePath,
  removeService,
  serviceRunning,
  writeService,
} from "./serviceState.ts";
import type { ServiceRecord } from "./serviceState.ts";
import { createServiceRequestHandler } from "./serviceHttp.ts";
import { createRemoteRequestHandler } from "./remoteApi.ts";
import { createRemoteRoutes } from "./remoteRoutes.ts";
import type { RemoteRoutes } from "./remoteRoutes.ts";
import { DeviceRegistry, devicesFilePath } from "./remoteDevices.ts";
import type { ServiceApi } from "./serviceApi.ts";
import { pipelineStateDir } from "./store.ts";


/** Le client qu'une requête peut joindre pendant qu'elle est en vol (arrêt). */
export type ServiceHandle = {
  /** Le port RÉELLEMENT écouté : celui du fichier, jamais le port demandé. */
  port: number;
  /** Le port du protocole distant (VPS), ou `null` quand le service n'en sert pas (S-2). */
  remotePort: number | null;
  pid: number;
  token: string;
  /** Arrêt propre : plus de nouvelles requêtes, flux coupés, `service.json` retiré. */
  stop: () => Promise<void>;
};

export type ServiceStartResult =
  | { kind: "started"; handle: ServiceHandle }
  | { kind: "already-running"; pid: number };


/** La surface de `Bun` que l'hôte utilise, déclarée localement (Doc-1 §11). */
type BunServerLike = {
  port: number;
  stop: (force?: boolean) => Promise<void> | void;
  timeout?: (request: Request, seconds: number) => void;
  /** L'adresse du pair d'une requête : le protocole distant refuse hors tailnet (S-2). */
  requestIP?: (request: Request) => { address: string; family?: string; port: number } | null;
  unref?: () => void;
  ref?: () => void;
};

type BunLike = {
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request, server: BunServerLike) => Response | Promise<Response>;
    idleTimeout?: number;
  }) => BunServerLike;
  sleepSync?: (ms: number) => void;
};


/** `Bun` du process, ou une erreur NOMMÉE : le service n'existe que sous l'hôte. */
export function bunRuntime(): BunLike {
  // `Bun` est un global de l'hôte que `types: ["node"]` ne déclare pas : la seule
  // assertion du module, nommée, faute de schéma pour un objet natif (Doc-1 §11).
  const host = globalThis as typeof globalThis & { Bun?: unknown };
  const bun = host.Bun;
  if (bun === null || typeof bun !== "object") {
    throw new Error("Bun est absent de ce process : le service OMP tourne sous l'hôte omp (Bun)");
  }
  if (!("serve" in bun) || typeof bun.serve !== "function") {
    throw new Error("Bun est absent de ce process : le service OMP tourne sous l'hôte omp (Bun)");
  }
  return bun as BunLike;
}


export type StartServiceDeps = {
  api: ServiceApi;
  stateDir?: string;
  port?: number;
  env?: Record<string, string | undefined>;
  /** La sortie du service : le singleton et les pannes y sont NOMMÉS. */
  log?: (line: string) => void;
  now?: () => number;
  /** Appelé au premier signal d'arrêt, avant la fermeture du serveur. */
  onStop?: () => void | Promise<void>;
};


/**
 * Démarre le service : contrôle d'unicité, écoute sur `127.0.0.1`, publication de
 * `service.json`. Le port demandé occupé n'est pas une panne — le service prend un
 * port éphémère, et c'est le FICHIER qui fait foi pour les clients (S-1).
 */
export async function startService(deps: StartServiceDeps): Promise<ServiceStartResult> {
  const stateDir = deps.stateDir ?? pipelineStateDir();
  const log = deps.log ?? (() => {});
  const running = serviceRunning(stateDir);
  if (running !== null) {
    // Un second service ne double JAMAIS les runs : il le dit et sort sans rien
    // écraser — le port et le jeton du premier restent ceux que les clients lisent.
    log(`un service tourne déjà (pid ${running.pid})`);
    return { kind: "already-running", pid: running.pid };
  }
  const bun = bunRuntime();
  const env = deps.env ?? process.env;
  const token = newServiceToken();
  let stopping = false;
  // Le protocole distant n'existe que sur le VPS (S-2) : le Mac garde son serveur Swift.
  const vps = pipelineMachine(env) === "vps";
  const devices = vps ? new DeviceRegistry({ file: devicesFilePath(stateDir), now: deps.now }) : null;
  devices?.load();
  const handler = createServiceRequestHandler({
    api: deps.api,
    token,
    stopping: () => stopping,
    onLongLived: req => {
      try {
        server?.timeout?.(req, 0);
      } catch {
        /* hôte sans `timeout` : le flux reste borné par la durée de la session */
      }
    },
    devices: devices ?? undefined,
  });
  let server: BunServerLike | null = null;
  const listen = (port: number): BunServerLike =>
    bun.serve({ hostname: "127.0.0.1", port, fetch: handler, idleTimeout: 0 });
  const requested = deps.port ?? servicePort(env);
  try {
    server = listen(requested);
  } catch (err) {
    if (requested === 0) throw err;
    log(`port ${requested} indisponible (${err instanceof Error ? err.message : String(err)}) — port éphémère`);
    server = listen(0);
  }
  // Le second écouteur : le protocole distant, sur l'adresse Tailscale. Une adresse
  // non liable est une PANNE (Tailscale pas encore prêt) : le service s'arrête, le
  // superviseur le relance — il ne reste jamais à moitié servi (S-2, cas limites).
  let remote: BunServerLike | null = null;
  let remoteRoutes: RemoteRoutes | null = null;
  const remoteHost = vps ? remoteApiHost(env) : null;
  if (vps && devices !== null && remoteHost === null) {
    log("[service] protocole distant désactivé : MEM0_REMOTE_API_HOST absent");
  }
  if (devices !== null && remoteHost !== null) {
    const machine = { kind: "vps" as const, name: pipelineMachineName(env) };
    remoteRoutes = createRemoteRoutes({ api: deps.api, stateDir, machine, devices, env, now: deps.now });
    const remoteHandler = createRemoteRequestHandler({ devices, machine, routes: remoteRoutes.routes });
    const remotePort = remoteApiPort(env);
    try {
      remote = bun.serve({
        hostname: remoteHost,
        port: remotePort,
        fetch: (req, srv) => remoteHandler(req, srv.requestIP?.(req)?.address ?? null),
        // Les flux SSE (`GET /v1/stream`) vivent des heures : Bun coupe sinon une connexion
        // muette au bout de 10 s, avant même le premier battement de 15 s.
        idleTimeout: 0,
      });
    } catch (err) {
      remoteRoutes.close();
      await server.stop(true);
      throw new Error(
        `protocole distant : ${remoteHost}:${remotePort} non liable (${err instanceof Error ? err.message : String(err)})`,
      );
    }
    log(`[service] protocole distant en écoute sur ${remoteHost}:${remote.port}`);
  }
  const record: ServiceRecord = {
    version: SERVICE_VERSION,
    pid: process.pid,
    port: server.port,
    token,
    startedAt: (deps.now ?? Date.now)(),
    stateDir,
    sessionFile: null,
  };
  writeService(record, stateDir);
  log(`service en marche (pid ${record.pid}, port ${record.port}) — ${serviceFilePath(stateDir)}`);
  return {
    kind: "started",
    handle: {
      port: server.port,
      remotePort: remote?.port ?? null,
      pid: process.pid,
      token,
      stop: async () => {
        if (stopping) return;
        stopping = true;
        await deps.onStop?.();
        remoteRoutes?.close();
        try {
          await remote?.stop(true);
          await server?.stop(true);
        } catch {
          /* serveur déjà fermé */
        }
        removeService(stateDir);
      },
    },
  };
}
