// L'entrée du Pipeline Service : un process, une base, une API.
//
//   node --experimental-strip-types omp-harness/main.ts --config /etc/omp-harness/config.json
//   … --check : vérifie l'installation (omp, lanceur, modèles, oracle, dépôts) et sort.
//   … --add-repo <url> [--name <nom>] : clone le dépôt, éprouve l'écriture, devine ses
//     tests et le déclare dans le fichier de configuration (codes : repos.ts).
//
// Le jeton d'API vient de HARNESS_TOKEN, sinon du fichier `tokenFile` (créé en 0600
// au premier démarrage). SIGTERM arrête proprement : plus de requêtes, runners
// arrêtés ; au redémarrage, chaque run reprend à son dernier checkpoint.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { renderChecks, runChecks } from "./check.ts";
import { loadConfig } from "./config.ts";
import type { HarnessConfig } from "./config.ts";
import { Store } from "./db.ts";
import { Git } from "./git.ts";
import { HeavyRunner } from "./heavy.ts";
import { createHandler } from "./http.ts";
import { HttpOracle, NO_ORACLE } from "./oracle.ts";
import { Orchestrator } from "./orchestrator.ts";
import { addRepo } from "./repos.ts";
import type { SpawnRunner } from "./orchestrator.ts";
import { execProcess } from "./proc.ts";
import { Scheduler } from "./scheduler.ts";


/** Le jeton de l'API : variable d'environnement, sinon fichier 0600 (créé directement en 0600). */
export function loadToken(config: HarnessConfig, env: Record<string, string | undefined> = process.env): string {
  if (env.HARNESS_TOKEN) return env.HARNESS_TOKEN;
  if (fs.existsSync(config.tokenFile)) return fs.readFileSync(config.tokenFile, "utf8").trim();
  fs.mkdirSync(path.dirname(config.tokenFile), { recursive: true });
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(config.tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
  return token;
}


export const spawnRunner: SpawnRunner = (command, args, options) => spawn(command, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });


export type Harness = { orchestrator: Orchestrator; server: http.Server; store: Store; stop: () => Promise<void> };


export async function startHarness(config: HarnessConfig, options: { spawn?: SpawnRunner; log?: (line: string) => void; token?: string } = {}): Promise<Harness> {
  const log = options.log ?? ((line: string) => console.error(`[omp-harness] ${line}`));
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.worktreesDir, { recursive: true });
  const store = new Store(path.join(config.dataDir, "harness.sqlite"));
  const scheduler = new Scheduler({
    runnerSlots: config.runner.slots,
    heavySlots: config.heavy.slots,
    admission: config.admission,
    providers: config.providers,
  });
  const git = new Git(execProcess, config.git);
  const heavy = new HeavyRunner({ config, store, scheduler, git, exec: execProcess });
  // Le jeton de mem0-rs peut venir de l'environnement (/etc/omp-harness/env), comme pour le plugin mémoire.
  if (config.oracle && !config.oracle.token && process.env.MEM0_HTTP_TOKEN) config.oracle.token = process.env.MEM0_HTTP_TOKEN;
  const oracle = config.oracle ? new HttpOracle(config.oracle, { log }) : NO_ORACLE;
  const orchestrator = new Orchestrator({ config, store, scheduler, git, heavy, oracle, spawn: options.spawn ?? spawnRunner, exec: execProcess, log });
  await orchestrator.start();
  const token = options.token ?? loadToken(config);
  const server = http.createServer(createHandler({ orchestrator, token }));
  await new Promise<void>(resolve => server.listen(config.listen.port, config.listen.host, resolve));
  log(`à l'écoute sur ${config.listen.host}:${(server.address() as { port: number }).port}`);
  return {
    orchestrator,
    server,
    store,
    stop: async () => {
      server.closeAllConnections?.();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await orchestrator.stop();
      store.close();
    },
  };
}


function argValue(argv: string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}


const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);

if (isMain) {
  const file = argValue(process.argv, "--config") ?? process.env.HARNESS_CONFIG ?? null;
  // Un rejet oublié est journalisé, jamais fatal : un crash ferait reprendre tous les runs au checkpoint.
  process.on("unhandledRejection", reason => console.error(`[omp-harness] rejet non géré : ${reason instanceof Error ? reason.stack : String(reason)}`));
  const config = loadConfig(file);
  const added = argValue(process.argv, "--add-repo");
  if (added !== null) {
    if (file === null) throw new Error("--add-repo exige --config");
    const result = await addRepo(file, config, new Git(execProcess, config.git), added, argValue(process.argv, "--name") ?? undefined);
    console.log(`${result.code === 0 ? "✓" : "✗"} ${result.message}`);
    process.exit(result.code);
  }
  if (process.argv.includes("--check")) {
    if (config.oracle && !config.oracle.token && process.env.MEM0_HTTP_TOKEN) config.oracle.token = process.env.MEM0_HTTP_TOKEN;
    const oracle = config.oracle ? new HttpOracle(config.oracle) : null;
    const lines = await runChecks(config, { exec: execProcess, git: new Git(execProcess, config.git), oracleHealth: () => oracle?.health() ?? Promise.resolve(false) });
    console.log(renderChecks(lines));
    process.exit(lines.some(line => line.status === "fail") ? 1 : 0);
  }
  const harness = await startHarness(config);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      void harness.stop().finally(() => process.exit(0));
    });
  }
}
