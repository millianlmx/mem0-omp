// Les jobs HEAVY (tests, builds) : lancés par l'outil `run_tests` d'un runner, dans
// son worktree, pendant que le runner attend (bloqué sur l'appel d'outil).
//
// Avant tout lancement, le cache est consulté par tree hash + commande + env : un
// arbre déjà testé ne reprend pas de slot. Sinon le job prend un slot heavy et part
// dans une unité systemd transitoire — MemoryMax=4G, CPUQuota=300 %, user dédié,
// PrivateNetwork, aucune clé dans l'environnement. Un OOM est un job raté, jamais la
// box : échec structuré, et 2 relances.
//
// Le schéma dit `systemd-run --scope` ; une scope ne porte ni `User=` ni
// `PrivateNetwork=` (propriétés d'exécution). Le job est donc un SERVICE transitoire
// (`--wait --pipe`) : mêmes limites cgroup, plus l'isolation demandée.
//
// En isolation `container`, le job est un conteneur frère de l'image de tests du
// dépôt : `--network=none`, mêmes plafonds, aucun secret monté, worktree en écriture
// et clone en lecture seulement.
import { createHash } from "node:crypto";
import * as path from "node:path";
import { launch } from "./config.ts";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import { containerUser, engine, forceStop } from "./runner.ts";
import type { Store } from "./db.ts";
import type { Exec, ProcResult } from "./proc.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Git } from "./git.ts";

export type TestScope = "touched" | "full" | "check";

export type HeavyOutcome = "pass" | "fail" | "oom" | "timeout" | "error" | "aborted";

export type HeavyJob = {
  runId: string;
  stepId: number | null;
  repo: RepoConfig;
  worktree: string;
  scope: TestScope;
  /** Les fichiers touchés (scope `touched`). */
  files: string[];
  /** Le nom de la commande dans `repo.checks` (scope `check`). */
  check?: string;
  /** La priorité du run : à attente égale, un job plus prioritaire prend le slot heavy d'abord. */
  priority?: number;
};

export type HeavyResult = {
  outcome: HeavyOutcome;
  exitCode: number | null;
  /** La fin de la sortie (stdout puis stderr). */
  output: string;
  durationMs: number;
  attempts: number;
  cached: boolean;
  /** Rien n'a été lancé (aucun fichier de test touché) : `outcome` vaut `pass` et `note` le dit. */
  skipped: boolean;
  note: string | null;
  tree: string;
  key: string;
  command: string;
};

/** Les octets de sortie gardés d'un job : la fin, là où est l'échec. */
export const OUTPUT_TAIL = 20_000;

/** Une chaîne citée pour `bash -c`. */
export function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Un glob maison (`**` : tout chemin, `*` : tout sauf `/`, `?` : un caractère) contre
 * un chemin relatif au worktree. Un motif sans `/` se compare au nom de fichier.
 */
export function matchesGlob(pattern: string, file: string): boolean {
  let regex = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*" && pattern[i + 1] === "*") {
      const slash = pattern[i + 2] === "/";
      regex += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (char === "*") regex += "[^/]*";
    else if (char === "?") regex += "[^/]";
    else regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const subject = pattern.includes("/") ? file : (file.split("/").pop() ?? file);
  return new RegExp(`^${regex}$`).test(subject);
}

/** Les fichiers de `files` qui sont des tests selon `repo.tests.pattern` (`null` : tous). */
export function testFiles(repo: RepoConfig, files: string[]): string[] {
  const pattern = repo.tests.pattern;
  return pattern === null ? files : files.filter((file) => matchesGlob(pattern, file));
}

/**
 * La commande d'une scope, ou `null` : scope `touched` sans fichier de test (rien à
 * lancer), scope `check` sans commande de ce nom.
 */
export function testCommand(repo: RepoConfig, scope: TestScope, files: string[], check?: string): string | null {
  switch (scope) {
    case "full":
      return repo.tests.full;
    case "check":
      return check !== undefined && Object.hasOwn(repo.checks, check) ? repo.checks[check] : null;
    case "touched": {
      const tests = testFiles(repo, files);
      if (tests.length === 0) return null;
      const quoted = tests.map(shellQuote).join(" ");
      return repo.tests.touched.includes("{files}")
        ? repo.tests.touched.split("{files}").join(quoted)
        : `${repo.tests.touched} ${quoted}`;
    }
    default: {
      const _exhaustive: never = scope;
      return _exhaustive;
    }
  }
}

/** Variables qui changent d'un worktree à l'autre sans changer le résultat : hors clé de cache. */
const KEY_EXCLUDED_ENV = new Set(["CARGO_TARGET_DIR", "HOME", "TMPDIR"]);

/** L'environnement COMPLET d'un job heavy : rien n'est hérité du service (aucune clé). */
export function heavyEnv(config: HarnessConfig, worktree: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    LANG: "C.UTF-8",
    CI: "1",
  };
  if (config.heavy.cargoTargetRoot)
    env.CARGO_TARGET_DIR = path.join(config.heavy.cargoTargetRoot, path.basename(worktree));
  return { ...env, ...config.heavy.env };
}

/** La clé du cache : tree hash + commande + env (hors variables de chemin propres au worktree). */
export function cacheKey(tree: string, command: string, env: Record<string, string>): string {
  const stable = Object.keys(env)
    .filter((key) => !KEY_EXCLUDED_ENV.has(key))
    .sort()
    .map((key) => [key, env[key]]);
  return createHash("sha256")
    .update(JSON.stringify({ tree, command, env: stable }))
    .digest("hex");
}

/** `300%` → `3` : le quota CPU de systemd en nombre de cœurs du moteur. */
export function cpusOf(quota: string): string {
  return String(Number.parseInt(quota, 10) / 100);
}

/** Le job en conteneur frère : sans réseau ni secret, worktree en écriture, clone en lecture. */
function containerHeavyArgv(
  config: HarnessConfig,
  repo: RepoConfig,
  worktree: string,
  unit: string,
  command: string,
  env: Record<string, string>,
): { command: string; args: string[] } {
  const heavy = config.heavy;
  const writable = [worktree, ...(heavy.cargoTargetRoot ? [heavy.cargoTargetRoot] : []), ...heavy.readWritePaths];
  return engine(config, [
    "run",
    "--rm",
    "--init",
    `--name=${unit}`,
    "--label=omp-harness=heavy",
    "--network=none",
    `--memory=${heavy.memoryMax}`,
    `--memory-swap=${heavy.memoryMax}`,
    `--cpus=${cpusOf(heavy.cpuQuota)}`,
    `--oom-score-adj=${heavy.oomScoreAdjust}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--user=${containerUser(config)}`,
    "--tmpfs=/tmp",
    `--workdir=${worktree}`,
    ...[...new Set(writable)].flatMap((dir) => ["--volume", `${dir}:${dir}`]),
    ...(writable.includes(repo.path) ? [] : ["--volume", `${repo.path}:${repo.path}:ro`]),
    ...Object.entries({ HOME: "/tmp", ...env }).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    repo.testImage ?? config.container.testImage,
    "bash",
    "-c",
    command,
  ]);
}

/** La ligne de commande d'un job : unité systemd transitoire, conteneur frère, ou `bash -c` nu (isolation `none`). */
export function heavyArgv(
  config: HarnessConfig,
  worktree: string,
  unit: string,
  command: string,
  env: Record<string, string>,
  repo?: RepoConfig,
): { command: string; args: string[] } {
  if (config.heavy.isolation === "none") return { command: "bash", args: ["-c", command] };
  if (config.heavy.isolation === "container") {
    if (!repo) throw new Error("isolation container : le dépôt du job est requis (image de tests, clone)");
    return containerHeavyArgv(config, repo, worktree, unit, command, env);
  }
  const heavy = config.heavy;
  const writable = [worktree, ...(heavy.cargoTargetRoot ? [heavy.cargoTargetRoot] : []), ...heavy.readWritePaths];
  const args = [
    "--wait",
    "--pipe",
    "--collect",
    "--service-type=exec",
    `--unit=${unit}`,
    `--slice=${heavy.slice}`,
    `--working-directory=${worktree}`,
    "-p",
    `MemoryMax=${heavy.memoryMax}`,
    "-p",
    `CPUQuota=${heavy.cpuQuota}`,
    "-p",
    `User=${heavy.user}`,
    "-p",
    "PrivateNetwork=yes",
    "-p",
    `OOMScoreAdjust=${heavy.oomScoreAdjust}`,
    "-p",
    `RuntimeMaxSec=${heavy.timeoutSec}`,
    "-p",
    "NoNewPrivileges=yes",
    "-p",
    "PrivateTmp=yes",
    "-p",
    "UMask=0002",
    "-p",
    "ProtectSystem=strict",
    "-p",
    `ReadWritePaths=${writable.join(" ")}`,
    ...Object.entries(env).map(([key, value]) => `--setenv=${key}=${value}`),
    "--",
    heavy.shell,
    "-c",
    command,
  ];
  return launch(config, args);
}

/** Le `Finished with result: …` de `systemd-run --wait`, ou `null`. */
export function systemdResult(stderr: string): string | null {
  const match = /Finished with result:\s*([\w-]+)/.exec(stderr);
  return match ? (match[1] as string) : null;
}

/** L'issue d'un job à partir de son process. */
export function classify(result: ProcResult): HeavyOutcome {
  const unitResult = systemdResult(result.stderr);
  if (result.aborted) return "aborted";
  if (result.timedOut || unitResult === "timeout") return "timeout";
  if (unitResult === "oom-kill" || result.code === 137 || (result.code === null && result.signal === "SIGKILL"))
    return "oom";
  if (result.code === 0) return "pass";
  if (result.code === 127 && result.stdout === "") return "error";
  return "fail";
}

/** L'environnement du CLI qui lance le job : de quoi joindre le moteur, rien d'autre. */
function clientEnv(): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin" };
  for (const key of ["HOME", "DOCKER_HOST", "CONTAINER_HOST", "XDG_RUNTIME_DIR"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export type HeavyDeps = {
  config: HarnessConfig;
  store: Store;
  scheduler: Scheduler;
  git: Git;
  exec: Exec;
  now?: () => number;
};

/** Un job en vol : sa promesse, ses appelants qui attendent encore, et de quoi l'arrêter. */
type Flight = {
  promise: Promise<HeavyResult>;
  waiters: number;
  controller: AbortController;
};

/** Le résultat d'un job qui n'a rien lancé (base des issues `skipped` et `error` avant tout process). */
const NOTHING_RAN: HeavyResult = {
  outcome: "pass",
  exitCode: null,
  output: "",
  durationMs: 0,
  attempts: 0,
  cached: false,
  skipped: false,
  note: null,
  tree: "",
  key: "",
  command: "",
};

type JobId = { key: string; tree: string; command: string; env: Record<string, string> };

export class HeavyRunner {
  readonly #deps: HeavyDeps;
  readonly #flights = new Map<string, Flight>();
  #seq = 0;

  constructor(deps: HeavyDeps) {
    this.#deps = deps;
  }

  /** La clé de cache de la scope sur l'arbre COURANT du worktree, ou `null` si rien à tester. */
  async keyFor(
    job: Omit<HeavyJob, "runId" | "stepId">,
  ): Promise<{ key: string; tree: string; command: string } | null> {
    const command = testCommand(job.repo, job.scope, job.files, job.check);
    if (command === null) return null;
    const tree = await this.#deps.git.workingTreeHash(job.worktree);
    return { key: cacheKey(tree, command, heavyEnv(this.#deps.config, job.worktree)), tree, command };
  }

  /** Les clés des jobs en vol (observabilité, tests). */
  get inFlight(): string[] {
    return [...this.#flights.keys()];
  }

  /**
   * Le résultat de la scope sur l'arbre courant : le cache (vert seulement), le job
   * déjà en vol sur la même clé (rejoint), ou un job neuf. `signal` est celui de
   * l'APPELANT : son arrêt le désabonne ; le job n'est tué que quand plus personne
   * ne l'attend.
   */
  async run(job: HeavyJob, signal?: AbortSignal): Promise<HeavyResult> {
    const { config, store } = this.#deps;
    if (signal?.aborted) throw new Error("job heavy annulé : appel arrêté");
    const env = heavyEnv(config, job.worktree);
    const command = testCommand(job.repo, job.scope, job.files, job.check);
    if (command === null) {
      if (job.scope === "check") {
        const known = Object.keys(job.repo.checks);
        const list = known.length > 0 ? `connus : ${known.join(", ")}` : "aucun check déclaré";
        return { ...NOTHING_RAN, outcome: "error", output: `check inconnu : ${job.check ?? "(aucun nom)"} (${list})` };
      }
      const note = job.files.length === 0 ? "aucun fichier touché : rien à tester" : "aucun test touché";
      store.appendEvent("heavy_skipped", job.runId, { scope: job.scope, files: job.files.length, note });
      return { ...NOTHING_RAN, skipped: true, note, output: note };
    }
    const tree = await this.#deps.git.workingTreeHash(job.worktree);
    const key = cacheKey(tree, command, env);

    const hit = store.cacheGet(key);
    if (hit && hit.outcome === "pass") {
      store.addTestRun({
        runId: job.runId,
        stepId: job.stepId,
        scope: job.scope,
        key,
        tree,
        outcome: hit.outcome,
        cached: true,
        attempts: 0,
      });
      store.appendEvent("heavy_cached", job.runId, { scope: job.scope, outcome: hit.outcome, tree });
      return {
        outcome: hit.outcome,
        exitCode: hit.exitCode,
        output: hit.output,
        durationMs: hit.durationMs,
        attempts: 0,
        cached: true,
        skipped: false,
        note: null,
        tree,
        key,
        command,
      };
    }

    // Un job que plus personne n'attend est en train de mourir : on n'y monte pas.
    const live = this.#flights.get(key);
    let flight = live && !live.controller.signal.aborted ? live : undefined;
    if (flight) {
      store.appendEvent("heavy_joined", job.runId, { scope: job.scope, tree, waiters: flight.waiters + 1 });
    } else {
      const controller = new AbortController();
      const created: Flight = { promise: Promise.resolve(NOTHING_RAN), waiters: 0, controller };
      created.promise = this.#execute(job, { key, tree, command, env }, controller.signal).finally(() => {
        if (this.#flights.get(key) === created) this.#flights.delete(key);
      });
      // Un job abandonné par tous (slot refusé, process tué) rejette sans personne pour l'entendre.
      created.promise.catch(() => {});
      this.#flights.set(key, created);
      flight = created;
    }
    const result = await this.#join(flight, signal);
    store.addTestRun({
      runId: job.runId,
      stepId: job.stepId,
      scope: job.scope,
      key,
      tree,
      outcome: result.outcome,
      cached: false,
      attempts: result.attempts,
    });
    return result;
  }

  /** Attend `flight` au nom d'un appelant ; son arrêt le désabonne, le dernier parti arrête le job. */
  #join(flight: Flight, signal: AbortSignal | undefined): Promise<HeavyResult> {
    if (signal?.aborted) return Promise.reject(new Error("job heavy annulé : appel arrêté"));
    flight.waiters++;
    return new Promise<HeavyResult>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        flight.waiters--;
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        leave();
        if (flight.waiters === 0) flight.controller.abort();
        reject(new Error("job heavy annulé : appel arrêté"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      flight.promise.then(
        (result) => {
          leave();
          resolve(result);
        },
        (error: unknown) => {
          leave();
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  /**
   * Le job lui-même : un slot heavy par tentative, relances sur OOM, et UNE relance
   * d'un rouge frais (un échec instable ne vaut pas verdict). Seul un vert entre au cache.
   */
  async #execute(job: HeavyJob, id: JobId, signal: AbortSignal): Promise<HeavyResult> {
    const { config, store } = this.#deps;
    let attempts = 0;
    let oomRetries = 0;
    let failRetried = false;
    let last: HeavyResult = NOTHING_RAN;
    for (;;) {
      attempts++;
      last = await this.#attempt(job, id, attempts, signal);
      if (last.outcome === "fail" && !failRetried) {
        failRetried = true;
        store.appendEvent("heavy_fail_retry", job.runId, { scope: job.scope, attempt: attempts, exitCode: last.exitCode });
        continue;
      }
      if (last.outcome === "oom" && oomRetries < config.heavy.oomRetries) {
        oomRetries++;
        store.appendEvent("heavy_oom_retry", job.runId, {
          scope: job.scope,
          attempt: attempts,
          memoryMax: config.heavy.memoryMax,
        });
        continue;
      }
      break;
    }
    // Seul un VERT entre au cache : un rouge peut être instable, un OOM ou un délai dépend de la charge.
    if (last.outcome === "pass") {
      store.cachePut({
        key: id.key,
        repo: job.repo.name,
        tree: id.tree,
        command: id.command,
        outcome: last.outcome,
        exitCode: last.exitCode ?? -1,
        output: last.output,
        durationMs: last.durationMs,
      });
    }
    return last;
  }

  /** Une tentative : un slot, un process (tué par `signal`), son issue. */
  async #attempt(job: HeavyJob, id: JobId, attempt: number, signal: AbortSignal): Promise<HeavyResult> {
    const { config, store, scheduler, exec } = this.#deps;
    const now = this.#deps.now ?? Date.now;
    const slot = await scheduler.acquire("heavy", `${job.runId}:${job.scope}`, signal, job.priority ?? 0);
    const unit = `omp-heavy-${job.runId}-${++this.#seq}`;
    const argv = heavyArgv(config, job.worktree, unit, id.command, id.env, job.repo);
    store.appendEvent("heavy_started", job.runId, { scope: job.scope, attempt, unit });
    const started = now();
    let result: ProcResult;
    try {
      result = await exec(argv.command, argv.args, {
        cwd: job.worktree,
        env: config.heavy.isolation === "none" ? id.env : clientEnv(),
        // systemd borne le job lui-même (RuntimeMaxSec) ; un conteneur, c'est le délai du client.
        timeoutMs: (config.heavy.timeoutSec + (config.heavy.isolation === "container" ? 0 : 30)) * 1000,
        maxBytes: OUTPUT_TAIL,
        signal,
      });
    } finally {
      // Un client tué (délai, arrêt) laisse son unité ou son conteneur vivant : il part avec le slot.
      if (config.heavy.isolation === "container" || (config.heavy.isolation === "systemd" && signal.aborted))
        await forceStop(config, exec, unit, config.heavy.isolation).catch(() => {});
      slot.release();
    }
    const outcome = classify(result);
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.slice(-OUTPUT_TAIL);
    store.appendEvent("heavy_done", job.runId, { scope: job.scope, attempt, outcome, exitCode: result.code });
    return {
      outcome,
      exitCode: result.code,
      output,
      durationMs: now() - started,
      attempts: attempt,
      cached: false,
      skipped: false,
      note: null,
      tree: id.tree,
      key: id.key,
      command: id.command,
    };
  }
}

/** Le résultat rendu au runner : structuré, jamais une exception. */
export function heavyReport(result: HeavyResult, memoryMax: string): string {
  if (result.skipped) return `VERT (rien lancé : ${result.note ?? "rien à tester"})`;
  const head = result.cached
    ? "(cache : arbre déjà testé)"
    : `(${result.attempts} tentative(s), ${Math.round(result.durationMs / 1000)} s)`;
  switch (result.outcome) {
    case "pass":
      return `VERT ${head}\n${result.output.slice(-2000)}`;
    case "fail":
      return `ROUGE — code ${result.exitCode} ${head}\n${result.output.slice(-8000)}`;
    case "oom":
      return `ÉCHEC STRUCTURÉ : OOM — le job a dépassé MemoryMax=${memoryMax} ${result.attempts} fois. Réduis la portée (moins de fichiers, moins de parallélisme de test) ; ce n'est PAS un échec de tes tests.`;
    case "timeout":
      return `ÉCHEC STRUCTURÉ : délai dépassé ${head}\n${result.output.slice(-4000)}`;
    case "aborted":
      return `ÉCHEC STRUCTURÉ : job arrêté (plus personne ne l'attendait) ${head}`;
    case "error":
      return `ÉCHEC STRUCTURÉ : le job n'a pas pu démarrer\n${result.output.slice(-2000)}`;
    default: {
      const _exhaustive: never = result.outcome;
      return _exhaustive;
    }
  }
}
