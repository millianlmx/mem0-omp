// Feature harness-providers : les fournisseurs LLM et les chaînes de modèles déclarés
// par l'API (les apps Mac et iOS, rôle admin). Une clé entre et n'en ressort jamais :
// elle vit dans providers.env (0600), d'où la session, le conteneur ou le lanceur root
// la livre aux runners ; les fournisseurs compatibles OpenAI vont dans leur models.yml.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { DEFAULT_LAUNCHER, defaultConfig, loadConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { ProviderRegistry } from "../../omp-harness/providers.ts";
import { runnerArgv } from "../../omp-harness/runner.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import { OK, fakeWorld, testConfig, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const DEPLOY = path.join(ROOT, "omp-harness", "deploy");
const OPENAI_KEY = "test-openai-key-9f3c";
const OLLAMA_KEY = "test-ollama-key-77aa";
const OLLAMA = {
  kind: "openai-compatible",
  baseUrl: "http://127.0.0.1:11434/v1",
  models: [{ id: "qwen3:8b", contextWindow: 32768 }],
  apiKey: OLLAMA_KEY,
};

type Served = { url: string; operator: string; close: () => Promise<void> };

async function serve(world: FakeWorld): Promise<Served> {
  const clients = new ClientRegistry(path.join(tmpdir("harness-providers-"), "clients.json"), ADMIN);
  const { token: operator } = clients.add("iphone", "operator", "*");
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    operator,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function call(url: string, token: string, method: string, route: string, body?: unknown) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await response.text();
  return { status: response.status, raw, body: JSON.parse(raw) as Record<string, unknown> };
}

const chains = (heavy: { provider: string; model: string }[]) => ({ fast: [], standard: [], heavy });

test("harness-providers/AC-1 : seul un admin déclare un fournisseur ; la clé part dans providers.env (0600), jamais en base ni dans une réponse ou un événement", async () => {
  const world = fakeWorld({});
  const served = await serve(world);
  try {
    const health = await fetch(`${served.url}/v1/health`).then((r) => r.json() as Promise<{ features: string[] }>);
    assert.ok(health.features.includes("providers"));
    assert.equal((await call(served.url, served.operator, "GET", "/v1/providers")).status, 403);
    assert.equal(
      (await call(served.url, served.operator, "PUT", "/v1/providers/openai", { kind: "openai", apiKey: OPENAI_KEY }))
        .status,
      403,
    );

    const put = await call(served.url, ADMIN, "PUT", "/v1/providers/openai", { kind: "openai", apiKey: OPENAI_KEY });
    assert.equal(put.status, 200, put.raw);
    assert.ok(!put.raw.includes(OPENAI_KEY), "la clé ne ressort jamais");
    assert.deepEqual(
      (({ name, kind, source, keyVariable, hasKey, keyHint, updatedBy }) => ({
        name,
        kind,
        source,
        keyVariable,
        hasKey,
        keyHint,
        updatedBy,
      }))(put.body.provider as Record<string, unknown>),
      {
        name: "openai",
        kind: "openai",
        source: "api",
        keyVariable: "OPENAI_API_KEY",
        hasKey: true,
        keyHint: "9f3c",
        updatedBy: "admin",
      },
    );
    const env = world.config.providersEnvFile;
    assert.equal(fs.readFileSync(env, "utf8"), `OPENAI_API_KEY=${OPENAI_KEY}\n`);
    assert.equal(fs.statSync(env).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(path.join(world.config.dataDir, "harness.sqlite")).includes(OPENAI_KEY));

    const list = await call(served.url, ADMIN, "GET", "/v1/providers");
    assert.ok(!list.raw.includes(OPENAI_KEY));
    assert.ok((list.body.kinds as string[]).includes("openai-compatible"));
    assert.equal(list.body.modelsSource, "config");
    const events = world.store.eventsSince(0, null, 100, null).filter((e) => e.type === "providers_changed");
    assert.deepEqual(
      events.map((e) => e.payload),
      [{ provider: "openai", change: "put", by: "admin" }],
    );

    // Garder la clé (champ absent), puis la retirer (chaîne vide).
    const kept = await call(served.url, ADMIN, "PUT", "/v1/providers/openai", {
      kind: "openai",
      capacity: 5,
      refillPerMinute: 10,
    });
    assert.equal((kept.body.provider as { hasKey: boolean }).hasKey, true);
    assert.deepEqual(world.config.providers.openai, { capacity: 5, refillPerMinute: 10 });
    const cleared = await call(served.url, ADMIN, "PUT", "/v1/providers/openai", { kind: "openai", apiKey: "" });
    assert.equal((cleared.body.provider as { hasKey: boolean }).hasKey, false);
    assert.equal(fs.readFileSync(env, "utf8"), "");

    // Les refus : sorte, clé, nom réservé.
    for (const [route, body, status] of [
      ["/v1/providers/openai", { kind: "openai-compatible" }, 400],
      ["/v1/providers/mon-vllm", { kind: "openai" }, 400],
      ["/v1/providers/openai", { kind: "openai", apiKey: "a b c d e f g h" }, 400],
      ["/v1/providers/omlx", { ...OLLAMA }, 409],
      ["/v1/providers/Majuscule", { ...OLLAMA }, 400],
      ["/v1/providers/sans-modele", { ...OLLAMA, models: [] }, 400],
      ["/v1/providers/sans-url", { ...OLLAMA, baseUrl: "ftp://x" }, 400],
    ] as const) {
      assert.equal(
        (await call(served.url, ADMIN, "PUT", route, body)).status,
        status,
        `${route} ${JSON.stringify(body)}`,
      );
    }
  } finally {
    await served.close();
  }
});

test("harness-providers/AC-2 : un fournisseur compatible OpenAI est écrit dans le models.yml des runners ; les chaînes le nomment ; il ne part pas tant qu'elles l'utilisent", async () => {
  const world = fakeWorld({});
  const served = await serve(world);
  try {
    // Un models.yml posé par `harness.sh up --omlx` : son bloc `omlx` est gardé.
    const modelsFile = world.config.providersModelsFile;
    fs.writeFileSync(
      modelsFile,
      '# Écrit par harness.sh up --omlx\nproviders:\n  omlx:\n    baseUrl: http://host:8000/v1\n    models:\n      - id: "q"\n',
    );
    const put = await call(served.url, ADMIN, "PUT", "/v1/providers/vps-ollama", OLLAMA);
    assert.equal(put.status, 200, put.raw);
    const yaml = fs.readFileSync(modelsFile, "utf8");
    assert.match(yaml, /^# Écrit par omp-harness/);
    assert.ok(
      yaml.includes(
        [
          "  vps-ollama:",
          '    baseUrl: "http://127.0.0.1:11434/v1"',
          "    api: openai-completions",
          "    apiKey: VPS_OLLAMA_API_KEY",
          "    models:",
          '      - id: "qwen3:8b"',
          '        name: "qwen3:8b"',
          "        contextWindow: 32768",
        ].join("\n"),
      ),
      yaml,
    );
    assert.ok(yaml.includes('  omlx:\n    baseUrl: http://host:8000/v1\n    models:\n      - id: "q"'), yaml);
    assert.ok(!yaml.includes(OLLAMA_KEY), "le models.yml nomme la variable, jamais la clé");

    // Les chaînes : un fournisseur inconnu est refusé, un déclaré passe.
    const unknown = await call(served.url, ADMIN, "PUT", "/v1/models", {
      models: chains([{ provider: "inconnu", model: "x" }]),
    });
    assert.equal(unknown.status, 400);
    const set = await call(served.url, ADMIN, "PUT", "/v1/models", {
      models: chains([{ provider: "vps-ollama", model: "qwen3:8b" }]),
    });
    assert.equal(set.status, 200, set.raw);
    assert.equal(set.body.modelsSource, "api");
    assert.deepEqual(world.config.models.heavy, [{ provider: "vps-ollama", model: "qwen3:8b" }]);
    assert.equal((await call(served.url, ADMIN, "DELETE", "/v1/providers/vps-ollama")).status, 409);

    // Retour aux chaînes de la configuration, puis retrait : clé et bloc s'en vont, `omlx` reste.
    const reset = await call(served.url, ADMIN, "PUT", "/v1/models", { models: null });
    assert.equal(reset.body.modelsSource, "config");
    assert.equal((await call(served.url, ADMIN, "DELETE", "/v1/providers/vps-ollama")).status, 200);
    assert.equal((await call(served.url, ADMIN, "DELETE", "/v1/providers/vps-ollama")).status, 404);
    assert.equal(fs.readFileSync(world.config.providersEnvFile, "utf8"), "");
    const after = fs.readFileSync(modelsFile, "utf8");
    assert.ok(!after.includes("vps-ollama") && after.includes("  omlx:"), after);
  } finally {
    await served.close();
  }
});

test("harness-providers/AC-3 : sans isolation, chaque runner reçoit les clés déclarées et le modèle de la chaîne ; tout survit à un redémarrage", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  world.orchestrator.providers.put("vps-ollama", OLLAMA, "admin");
  world.orchestrator.providers.setChains(
    {
      fast: [],
      standard: [{ provider: "vps-ollama", model: "qwen3:8b" }],
      heavy: [{ provider: "vps-ollama", model: "qwen3:8b" }],
    },
    "admin",
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter" });
    await waitFor(
      () => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => String(world.store.getRun(run.id)?.reason),
    );
    assert.equal(world.store.getRun(run.id)?.state, "merged", String(world.store.getRun(run.id)?.reason));
    const starts = world.log().filter((entry) => entry.kind === "argv");
    assert.ok(starts.length > 0);
    for (const start of starts) {
      assert.deepEqual(start.keys, { VPS_OLLAMA_API_KEY: OLLAMA_KEY });
      const argv = start.argv as string[];
      assert.equal(argv[argv.indexOf("--model") + 1], "vps-ollama/qwen3:8b");
    }
  } finally {
    await world.orchestrator.stop();
  }

  // Un service neuf sur la même base : chaînes et limites reviennent de la base.
  const config = testConfig(harnessRepo());
  config.providersEnvFile = world.config.providersEnvFile;
  config.providersModelsFile = world.config.providersModelsFile;
  const store = new Store(path.join(world.config.dataDir, "harness.sqlite"));
  const scheduler = new Scheduler({
    runnerSlots: 1,
    heavySlots: 1,
    admission: config.admission,
    providers: config.providers,
    memAvailableMiB: () => null,
  });
  const registry = new ProviderRegistry({ config, store, scheduler, log: () => {} });
  registry.put("vps-ollama", { kind: "openai-compatible", capacity: 1, refillPerMinute: 1 }, "admin");
  registry.apply();
  assert.deepEqual(config.models.standard, [{ provider: "vps-ollama", model: "qwen3:8b" }]);
  assert.deepEqual(config.providers["vps-ollama"], { capacity: 1, refillPerMinute: 1 });
  // La limite vaut tout de suite : un jeton, puis le fournisseur attend.
  const choice = [{ provider: "vps-ollama", model: "qwen3:8b" }];
  assert.ok("choice" in scheduler.pickModel(choice));
  assert.ok("waitMs" in scheduler.pickModel(choice));
  assert.equal((registry.list().find((view) => view.name === "vps-ollama") as { hasKey: boolean }).hasKey, true);
  store.close();
});

test("harness-providers/AC-4 : en conteneur, providers.env est monté et l'entrée n'en exporte que des *_API_KEY ; derrière le lanceur root, de même, et le models.yml est posé sous le profil du runner", () => {
  // Conteneur : monté seulement si le fichier existe.
  const config = defaultConfig(tmpdir("harness-providers-box-"));
  config.runner.isolation = "container";
  const spec = { unit: "omp-runner-r1-1", cwd: "/w", overlay: "/o.json", model: null, scope: "demo", repo: "/r" };
  const mount = `${config.providersEnvFile}:/run/secrets/providers.env:ro`;
  assert.ok(!runnerArgv(config, spec).args.includes(mount));
  fs.writeFileSync(config.providersEnvFile, `OPENAI_API_KEY=${OPENAI_KEY}\n`, { mode: 0o600 });
  assert.ok(runnerArgv(config, spec).args.includes(mount));

  // L'entrée des runners : lues, jamais sourcées, et seulement des `*_API_KEY` simples.
  const dir = tmpdir("harness-providers-entry-");
  const secrets = path.join(dir, "providers.env");
  fs.writeFileSync(
    secrets,
    [`OPENAI_API_KEY=${OPENAI_KEY}`, "LD_PRELOAD=/tmp/x.so", "EVIL_API_KEY=$(id)", "lower_API_KEY=abcdefgh", ""].join(
      "\n",
    ),
  );
  const entry = fs
    .readFileSync(path.join(DEPLOY, "container", "runner-entrypoint"), "utf8")
    .replaceAll("/run/secrets/providers.env", secrets)
    .replaceAll("/run/secrets/runner.env", path.join(dir, "absent"))
    .replace('exec "$@"', 'env | grep -E "API_KEY|LD_PRELOAD" | sort');
  const script = path.join(dir, "entry.sh");
  fs.writeFileSync(script, entry);
  const shown = spawnSync("sh", [script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir } });
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, `OPENAI_API_KEY=${OPENAI_KEY}\n`);

  // Le lanceur root : une configuration de remplacement, honorée hors root seulement.
  const root = process.getuid?.() === 0;
  const confDir = tmpdir("harness-providers-launcher-");
  fs.chmodSync(confDir, 0o755);
  const envFile = path.join(confDir, "providers.env");
  const modelsFile = path.join(confDir, "providers.models.yml");
  fs.writeFileSync(envFile, `OPENAI_API_KEY=${OPENAI_KEY}\nLD_PRELOAD=/tmp/x.so\nPATH_API_KEY=a b\n`, { mode: 0o644 });
  fs.writeFileSync(modelsFile, "providers: {}\n", { mode: 0o644 });
  if (root) for (const file of [envFile, modelsFile]) fs.chownSync(file, 65534, 65534);
  const conf = path.join(confDir, "launcher.conf");
  const writeConf = (env: string, models: string) =>
    fs.writeFileSync(
      conf,
      `${fs.readFileSync(path.join(DEPLOY, "launcher.conf"), "utf8")}PROVIDERS_ENV_FILE=${env}\nPROVIDERS_MODELS_FILE=${models}\n`,
      { mode: 0o644 },
    );
  const launcherConfig = loadConfig(path.join(DEPLOY, "config.example.json"));
  const args = runnerArgv(launcherConfig, {
    unit: "omp-runner-r1-1",
    cwd: "/var/lib/omp-harness/worktrees/demo/export",
    overlay: "/o.json",
    model: null,
    scope: "demo",
    repo: "/var/lib/omp-harness/repos/demo",
  }).args.slice(DEFAULT_LAUNCHER.length - 1);
  const launcher = (argv: string[]) =>
    spawnSync("bash", [path.join(DEPLOY, "omp-harness-systemd-run"), ...argv], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", OMP_HARNESS_LAUNCHER_DRY_RUN: "1", OMP_HARNESS_LAUNCHER_CONF: conf },
      ...(root ? { uid: 65534, gid: 65534 } : {}),
    });

  writeConf(envFile, modelsFile);
  const ok = launcher(args);
  assert.equal(ok.status, 0, ok.stderr);
  const lines = ok.stdout.split("\n");
  assert.deepEqual(
    lines.filter((line) => line.startsWith("providerenv:")),
    ["providerenv:OPENAI_API_KEY"],
  );
  const models = lines.filter((line) => line.startsWith("models:"));
  assert.equal(models.length, 1);
  assert.match(models[0] as string, /\/\.omp\/profiles\/pipeline\/agent\/models\.yml$/);
  const profile = args.indexOf("--profile") + 1;
  assert.equal(launcher(args.map((arg, index) => (index === profile ? "../etc" : arg))).status, 64);

  // Un lien posé par le service n'est jamais suivi par root.
  const link = path.join(confDir, "lien.env");
  fs.symlinkSync(envFile, link);
  writeConf(link, path.join(confDir, "absent.yml"));
  const linked = launcher(args);
  assert.equal(linked.status, 0, linked.stderr);
  assert.ok(!/^(providerenv|models):/m.test(linked.stdout), linked.stdout);
});
