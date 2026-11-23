// Les exécuteurs des cibles d'un dépôt (`.harness-env.json`) : où tourne chaque passage de
// tests, ou chaque commande de `run_on`.
//
// - `local` : le heavy du service (slot heavy, isolation du service, image de la cible en
//   conteneur), dans le worktree lui-même ;
// - `ssh` : une machine jointe en ssh (un Mac, un Linux d'une autre architecture). L'arbre
//   COURANT du worktree y est déposé (archive d'un index temporaire : fichiers suivis et
//   non ignorés, modifications non commitées comprises), le passage y tourne, ses rapports
//   et, pour `run_on`, ses modifications (un patch binaire) reviennent ; le dossier est retiré ;
// - `tart` : une VM jetable (macOS, ou Linux arm64) clonée de l'image de la cible (sa recette
//   `vm`, construite et gardée par le harness) ou de `tart.image`, démarrée sans écran, pilotée
//   par `tart exec`, puis arrêtée et supprimée : rien ne survit d'un job à l'autre. Le Mac de
//   Tart est cette machine, ou un Mac joint en ssh (le service tourne sur un VPS Linux).
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
  /** La VM de la cible (exécuteur `tart`) : sa recette et le nom de son image ; `null` : l'image de l'exécuteur. */
  vm: VmJob | null;
  /** Les rapports à rapatrier (globs relatifs au dépôt). */
  reports: string[];
  /** `run_on` : les modifications du passage reviennent au worktree. */
  patch: boolean;
  timeoutMs: number;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
  onStdout?: (chunk: Buffer) => void;
};

/** Une recette de VM résolue pour un dépôt et une cible : `image` porte l'empreinte, `prefix` ses devancières. */
export type VmJob = { image: string; prefix: string; base: string; provision: string[] };

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

/**
 * L'exécuteur peut-il prendre la cible ? Une cible à recette `vm` veut une VM Tart, et son `os` est celui de la
 * VM (pas de l'exécuteur) ; une autre veut ses exigences sur l'exécuteur, et un Tart sans `tart.image` ne la prend pas.
 */
export function canHost(config: ExecutorConfig, requires: Record<string, string>, vm: boolean): boolean {
  if (vm) {
    const { os: _os, ...rest } = requires;
    return config.kind === "tart" && satisfies(config.labels, rest);
  }
  if (config.kind === "tart" && !config.tart?.image) return false;
  return satisfies(config.labels, requires);
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

export function sshTarget(config: ExecutorConfig, host: string): SshTarget {
  const ssh = config.ssh ?? {};
  return {
    destination: ssh.user ? `${ssh.user}@${host}` : host,
    options: [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=15",
      "-o",
      "StrictHostKeyChecking=accept-new",
      ...(ssh.port ? ["-p", String(ssh.port)] : []),
      ...(ssh.key ? ["-i", ssh.key] : []),
    ],
  };
}

/**
 * Comment lancer un script bash là où tourne un passage : `command` puis `argv(script)`. `stdin` : l'entrée
 * standard du process y est attachée (le dépôt de l'arbre).
 */
export type Shell = { command: string; argv: (script: string, stdin: boolean) => string[] };

/** Un script bash sur une machine jointe en ssh. */
export function sshShell(command: string, target: SshTarget): Shell {
  return { command, argv: (script) => [...target.options, target.destination, `bash -c ${shellQuote(script)}`] };
}

/**
 * L'arbre courant du worktree (index temporaire : suivis + non suivis non ignorés), archivé et passé à la
 * commande `"$@"` (le shell du passage, qui le déballe).
 */
const SYNC = [
  "set -euo pipefail",
  'worktree="$1"; shift',
  'index="$(mktemp)"; trap \'rm -f "$index"\' EXIT',
  'export GIT_INDEX_FILE="$index"',
  'git -C "$worktree" read-tree HEAD',
  'git -C "$worktree" add -A',
  'tree="$(git -C "$worktree" write-tree)"',
  "unset GIT_INDEX_FILE",
  'git -C "$worktree" archive --format=tar "$tree" | gzip -c | "$@"',
].join("\n");

/** Les variables propres à la machine du service (chemins) : la machine distante garde les siennes. */
const LOCAL_ONLY_ENV = new Set(["PATH", "HOME", "TMPDIR", "CARGO_TARGET_DIR"]);

/** Le passage sur la machine : setup + commande ; pour `run_on`, l'arbre est d'abord figé pour en tirer le patch. */
export function remoteScript(dir: string, job: Pick<ExecutorJob, "script" | "env" | "patch">): string {
  const exports = Object.entries(job.env)
    .filter(([key]) => !LOCAL_ONLY_ENV.has(key))
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  // Sans entrée standard, comme un passage local : celle de `ssh` ou de `tart exec` reste ouverte, et un process
  // qui l'hérite peut s'y bloquer (un serveur de test lancé par la suite ne démarrait jamais dans une VM).
  const body = `bash -lc ${shellQuote(job.script)} </dev/null`;
  const run = job.patch
    ? [
        "git init -q . && git add -A && git -c user.name=omp -c user.email=omp@harness commit -qm base --no-verify",
        `${body}; code=$?`,
        "git add -A && git diff --cached --binary HEAD > .omp-run-on.patch",
        "exit $code",
      ]
    : [body];
  // Le chemin physique, sans lien : un outil qui compare un chemin résolu à un chemin logique les découpe mal.
  return [`cd ${shellQuote(dir)}`, 'cd "$(pwd -P)"', ...exports, ...run].join("\n");
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

/**
 * Un passage sur une machine distante, par son `shell` : l'arbre déposé dans `dir`, le passage, ses rapports et
 * son patch rapatriés, le dossier retiré. `where` nomme la machine dans les erreurs.
 */
export async function runThrough(
  exec: Exec,
  shell: Shell,
  dir: string,
  where: string,
  job: ExecutorJob,
): Promise<ExecutorRun> {
  const call = (script: string, options: { timeoutMs: number; signal?: AbortSignal; maxBytes?: number }) =>
    exec(shell.command, shell.argv(script, false), { env: clientEnv(), ...options });
  try {
    const sync = await exec(
      "bash",
      [
        "-c",
        SYNC,
        "sync",
        job.worktree,
        shell.command,
        ...shell.argv(`mkdir -p ${shellQuote(dir)} && tar -xzf - -C ${shellQuote(dir)}`, true),
      ],
      { env: clientEnv(), timeoutMs: 300_000, signal: job.signal },
    );
    if (sync.code !== 0)
      return {
        proc: failedProc(`dépôt de l'arbre sur ${where} impossible : ${sync.stderr.trim().slice(-500)}`),
        reports: [],
        patch: null,
      };
    const proc = await call(remoteScript(dir, job), {
      timeoutMs: job.timeoutMs,
      maxBytes: OUTPUT_TAIL,
      signal: job.signal,
      ...(job.onStdout ? { onStdout: job.onStdout } : {}),
      ...(job.onOutput ? { onOutput: job.onOutput } : {}),
    });
    const fetched =
      job.reports.length > 0 && !job.signal.aborted
        ? await call(reportsScript(dir, job.reports), { timeoutMs: 120_000, maxBytes: 16 * 1024 * 1024 })
        : null;
    const patch =
      job.patch && !job.signal.aborted
        ? await call(`cat ${shellQuote(`${dir}/.omp-run-on.patch`)}`, {
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
    await call(`rm -rf ${shellQuote(dir)}`, { timeoutMs: 60_000 }).catch(() => {});
  }
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
    const shell = sshShell(this.#ssh, sshTarget(this.config, this.config.ssh?.host as string));
    return runThrough(this.#exec, shell, `${this.config.ssh?.workdir ?? "/tmp"}/${job.unit}`, this.config.name, job);
  }
}

/** Le PATH d'une session ssh non interactive sur un Mac n'a pas Homebrew : `tart` y est. */
const MAC_PATH = 'PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"';

/** Le préfixe des images construites d'une cible : `omp-vm-<dépôt>-<cible>-`. */
export function vmImagePrefix(repo: string, target: string): string {
  return `omp-vm-${`${repo}-${target}`.toLowerCase().replace(/[^a-z0-9-]/g, "-")}-`;
}

/**
 * Les VM Tart d'un Mac : jetables, clonées pour un passage (copie à l'écriture APFS : instantané), démarrées sans
 * écran, pilotées par `tart exec` (l'agent invité des images Cirrus : ni clé, ni mot de passe, ni adresse), puis
 * arrêtées et supprimées. Le Mac est cette machine, ou celui de `ssh.host` (le service sur un VPS) : chaque
 * commande `tart` y part alors en ssh.
 *
 * L'image d'un passage est la recette `vm` de sa cible, construite ici une fois puis gardée (son nom porte
 * l'empreinte de la recette), sinon l'image fixe de l'exécuteur (`tart.image`).
 */
export class TartExecutor implements Executor {
  readonly config: ExecutorConfig;
  readonly #exec: Exec;
  readonly #ssh: string;
  readonly #tart: string;
  /** Les images en construction, par nom : une construction à la fois par image. */
  readonly #builds = new Map<string, Promise<{ image: string } | { error: string }>>();

  constructor(config: ExecutorConfig, exec: Exec, commands: { ssh?: string; tart?: string } = {}) {
    this.config = config;
    this.#exec = exec;
    this.#ssh = commands.ssh ?? "ssh";
    this.#tart = commands.tart ?? "tart";
  }

  /** La ligne de commande d'un appel `tart` : ici, ou sur le Mac de `ssh.host`. */
  tartArgv(args: string[]): { command: string; args: string[] } {
    const host = this.config.ssh?.host;
    if (host === undefined) return { command: this.#tart, args };
    const target = sshTarget(this.config, host);
    const line = `${MAC_PATH} ${[this.#tart, ...args].map(shellQuote).join(" ")}`;
    return { command: this.#ssh, args: [...target.options, target.destination, line] };
  }

  #call(args: string[], timeoutMs: number, signal?: AbortSignal): Promise<ProcResult> {
    const argv = this.tartArgv(args);
    return this.#exec(argv.command, argv.args, {
      env: clientEnv(),
      timeoutMs,
      maxBytes: OUTPUT_TAIL,
      ...(signal ? { signal } : {}),
    });
  }

  /** Un script bash dans la VM, par son agent invité. */
  shell(vm: string): Shell {
    return {
      command: this.tartArgv([]).command,
      argv: (script, stdin) => this.tartArgv(["exec", ...(stdin ? ["-i"] : []), vm, "bash", "-c", script]).args,
    };
  }

  /** La VM démarrée sans écran ; `stop()` l'arrête. Une erreur si son agent ne répond pas (la VM est alors arrêtée). */
  async #boot(vm: string, signal?: AbortSignal): Promise<{ stop: () => Promise<void> } | { error: string }> {
    const machine = new AbortController();
    const argv = this.tartArgv(["run", "--no-graphics", vm]);
    let exited: ProcResult | null = null;
    const running = this.#exec(argv.command, argv.args, {
      env: clientEnv(),
      timeoutMs: 24 * 3_600_000,
      signal: machine.signal,
    })
      .then((result) => {
        exited = result;
      })
      .catch(() => {});
    const stop = async () => {
      await this.#call(["stop", vm], 60_000).catch(() => null);
      machine.abort();
      await running;
    };
    // L'agent invité répond quelques secondes après le démarrage : jusqu'à 3 minutes d'attente.
    const deadline = Date.now() + 180_000;
    let last = "";
    while (Date.now() < deadline && !signal?.aborted && exited === null) {
      const up = await this.#call(["exec", vm, "true"], 20_000, signal).catch(() => null);
      if (up?.code === 0) return { stop };
      last = up?.stderr.trim() ?? "";
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    await stop();
    const why = exited === null ? last : `tart run a quitté : ${(exited as ProcResult).stderr.trim()}`;
    return { error: `la VM ${vm} ne répond pas (agent invité de Tart) : ${why.slice(-500)}` };
  }

  /**
   * L'image du passage, prête : celle de la recette (construite si absente : la base clonée, démarrée, chaque
   * étape lancée, arrêtée, renommée ; les images d'une recette précédente retirées), sinon `tart.image`.
   */
  image(job: Pick<ExecutorJob, "vm">): Promise<{ image: string } | { error: string }> {
    if (job.vm === null)
      return Promise.resolve(
        this.config.tart?.image
          ? { image: this.config.tart.image }
          : {
              error: `l'exécuteur ${this.config.name} n'a pas d'image (\`tart.image\`) et la cible pas de recette (\`vm\`)`,
            },
      );
    const recipe = job.vm;
    let built = this.#builds.get(recipe.image);
    if (!built) {
      built = this.#build(recipe);
      this.#builds.set(recipe.image, built);
      // Un échec se retente au passage suivant (la recette ou le réseau a pu être réparé).
      void built.then((outcome) => {
        if ("error" in outcome) this.#builds.delete(recipe.image);
      });
    }
    return built;
  }

  async #build(recipe: VmJob): Promise<{ image: string } | { error: string }> {
    if ((await this.#call(["get", recipe.image], 60_000)).code === 0) return { image: recipe.image };
    // Une construction n'appartient à aucun job : l'annulation de l'un ne la coupe pas, seule sa durée la borne.
    const scratch = `${recipe.image}-build`;
    await this.#call(["delete", scratch], 120_000).catch(() => null);
    const cloned = await this.#call(["clone", recipe.base, scratch], 3 * 3_600_000);
    if (cloned.code !== 0)
      return { error: `tart clone ${recipe.base} impossible : ${cloned.stderr.trim().slice(-500)}` };
    let ok = false;
    try {
      const booted = await this.#boot(scratch);
      if ("error" in booted) return booted;
      try {
        const shell = this.shell(scratch);
        for (const step of recipe.provision) {
          const done = await this.#exec(shell.command, shell.argv(`bash -lc ${shellQuote(step)} </dev/null`, false), {
            env: clientEnv(),
            timeoutMs: 2 * 3_600_000,
            maxBytes: OUTPUT_TAIL,
          });
          if (done.code !== 0)
            return {
              error: `construction de l'image ${recipe.image} : « ${step} » a échoué (code ${done.code}) :\n${`${done.stdout}\n${done.stderr}`.trim().slice(-4000)}`,
            };
        }
      } finally {
        await booted.stop();
      }
      const renamed = await this.#call(["rename", scratch, recipe.image], 120_000);
      if (renamed.code !== 0)
        return { error: `tart rename ${scratch} impossible : ${renamed.stderr.trim().slice(-500)}` };
      ok = true;
    } finally {
      if (!ok) await this.#call(["delete", scratch], 120_000).catch(() => null);
    }
    await this.#prune(recipe);
    return { image: recipe.image };
  }

  /** Les images des recettes précédentes de la cible : retirées (une image Xcode pèse des dizaines de Go). */
  async #prune(recipe: VmJob): Promise<void> {
    const listed = await this.#call(["list", "--source", "local", "--format", "json"], 60_000).catch(() => null);
    if (listed?.code !== 0) return;
    let names: string[] = [];
    try {
      names = (JSON.parse(listed.stdout) as { Name?: unknown }[])
        .map((vm) => vm.Name)
        .filter((name): name is string => typeof name === "string");
    } catch {
      return;
    }
    for (const name of names)
      if (name.startsWith(recipe.prefix) && name !== recipe.image && !name.endsWith("-build"))
        await this.#call(["delete", name], 120_000).catch(() => null);
  }

  async run(job: ExecutorJob): Promise<ExecutorRun> {
    const image = await this.image(job);
    if ("error" in image) return { proc: failedProc(image.error), reports: [], patch: null };
    const vm = job.unit;
    const cloned = await this.#call(["clone", image.image, vm], 600_000, job.signal);
    if (cloned.code !== 0)
      return {
        proc: failedProc(`tart clone ${image.image} impossible : ${cloned.stderr.trim().slice(-500)}`),
        reports: [],
        patch: null,
      };
    try {
      const booted = await this.#boot(vm, job.signal);
      if ("error" in booted) return { proc: failedProc(booted.error), reports: [], patch: null };
      try {
        const shell = this.shell(vm);
        // Sous le dossier de l'utilisateur de la VM, jamais `/tmp` : sur macOS, Foundation rend `/private/tmp/…`
        // en `/tmp/…` et le compilateur l'inverse, et un test qui découpe ses chemins de sources s'y perd.
        const home = await this.#exec(shell.command, shell.argv('printf %s "$HOME"', false), {
          env: clientEnv(),
          timeoutMs: 60_000,
          signal: job.signal,
        });
        const root = home.code === 0 && /^\/[\w./-]+$/.test(home.stdout.trim()) ? home.stdout.trim() : "/tmp";
        return await runThrough(
          this.#exec,
          shell,
          `${root}/omp-jobs/${job.unit}`,
          `${this.config.name} (VM ${vm})`,
          job,
        );
      } finally {
        await booted.stop();
      }
    } finally {
      await this.#call(["delete", vm], 120_000).catch(() => null);
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

  /** Les exécuteurs qui portent ces exigences (`vm` : une cible à recette de VM, que seul un Tart prend). */
  matching(requires: Record<string, string>, vm = false): Executor[] {
    return this.#executors.filter((executor) => canHost(executor.config, requires, vm));
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
    vm = false,
  ): Promise<Lease | null> {
    const candidates = this.matching(requires, vm);
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
