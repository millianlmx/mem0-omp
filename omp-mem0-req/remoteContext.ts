// Le CONTEXTE que reçoivent tous les modules de routes de parité (S-3) : ce que le
// service met à leur disposition, sans saut HTTP interne. Chaque module de routes
// exporte `xxxRoutes(ctx: RemoteContext): RemoteRoute[]` ; `remoteRoutes.ts` les
// assemble en une seule table passée à `createRemoteRequestHandler`.
//
// Web standard + `node:*` seulement : la suite de tests l'exerce sous `node --test`.
import { execFile } from "node:child_process";
import type { RemoteMachine } from "./remoteApi.ts";
import type { DeviceRegistry } from "./remoteDevices.ts";
import type { GestureJournal } from "./remoteJournal.ts";
import type { StoreSource } from "./remoteStore.ts";
import type { StreamHub } from "./remoteStream.ts";
import type { ServiceApi } from "./serviceApi.ts";


/** Le résultat d'un binaire externe (`gh`, `omp`, `git`) : jamais une exception. */
export type ExecResult = {
  /** Code de sortie ; `null` si tué (délai) ou jamais lancé. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** Le binaire est introuvable dans le PATH (ENOENT). */
  missing: boolean;
  timedOut: boolean;
};

export type ExecOptions = { cwd?: string; timeoutMs?: number; input?: string };

export type ExecFn = (file: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

/** L'exécuteur de production : `execFile` avec l'environnement du contexte (PATH compris). */
export function defaultExec(env: Record<string, string | undefined>): ExecFn {
  return (file, args, options = {}) =>
    new Promise<ExecResult>(resolve => {
      const child = execFile(
        file,
        args,
        {
          cwd: options.cwd,
          env: env as NodeJS.ProcessEnv,
          timeout: options.timeoutMs ?? 60_000,
          maxBuffer: 64 * 1024 * 1024,
          encoding: "utf8",
        },
        (error, stdout, stderr) => {
          const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: string | number }) | null;
          if (e === null) return resolve({ code: 0, stdout, stderr, missing: false, timedOut: false });
          const missing = e.code === "ENOENT";
          const timedOut = e.killed === true;
          resolve({
            code: typeof e.code === "number" ? e.code : null,
            stdout: stdout ?? "",
            stderr: stderr ?? "",
            missing,
            timedOut,
          });
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    });
}


export type RemoteContext = {
  /** Sessions, conduite, audits, commandes : le service du process, appelé en direct. */
  api: ServiceApi;
  /** `<stateDir>` : lots, running, history, projects, inbox, audit, audits, journal. */
  stateDir: string;
  machine: RemoteMachine;
  env: Record<string, string | undefined>;
  /** L'horloge (fixée à 1 700 000 000 000 ms par la fixture de parité). */
  now: () => number;
  /** Un pid est-il vivant ? (ESRCH ⇒ non). Faux partout dans la fixture de parité. */
  pidAlive: (pid: number) => boolean;
  exec: ExecFn;
  devices: DeviceRegistry;
  /** Le magasin lu et surveillé (instantané filaire Swift du `StoreSnapshot`). */
  store: StoreSource;
  /** Le journal des gestes, en mémoire, 20 entrées. */
  journal: GestureJournal;
  /** Le concentrateur des flux SSE (rediffusion des faits de PR, des appareils). */
  streams: StreamHub;
};

/** Une source d'évènements à charge complète : la charge courante, et l'abonnement à ses changements. */
export type Feed<T> = {
  payload: () => T;
  /** Abonne un auditeur ; rend le désabonnement. */
  onChange: (listener: () => void) => () => void;
};
