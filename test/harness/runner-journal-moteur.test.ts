// Feature runner-journal-moteur (#412 « panic ×N », #414 « collision git index.lock ×N ») : un runner conteneur
// ne laisse rien de sa session (trames RPC, résultats d'outils) dans le journal du moteur, où un détecteur
// externe la lirait comme un faux incident. Seul l'argv est vérifié ici ; le journal vide et le dialogue RPC
// sous `run -i` se vérifient à la main sur un hôte avec moteur (AC-109, aucun test).
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { browserArgv, previewArgv } from "../../omp-harness/browser/qa.ts";
import { heavyArgv, heavyEnv } from "../../omp-harness/heavy.ts";
import { loginArgv } from "../../omp-harness/oauth.ts";
import { runnerArgv } from "../../omp-harness/runner.ts";
import type { RunnerSpec } from "../../omp-harness/runner.ts";

const NO_LOG = "--log-driver=none";
const WT = "/srv/omp/worktrees/demo/export";
const REPO = "/srv/omp/repos/demo";

function containerConfig(patch: (config: HarnessConfig) => void = () => {}): HarnessConfig {
  const config = defaultConfig("/srv/omp/state");
  config.runner.isolation = "container";
  config.heavy.isolation = "container";
  config.container.network = "omp-harness";
  config.container.runnerEnvFile = "/srv/secrets/runner.env";
  config.container.runnerHome = "/srv/omp/runner-home";
  config.container.user = "1000:1000";
  config.heavy.cargoTargetRoot = null;
  config.ompBin = "/usr/local/bin/omp";
  patch(config);
  return config;
}

const spec = (patch: Partial<RunnerSpec> = {}): RunnerSpec => ({
  unit: "omp-runner-r1-3",
  cwd: WT,
  overlay: "/srv/omp/state/runner-settings.json",
  model: { provider: "anthropic", model: "claude-sonnet-5-5" },
  scope: "demo",
  repo: REPO,
  ...patch,
});

/** Le début de la ligne du moteur, jusqu'au nom de l'unité compris. */
const head = (args: string[], unit: string) => args.slice(0, args.indexOf(`--name=${unit}`) + 1);

test("runner-journal-moteur/AC-108 : un runner conteneur coupe le journal du moteur, juste après -i, quel que soit son spec et son moteur", () => {
  const docker = runnerArgv(containerConfig(), spec());
  assert.equal(docker.command, "docker");
  assert.deepEqual(head(docker.args, "omp-runner-r1-3"), [
    "run",
    "--rm",
    "-i",
    NO_LOG,
    "--init",
    "--name=omp-runner-r1-3",
  ]);

  const podman = runnerArgv(
    containerConfig((c) => {
      c.container.command = ["podman"];
    }),
    spec(),
  );
  assert.equal(podman.command, "podman");
  assert.deepEqual(podman.args.slice(0, 4), ["run", "--rm", "-i", NO_LOG]);

  const remote = runnerArgv(
    containerConfig((c) => {
      c.container.command = ["docker", "--host", "unix:///x.sock"];
    }),
    spec(),
  );
  assert.equal(remote.command, "docker");
  assert.deepEqual(remote.args.slice(0, 7), ["--host", "unix:///x.sock", "run", "--rm", "-i", NO_LOG, "--init"]);

  const bare = containerConfig((c) => {
    c.container.network = null;
    c.container.runnerHome = null;
    c.container.runnerEnvFile = null;
  });
  const variants: RunnerSpec[] = [
    spec({ model: null, memory: false }),
    spec({ localOnly: true }),
    spec({ memoryEnvFile: "/srv/omp/state/memory.env", oracleUrl: "http://mem0:8321" }),
  ];
  for (const variant of variants)
    for (const config of [containerConfig(), bare]) {
      const line = runnerArgv(config, variant);
      assert.deepEqual(line.args.slice(0, 4), ["run", "--rm", "-i", NO_LOG], JSON.stringify(variant));
    }

  assert.throws(() => runnerArgv(containerConfig(), spec({ repo: undefined })), /clone du dépôt du runner est requis/);
});

test("runner-journal-moteur/AC-110 : les runners en isolation none et systemd ne portent aucune option de journal", () => {
  const none = defaultConfig("/srv/omp/state");
  none.runner.isolation = "none";
  none.ompBin = "/usr/local/bin/omp";
  const bare = runnerArgv(none, spec({ repo: undefined }));
  assert.equal(bare.command, "/usr/local/bin/omp");
  assert.deepEqual(bare.args.slice(0, 3), ["--mode", "rpc", "--no-ui"]);
  assert.ok(!bare.args.some((arg) => arg.startsWith("--log")));

  const systemd = defaultConfig("/srv/omp/state");
  systemd.runner.isolation = "systemd";
  systemd.launcher = ["sudo", "-n", "/usr/local/libexec/omp-harness-systemd-run"];
  const unit = runnerArgv(systemd, spec());
  assert.equal(unit.command, "sudo");
  assert.ok(!unit.args.some((arg) => arg.startsWith("--log-driver")));
});

test("runner-journal-moteur/AC-111 : heavy, QA et login OAuth gardent le journal du moteur", () => {
  const config = containerConfig();
  const repo = repoDefaults({ name: "demo", path: REPO });
  const lines = {
    heavy: heavyArgv(config, WT, "omp-heavy-r1-2", "npm test", heavyEnv(config, WT), repo),
    preview: previewArgv(config, repo, { command: "npm run dev", port: 3000, path: "/" }, WT, "omp-qa-r1-2-preview"),
    browser: browserArgv(config, "omp-qa-r1-2-preview", "omp-qa-r1-2-browser"),
    login: loginArgv(config, "omp-login-1"),
  };
  for (const [name, line] of Object.entries(lines)) {
    assert.equal(line.command, "docker", name);
    assert.ok(line.args.includes("run"), `${name} : une ligne run`);
    assert.ok(!line.args.some((arg) => arg.startsWith("--log-driver")), `${name} garde le journal`);
  }
});

test("runner-journal-moteur/AC-112 : la ligne d'un runner conteneur porte exactement une fois l'option, avant l'image, avec -i", () => {
  for (const config of [
    containerConfig(),
    containerConfig((c) => {
      c.container.command = ["podman"];
    }),
  ]) {
    const { args } = runnerArgv(config, spec());
    const image = args.indexOf(config.container.runnerImage);
    assert.ok(image > 0, "l'image du runner est dans la ligne");
    const engineFlags = args.slice(0, image);
    assert.equal(engineFlags.filter((arg) => arg === NO_LOG).length, 1, `${NO_LOG} une fois avant l'image`);
    assert.ok(engineFlags.includes("-i"), "-i garde stdin/stdout du harness");
    assert.deepEqual(
      engineFlags.filter((arg) => arg.startsWith("--log-driver") || arg.startsWith("--log-opt")),
      [NO_LOG],
    );
    assert.ok(!args.slice(image + 1).includes(NO_LOG), "l'option est celle du moteur, pas d'omp");
  }
});
