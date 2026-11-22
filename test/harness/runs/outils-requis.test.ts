// Feature outils-requis : un dépôt déclare les commandes que ses agents lancent
// (`repos[].tools`). Le harness les cherche là où tournent les runners avant chaque
// étape ; une absente met le run en attente de l'humain, au lieu de laisser l'agent la
// contourner en silence (un `project.pbxproj` édité à la main faute de `xcodegen`).
import test from "node:test";
import assert from "node:assert/strict";
import type { RepoConfig } from "../../../omp-harness/config/config.ts";
import { validateConfig } from "../../../omp-harness/config/config.ts";
import { renderChecks, runChecks } from "../../../omp-harness/config/check.ts";
import { Git } from "../../../omp-harness/forge/git.ts";
import type { Exec, ProcResult } from "../../../omp-harness/runners/proc.ts";
import { execProcess } from "../../../omp-harness/runners/proc.ts";
import { missingTools } from "../../../omp-harness/runners/tools.ts";
import { fakeWorld, harnessRepo, OK, testConfig, waitFor } from "../../support/harness-fixtures.ts";

const ABSENT = "outil-introuvable-omp-harness";

const done = (stdout: string, code = 0): ProcResult => ({
  code,
  signal: null,
  stdout,
  stderr: "",
  timedOut: false,
  aborted: false,
});

test("outils-requis/AC-1 : `repos[].tools` n'accepte que des noms de commandes — ni chemin, ni option, ni shell", () => {
  const config = testConfig(harnessRepo("outils-requis-config-"));
  const repo = config.repos[0] as RepoConfig;
  repo.tools = ["xcodegen", "python3", "clang++"];
  assert.doesNotThrow(() => validateConfig(config));
  for (const bad of ["/usr/bin/python3", "-rf", "a b", "x;rm", "$(id)", ""]) {
    repo.tools = [bad];
    assert.throws(() => validateConfig(config), /repos\.demo\.tools/, bad);
  }
});

test("outils-requis/AC-2 : hors conteneur, les outils sont cherchés dans le PATH du service ; en conteneur, dans un conteneur jetable de l'image des runners, sans réseau", async () => {
  const config = testConfig(harnessRepo("outils-requis-probe-"));
  const repo = config.repos[0] as RepoConfig;
  assert.deepEqual(await missingTools(config, execProcess, repo), [], "aucun outil déclaré : rien à chercher");
  repo.tools = ["sh", ABSENT];
  assert.deepEqual(await missingTools(config, execProcess, repo), [ABSENT]);

  config.runner.isolation = "container";
  config.container.command = ["docker"];
  config.container.runnerImage = "omp-runner:test";
  const calls: { command: string; args: string[] }[] = [];
  let reachable = true;
  const exec: Exec = async (command, args) => {
    calls.push({ command, args });
    return reachable ? done(`${ABSENT}\n`) : done("", 125);
  };
  assert.deepEqual(await missingTools(config, exec, repo), [ABSENT]);
  const [call] = calls;
  assert.equal(call?.command, "docker");
  assert.deepEqual(call?.args.slice(0, 2), ["run", "--rm"]);
  assert.ok(call?.args.includes("--network=none"));
  assert.ok(call?.args.includes("--entrypoint=sh"));
  assert.deepEqual(call?.args.slice(call.args.indexOf("omp-runner:test") + 1).slice(-3), ["sh", "sh", ABSENT]);
  // Une recherche impossible (image absente, moteur injoignable) ne conclut rien.
  reachable = false;
  assert.equal(await missingTools(config, exec, repo), null);
});

test("outils-requis/AC-3 : --check nomme les outils absents d'un dépôt et le geste qui corrige", async () => {
  const config = testConfig(harnessRepo("outils-requis-check-"), (c) => {
    c.ompBin = "/bin/echo";
  });
  (config.repos[0] as RepoConfig).tools = ["sh", ABSENT];
  const lines = await runChecks(config, {
    exec: execProcess,
    git: new Git(execProcess, config.git),
    oracleHealth: async () => true,
    spaces: [],
  });
  const line = lines.find((candidate) => candidate.label === "dépôt demo — outils des runners");
  assert.equal(line?.status, "fail");
  assert.equal(line?.detail, `absents : ${ABSENT}`);
  assert.match(renderChecks(lines), /→ Installe-les dans le PATH des runners, ou retire-les de `repos\.demo\.tools`/);
});

test("outils-requis/AC-4 : un outil absent arrête le run à sa première étape, sans lancer d'agent — en attente de l'humain, la raison nomme l'outil ; installé, la relance repart", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  const repo = world.config.repos[0] as RepoConfig;
  repo.tools = ["sh", ABSENT];
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "awaiting_human",
      () => `${world.store.getRun(run.id)?.state} : ${world.store.getRun(run.id)?.reason}`,
    );
    const waiting = world.store.getRun(run.id);
    assert.equal(waiting?.step, "req");
    assert.equal(waiting?.lastFailCause, "tools");
    assert.match(waiting?.reason ?? "", new RegExp(`outils absents des runners : ${ABSENT} — Installe-les`));
    assert.equal(world.spawned.length, 0, "aucun runner lancé");
    assert.deepEqual(
      world.store.listSteps(run.id).map((step) => `${step.kind}:${step.status}`),
      ["req:failed"],
    );

    // L'humain installe l'outil (ici : le retire de la déclaration) puis relance.
    repo.tools = ["sh"];
    await world.orchestrator.retry(run.id);
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => `${world.store.getRun(run.id)?.state} : ${world.store.getRun(run.id)?.reason}`,
    );
    assert.equal(world.store.getRun(run.id)?.state, "merged", world.store.getRun(run.id)?.reason ?? "");
  } finally {
    await world.orchestrator.stop();
  }
});
