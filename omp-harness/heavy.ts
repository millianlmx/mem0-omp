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
import { createHash } from "node:crypto";
import * as path from "node:path";
import { launch } from "./config.ts";
import type { HarnessConfig, RepoConfig } from "./config.ts";
import type { Store } from "./db.ts";
import type { Exec, ProcResult } from "./proc.ts";
import type { Scheduler } from "./scheduler.ts";
import type { Git } from "./git.ts";


export type TestScope = "touched" | "full";

export type HeavyOutcome = "pass" | "fail" | "oom" | "timeout" | "error" | "skipped";

export type HeavyJob = {
  runId: string;
  stepId: number | null;
  repo: RepoConfig;
  worktree: string;
  scope: TestScope;
  /** Les fichiers touchés (scope `touched`). */
  files: string[];
};

export type HeavyResult = {
  outcome: HeavyOutcome;
  exitCode: number | null;
  /** La fin de la sortie (stdout puis stderr). */
  output: string;
  durationMs: number;
  attempts: number;
  cached: boolean;
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


/** La commande de test d'une scope, ou `null` (scope `touched` sans fichier : rien à tester). */
export function testCommand(repo: RepoConfig, scope: TestScope, files: string[]): string | null {
  if (scope === "full") return repo.tests.full;
  if (files.length === 0) return null;
  const quoted = files.map(shellQuote).join(" ");
  return repo.tests.touched.includes("{files}") ? repo.tests.touched.split("{files}").join(quoted) : `${repo.tests.touched} ${quoted}`;
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
  if (config.heavy.cargoTargetRoot) env.CARGO_TARGET_DIR = path.join(config.heavy.cargoTargetRoot, path.basename(worktree));
  return { ...env, ...config.heavy.env };
}


/** La clé du cache : tree hash + commande + env (hors variables de chemin propres au worktree). */
export function cacheKey(tree: string, command: string, env: Record<string, string>): string {
  const stable = Object.keys(env)
    .filter(key => !KEY_EXCLUDED_ENV.has(key))
    .sort()
    .map(key => [key, env[key]]);
  return createHash("sha256").update(JSON.stringify({ tree, command, env: stable })).digest("hex");
}


/** La ligne de commande d'un job : unité systemd transitoire, ou `bash -c` nu (isolation `none`). */
export function heavyArgv(config: HarnessConfig, worktree: string, unit: string, command: string, env: Record<string, string>): { command: string; args: string[] } {
  if (config.heavy.isolation === "none") return { command: "bash", args: ["-c", command] };
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
    "-p", `MemoryMax=${heavy.memoryMax}`,
    "-p", `CPUQuota=${heavy.cpuQuota}`,
    "-p", `User=${heavy.user}`,
    "-p", "PrivateNetwork=yes",
    "-p", `OOMScoreAdjust=${heavy.oomScoreAdjust}`,
    "-p", `RuntimeMaxSec=${heavy.timeoutSec}`,
    "-p", "NoNewPrivileges=yes",
    "-p", "PrivateTmp=yes",
    "-p", "UMask=0002",
    "-p", "ProtectSystem=strict",
    "-p", `ReadWritePaths=${writable.join(" ")}`,
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
  if (result.timedOut || unitResult === "timeout") return "timeout";
  if (unitResult === "oom-kill" || result.code === 137 || (result.code === null && result.signal === "SIGKILL")) return "oom";
  if (result.code === 0) return "pass";
  if (result.code === 127 && result.stdout === "") return "error";
  return "fail";
}


export type HeavyDeps = {
  config: HarnessConfig;
  store: Store;
  scheduler: Scheduler;
  git: Git;
  exec: Exec;
  now?: () => number;
};


export class HeavyRunner {
  readonly #deps: HeavyDeps;
  #seq = 0;

  constructor(deps: HeavyDeps) {
    this.#deps = deps;
  }

  /** La clé de cache de la scope sur l'arbre COURANT du worktree, ou `null` si rien à tester. */
  async keyFor(job: Omit<HeavyJob, "runId" | "stepId">): Promise<{ key: string; tree: string; command: string } | null> {
    const command = testCommand(job.repo, job.scope, job.files);
    if (command === null) return null;
    const tree = await this.#deps.git.workingTreeHash(job.worktree);
    return { key: cacheKey(tree, command, heavyEnv(this.#deps.config, job.worktree)), tree, command };
  }

  async run(job: HeavyJob, signal?: AbortSignal): Promise<HeavyResult> {
    const { config, store, scheduler, exec } = this.#deps;
    const now = this.#deps.now ?? Date.now;
    const env = heavyEnv(config, job.worktree);
    const command = testCommand(job.repo, job.scope, job.files);
    if (command === null) {
      return { outcome: "skipped", exitCode: null, output: "aucun fichier touché : rien à tester", durationMs: 0, attempts: 0, cached: false, tree: "", key: "", command: "" };
    }
    const tree = await this.#deps.git.workingTreeHash(job.worktree);
    const key = cacheKey(tree, command, env);

    const hit = store.cacheGet(key);
    if (hit) {
      store.addTestRun({ runId: job.runId, stepId: job.stepId, scope: job.scope, key, tree, outcome: hit.outcome, cached: true, attempts: 0 });
      store.appendEvent("heavy_cached", job.runId, { scope: job.scope, outcome: hit.outcome, tree });
      return { outcome: hit.outcome, exitCode: hit.exitCode, output: hit.output, durationMs: hit.durationMs, attempts: 0, cached: true, tree, key, command };
    }

    const maxAttempts = 1 + config.heavy.oomRetries;
    let attempts = 0;
    let last: HeavyResult | null = null;
    while (attempts < maxAttempts) {
      attempts++;
      const slot = await scheduler.acquire("heavy", `${job.runId}:${job.scope}`, signal);
      const unit = `omp-heavy-${job.runId}-${++this.#seq}`;
      const argv = heavyArgv(config, job.worktree, unit, command, env);
      store.appendEvent("heavy_started", job.runId, { scope: job.scope, attempt: attempts, unit });
      const started = now();
      let result: ProcResult;
      try {
        result = await exec(argv.command, argv.args, {
          cwd: job.worktree,
          env: config.heavy.isolation === "none" ? env : { PATH: process.env.PATH ?? "/usr/bin:/bin" },
          timeoutMs: (config.heavy.timeoutSec + 30) * 1000,
          maxBytes: OUTPUT_TAIL,
        });
      } finally {
        slot.release();
      }
      const outcome = classify(result);
      const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ""}`.slice(-OUTPUT_TAIL);
      last = { outcome, exitCode: result.code, output, durationMs: now() - started, attempts, cached: false, tree, key, command };
      store.appendEvent("heavy_done", job.runId, { scope: job.scope, attempt: attempts, outcome, exitCode: result.code });
      if (outcome !== "oom") break;
      if (attempts < maxAttempts) store.appendEvent("heavy_oom_retry", job.runId, { scope: job.scope, attempt: attempts, memoryMax: config.heavy.memoryMax });
    }
    const final = last as HeavyResult;
    // Seules les issues DÉTERMINISTES entrent au cache : un OOM ou un délai dépend de la charge.
    if (final.outcome === "pass" || final.outcome === "fail") {
      store.cachePut({ key, repo: job.repo.name, tree, command, outcome: final.outcome, exitCode: final.exitCode ?? -1, output: final.output, durationMs: final.durationMs });
    }
    store.addTestRun({ runId: job.runId, stepId: job.stepId, scope: job.scope, key, tree, outcome: final.outcome, cached: false, attempts });
    return final;
  }
}


/** Le résultat rendu au runner : structuré, jamais une exception. */
export function heavyReport(result: HeavyResult, memoryMax: string): string {
  const head = result.cached ? "(cache : arbre déjà testé)" : `(${result.attempts} tentative(s), ${Math.round(result.durationMs / 1000)} s)`;
  switch (result.outcome) {
    case "pass":
      return `VERT ${head}\n${result.output.slice(-2000)}`;
    case "fail":
      return `ROUGE — code ${result.exitCode} ${head}\n${result.output.slice(-8000)}`;
    case "oom":
      return `ÉCHEC STRUCTURÉ : OOM — le job a dépassé MemoryMax=${memoryMax} ${result.attempts} fois. Réduis la portée (moins de fichiers, moins de parallélisme de test) ; ce n'est PAS un échec de tes tests.`;
    case "timeout":
      return `ÉCHEC STRUCTURÉ : délai dépassé ${head}\n${result.output.slice(-4000)}`;
    case "skipped":
      return result.output;
    case "error":
      return `ÉCHEC STRUCTURÉ : le job n'a pas pu démarrer\n${result.output.slice(-2000)}`;
  }
}
