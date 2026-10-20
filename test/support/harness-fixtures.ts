// Les montages des tests du harness : une configuration sans systemd, un dépôt git
// réel, un orchestrateur complet dont les runners sont le faux `omp` RPC.
//
// Ce module n'est pas un fichier de test (pas de suffixe `.test.ts`) : seuls les
// tests l'importent.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { Git } from "../../omp-harness/git.ts";
import { HeavyRunner } from "../../omp-harness/heavy.ts";
import type { Oracle, Memory } from "../../omp-harness/oracle.ts";
import { Orchestrator } from "../../omp-harness/orchestrator.ts";
import type { OrchestratorDeps, SpawnRunner } from "../../omp-harness/orchestrator.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { Exec } from "../../omp-harness/proc.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import { GIT_ENV } from "./git.ts";
import { tmpdir } from "./repo.ts";

export const FAKE_RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "fake-omp-rpc.ts");


export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} : ${result.stderr}`);
  return result.stdout.trim();
}


/** Un clone de travail du harness : `main` avec un fichier par module, HEAD détachée (main jamais extraite). */
export function harnessRepo(prefix = "harness-repo-"): string {
  const root = tmpdir(prefix);
  git(root, "init", "-q", "-b", "main");
  for (const file of ["src/api/routes.ts", "src/db/schema.ts", "docs/guide.md", "README.md"]) {
    fs.mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), `// ${file}\n`);
  }
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  git(root, "checkout", "-q", "--detach");
  return root;
}


/** Un commit sur `main` du clone, sans l'extraire (un autre développeur a mergé). */
export function commitOnMain(repo: string, file: string, content: string): string {
  const scratch = tmpdir("harness-main-");
  git(repo, "worktree", "add", "-q", scratch, "main");
  fs.mkdirSync(path.dirname(path.join(scratch, file)), { recursive: true });
  fs.writeFileSync(path.join(scratch, file), content);
  git(scratch, "add", "-A");
  git(scratch, "commit", "-q", "-m", `main: ${file}`);
  const sha = git(scratch, "rev-parse", "HEAD");
  git(repo, "worktree", "remove", "--force", scratch);
  return sha;
}


export function testConfig(repo: string, patch: (config: HarnessConfig) => void = () => {}): HarnessConfig {
  const base = tmpdir("harness-data-");
  const config = defaultConfig(base);
  config.runner.isolation = "none";
  config.heavy.isolation = "none";
  config.listen.port = 0;
  config.git = { authorName: "Harness", authorEmail: "harness@example.com" };
  config.repos = [
    repoDefaults({
      name: "demo",
      path: repo,
      scope: "demo-scope",
      tests: { touched: "test ! -f FAIL_TOUCHED # {files}", full: "test ! -f FAIL_FULL" },
    }),
  ];
  patch(config);
  return config;
}


/** Un oracle en mémoire : il rend `memories` et garde ce qu'on lui écrit. */
export class MemoryOracle implements Oracle {
  readonly retained: { scope: string; text: string; tags: string[] }[] = [];
  memories: Memory[] = [];
  readonly queries: string[] = [];
  async recall(_scope: string, query: string): Promise<Memory[]> {
    this.queries.push(query);
    return this.memories;
  }
  async retain(scope: string, text: string, tags: string[] = []): Promise<boolean> {
    this.retained.push({ scope, text, tags });
    return true;
  }
}


export type FakeWorld = {
  config: HarnessConfig;
  store: Store;
  scheduler: Scheduler;
  oracle: MemoryOracle;
  orchestrator: Orchestrator;
  /** Les dépendances de l'orchestrateur : un second orchestrateur sur la même base simule un redémarrage. */
  deps: OrchestratorDeps;
  repo: string;
  log: () => Record<string, unknown>[];
  spawned: { command: string; args: string[] }[];
};


/** Un harness complet dont les runners sont le faux `omp` piloté par `scenario`. */
export function fakeWorld(scenario: Record<string, unknown>, options: { repo?: string; patch?: (config: HarnessConfig) => void; exec?: Exec; memAvailableMiB?: () => number | null } = {}): FakeWorld {
  const repo = options.repo ?? harnessRepo();
  const config = testConfig(repo, options.patch);
  const dir = tmpdir("harness-fake-");
  const scenarioFile = path.join(dir, "scenario.json");
  fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
  const stateDir = path.join(dir, "state");
  fs.mkdirSync(stateDir);
  const logFile = path.join(dir, "log.jsonl");
  fs.writeFileSync(logFile, "");
  const spawned: { command: string; args: string[] }[] = [];
  const spawnFake: SpawnRunner = (command, args, opts) => {
    spawned.push({ command, args });
    return spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", FAKE_RUNNER, ...args], {
      cwd: opts.cwd,
      env: { ...opts.env, FAKE_SCENARIO: scenarioFile, FAKE_STATE: stateDir, FAKE_LOG: logFile },
      stdio: ["pipe", "pipe", "pipe"],
    });
  };
  fs.mkdirSync(config.dataDir, { recursive: true });
  const store = new Store(path.join(config.dataDir, "harness.sqlite"));
  const scheduler = new Scheduler({
    runnerSlots: config.runner.slots,
    heavySlots: config.heavy.slots,
    admission: config.admission,
    providers: config.providers,
    memAvailableMiB: options.memAvailableMiB ?? (() => null),
    sleep: ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, 20))),
  });
  const exec = options.exec ?? execProcess;
  const gitClient = new Git(execProcess, config.git);
  const heavy = new HeavyRunner({ config, store, scheduler, git: gitClient, exec });
  const oracle = new MemoryOracle();
  const deps: OrchestratorDeps = { config, store, scheduler, git: gitClient, heavy, oracle, spawn: spawnFake, exec, tickMs: 25 };
  const orchestrator = new Orchestrator(deps);
  return {
    deps,
    config,
    store,
    scheduler,
    oracle,
    orchestrator,
    repo,
    spawned,
    log: () =>
      fs
        .readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>),
  };
}


/** Attend que `predicate` soit vrai (sondage), ou échoue avec `describe()`. */
export async function waitFor(predicate: () => boolean, describe: () => string, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`délai dépassé : ${describe()}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}


/** Les actions standard d'une étape réussie, réutilisées par les scénarios. */
export const OK = {
  req: [{ write: ".harness/req.md", content: "## Besoins\nB-1 : exporter les données\n## Hors périmètre\n## Contraintes\n" }],
  specs: [
    {
      write: ".harness/specs.md",
      content: "## Spécifications\nexport CSV\n## Critères d'acceptation\nAC-1 : export\n## Modules\n- src/api\n## Découpage\naucun\n",
    },
  ],
  impl: [
    { write: "src/api/export.ts", content: "export const exportCsv = () => 'a,b';\n" },
    { tool: "run_tests", args: { scope: "touched" } },
    { write: ".harness/impl.md", content: "AC-1 fait\n" },
  ],
  review: [
    { tool: "run_tests", args: { scope: "full" } },
    { tool: "review_verdict", args: { risk: "low", summary: "export CSV simple", blockers: [], risks: [], files: ["src/api/export.ts"], unverified: [], confidence: "strong" } },
  ],
};
