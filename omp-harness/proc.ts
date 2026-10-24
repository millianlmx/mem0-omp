// Lancer un process et attendre son issue : code, signal, sorties bornées, délai, arrêt.
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
  let killTimer: NodeJS.Timeout | undefined;
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
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
        child.kill("SIGKILL");
      }, options.timeoutMs)
    : undefined;
  const onAbort = () => {
    if (aborted) return;
    aborted = true;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), options.killGraceMs ?? KILL_GRACE_MS);
  };
  const signal = options.signal;
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const done = (result: ProcResult) => {
    clearTimeout(timer);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", onAbort);
    resolve(result);
  };
  child.on("error", (error) => {
    done({ code: 127, signal: null, stdout: "", stderr: String(error.message), timedOut, aborted });
  });
  child.on("close", (code, signal) => {
    done({ code, signal, stdout: tail(out, max), stderr: tail(err, max), timedOut, aborted });
  });
  return promise;
};
