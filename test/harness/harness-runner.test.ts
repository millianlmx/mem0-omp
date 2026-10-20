// Feature harness-runner : un runner OMP par étape — scope systemd plafonnée à 1 Go,
// OOM score 300, profil pipeline (LSP / DAP / noyau éteints), mode RPC, outils hôtes par étape.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { PIPELINE_SETTINGS, hostToolsFor, runnerArgv, runnerEnv, writePipelineOverlay } from "../../omp-harness/runner.ts";
import { testConfig } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";


test("harness-runner/AC-1 : un runner part en scope systemd (MemoryMax=1G, tranche des runners) sous choom 300, en mode RPC sans UI", () => {
  const config = testConfig("/srv/repo", c => {
    c.runner.isolation = "systemd";
    c.launcher = [];
  });
  const { command, args } = runnerArgv(config, { unit: "omp-runner-r1-3", cwd: "/w/feat", overlay: "/d/runner-settings.json", model: { provider: "anthropic", model: "fast" } });
  assert.equal(command, "systemd-run");
  const line = args.join(" ");
  assert.match(line, /^--scope --quiet --collect --unit=omp-runner-r1-3 --slice=omp-harness-runners\.slice -p MemoryMax=1G -- choom -n 300 -- omp /);
  for (const flag of ["--mode rpc", "--no-ui", "--no-session", "--no-lsp", "--auto-approve", "--profile pipeline", "--config /d/runner-settings.json", "--cwd /w/feat", "--model anthropic/fast"]) {
    assert.ok(line.includes(flag), `${flag} absent`);
  }
  const bare = runnerArgv(testConfig("/srv/repo"), { unit: "u", cwd: "/w", overlay: "/o", model: null });
  assert.equal(bare.command, "omp");
  assert.equal(bare.args.includes("--model"), false);
});


test("harness-runner/AC-2 : le profil pipeline éteint LSP, DAP et le noyau Python", () => {
  const dir = tmpdir("harness-overlay-");
  const file = writePipelineOverlay(dir);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), PIPELINE_SETTINGS);
  assert.equal(PIPELINE_SETTINGS.lsp.enabled, false);
  assert.equal(PIPELINE_SETTINGS.debug.enabled, false);
  assert.equal(PIPELINE_SETTINGS.eval.py, false);
});


test("harness-runner/AC-3 : un runner hérite des clés des fournisseurs mais jamais du jeton de l'API ; sa scope mémoire est celle du projet", () => {
  const env = runnerEnv("demo-scope", { ANTHROPIC_API_KEY: "k", HARNESS_TOKEN: "secret", PATH: "/bin" });
  assert.equal(env.ANTHROPIC_API_KEY, "k");
  assert.equal("HARNESS_TOKEN" in env, false);
  assert.equal(env.MEM0_PROJECT_ID, "demo-scope");
  assert.equal(env.PI_PY, "0");
});


test("harness-runner/AC-4 : les outils hôtes suivent l'étape — run_tests dès /impl (full seulement en revue), review_verdict seulement en revue", () => {
  const names = (step: Parameters<typeof hostToolsFor>[0]) => hostToolsFor(step).map(tool => tool.name).sort();
  assert.deepEqual(names("req"), ["decision", "oracle_recall", "progress"]);
  assert.deepEqual(names("impl"), ["decision", "oracle_recall", "progress", "run_tests"]);
  assert.deepEqual(names("review"), ["decision", "oracle_recall", "progress", "review_verdict", "run_tests"]);
  const scopes = (step: Parameters<typeof hostToolsFor>[0]) =>
    ((hostToolsFor(step).find(tool => tool.name === "run_tests")?.parameters as { properties: { scope: { enum: string[] } } }).properties.scope.enum);
  assert.deepEqual(scopes("impl"), ["touched"]);
  assert.deepEqual(scopes("fix"), ["touched"]);
  assert.deepEqual(scopes("review"), ["touched", "full"]);
});
