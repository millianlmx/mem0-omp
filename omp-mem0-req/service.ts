// L'hôte HTTP du service (S-1, S-2) : le seul endroit du plugin qui parle à `Bun`.
//
// Le CLI d'OMP est un bundle Bun et les extensions tournent dans ce process :
// `Bun.serve` est disponible (Doc-1 §11). Mais la suite de tests du dépôt tourne
// sous `node --test`, donc `Bun` n'est jamais REQUIS à l'import — il est lu
// paresseusement, derrière une déclaration locale (aucun type `Bun` n'existe,
// `tsconfig.json` ne déclare que `node`).
import { SERVICE_VERSION, newServiceToken, servicePort, serviceFilePath, removeService, serviceRunning, writeService } from "./serviceState.ts";
import type { ServiceRecord } from "./serviceState.ts";
import { createServiceRequestHandler } from "./serviceHttp.ts";
import type { ServiceApi } from "./serviceApi.ts";
import { pipelineStateDir } from "./store.ts";


/** Le client qu'une requête peut joindre pendant qu'elle est en vol (arrêt). */
export type ServiceHandle = {
  /** Le port RÉELLEMENT écouté : celui du fichier, jamais le port demandé. */
  port: number;
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
  unref?: () => void;
  ref?: () => void;
};

type BunLike = {
  serve: (options: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
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
  const token = newServiceToken();
  let stopping = false;
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
  });
  let server: BunServerLike | null = null;
  const listen = (port: number): BunServerLike =>
    bun.serve({ hostname: "127.0.0.1", port, fetch: handler, idleTimeout: 0 });
  const requested = deps.port ?? servicePort(deps.env ?? process.env);
  try {
    server = listen(requested);
  } catch (err) {
    if (requested === 0) throw err;
    log(`port ${requested} indisponible (${err instanceof Error ? err.message : String(err)}) — port éphémère`);
    server = listen(0);
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
      pid: process.pid,
      token,
      stop: async () => {
        if (stopping) return;
        stopping = true;
        await deps.onStop?.();
        try {
          await server?.stop(true);
        } catch {
          /* serveur déjà fermé */
        }
        removeService(stateDir);
      },
    },
  };
}
