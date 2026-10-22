// Lancer un process et attendre son issue : code, signal, sorties bornées, délai.
import { spawn } from "node:child_process";

export type ProcResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export type ProcOptions = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Octets gardés de chaque sortie (la FIN : c'est là qu'est l'erreur). */
  maxBytes?: number;
};

export type Exec = (command: string, args: string[], options?: ProcOptions) => Promise<ProcResult>;

function tail(chunks: Buffer[], max: number): string {
  const all = Buffer.concat(chunks);
  return (all.length > max ? all.subarray(all.length - max) : all).toString("utf8");
}

/** Un `Exec` réel : jamais de shell implicite, `env` remplace l'environnement s'il est donné. */
export const execProcess: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    const max = options.maxBytes ?? 256 * 1024;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv | undefined,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Mémoire bornée : au-delà de 2× le plafond, on ne garde que la fin.
    const keep = (chunks: Buffer[], bytes: number, chunk: Buffer): number => {
      chunks.push(chunk);
      bytes += chunk.length;
      while (bytes > 2 * max && chunks.length > 1) bytes -= (chunks.shift() as Buffer).length;
      return bytes;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes = keep(out, outBytes, chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errBytes = keep(err, errBytes, chunk);
    });
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : null;
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, signal: null, stdout: "", stderr: String(error.message), timedOut });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout: tail(out, max), stderr: tail(err, max), timedOut });
    });
  });
