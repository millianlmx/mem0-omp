// Feature harness-politique : la politique par dépôt (et celle du poste) — ses modèles,
// sa liste blanche de fournisseurs (jamais de bascule hors liste), `local-only` (le
// modèle local pour CE dépôt seulement), l'identité de ses commits, son compte gh et son
// jeton mémoire cloisonné. Sans ces champs, rien ne change.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { renderChecks, runChecks } from "../../omp-harness/check.ts";
import type { HarnessConfig, RepoConfig } from "../../omp-harness/config.ts";
import { DEFAULT_LAUNCHER, loadConfig, repoDefaults, validateConfig } from "../../omp-harness/config.ts";
import { HarnessContext } from "../../omp-harness/context.ts";
import type { SpawnRunner } from "../../omp-harness/context.ts";
import { Store } from "../../omp-harness/db.ts";
import { Git } from "../../omp-harness/git.ts";
import { HeavyRunner } from "../../omp-harness/heavy.ts";
import { addLocalModel, localProvider } from "../../omp-harness/local-model.ts";
import { PolicyRefusal, memoryTokenFile, repoIdentity } from "../../omp-harness/policy.ts";
import type { Exec, ProcResult } from "../../omp-harness/proc.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { PromptError, RunnerProcess } from "../../omp-harness/rpc.ts";
import { runnerArgv } from "../../omp-harness/runner.ts";
import { RunnerSession } from "../../omp-harness/runner-session.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import { workstationTarget } from "../../omp-harness/workstation-agent.ts";
import { MemoryOracle, fakeWorld, git, harnessRepo, testConfig, waitFor } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const DEPLOY = path.join(ROOT, "omp-harness", "deploy");
const CORPO_TOKEN = "corpo-memoire-0123456789";

type Spawned = { args: string[]; env: Record<string, string | undefined> };

/** Un faux runner : chaque prompt reçoit la prochaine réponse du script (`null` : succès). */
function scriptedRunner(script: (PromptError | null)[]) {
  const spawned: Spawned[] = [];
  const models: string[] = [];
  const spawn: SpawnRunner = (_command, args, options) => {
    spawned.push({ args, env: options.env });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    stdin.setEncoding("utf8");
    stdin.on("end", () => events.emit("exit", 0, null));
    const out = (frame: object) => stdout.write(`${JSON.stringify(frame)}\n`);
    stdin.on("data", (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const frame: { id: string; type: string; provider?: string; modelId?: string } = JSON.parse(line);
        if (frame.type === "set_model") models.push(`${frame.provider}/${frame.modelId}`);
        if (frame.type === "set_host_tools" || frame.type === "set_model")
          out({ id: frame.id, type: "response", command: frame.type, success: true, data: {} });
        if (frame.type === "prompt") {
          out({ id: frame.id, type: "response", command: "prompt", success: true });
          const error = script.shift() ?? null;
          out(
            error
              ? { id: frame.id, type: "prompt_result", status: "error", error }
              : { id: frame.id, type: "prompt_result", status: "completed", error: null },
          );
        }
      }
    });
    const proc: RunnerProcess = {
      pid: 1,
      stdin,
      stdout,
      stderr: new PassThrough(),
      kill: () => {
        events.emit("exit", null, "SIGTERM");
        return true;
      },
      once: (event, listener) => events.once(event, listener),
      on: (event, listener) => events.on(event, listener),
    };
    queueMicrotask(() => out({ type: "ready", protocolVersion: 1 }));
    return proc;
  };
  return { spawn, spawned, models };
}

/** Un contexte complet sur un faux runner ; `target` : le dépôt et le répertoire de la session. */
function world(
  patch: (config: HarnessConfig) => void,
  script: (PromptError | null)[] = [],
  target?: (config: HarnessConfig) => { repo: RepoConfig; cwd: string },
) {
  const repo = harnessRepo();
  const config = testConfig(repo, (c) => {
    c.models = {
      fast: [],
      standard: [{ provider: "anthropic", model: "sonnet" }],
      heavy: [
        { provider: "anthropic", model: "opus" },
        { provider: "openrouter", model: "big" },
      ],
    };
    c.oracle = { url: "http://127.0.0.1:8321", token: "jeton-global-0123456789" };
    patch(c);
  });
  const store = new Store(path.join(config.dataDir, "h.sqlite"));
  const scheduler = new Scheduler({
    runnerSlots: 5,
    heavySlots: 2,
    admission: config.admission,
    providers: config.providers,
    memAvailableMiB: () => null,
    sleep: async () => {},
  });
  const git = new Git(execProcess, repoIdentity(config));
  const heavy = new HeavyRunner({ config, store, scheduler, git, exec: execProcess });
  const runner = scriptedRunner(script);
  const ctx = new HarnessContext({
    config,
    store,
    scheduler,
    git,
    heavy,
    oracle: new MemoryOracle(),
    spawn: runner.spawn,
    exec: execProcess,
  });
  const { repo: repoConfig, cwd } = target?.(config) ?? { repo: config.repos[0] as RepoConfig, cwd: repo };
  fs.mkdirSync(cwd, { recursive: true });
  const session = new RunnerSession(
    ctx,
    { repo: repoConfig, cwd },
    {
      onHostTool: async () => ({ text: "" }),
      event: () => {},
      sleep: async () => {},
    },
  );
  return { config, session, runner };
}

const signal = () => new AbortController().signal;
const far = () => Date.now() + 3_600_000;
const modelArg = (spawned: Spawned | undefined) => spawned?.args[spawned.args.indexOf("--model") + 1];

/** Un `models.yml` des runners qui déclare le fournisseur local `omlx` (comme `--local-model`). */
function declareLocal(config: HarnessConfig, model = "qwen3-coder"): void {
  config.providersModelsFile = path.join(tmpdir("harness-politique-models-"), "providers.models.yml");
  addLocalModel(config, `omlx/${model}`, { baseUrl: "http://127.0.0.1:8000/v1" });
}

/** Une variable du service posée le temps de `body`. */
async function withEnv<T>(vars: Record<string, string | undefined>, body: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  const set = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  set(vars);
  try {
    return await body();
  } finally {
    set(before);
  }
}

test("harness-politique/AC-1 : les chaînes d'un dépôt passent avant celles du serveur, tier par tier ; un dépôt sans politique garde celles du serveur", async () => {
  const own = world((c) => {
    Object.assign(c.repos[0] as RepoConfig, { models: { heavy: ["mistral/large", "openrouter/big"] } });
  });
  await own.session.open("heavy", "u1", signal());
  assert.equal(modelArg(own.runner.spawned[0]), "mistral/large");
  // Le tier `standard` n'est pas redéfini par le dépôt : celui du serveur.
  await own.session.open("standard", "u1", signal());
  assert.deepEqual(own.runner.models, ["anthropic/sonnet"]);
  assert.deepEqual(own.config.models.heavy[0], { provider: "anthropic", model: "opus" }, "le serveur n'a pas changé");
  await own.session.stop();

  const plain = world(() => {});
  await plain.session.open("heavy", "u1", signal());
  assert.equal(modelArg(plain.runner.spawned[0]), "anthropic/opus");
  await plain.session.stop();
});

test("harness-politique/AC-2 : la liste blanche ne bascule jamais hors d'elle — une erreur du fournisseur réessaie le même, un tier sans modèle permis refuse l'étape sans lancer de runner", async () => {
  const w = world(
    (c) => {
      Object.assign(c.repos[0] as RepoConfig, { providers: ["anthropic"] });
    },
    [{ message: "Internal Server Error", httpStatus: 503 }, null],
  );
  await w.session.open("heavy", "u1", signal());
  assert.equal(modelArg(w.runner.spawned[0]), "anthropic/opus");
  const result = await w.session.prompt("bonjour", signal(), far());
  assert.equal(result.status, "completed");
  assert.deepEqual(w.runner.models, [], "openrouter, hors liste, n'a jamais été choisi");
  await w.session.stop();

  const refused = world((c) => {
    Object.assign(c.repos[0] as RepoConfig, { providers: ["mistral"] });
  });
  await assert.rejects(refused.session.open("heavy", "u1", signal()), (err: unknown) => {
    assert.ok(err instanceof PolicyRefusal);
    assert.match(err.message, /mistral/);
    return true;
  });
  assert.equal(refused.runner.spawned.length, 0, "aucun runner sans modèle permis");
});

test("harness-politique/AC-3 : `local-only` prend le modèle local pour CE dépôt seulement — aucune clé distante chez son runner, le serveur et les autres dépôts inchangés — et refuse sans modèle local", async () => {
  await withEnv({ ANTHROPIC_API_KEY: "sk-ant-0123456789" }, async () => {
    const w = world((c) => {
      declareLocal(c);
      Object.assign(c.repos[0] as RepoConfig, { privacy: "local-only" });
    });
    await w.session.open("standard", "u1", signal());
    const spawned = w.runner.spawned[0] as Spawned;
    assert.equal(modelArg(spawned), "omlx/qwen3-coder");
    assert.equal(spawned.env.ANTHROPIC_API_KEY, undefined, "aucune clé de fournisseur distant");
    assert.equal(spawned.env.OMP_HARNESS_LOCAL_ONLY, "1");
    assert.deepEqual(
      w.config.models.standard,
      [{ provider: "anthropic", model: "sonnet" }],
      "le serveur n'a pas basculé",
    );
    await w.session.stop();

    const other = world((c) => declareLocal(c));
    await other.session.open("standard", "u1", signal());
    assert.equal(modelArg(other.runner.spawned[0]), "anthropic/sonnet", "un dépôt standard reste chez son fournisseur");
    assert.equal(other.runner.spawned[0]?.env.ANTHROPIC_API_KEY, "sk-ant-0123456789");
    await other.session.stop();
  });

  const bare = world((c) => {
    c.providersModelsFile = path.join(tmpdir("harness-politique-none-"), "absent.yml");
    Object.assign(c.repos[0] as RepoConfig, { privacy: "local-only" });
  });
  await assert.rejects(bare.session.open("heavy", "u1", signal()), PolicyRefusal);
  assert.equal(bare.runner.spawned.length, 0);

  // En conteneur : pas de fichier des clés de l'API, et l'entrée retire les clés de runner.env.
  const config = testConfig(harnessRepo(), (c) => {
    c.runner.isolation = "container";
  });
  config.providersEnvFile = path.join(tmpdir("harness-politique-keys-"), "providers.env");
  fs.writeFileSync(config.providersEnvFile, "ANTHROPIC_API_KEY=sk-ant-0123456789\n");
  const spec = { unit: "omp-runner-r1-1", cwd: "/w/x", overlay: "/o.json", model: null, scope: "s", repo: "/r" };
  const local = runnerArgv(config, { ...spec, localOnly: true }).args.join(" ");
  assert.doesNotMatch(local, /providers\.env/);
  assert.match(local, /--env OMP_HARNESS_LOCAL_ONLY=1/);
  assert.match(runnerArgv(config, spec).args.join(" "), /providers\.env/);
  // L'entrée des runners : le jeton mémoire du dépôt remplace celui de runner.env ; local-only, aucune clé.
  const dir = tmpdir("harness-politique-entry-");
  fs.writeFileSync(
    path.join(dir, "runner.env"),
    "ANTHROPIC_API_KEY=root-key-0001\nMEM0_HTTP_TOKEN=global-0123456789abcdef\n",
  );
  fs.writeFileSync(path.join(dir, "memory.env"), `MEM0_HTTP_TOKEN=${CORPO_TOKEN}\n`);
  fs.writeFileSync(path.join(dir, "providers.env"), "OPENAI_API_KEY=sk-openai-01234567\n");
  const script = path.join(dir, "entry.sh");
  fs.writeFileSync(
    script,
    fs
      .readFileSync(path.join(DEPLOY, "container", "runner-entrypoint"), "utf8")
      .replaceAll("/run/secrets/", `${dir}/`)
      .replace("/etc/passwd", path.join(dir, "passwd"))
      .replace('exec "$@"', 'env | grep -E "API_KEY|MEM0_HTTP_TOKEN" | sort'),
  );
  const entry = (env: Record<string, string>) =>
    spawnSync("sh", [script], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: dir, ...env } });
  const remote = entry({});
  assert.equal(remote.status, 0, remote.stderr);
  assert.equal(
    remote.stdout,
    `ANTHROPIC_API_KEY=root-key-0001\nMEM0_HTTP_TOKEN=${CORPO_TOKEN}\nOPENAI_API_KEY=sk-openai-01234567\n`,
  );
  const localOnly = entry({ OMP_HARNESS_LOCAL_ONLY: "1" });
  assert.equal(localOnly.stdout, `MEM0_HTTP_TOKEN=${CORPO_TOKEN}\n`);
  if (process.getuid?.() !== 0) {
    fs.chmodSync(path.join(dir, "memory.env"), 0o000);
    assert.notEqual(entry({}).status, 0, "un jeton du dépôt illisible arrête le runner, jamais de repli");
  }
});

test("harness-politique/AC-4 : les commits d'un dépôt portent son identité (`git`), ceux des autres l'identité du serveur", async () => {
  const corpo = harnessRepo("harness-politique-corpo-");
  const perso = harnessRepo("harness-politique-perso-");
  const config = testConfig(corpo, (c) => {
    Object.assign(c.repos[0] as RepoConfig, { git: { name: "Alice Corpo", email: "alice@corpo.example" } });
    c.repos.push(repoDefaults({ name: "perso", path: perso, scope: "perso" }));
  });
  const client = new Git(execProcess, repoIdentity(config));
  const base = git(corpo, "rev-parse", "main");
  const corpoWt = path.join(config.worktreesDir, "demo", "f1");
  await client.addWorktree(corpo, corpoWt, "harness/f1", base);
  fs.writeFileSync(path.join(corpoWt, "note.txt"), "corpo\n");
  const sha = await client.commitAll(corpoWt, "wip: corpo");
  assert.equal(
    git(corpo, "log", "-1", "--format=%an <%ae> / %cn <%ce>", sha),
    "Alice Corpo <alice@corpo.example> / Alice Corpo <alice@corpo.example>",
  );
  // Un worktree hors de `worktreesDir/<dépôt>` (le revert) : reconnu par son clone.
  const scratch = path.join(config.worktreesDir, "revert-f1-x");
  await client.addWorktree(corpo, scratch, null, base);
  fs.writeFileSync(path.join(scratch, "revert.txt"), "x\n");
  assert.equal(
    git(corpo, "log", "-1", "--format=%ae", await client.commitAll(scratch, "revert")),
    "alice@corpo.example",
  );

  const persoWt = path.join(config.worktreesDir, "perso", "f2");
  await client.addWorktree(perso, persoWt, "harness/f2", git(perso, "rev-parse", "main"));
  fs.writeFileSync(path.join(persoWt, "note.txt"), "perso\n");
  assert.equal(
    git(perso, "log", "-1", "--format=%an <%ae>", await client.commitAll(persoWt, "wip: perso")),
    "Harness <harness@example.com>",
  );
});

test("harness-politique/AC-5 : `gh` parle sous le compte du dépôt — sa connexion (GH_CONFIG_DIR) et son jeton, jamais celui du service — et refuse sans son jeton", async () => {
  const calls: { args: string[]; env: Record<string, string | undefined> | undefined }[] = [];
  const done = (stdout: string): ProcResult => ({
    code: 0,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    aborted: false,
  });
  const exec: Exec = async (command, args, options) => {
    if (command !== "gh") return execProcess(command, args, options);
    calls.push({ args, env: options?.env });
    return done("[]");
  };
  const configDir = tmpdir("harness-politique-gh-");
  const w = fakeWorld(
    {},
    {
      exec,
      patch: (c) => {
        Object.assign(c.repos[0] as RepoConfig, { gh: { configDir, tokenEnv: "CORPO_GH_TOKEN" } });
        c.repos.push(repoDefaults({ name: "perso", path: harnessRepo("harness-politique-gh-perso-"), scope: "perso" }));
      },
    },
  );
  for (const repo of w.config.repos) git(repo.path, "remote", "add", "origin", `git@github.com:moi/${repo.name}.git`);
  const [corpo, perso] = w.config.repos as [RepoConfig, RepoConfig];
  await withEnv({ CORPO_GH_TOKEN: "ghp_corpo", GH_TOKEN: "ghp_service", GITHUB_TOKEN: "ghp_service2" }, async () => {
    await w.orchestrator.issues.list(corpo);
    await w.orchestrator.issues.list(perso);
  });
  assert.equal(calls.length, 2);
  const [own, plain] = calls;
  assert.equal(own?.env?.GH_TOKEN, "ghp_corpo");
  assert.equal(own?.env?.GH_CONFIG_DIR, configDir);
  assert.equal(own?.env?.GITHUB_TOKEN, undefined, "aucun jeton du service sous le compte du dépôt");
  assert.equal(plain?.env, undefined, "un dépôt sans compte propre hérite du service");
  await withEnv({ CORPO_GH_TOKEN: undefined }, async () => {
    await assert.rejects(w.orchestrator.issues.list(corpo), PolicyRefusal);
  });
  assert.equal(calls.length, 2, "aucun gh sous un autre compte");
});

test("harness-politique/AC-6 : le runner d'un dépôt reçoit SON jeton mémoire au lieu du jeton global — jamais le jeton d'un autre dépôt — et ne part pas sans lui", async () => {
  await withEnv({ CORPO_MEM0_TOKEN: CORPO_TOKEN, PERSO_GH_TOKEN: "ghp_perso" }, async () => {
    const w = world((c) => {
      Object.assign(c.repos[0] as RepoConfig, { memory: { tokenEnv: "CORPO_MEM0_TOKEN" } });
      c.repos.push({
        ...repoDefaults({ name: "perso", path: "/srv/perso", scope: "perso" }),
        gh: { tokenEnv: "PERSO_GH_TOKEN" },
      });
    });
    await w.session.open("heavy", "u1", signal());
    const env = (w.runner.spawned[0] as Spawned).env;
    assert.equal(env.MEM0_HTTP_TOKEN, CORPO_TOKEN);
    assert.equal(env.CORPO_MEM0_TOKEN, undefined);
    assert.equal(env.PERSO_GH_TOKEN, undefined, "le jeton d'un autre dépôt ne passe jamais");
    // Le fichier que lisent le lanceur root et le conteneur : 0600, le jeton du dépôt seul.
    const file = memoryTokenFile(w.config, "demo");
    assert.equal(fs.readFileSync(file, "utf8"), `MEM0_HTTP_TOKEN=${CORPO_TOKEN}\n`);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    await w.session.stop();

    const plain = world(() => {});
    await plain.session.open("heavy", "u1", signal());
    assert.equal(plain.runner.spawned[0]?.env.MEM0_HTTP_TOKEN, "jeton-global-0123456789");
    await plain.session.stop();
  });

  const missing = world((c) => {
    Object.assign(c.repos[0] as RepoConfig, { memory: { tokenEnv: "ABSENT_MEM0_TOKEN" } });
  });
  await assert.rejects(missing.session.open("heavy", "u1", signal()), PolicyRefusal);
  assert.equal(missing.runner.spawned.length, 0);

  // Le lanceur root (systemd) : le jeton du dépôt, lu dans le dossier des jetons, après runner.env ; aucune clé en local-only.
  const dir = tmpdir("harness-politique-launcher-");
  fs.chmodSync(dir, 0o755);
  const runnerEnvFile = path.join(dir, "runner.env");
  fs.writeFileSync(runnerEnvFile, "ANTHROPIC_API_KEY=root-key-0001\nMEM0_HTTP_TOKEN=global-0123456789abcdef\n");
  fs.mkdirSync(path.join(dir, "tokens"));
  fs.writeFileSync(path.join(dir, "tokens", "mon-produit.env"), `MEM0_HTTP_TOKEN=${CORPO_TOKEN}\n`, { mode: 0o600 });
  const conf = path.join(dir, "launcher.conf");
  fs.writeFileSync(
    conf,
    `${fs.readFileSync(path.join(DEPLOY, "launcher.conf"), "utf8")}RUNNER_ENV_FILE=${runnerEnvFile}\nPROVIDERS_ENV_FILE=${path.join(dir, "absent.env")}\nPROVIDERS_MODELS_FILE=${path.join(dir, "absent.yml")}\nMEMORY_TOKENS_DIR=${path.join(dir, "tokens")}\n`,
  );
  const config = loadConfig(path.join(DEPLOY, "config.example.json"));
  const line = runnerArgv(config, {
    unit: "omp-runner-r1-7",
    cwd: "/var/lib/omp-harness/worktrees/mon-produit/export",
    overlay: "/var/lib/omp-harness/state/runner-settings.json",
    model: { provider: "omlx", model: "qwen3-coder" },
    scope: "mon-produit",
    localOnly: true,
  });
  assert.equal(line.command, DEFAULT_LAUNCHER[0]);
  const result = spawnSync(
    "bash",
    [path.join(DEPLOY, "omp-harness-systemd-run"), ...line.args.slice(DEFAULT_LAUNCHER.length - 1)],
    {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", OMP_HARNESS_LAUNCHER_DRY_RUN: "1", OMP_HARNESS_LAUNCHER_CONF: conf },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const envFile = result.stdout
    .split("\n")
    .filter((entry) => entry.startsWith("envfile:"))
    .map((entry) => entry.slice("envfile:".length));
  assert.ok(!envFile.some((entry) => entry.startsWith("ANTHROPIC_API_KEY=")), "local-only : aucune clé distante");
  const tokens = envFile.filter((entry) => entry.startsWith("MEM0_HTTP_TOKEN="));
  assert.equal(
    tokens.at(-1),
    `MEM0_HTTP_TOKEN='${CORPO_TOKEN}'`,
    "le jeton du dépôt l'emporte sur celui de runner.env",
  );
  assert.ok(!result.stdout.slice(result.stdout.indexOf("systemd-run")).includes(CORPO_TOKEN), "jamais sur la ligne");
});

test("harness-politique/AC-7 : les jobs du poste suivent `workstation.policy` — local-only, ou liste blanche sans bascule — comme un dépôt", async () => {
  const local = world(
    (c) => {
      declareLocal(c, "gemma-3");
      c.workstation.policy = { privacy: "local-only" };
    },
    [],
    workstationTarget,
  );
  await local.session.open("heavy", "u1", signal());
  assert.equal(modelArg(local.runner.spawned[0]), "omlx/gemma-3");
  assert.equal(local.runner.spawned[0]?.env.OMP_HARNESS_LOCAL_ONLY, "1");
  await local.session.stop();

  const listed = world(
    (c) => {
      c.workstation.policy = { providers: ["openrouter"] };
    },
    [],
    workstationTarget,
  );
  await listed.session.open("heavy", "u1", signal());
  assert.equal(modelArg(listed.runner.spawned[0]), "openrouter/big");
  await listed.session.stop();
  const none = world((c) => (c.workstation.policy = { providers: [] }), [], workstationTarget);
  await assert.rejects(none.session.open("standard", "u1", signal()), PolicyRefusal);
});

test("harness-politique/AC-8 : --check donne ✗ par dépôt — local-only sans modèle local joignable, jeton absent de l'environnement, configDir gh absent, liste blanche vide — et ✓ quand tout y est", async () => {
  const configDir = tmpdir("harness-politique-check-gh-");
  const config = testConfig(harnessRepo("harness-politique-check-"), (c) => {
    c.ompBin = "/bin/echo";
    declareLocal(c);
    Object.assign(c.repos[0] as RepoConfig, {
      privacy: "local-only",
      memory: { tokenEnv: "CORPO_MEM0_TOKEN" },
      gh: { configDir: path.join(configDir, "absent"), tokenEnv: "CORPO_GH_TOKEN" },
    });
    c.repos.push(repoDefaults({ name: "vide", path: c.repos[0]?.path ?? "", scope: "vide", providers: [] }));
  });
  const deps = (served: string[] | null, env: Record<string, string>) => ({
    exec: execProcess,
    git: new Git(execProcess, config.git),
    oracleHealth: async () => true,
    env: { HOME: "/var/lib/omp-harness", ...env },
    servedModels: async () => served,
  });
  const failing = await runChecks(config, deps(null, {}));
  const failed = (lines: typeof failing) =>
    lines.filter((line) => line.status === "fail" && line.label.startsWith("dépôt")).map((line) => line.label);
  assert.deepEqual(failed(failing), [
    "dépôt demo — jeton mémoire",
    "dépôt demo — compte gh",
    "dépôt demo — compte gh",
    "dépôt demo — modèle local",
    "dépôt vide — modèles",
  ]);
  assert.match(renderChecks(failing), /ne répond pas/);
  assert.match(renderChecks(failing), /`providers` est vide/);

  (config.repos[0] as RepoConfig).gh = { configDir, tokenEnv: "CORPO_GH_TOKEN" };
  config.repos.pop();
  const env = { CORPO_MEM0_TOKEN: CORPO_TOKEN, CORPO_GH_TOKEN: "ghp_corpo" };
  const wrongModel = await runChecks(config, deps(["autre-modele"], env));
  assert.deepEqual(
    failed(wrongModel).filter((label) => !label.endsWith("— gh")),
    ["dépôt demo — modèle local"],
  );
  const passing = await runChecks(config, deps(["qwen3-coder"], env));
  const report = renderChecks(passing);
  assert.match(report, /✓ dépôt demo — jeton mémoire : CORPO_MEM0_TOKEN/);
  assert.match(report, /✓ dépôt demo — modèles : omlx\/qwen3-coder/);
  assert.match(report, /✓ dépôt demo — modèle local : http:\/\/127\.0\.0\.1:8000\/v1 sert qwen3-coder/);
});

test("harness-politique/AC-9 : la configuration refuse une politique incohérente — fournisseur distant sous local-only, modèle hors liste blanche, identité ou variable illisible — et n'ajoute rien aux dépôts qui n'en ont pas", () => {
  const base = () => testConfig(harnessRepo("harness-politique-cfg-"));
  const cases: [string, Partial<RepoConfig>, RegExp][] = [
    ["local-only et anthropic", { privacy: "local-only", providers: ["anthropic"] }, /local-only.*anthropic/],
    [
      "local-only et modèle distant",
      { privacy: "local-only", models: { heavy: ["anthropic/opus"] } },
      /local-only.*anthropic/,
    ],
    [
      "modèle hors liste",
      { providers: ["anthropic"], models: { heavy: ["openrouter/big"] } },
      /hors de la liste blanche/,
    ],
    ["référence illisible", { models: { heavy: ["opus"] } }, /fournisseur\/modèle/],
    ["tier inconnu", { models: { huge: ["a/b"] } as never }, /tier inconnu/],
    ["identité sans email", { git: { name: "Alice", email: "" } }, /git/],
    ["variable illisible", { memory: { tokenEnv: "jeton mémoire" } }, /tokenEnv/],
    ["configDir relatif", { gh: { configDir: "gh" } }, /configDir/],
  ];
  for (const [name, policy, message] of cases) {
    const config = base();
    Object.assign(config.repos[0] as RepoConfig, policy);
    assert.throws(() => validateConfig(config), message, name);
  }
  const ws = base();
  ws.workstation.policy = { privacy: "local-only", providers: ["openai"] };
  assert.throws(() => validateConfig(ws), /workstation\.policy/);
  const plain = repoDefaults({ name: "x", path: "/x" });
  for (const key of ["models", "providers", "privacy", "git", "gh", "memory"]) assert.equal(key in plain, false, key);
  assert.equal(localProvider(base()), null, "aucun fournisseur local sans `--local-model`");
});

test("harness-politique/AC-10 : une étape refusée par la politique du dépôt n'est pas relancée — le run échoue avec la raison", async () => {
  const w = fakeWorld(
    {},
    {
      patch: (c) => {
        c.models.heavy = [{ provider: "anthropic", model: "opus" }];
        Object.assign(c.repos[0] as RepoConfig, { providers: ["mistral"] });
      },
    },
  );
  await w.orchestrator.start();
  try {
    const run = w.orchestrator.createRun({ repo: "demo", title: "Politique", request: "Rien" });
    await waitFor(
      () => w.store.getRun(run.id)?.state === "failed",
      () => JSON.stringify(w.store.getRun(run.id)),
    );
    const failed = w.store.getRun(run.id);
    assert.match(failed?.reason ?? "", /mistral/);
    assert.equal(w.spawned.length, 0, "aucun runner n'est parti");
    assert.equal(w.store.listSteps(run.id).length, 1, "une seule tentative : le refus ne se relance pas");
  } finally {
    await w.orchestrator.stop();
  }
});

test("harness-politique/AC-11 : la pile Portainer pose les jetons par dépôt — mem0-rs reçoit les jetons à portées en fichier, le service MEM0_TOKEN_<NOM> et GH_TOKEN_<NOM>", () => {
  const dir = tmpdir("harness-politique-stack-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "ssh-keygen"),
    '#!/bin/sh\nwhile [ $# -gt 1 ]; do [ "$1" = -f ] && file="$2"; shift; done\necho K > "$file"; echo "ssh-ed25519 AAAA k" > "$file.pub"\n',
    { mode: 0o755 },
  );
  const secrets = path.join(dir, "secrets");
  const setup = (extra: Record<string, string>) =>
    spawnSync("sh", [path.join(DEPLOY, "container", "stack-setup"), "init"], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        OMP_HARNESS_ROOT: path.join(dir, "root"),
        OMP_HARNESS_SECRETS: secrets,
        OMP_HARNESS_TEMPLATE: path.join(DEPLOY, "container", "config.container.json"),
        ...extra,
      },
    });
  const first = setup({
    OMP_HARNESS_MEMORY_TOKENS: `client-corpo:${CORPO_TOKEN}:client-corpo,client-corpo-web;perso:perso-memoire-0123456789:perso`,
    OMP_HARNESS_GITHUB_ACCOUNTS: "client-corpo:ghp_corpo123",
  });
  assert.equal(first.status, 0, first.stderr);
  const harnessEnv = fs.readFileSync(path.join(secrets, "harness", "harness.env"), "utf8");
  assert.match(harnessEnv, new RegExp(`^MEM0_TOKEN_CLIENT_CORPO=${CORPO_TOKEN}$`, "m"));
  assert.match(harnessEnv, /^MEM0_TOKEN_PERSO=perso-memoire-0123456789$/m);
  assert.match(harnessEnv, /^GH_TOKEN_CLIENT_CORPO=ghp_corpo123$/m);
  assert.match(
    fs.readFileSync(path.join(secrets, "mem0", "mem0.env"), "utf8"),
    /^MEM0_HTTP_TOKENS_FILE=\/run\/secrets\/mem0\/tokens$/m,
  );
  assert.equal(
    fs.readFileSync(path.join(secrets, "mem0", "tokens"), "utf8"),
    `client-corpo:${CORPO_TOKEN}:client-corpo,client-corpo-web\nperso:perso-memoire-0123456789:perso\n`,
  );
  // Sans la variable au redéploiement, plus aucun jeton à portées.
  assert.equal(setup({}).status, 0);
  assert.equal(fs.existsSync(path.join(secrets, "mem0", "tokens")), false);
  assert.doesNotMatch(fs.readFileSync(path.join(secrets, "harness", "harness.env"), "utf8"), /MEM0_TOKEN_/);
  assert.notEqual(setup({ OMP_HARNESS_MEMORY_TOKENS: "a:b c:d" }).status, 0, "un blanc est refusé");
});

/** Le modèle d'exploration (`task.agentModelOverrides.scout`) que l'overlay d'un runner lancé pose. */
function scoutOf(spawned: Spawned | undefined): string | undefined {
  const file = spawned?.args[spawned.args.indexOf("--config") + 1] ?? "";
  const settings = JSON.parse(fs.readFileSync(file, "utf8")) as { task?: { agentModelOverrides?: { scout?: string } } };
  return settings.task?.agentModelOverrides?.scout;
}

test("harness-politique/AC-12 : l'agent d'exploration d'omp (scout) tourne sur la tête du tier fast sous la politique du dépôt — jamais hors de sa liste blanche ni de local-only ; sans tier fast rien ne change ; un espace durci arrête le runner qui porte l'ancien override", async () => {
  const fast = [{ provider: "anthropic", model: "haiku" }];
  const plain = world((c) => {
    c.models.fast = fast;
  });
  await plain.session.open("heavy", "u1", signal());
  assert.equal(modelArg(plain.runner.spawned[0]), "anthropic/opus", "la session garde le modèle de son étape");
  assert.equal(scoutOf(plain.runner.spawned[0]), "anthropic/haiku");
  await plain.session.stop();

  const none = world(() => {});
  await none.session.open("heavy", "u1", signal());
  assert.equal(scoutOf(none.runner.spawned[0]), undefined, "aucun tier fast : l'agent suit le modèle de l'étape");
  await none.session.stop();

  const listed = world((c) => {
    c.models.fast = fast;
    Object.assign(c.repos[0] as RepoConfig, { providers: ["openrouter"] });
  });
  await listed.session.open("heavy", "u1", signal());
  assert.equal(scoutOf(listed.runner.spawned[0]), "openrouter/big", "anthropic est hors liste blanche");
  await listed.session.stop();

  const sealed = world((c) => {
    declareLocal(c);
    c.models.fast = fast;
    Object.assign(c.repos[0] as RepoConfig, { privacy: "local-only" });
  });
  await sealed.session.open("heavy", "u1", signal());
  assert.equal(scoutOf(sealed.runner.spawned[0]), "omlx/qwen3-coder", "local-only : le seul modèle local");
  await sealed.session.stop();

  const drift = world((c) => {
    c.models.fast = fast;
  });
  assert.equal(await drift.session.open("heavy", "u1", signal()), false);
  assert.equal(
    await drift.session.open("heavy", "u1", signal()),
    true,
    "politique inchangée : le runner est réutilisé",
  );
  Object.assign(drift.config.repos[0] as RepoConfig, { providers: ["openrouter"] });
  assert.equal(await drift.session.open("heavy", "u1", signal()), false, "l'override n'est plus permis : runner neuf");
  assert.equal(drift.runner.spawned.length, 2);
  assert.equal(scoutOf(drift.runner.spawned[1]), "openrouter/big");
  await drift.session.stop();
});
