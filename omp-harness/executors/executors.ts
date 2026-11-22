// Les exécuteurs des cibles d'un dépôt (`.harness-env.json`) : où tourne chaque passage de
// tests, ou chaque commande de `run_on`.
//
// - `local` : le heavy du service (slot heavy, isolation du service, image de la cible en
//   conteneur), dans le worktree lui-même ;
// - `ssh` : une machine jointe en ssh (un Mac, un Linux d'une autre architecture). L'arbre
//   COURANT du worktree y est déposé (archive d'un index temporaire : fichiers suivis et
//   non ignorés, modifications non commitées comprises), le passage y tourne, ses rapports
//   et, pour `run_on`, ses modifications (un patch binaire) reviennent ; le dossier est retiré ;
// - `tart` : une VM macOS jetable clonée de `tart.image`, démarrée sans écran, jointe en ssh
//   comme ci-dessus, puis arrêtée et supprimée : rien ne survit d'un job à l'autre.
//
// Un passage dont aucun exécuteur ne porte les exigences ne tourne pas, et le dit : rien
// n'est jamais sauté en silence.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExecutorConfig, HarnessConfig, RepoConfig } from "../config/config.ts";
import type { Exec, ProcResult } from "../runners/proc.ts";
import type { Scheduler, Slot } from "../runners/scheduler.ts";
import { clientEnv, heavyArgv, matchesGlob, OUTPUT_TAIL, shellQuote } from "../heavy/heavy.ts";
import { forceStop } from "../runners/runner.ts";

/** Un passage confié à un exécuteur. */
export type ExecutorJob = {
  unit: string;
  repo: RepoConfig;
  worktree: string;
  /** Le script bash du passage : setup de la cible puis la commande. */
  script: string;
  env: Record<string, string>;
  /** L'image Linux de la cible (exécuteur `local` en isolation `container`), sinon `null`. */
  image: string | null;
  /** Les rapports à rapatrier (globs relatifs au dépôt). */
  reports: string[];
  /** `run_on` : les modifications du passage reviennent au worktree. */
  patch: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
  onStdout?: (chunk: Buffer) => void;
};

export type ExecutorRun = {
  proc: ProcResult;
  reports: { file: string; content: string }[];
  /** `run_on` sur un exécuteur distant : le patch binaire des modifications (vide : rien n'a changé). */
  patch: string | null;
};

export interface Executor {
  readonly config: ExecutorConfig;
  run(job: ExecutorJob): Promise<ExecutorRun>;
}

/** Le résultat d'un process qui n'a pas pu partir (un geste préparatoire a échoué). */
export function failedProc(stderr: string, code = 1): ProcResult {
  return { code, signal: null, stdout: "", stderr, timedOut: false, aborted: false };
}

/** Les étiquettes du heavy du service : son OS (Linux dès qu'il isole en conteneur ou systemd) et son architecture. */
export function localLabels(config: HarnessConfig): Record<string, string> {
  const hostOs = process.platform === "darwin" ? "macos" : "linux";
  return {
    os: config.heavy.isolation === "none" ? hostOs : "linux",
    arch: process.arch === "x64" ? "amd64" : process.arch,
  };
}

/** L'exécuteur porte-t-il toutes ces exigences ? */
export function satisfies(labels: Record<string, string>, requires: Record<string, string>): boolean {
  return Object.entries(requires).every(([key, value]) => labels[key] === value);
}

/** Les exigences lisibles : `os=macos, xcode=16`. */
export function requirementText(requires: Record<string, string>): string {
  return Object.entries(requires)
    .map(([key, value]) => `${key}=${value}`)
    .join(", ");
}

const REPORT_MARK = "<<<omp-report:";

/** Les rapports d'un dossier : chaque fichier dont le chemin relatif répond à un glob (sans `.git` ni `node_modules`). */
export function collectReports(root: string, globs: string[]): { file: string; content: string }[] {
  if (globs.length === 0) return [];
  const found: { file: string; content: string }[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 12 || found.length >= 200) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        const file = path.relative(root, full);
        if (globs.some((glob) => matchesGlob(glob, file)))
          found.push({ file, content: fs.readFileSync(full, "utf8").slice(0, 4 * 1024 * 1024) });
      }
    }
  };
  walk(root, 0);
  return found;
}

/** Les rapports renvoyés par un exécuteur distant : `<<<omp-report:<chemin>>>` puis le contenu, fichier après fichier. */
export function parseReports(stdout: string): { file: string; content: string }[] {
  const reports: { file: string; content: string }[] = [];
  for (const part of stdout.split(`\n${REPORT_MARK}`).slice(1)) {
    const end = part.indexOf(">>>\n");
    if (end < 0) continue;
    reports.push({ file: part.slice(0, end), content: part.slice(end + 4) });
  }
  return reports;
}

/** Le heavy du service : un slot heavy (admission mémoire comprise), dans le worktree, isolation du service. */
export class LocalExecutor implements Executor {
  readonly config: ExecutorConfig;
  readonly #harness: HarnessConfig;
  readonly #exec: Exec;

  constructor(config: ExecutorConfig, harness: HarnessConfig, exec: Exec) {
    this.config = config;
    this.#harness = harness;
    this.#exec = exec;
  }

  async run(job: ExecutorJob): Promise<ExecutorRun> {
    const config = this.#harness;
    const argv = heavyArgv(config, job.worktree, job.unit, job.script, job.env, job.repo, job.image);
    try {
      const proc = await this.#exec(argv.command, argv.args, {
        cwd: job.worktree,
        env: config.heavy.isolation === "none" ? job.env : clientEnv(),
        timeoutMs: job.timeoutMs,
        maxBytes: OUTPUT_TAIL,
        signal: job.signal,
        ...(job.onStdout ? { onStdout: job.onStdout } : {}),
        ...(job.onOutput ? { onOutput: job.onOutput } : {}),
      });
      // Le passage a tourné dans le worktree : ses modifications y sont déjà, ses rapports aussi.
      return { proc, reports: collectReports(job.worktree, job.reports), patch: null };
    } finally {
      if (config.heavy.isolation === "container" || (config.heavy.isolation === "systemd" && job.signal.aborted))
        await forceStop(config, this.#exec, job.unit, config.heavy.isolation).catch(() => {});
    }
  }
}

/** La ligne `ssh` vers une machine : sans mot de passe ni question, clé et port de l'exécuteur. */
export type SshTarget = { destination: string; options: string[] };

export function sshTarget(config: ExecutorConfig, host: string, ephemeral: boolean): SshTarget {
  const ssh = config.ssh ?? {};
  const user = ssh.user ?? (config.kind === "tart" ? "admin" : undefined);
  return {
    destination: user ? `${user}@${host}` : host,
    options: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      // Une VM jetable change de clé d'hôte à chaque clone : rien à retenir d'elle.
      ...(ephemeral
        ? ["-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "LogLevel=ERROR"]
        : ["-o", "StrictHostKeyChecking=accept-new"]),
      ...(ssh.port ? ["-p", String(ssh.port)] : []),
      ...(ssh.key ? ["-i", ssh.key] : []),
    ],
  };
}

/**
 * L'arbre courant du worktree (index temporaire : suivis + non suivis non ignorés), archivé et déposé dans `dir`
 * de la machine distante. `$SSH` est la commande ssh (un double en test).
 */
const SYNC = [
  "set -euo pipefail",
  'worktree="$1"; remote="$2"; shift 2',
  'index="$(mktemp)"; trap \'rm -f "$index"\' EXIT',
  'export GIT_INDEX_FILE="$index"',
  'git -C "$worktree" read-tree HEAD',
  'git -C "$worktree" add -A',
  'tree="$(git -C "$worktree" write-tree)"',
  "unset GIT_INDEX_FILE",
  'git -C "$worktree" archive --format=tar "$tree" | gzip -c | "$SSH" "$@" "$remote"',
].join("\n");

/** Les variables propres à la machine du service (chemins) : la machine distante garde les siennes. */
const LOCAL_ONLY_ENV = new Set(["PATH", "HOME", "TMPDIR", "CARGO_TARGET_DIR"]);

/** Le passage sur la machine : setup + commande ; pour `run_on`, l'arbre est d'abord figé pour en tirer le patch. */
export function remoteScript(dir: string, job: Pick<ExecutorJob, "script" | "env" | "patch">): string {
  const exports = Object.entries(job.env)
    .filter(([key]) => !LOCAL_ONLY_ENV.has(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  const body = `bash -lc ${shellQuote(job.script)}`;
  const run = job.patch
    ? [
        "git init -q . && git add -A && git -c user.name=omp -c user.email=omp@harness commit -qm base --no-verify",
        `${body}; code=$?`,
        "git add -A && git diff --cached --binary HEAD > .omp-run-on.patch",
        "exit $code",
      ]
    : [body];
  return [`cd ${shellQuote(dir)}`, ...exports, ...run].join("\n");
}

/** Les rapports d'un dossier distant, en globs bash (`**` compris), marqués un par un sur la sortie. */
export function reportsScript(dir: string, globs: string[]): string {
  return [
    `cd ${shellQuote(dir)} || exit 0`,
    "shopt -s globstar nullglob",
    `for f in ${globs.join(" ")}; do [ -f "$f" ] && printf '\\n${REPORT_MARK}%s>>>\\n' "$f" && head -c 4194304 "$f"; done`,
    "exit 0",
  ].join("\n");
}

/** Une machine jointe en ssh : dépôt de l'arbre, passage, rapports et patch rapatriés, dossier retiré. */
export class SshExecutor implements Executor {
  readonly config: ExecutorConfig;
  readonly #exec: Exec;
  readonly #ssh: string;

  constructor(config: ExecutorConfig, exec: Exec, sshCommand = "ssh") {
    this.config = config;
    this.#exec = exec;
    this.#ssh = sshCommand;
  }

  run(job: ExecutorJob): Promise<ExecutorRun> {
    return this.runOn(sshTarget(this.config, this.config.ssh?.host as string, false), job);
  }

  #call(target: SshTarget, script: string, options: { timeoutMs: number; signal?: AbortSignal; maxBytes?: number }) {
    return this.#exec(this.#ssh, [...target.options, target.destination, `bash -c ${shellQuote(script)}`], {
      env: clientEnv(),
      ...options,
    });
  }

  /** Le passage sur `target` (l'hôte de l'exécuteur, ou une VM jetable). */
  async runOn(target: SshTarget, job: ExecutorJob): Promise<ExecutorRun> {
    const dir = `${this.config.ssh?.workdir ?? "/tmp"}/${job.unit}`;
    try {
      const sync = await this.#exec(
        "bash",
        [
          "-c",
          SYNC,
          "sync",
          job.worktree,
          `mkdir -p ${shellQuote(dir)} && tar -xzf - -C ${shellQuote(dir)}`,
          ...target.options,
          target.destination,
        ],
        { env: { ...clientEnv(), SSH: this.#ssh }, timeoutMs: 300_000, signal: job.signal },
      );
      if (sync.code !== 0)
        return {
          proc: failedProc(`dépôt de l'arbre sur ${this.config.name} impossible : ${sync.stderr.trim().slice(-500)}`),
          reports: [],
          patch: null,
        };
      const proc = await this.#exec(
        this.#ssh,
        [...target.options, target.destination, `bash -c ${shellQuote(remoteScript(dir, job))}`],
        {
          env: clientEnv(),
          timeoutMs: job.timeoutMs,
          maxBytes: OUTPUT_TAIL,
          signal: job.signal,
          ...(job.onStdout ? { onStdout: job.onStdout } : {}),
          ...(job.onOutput ? { onOutput: job.onOutput } : {}),
        },
      );
      const fetched =
        job.reports.length > 0 && !job.signal.aborted
          ? await this.#call(target, reportsScript(dir, job.reports), {
              timeoutMs: 120_000,
              maxBytes: 16 * 1024 * 1024,
            })
          : null;
      const patch =
        job.patch && !job.signal.aborted
          ? await this.#call(target, `cat ${shellQuote(`${dir}/.omp-run-on.patch`)}`, {
              timeoutMs: 120_000,
              maxBytes: 16 * 1024 * 1024,
            })
          : null;
      return {
        proc,
        reports: fetched?.code === 0 ? parseReports(fetched.stdout) : [],
        patch: patch?.code === 0 ? patch.stdout : null,
      };
    } finally {
      await this.#call(target, `rm -rf ${shellQuote(dir)}`, { timeoutMs: 60_000 }).catch(() => {});
    }
  }
}

/** Une VM macOS jetable : clonée, démarrée sans écran, jointe en ssh, puis arrêtée et supprimée. */
export class TartExecutor implements Executor {
  readonly config: ExecutorConfig;
  readonly #exec: Exec;
  readonly #ssh: SshExecutor;
  readonly #sshCommand: string;
  readonly #tart: string;

  constructor(config: ExecutorConfig, exec: Exec, commands: { ssh?: string; tart?: string } = {}) {
    this.config = config;
    this.#exec = exec;
    this.#sshCommand = commands.ssh ?? "ssh";
    this.#ssh = new SshExecutor(config, exec, this.#sshCommand);
    this.#tart = commands.tart ?? "tart";
  }

  async run(job: ExecutorJob): Promise<ExecutorRun> {
    const vm = job.unit;
    const tart = (args: string[], timeoutMs = 600_000) =>
      this.#exec(this.#tart, args, { env: clientEnv(), timeoutMs, signal: job.signal });
    const cloned = await tart(["clone", this.config.tart?.image as string, vm]);
    if (cloned.code !== 0)
      return {
        proc: failedProc(`tart clone ${this.config.tart?.image} impossible : ${cloned.stderr.trim().slice(-500)}`),
        reports: [],
        patch: null,
      };
    const machine = new AbortController();
    const running = this.#exec(this.#tart, ["run", "--no-graphics", vm], {
      env: clientEnv(),
      timeoutMs: job.timeoutMs + 900_000,
      signal: machine.signal,
    }).catch(() => null);
    try {
      const ip = await tart(["ip", "--wait", "180", vm], 200_000);
      const host = ip.stdout.trim();
      if (ip.code !== 0 || host === "")
        return {
          proc: failedProc(`la VM ${vm} n'a pas d'adresse : ${ip.stderr.trim().slice(-500)}`),
          reports: [],
          patch: null,
        };
      const target = sshTarget(this.config, host, true);
      // sshd démarre après l'adresse : quelques secondes d'attente au plus.
      for (let i = 0; i < 30; i++) {
        const up = await this.#exec(this.#sshCommand, [...target.options, target.destination, "true"], {
          env: clientEnv(),
          timeoutMs: 20_000,
          signal: job.signal,
        });
        if (up.code === 0 || job.signal.aborted) break;
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
      return await this.#ssh.runOn(target, job);
    } finally {
      await this.#exec(this.#tart, ["stop", vm], { env: clientEnv(), timeoutMs: 60_000 }).catch(() => null);
      machine.abort();
      await running;
      await this.#exec(this.#tart, ["delete", vm], { env: clientEnv(), timeoutMs: 120_000 }).catch(() => null);
    }
  }
}

export type PoolDeps = {
  config: HarnessConfig;
  exec: Exec;
  scheduler: Scheduler;
  /** Les commandes `ssh` et `tart` (des doubles en test). */
  commands?: { ssh?: string; tart?: string };
};

/** Un exécuteur pris : à rendre une fois le passage fini. */
export type Lease = { executor: Executor; release: () => void };

/** Les exécuteurs du service : celui du heavy local, puis ceux déclarés ; un slot par passage. */
export class ExecutorPool {
  readonly #deps: PoolDeps;
  readonly #executors: Executor[];
  readonly #busy = new Map<string, number>();

  constructor(deps: PoolDeps) {
    this.#deps = deps;
    const declared = deps.config.executors;
    const local = declared.find((executor) => executor.kind === "local") ?? {
      name: "local",
      kind: "local" as const,
      labels: localLabels(deps.config),
      slots: deps.config.heavy.slots,
    };
    this.#executors = [local, ...declared.filter((executor) => executor.kind !== "local")].map((executor) => {
      if (executor.kind === "local") return new LocalExecutor(executor, deps.config, deps.exec);
      if (executor.kind === "ssh") return new SshExecutor(executor, deps.exec, deps.commands?.ssh);
      return new TartExecutor(executor, deps.exec, deps.commands ?? {});
    });
  }

  get executors(): readonly Executor[] {
    return this.#executors;
  }

  /** Les exécuteurs qui portent ces exigences. */
  matching(requires: Record<string, string>): Executor[] {
    return this.#executors.filter((executor) => satisfies(executor.config.labels, requires));
  }

  /**
   * Un exécuteur qui porte les exigences, le moins chargé d'abord ; attend qu'un slot se libère s'ils sont tous
   * pris. `null` : aucun n'en porte (la cible ne peut tourner nulle part). Le local passe par le slot heavy.
   */
  async acquire(
    requires: Record<string, string>,
    label: string,
    signal: AbortSignal,
    priority = 0,
  ): Promise<Lease | null> {
    const candidates = this.matching(requires);
    if (candidates.length === 0) return null;
    for (;;) {
      if (signal.aborted) throw new Error("attente d'exécuteur annulée");
      const free = candidates
        .filter(
          (executor) =>
            executor.config.kind === "local" || (this.#busy.get(executor.config.name) ?? 0) < executor.config.slots,
        )
        .sort(
          (a, b) =>
            (this.#busy.get(a.config.name) ?? 0) / a.config.slots -
            (this.#busy.get(b.config.name) ?? 0) / b.config.slots,
        );
      // Un exécuteur distant libre d'abord : le slot heavy local, borné par la mémoire du service, en dernier.
      const remote = free.find((executor) => executor.config.kind !== "local");
      if (remote) return this.#take(remote);
      const local = free.find((executor) => executor.config.kind === "local");
      if (local) {
        const slot: Slot = await this.#deps.scheduler.acquire("heavy", label, signal, priority);
        const lease = this.#take(local);
        return {
          executor: local,
          release: () => {
            lease.release();
            slot.release();
          },
        };
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  #take(executor: Executor): Lease {
    const name = executor.config.name;
    this.#busy.set(name, (this.#busy.get(name) ?? 0) + 1);
    let released = false;
    return {
      executor,
      release: () => {
        if (released) return;
        released = true;
        this.#busy.set(name, (this.#busy.get(name) ?? 1) - 1);
      },
    };
  }
}
