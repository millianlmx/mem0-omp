// Lancer un process et attendre son issue : code, signal, sorties bornées, délai, arrêt.
//
// Le process part dans son propre groupe (`detached`, sans `unref` : le service
// l'attend toujours) : un délai ou un arrêt tue tout le groupe, petits-enfants
// compris (le ssh derrière `git push`, le git derrière `gh`). Un descendant qui
// garde stdout ou stderr ne retient plus l'issue : `CLOSE_GRACE_MS` après la
// sortie du process, ses tubes sont coupés.
import { spawn } from "node:child_process";

export type ProcResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Le process a été tué parce que `signal` (ProcOptions) a été déclenché : une issue à part, ni délai ni échec. */
  aborted: boolean;
};

export type ProcOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Octets gardés de chaque sortie (la FIN : c'est là qu'est l'erreur). */
  maxBytes?: number;
  /** Un arrêt demandé : SIGTERM, puis SIGKILL si le process vit encore `killGraceMs` plus tard. */
  signal?: AbortSignal;
  killGraceMs?: number;
  /** Chaque morceau de sortie (stdout ou stderr) dès qu'il arrive : la sortie en direct d'un job. */
  onOutput?: (chunk: string) => void;
};

export type Exec = (command: string, args: string[], options?: ProcOptions) => Promise<ProcResult>;

/** Le délai entre SIGTERM et SIGKILL d'un process arrêté par son signal. */
export const KILL_GRACE_MS = 5000;

/** L'attente de la fermeture des sorties après la sortie du process, avant de les couper. */
export const CLOSE_GRACE_MS = 1000;

function tail(chunks: Buffer[], max: number): string {
  const all = Buffer.concat(chunks);
  return (all.length > max ? all.subarray(all.length - max) : all).toString("utf8");
}

/** Un `Exec` réel : jamais de shell implicite, `env` remplace l'environnement s'il est donné. */
export const execProcess: Exec = (command, args, options = {}) => {
  // Les sources sont typées en lib ES2023 : pas de Promise.withResolvers ici.
  let resolve: (result: ProcResult) => void = () => {};
  const promise = new Promise<ProcResult>((done) => {
    resolve = done;
  });
  const max = options.maxBytes ?? 256 * 1024;
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let outBytes = 0;
  let errBytes = 0;
  let timedOut = false;
  let aborted = false;
  let settled = false;
  let killTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
    // Un groupe à lui (pgid = son pid), jamais celui du service : tuer ce groupe épargne le service.
    detached: true,
  });
  /** Signale tout le groupe du process ; s'il n'existe plus, le process seul (sans effet s'il est parti). */
  const kill = (sig: NodeJS.Signals): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  // Mémoire bornée : au-delà de 2× le plafond, on ne garde que la fin.
  const keep = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
    chunks.push(chunk);
    bytes += chunk.length;
    while (bytes > 2 * max && chunks.length > 1) {
      const dropped = chunks.shift();
      if (dropped) bytes -= dropped.length;
    }
    return bytes;
  };
  const live = (chunk: Buffer): void => {
    try {
      options.onOutput?.(chunk.toString("utf8"));
    } catch {
      /* un lecteur du direct qui échoue n'arrête pas le process */
    }
  };
  child.stdout.on("data", (chunk: Buffer) => {
    outBytes = keep(out, outBytes, chunk);
    live(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    errBytes = keep(err, errBytes, chunk);
    live(chunk);
  });
  const timer = options.timeoutMs
    ? setTimeout(() => {
        timedOut = true;
        kill("SIGKILL");
      }, options.timeoutMs)
    : undefined;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
  };
  const signal = options.signal;
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const done = (result: ProcResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(closeTimer);
    signal?.removeEventListener("abort", onAbort);
    resolve(result);
  };
  const settle = (code: number | null, sig: NodeJS.Signals | null): void =>
    done({ code, signal: sig, stdout: tail(out, max), stderr: tail(err, max), timedOut, aborted });
  child.on("error", (error) => {
    done({ code: 127, signal: null, stdout: "", stderr: String(error.message), timedOut, aborted });
  });
  // `close` attend la fermeture des tubes, qu'un descendant peut retenir sans fin : la sortie du process suffit, après un délai.
  child.on("exit", (code, sig) => {
    closeTimer = setTimeout(() => {
      // Un process tué (délai, arrêt) n'a plus de descendant légitime : ce qui reste du groupe part avec lui.
      if (timedOut || aborted) kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      settle(code, sig);
    }, CLOSE_GRACE_MS);
  });
  child.on("close", settle);
  return promise;
};
