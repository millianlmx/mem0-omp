// Feature local-model : `harness.sh up --omlx <modèle>` met tout en local sur un Mac.
// Les agents passent sur le serveur oMLX natif de l'hôte (fournisseur `omlx` dans le
// `models.yml` de leur profil), la mémoire y prend ses embeddings, et les slots
// descendent pour tenir à côté du modèle ; `--anthropic` rétablit les chaînes.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../../omp-harness/config.ts";
import { ANTHROPIC_MODELS, LOCAL_SLOTS, runnerModelsFile, setModels } from "../../omp-harness/local-model.ts";
import { runnerArgv } from "../../omp-harness/runner.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const BOX = path.join(ROOT, "omp-harness", "deploy", "container");
const SCRIPT = path.join(BOX, "harness.sh");

/** Le modèle de configuration conteneur, ses chemins posés sous une racine jetable. */
function containerConfigFile(): { file: string; root: string } {
  const root = tmpdir("local-model-");
  const file = path.join(root, "config.json");
  const template = fs.readFileSync(path.join(BOX, "config.container.json"), "utf8");
  fs.writeFileSync(file, template.replaceAll("@ROOT@", root).replaceAll("@SECRETS@", path.join(root, "secrets")));
  return { file, root };
}

test("local-model/AC-1 : --models omlx/<modèle> met toutes les étapes sur oMLX, pose le models.yml du profil des runners et baisse les slots", () => {
  const { file, root } = containerConfigFile();
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.repos = [{ name: "produit", path: path.join(root, "repos", "produit") }];
  fs.writeFileSync(file, JSON.stringify(raw));

  setModels(file, loadConfig(file), "omlx/qwen3-coder-next", { baseUrl: "http://host.docker.internal:8000/v1" });
  const config = loadConfig(file);
  assert.deepEqual(config.models.heavy, [{ provider: "omlx", model: "qwen3-coder-next" }]);
  assert.deepEqual(config.models.standard, [], "un tier vide prend celui du dessus : un seul modèle");
  assert.equal(config.runner.slots, LOCAL_SLOTS.runner);
  assert.equal(config.heavy.slots, LOCAL_SLOTS.heavy);
  assert.equal(config.repos[0]?.name, "produit", "le reste de la configuration est intact");

  // omp lit `~/.omp/profiles/<profil>/agent/models.yml` : le HOME monté du runner, sous `--profile pipeline`.
  const models = runnerModelsFile(config) as string;
  assert.equal(models, path.join(root, "runner-home", ".omp", "profiles", "pipeline", "agent", "models.yml"));
  const yaml = fs.readFileSync(models, "utf8");
  assert.match(
    yaml,
    /^ {2}omlx:\n {4}baseUrl: http:\/\/host\.docker\.internal:8000\/v1\n {4}api: openai-completions\n/m,
  );
  assert.match(yaml, /apiKey: OMLX_API_TOKEN/, "le nom d'une variable de runner.env, jamais la clé");
  assert.match(yaml, /- id: "qwen3-coder-next"\n {8}name: "qwen3-coder-next"\n {8}contextWindow: 131072\n/);

  // Le runner demande ce modèle à omp, sous le profil dont le models.yml le déclare.
  const line = runnerArgv(config, {
    unit: "u",
    cwd: "/w",
    overlay: "/o",
    model: config.models.heavy[0] ?? null,
    scope: "produit",
    repo: "/r",
  });
  assert.ok(line.args.includes("omlx/qwen3-coder-next"));
  assert.equal(line.args[line.args.indexOf("--profile") + 1], config.runner.profile);

  // Des slots déjà plus bas ne remontent pas.
  const lower = JSON.parse(fs.readFileSync(file, "utf8"));
  lower.runner.slots = 1;
  fs.writeFileSync(file, JSON.stringify(lower));
  setModels(file, loadConfig(file), "omlx/autre", { baseUrl: "http://h:8000/v1", contextWindow: 32768 });
  assert.equal(loadConfig(file).runner.slots, 1);
  assert.match(fs.readFileSync(models, "utf8"), /contextWindow: 32768/);
});

test("local-model/AC-2 : --models anthropic rétablit les chaînes ; un spec inconnu ou sans adresse oMLX est refusé, rien n'est écrit", () => {
  const { file } = containerConfigFile();
  setModels(file, loadConfig(file), "omlx/m", { baseUrl: "http://h:8000/v1" });
  setModels(file, loadConfig(file), "anthropic");
  assert.deepEqual(loadConfig(file).models, ANTHROPIC_MODELS);

  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => setModels(file, loadConfig(file), "openai/gpt"), /ni anthropic ni omlx/);
  assert.throws(() => setModels(file, loadConfig(file), "omlx/m"), /exige --omlx-url/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("local-model/AC-3 : main.ts --models applique le changement au fichier de configuration et sort", () => {
  const { file } = containerConfigFile();
  const run = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--disable-warning=ExperimentalWarning",
      path.join(ROOT, "omp-harness", "main.ts"),
      "--config",
      file,
      "--models",
      "omlx/qwen3-coder-next",
      "--omlx-url",
      "http://host.containers.internal:8000/v1",
      "--omlx-context",
      "65536",
    ],
    { encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^✓ toutes les étapes sur omlx\/qwen3-coder-next, 2 runners et 1 job de tests à la fois/);
  const config = loadConfig(file);
  assert.deepEqual(config.models.heavy, [{ provider: "omlx", model: "qwen3-coder-next" }]);
  assert.match(fs.readFileSync(runnerModelsFile(config) as string, "utf8"), /contextWindow: 65536/);
});

test("local-model/AC-4 : harness.sh up --omlx sonde oMLX avant tout, garde le mode, n'exige aucune clé et donne ses embeddings à la mémoire", () => {
  const script = fs.readFileSync(SCRIPT, "utf8");
  const usage = spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, OMP_HARNESS_ENGINE: "sh" } });
  assert.match(usage.stdout, /harness\.sh up --omlx <modèle>/);
  assert.match(usage.stdout, /OMLX_CONTEXT_WINDOW/, "l'aide va jusqu'au bout des variables");

  // oMLX injoignable : arrêt avant d'avoir rien créé.
  const root = tmpdir("local-model-up-");
  const bin = tmpdir("local-model-bin-");
  fs.writeFileSync(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const up = spawnSync("bash", [SCRIPT, "up", "--omlx", "qwen3-coder-next"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      OMP_HARNESS_ENGINE: "docker",
      OMP_HARNESS_ROOT: path.join(root, "harness"),
      OMP_HARNESS_SECRETS: path.join(root, "secrets"),
      OMLX_BASE_URL: "http://127.0.0.1:9/v1",
    },
  });
  assert.equal(up.status, 1);
  assert.match(up.stderr, /oMLX ne répond pas sur http:\/\/127\.0\.0\.1:9\/v1/);
  assert.ok(!fs.existsSync(path.join(root, "harness")), "rien n'est créé avant que oMLX réponde");

  // Les conteneurs joignent oMLX par le nom d'hôte de leur moteur ; l'hôte par sa boucle locale.
  assert.match(
    script,
    /podman.*host\.containers\.internal:8000\/v1; else echo http:\/\/host\.docker\.internal:8000\/v1/,
  );
  assert.match(script, /OMP_HARNESS_OMLX_MODEL=\$OMLX_MODEL/, "le mode est gardé dans compose.env");
  assert.match(script, /ask_llm_key\(\) \{\n {2}\[ -z "\$OMLX_MODEL" \] \|\| return 0/, "aucune clé demandée en local");
  assert.match(script, /set_line OMLX_BASE_URL "\$\(omlx_url\)" "\$SECRETS\/mem0\.env"/);
  // bash 3.2 (celui de macOS) refuse un tableau vide sous `set -u` : jamais de "${x[@]}" nu sur un tableau qui peut l'être.
  for (const name of ["profiles", "auth"])
    assert.match(script, new RegExp(`\\$\\{${name}\\[@\\]\\+"\\$\\{${name}\\[@\\]\\}"\\}`));
});
