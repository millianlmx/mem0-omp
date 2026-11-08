// L'entrée de la vigie (conteneur `vigie` de la pile, ou à la main) :
//
//   node --experimental-strip-types omp-harness/vigie/main.ts
//
// Tout vient de l'environnement :
//   VIGIE_HARNESS_URL     l'API du harness (http://harness:8790 dans la pile)
//   VIGIE_TOKEN           le jeton de SON client pilote (`main.ts --add-client vigie --pilot`),
//                         jamais celui de l'approbateur ni le jeton historique
//   VIGIE_STATE_DIR       son état (curseur du flux, positions du journal, signaux en attente)
//   VIGIE_LOGS_DIR        le journal structuré du harness (`<dataDir>/logs`, en lecture seule)
//   VIGIE_REPOS_DIR       les clones des dépôts (`<racine>/repos`, en lecture seule)
//   VIGIE_OMP_BIN         omp (défaut : omp) ; VIGIE_MODEL `fournisseur/modèle` (défaut : celui d'omp)
//   VIGIE_SESSION_TIMEOUT_SEC  l'échéance d'une session de tri ou de pilotage (600)
//   MEM0_HTTP_URL, MEM0_HTTP_TOKEN  la mémoire du projet (rappel des bugs connus)
//   ANTHROPIC_API_KEY, OPENROUTER_API_KEY…  les clés des sessions omp
// Elle n'a ni le socket du moteur, ni la base, ni le jeton GitHub : un arrêt du harness ne
// l'arrête pas (elle garde ses signaux et constate le silence).
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { HttpOracle } from "../oracle.ts";
import { execProcess } from "../proc.ts";
import { HarnessApi } from "./api.ts";
import { Vigie } from "./agent.ts";
import type { CiRun } from "./collect.ts";
import { record, textOf } from "./json.ts";

const env = process.env;

/** Les derniers runs de workflow de `main` d'un dépôt public (API GitHub sans jeton : 60 appels par heure). */
async function githubRuns(slug: string): Promise<CiRun[]> {
  const response = await fetch(`https://api.github.com/repos/${slug}/actions/runs?branch=main&per_page=30`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "omp-harness-vigie" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = record(await response.json());
  return (Array.isArray(body.workflow_runs) ? body.workflow_runs : []).map((raw) => {
    const run = record(raw);
    return {
      name: textOf(run.name),
      status: textOf(run.status),
      conclusion: textOf(run.conclusion) || null,
      htmlUrl: textOf(run.html_url),
      headSha: textOf(run.head_sha),
      createdAt: textOf(run.created_at),
    };
  });
}

/** La version de la vigie : celle du harness dont elle vient (`omp-harness/package.json`). */
const VERSION: string = (() => {
  try {
    const manifest = record(JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")));
    return textOf(manifest.version) || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const token = env.VIGIE_TOKEN?.trim() ?? "";
if (token === "") {
  console.error("[omp-vigie] VIGIE_TOKEN manquant : crée le client pilote (`main.ts --add-client vigie --pilot`)");
  process.exit(2);
}
const stateDir = env.VIGIE_STATE_DIR ?? path.join(env.HOME ?? ".", ".omp-vigie");
const mem0 = env.MEM0_HTTP_URL?.trim();
const vigie = new Vigie({
  api: new HarnessApi(env.VIGIE_HARNESS_URL ?? "http://127.0.0.1:8790", token),
  oracle: mem0 ? new HttpOracle({ url: mem0, token: env.MEM0_HTTP_TOKEN?.trim() || null }) : null,
  spawn: (command, args, options) =>
    spawn(command, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] }),
  exec: execProcess,
  omp: {
    bin: env.VIGIE_OMP_BIN ?? "omp",
    model: env.VIGIE_MODEL?.trim() || null,
    timeoutMs: (Number(env.VIGIE_SESSION_TIMEOUT_SEC) || 600) * 1000,
  },
  workDir: stateDir,
  logsDir: env.VIGIE_LOGS_DIR?.trim() || null,
  reposDir: env.VIGIE_REPOS_DIR?.trim() || null,
  ci: githubRuns,
  version: VERSION,
});
process.on("unhandledRejection", (reason) =>
  console.error(`[omp-vigie] rejet non géré : ${reason instanceof Error ? reason.stack : String(reason)}`),
);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.once(signal, () => {
    void vigie.stop().finally(() => process.exit(0));
  });
await vigie.start();
