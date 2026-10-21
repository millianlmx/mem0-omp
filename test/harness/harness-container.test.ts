// Feature harness-container : le harness en conteneurs (Docker ou podman). Chaque
// runner et chaque job de tests est un conteneur frère, aux mêmes plafonds que sous
// systemd ; le déploiement (images, compose, harness.sh) tient la même promesse
// d'isolation et le même omp que install.sh.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { defaultConfig, loadConfig, repoDefaults, validateConfig } from "../../omp-harness/config.ts";
import { heavyArgv, heavyEnv } from "../../omp-harness/heavy.ts";
import { forceStop, runnerArgv } from "../../omp-harness/runner.ts";
import type { ProcOptions, ProcResult } from "../../omp-harness/proc.ts";
import { OK, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const BOX = path.join(ROOT, "omp-harness", "deploy", "container");
const read = (name: string) => fs.readFileSync(path.join(BOX, name), "utf8");
const WT = "/srv/omp/worktrees/demo/export";
const REPO = "/srv/omp/repos/demo";

function containerConfig() {
  const config = defaultConfig("/srv/omp/state");
  config.runner.isolation = "container";
  config.heavy.isolation = "container";
  config.container.network = "omp-harness";
  config.container.runnerEnvFile = "/srv/secrets/runner.env";
  config.container.runnerHome = "/srv/omp/runner-home";
  config.container.user = "1000:1000";
  config.heavy.cargoTargetRoot = null;
  config.ompBin = "/usr/local/bin/omp";
  return config;
}

/** La valeur de chaque `--volume` d'une ligne. */
const volumes = (args: string[]) => args.flatMap((arg, i) => (arg === "--volume" ? [args[i + 1] as string] : []));
const envs = (args: string[]) => args.flatMap((arg, i) => (arg === "--env" ? [args[i + 1] as string] : []));

test("harness-container/AC-1 : un runner est un conteneur frère plafonné, qui ne monte que son worktree, le clone en lecture, l'overlay, son HOME et ses clés", () => {
  const config = containerConfig();
  const line = runnerArgv(config, {
    unit: "omp-runner-r1-3",
    cwd: WT,
    overlay: "/srv/omp/state/runner-settings.json",
    model: { provider: "anthropic", model: "claude-sonnet-5-5" },
    scope: "demo",
    repo: REPO,
    oracleUrl: "http://mem0:8321",
  });
  assert.equal(line.command, "docker");
  const image = line.args.indexOf(config.container.runnerImage);
  const flags = line.args.slice(0, image);
  for (const flag of [
    "run",
    "--rm",
    "-i",
    "--name=omp-runner-r1-3",
    "--memory=1G",
    "--memory-swap=1G",
    "--oom-score-adj=300",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=1000:1000",
    "--network=omp-harness",
    `--workdir=${WT}`,
  ])
    assert.ok(flags.includes(flag), `${flag} absent`);
  assert.deepEqual(volumes(flags), [
    `${WT}:${WT}`,
    `${REPO}:${REPO}:ro`,
    "/srv/omp/state/runner-settings.json:/srv/omp/state/runner-settings.json:ro",
    "/srv/omp/runner-home:/home/runner",
    "/srv/secrets/runner.env:/run/secrets/runner.env:ro",
  ]);
  assert.deepEqual(envs(flags).sort(), [
    "HOME=/home/runner",
    "MEM0_AUTOSETUP=0",
    "MEM0_HTTP_URL=http://mem0:8321",
    "MEM0_NUDGE=0",
    "MEM0_PROJECT_ID=demo",
    "PI_PY=0",
  ]);
  assert.ok(!flags.some((flag) => /TOKEN|API_KEY|docker\.sock/.test(flag)), "ni jeton, ni clé, ni socket du moteur");
  // Après l'image : omp et ses arguments, le modèle compris.
  assert.deepEqual(line.args.slice(image + 1, image + 4), ["/usr/local/bin/omp", "--mode", "rpc"]);
  assert.ok(line.args.includes("anthropic/claude-sonnet-5-5"));
  assert.throws(
    () => runnerArgv(config, { unit: "u", cwd: WT, overlay: "/o", model: null, scope: "demo" }),
    /clone du dépôt du runner est requis/,
  );
});

test("harness-container/AC-2 : un job de tests est un conteneur sans réseau ni secret, aux plafonds de systemd, dans l'image de son dépôt", () => {
  const config = containerConfig();
  const repo = repoDefaults({ name: "demo", path: REPO, testImage: "registry.local/rust-tests:1" });
  const line = heavyArgv(config, WT, "omp-heavy-r1-2", "cargo test", heavyEnv(config, WT), repo);
  const image = line.args.indexOf("registry.local/rust-tests:1");
  assert.ok(image > 0, "l'image du dépôt remplace celle par défaut");
  const flags = line.args.slice(0, image);
  for (const flag of [
    "--network=none",
    "--memory=4G",
    "--memory-swap=4G",
    "--cpus=3",
    "--oom-score-adj=800",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs=/tmp",
    `--workdir=${WT}`,
  ])
    assert.ok(flags.includes(flag), `${flag} absent`);
  assert.deepEqual(volumes(flags), [`${WT}:${WT}`, `${REPO}:${REPO}:ro`]);
  assert.ok(envs(flags).includes("HOME=/tmp"));
  assert.ok(!flags.some((flag) => /secrets|runner-home|TOKEN|API_KEY/.test(flag)), "aucun secret monté");
  assert.deepEqual(line.args.slice(image + 1), ["bash", "-c", "cargo test"]);
  // Sans image propre, celle de la configuration.
  const fallback = heavyArgv(
    config,
    WT,
    "u",
    "npm test",
    heavyEnv(config, WT),
    repoDefaults({ name: "x", path: REPO }),
  );
  assert.ok(fallback.args.includes(config.container.testImage));
});

test("harness-container/AC-3 : l'arrêt forcé retire le conteneur ; la configuration refuse un moteur vide et des chemins relatifs", async () => {
  const calls: string[][] = [];
  const exec = async (command: string, args: string[], _options?: ProcOptions): Promise<ProcResult> => {
    calls.push([command, ...args]);
    return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false };
  };
  const config = containerConfig();
  config.container.command = ["podman", "--remote"];
  await forceStop(config, exec, "omp-runner-r1-3");
  assert.deepEqual(calls, [["podman", "--remote", "rm", "--force", "omp-runner-r1-3"]]);

  assert.throws(
    () => validateConfig({ ...containerConfig(), container: { ...containerConfig().container, command: [] } }),
    /container\.command/,
  );
  assert.throws(
    () => validateConfig({ ...containerConfig(), container: { ...containerConfig().container, runnerHome: "home" } }),
    /container\.runnerHome doit être un chemin absolu/,
  );
});

test("harness-container/AC-4 : en isolation container, un run va de /req au merge — runners et tests passent par le CLI du moteur, chaque job est retiré", async () => {
  const engineLog = path.join(tmpdir("harness-engine-"), "engine.jsonl");
  fs.writeFileSync(engineLog, "");
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] },
    {
      patch: (config) => {
        config.runner.isolation = "container";
        config.heavy.isolation = "container";
        config.heavy.cargoTargetRoot = null;
        // Le service ne passe au CLI que de quoi joindre le moteur : le journal voyage dans la commande.
        config.container.command = [
          "env",
          `FAKE_ENGINE_LOG=${engineLog}`,
          path.join(ROOT, "test", "support", "fake-engine.sh"),
        ];
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export conteneur", request: "Exporter" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      30_000,
    );
    assert.equal(world.store.getRun(run.id)?.state, "merged", world.store.getRun(run.id)?.reason ?? "");
    assert.match(git(world.repo, "show", "main:src/api/export.ts"), /exportCsv/);

    // Chaque runner part par `run -i` de l'image des runners, son worktree monté.
    assert.ok(world.spawned.length >= 4);
    for (const { command, args } of world.spawned) {
      assert.equal(command, "env");
      const line = args.slice(args.indexOf("run"));
      assert.ok(line.length > 0 && line.includes("-i") && line.includes(world.config.container.runnerImage));
    }
    // Chaque job de tests : un `run` sans réseau, puis son retrait.
    const calls = fs
      .readFileSync(engineLog, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
    const jobs = calls.filter((call) => call[0] === "run");
    assert.ok(jobs.length >= 2, "les tests touchés puis la suite complète");
    for (const job of jobs) {
      assert.ok(job.includes("--network=none"));
      const name = (job.find((arg) => arg.startsWith("--name=")) as string).slice("--name=".length);
      assert.ok(
        calls.some((call) => call[0] === "rm" && call.includes(name)),
        `${name} n'a pas été retiré`,
      );
    }
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-container/AC-5 : le déploiement tient la même promesse — omp épinglé comme install.sh, racine montée au même chemin, clés jamais montées dans le service", () => {
  const install = fs.readFileSync(path.join(ROOT, "omp-harness", "deploy", "install.sh"), "utf8");
  const runner = read("Dockerfile.runner");
  const version = (text: string) => /OMP_VERSION=([\d.]+)/.exec(text)?.[1];
  assert.equal(version(runner), version(install), "le même omp que sur Debian et sur le Mac");
  for (const sha of install.match(/OMP_SHA256=([0-9a-f]{64})/g) ?? [])
    assert.ok(runner.includes(sha.slice("OMP_SHA256=".length)), "les mêmes empreintes épinglées");
  assert.match(runner, /sha256sum -c --quiet -/);

  const compose = read("compose.yaml");
  assert.match(
    compose,
    /- \$\{OMP_HARNESS_ROOT\}:\$\{OMP_HARNESS_ROOT\}\n/,
    "la racine au même chemin : un frère monte un worktree par son chemin d'hôte",
  );
  assert.match(compose, /- \$\{OMP_HARNESS_SOCKET\}:\/var\/run\/docker\.sock/);
  assert.match(compose, /\$\{OMP_HARNESS_SECRETS\}\/harness\.env/);
  assert.doesNotMatch(compose, /runner\.env/, "les clés LLM ne sont jamais montées dans le service");
  assert.match(compose, /name: omp-harness\n/, "le réseau que rejoignent les runners");

  // Le modèle de configuration, une fois les chemins posés, est une config valide en isolation container.
  const dir = tmpdir("harness-container-conf-");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    read("config.container.json").replaceAll("@ROOT@", "/srv/omp").replaceAll("@SECRETS@", "/srv/secrets"),
  );
  const config = loadConfig(file);
  assert.equal(config.runner.isolation, "container");
  assert.equal(config.heavy.isolation, "container");
  assert.equal(config.container.network, "omp-harness");
  assert.equal(config.container.runnerEnvFile, "/srv/secrets/runner.env");
  assert.equal(config.oracle?.url, "http://mem0:8321");
  assert.equal(config.listen.host, "0.0.0.0", "publié sur la boucle locale de l'hôte par le compose");

  // Un uid de lancement inconnu de l'image : déclaré (ssh l'exige), et la clé nommée par GIT_SSH_COMMAND.
  assert.match(read("Dockerfile.harness"), /ENTRYPOINT \["\/usr\/local\/bin\/omp-harness-entrypoint"\]/);
  assert.match(read("harness-entrypoint"), /getent passwd "\$\(id -u\)"/);
  assert.match(
    read("harness-entrypoint"),
    /GIT_SSH_COMMAND="ssh -i \$HOME\/\.ssh\/id_ed25519 -F \$HOME\/\.ssh\/config/,
  );
  assert.match(fs.readFileSync(path.join(ROOT, "omp-harness", "git.ts"), "utf8"), /"GIT_SSH_COMMAND"\]\) \{/);

  const script = path.join(BOX, "harness.sh");
  assert.equal(spawnSync("bash", ["-n", script]).status, 0);
  const usage = spawnSync("bash", [script], { encoding: "utf8", env: { ...process.env, OMP_HARNESS_ENGINE: "sh" } });
  assert.equal(usage.status, 64);
  for (const command of ["up", "key", "clone", "login", "check", "token"])
    assert.match(usage.stdout, new RegExp(`harness\\.sh ${command}\\b`));
});
