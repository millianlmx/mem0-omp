// Tranche « multi-client » M4 : la politique et l'étanchéité d'un espace (un client).
// - la politique de modèles d'un espace se croise, au plus strict et en échec fermé, avec celle de
//   chacun de ses dépôts : runs, audits, rêves et Demande ; un dépôt hors espace ne change pas ;
// - l'étanchéité (`isolation {sealed, gaps}`) est calculée à chaque lecture, un code et une phrase
//   par lacune ; un client borné n'en lit que ce qui touche ses dépôts ;
// - les portées mémoire en double ou réservées sont des avertissements, jamais un refus de démarrer ;
// - `POST /v1/spaces/onboard` accueille un client en un geste et dit ce qu'il reste à faire.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { CORPO_SCOPE } from "../../omp-harness/atlassian/desk.ts";
import { spaceTokenFile } from "../../omp-harness/atlassian/oauth.ts";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { RESERVED_SCOPES, configWarnings, repoDefaults, validateConfig } from "../../omp-harness/config.ts";
import type { HarnessConfig, ModelPolicy, RepoConfig } from "../../omp-harness/config.ts";
import { HarnessContext } from "../../omp-harness/context.ts";
import type { SpawnRunner } from "../../omp-harness/context.ts";
import { Store } from "../../omp-harness/db.ts";
import type { IntakeRow, Space } from "../../omp-harness/db.ts";
import { HarnessError } from "../../omp-harness/errors.ts";
import { Git } from "../../omp-harness/git.ts";
import { HeavyRunner } from "../../omp-harness/heavy.ts";
import { API_FEATURES, apiRoutes, createHandler } from "../../omp-harness/http.ts";
import { intakePolicy } from "../../omp-harness/intake.ts";
import { ISOLATION_CODES, isolationOf, nextSteps } from "../../omp-harness/isolation.ts";
import type { Isolation, IsolationFacts, OnboardStep } from "../../omp-harness/isolation.ts";
import { addLocalModel } from "../../omp-harness/local-model.ts";
import { MCP_TOOLS } from "../../omp-harness/mcp.ts";
import type { DreamDossier } from "../../omp-harness/oracle.ts";
import { PolicyRefusal, repoIdentity, spaceRule, strictest } from "../../omp-harness/policy.ts";
import { execProcess } from "../../omp-harness/proc.ts";
import type { RunnerProcess } from "../../omp-harness/rpc.ts";
import { RunnerSession } from "../../omp-harness/runner-session.ts";
import { runChecks } from "../../omp-harness/check.ts";
import type { CheckLine } from "../../omp-harness/check.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import type { SpaceInput, SpaceView } from "../../omp-harness/spaces.ts";
import { WORKSTATION_SCOPE } from "../../omp-harness/workstation-agent.ts";
import { MemoryOracle, fakeWorld, harnessRepo, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);
const HUMAN = { by: "mac" };
const PILOT = { by: "vigie", pilot: true };
const LOCAL_MODEL = "omlx/qwen3-coder";
const REMOTE_KEY = "ANTHROPIC_API_KEY";

/** Un espace à créer, avec les défauts de ce qui n'est pas dit. */
function input(name: string, repos: string[], extra: Partial<SpaceInput> = {}): SpaceInput {
  return { name, repos, jiraProjects: [], dailyBudgetUsd: null, autonomy: null, ...extra };
}

/** Un `models.yml` des runners qui déclare le fournisseur local `omlx` (comme `--local-model`). */
function declareLocal(config: HarnessConfig): void {
  config.providersModelsFile = path.join(tmpdir("mc-etancheite-models-"), "providers.models.yml");
  addLocalModel(config, LOCAL_MODEL, { baseUrl: "http://127.0.0.1:8000/v1" });
}

/** Une variable du service posée le temps de `body`. */
async function withEnv<T>(name: string, value: string, body: () => Promise<T>): Promise<T> {
  const before = process.env[name];
  process.env[name] = value;
  try {
    return await body();
  } finally {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  }
}

// -- des sessions de runner sur un faux runner : le modèle et l'environnement de chaque lancement --------

type Spawned = { args: string[]; env: Record<string, string | undefined> };

/**
 * Un contexte complet sur un faux runner muet (il se dit prêt, rien de plus) : les dépôts `demo` et
 * `other`, les chaînes du serveur chez `anthropic` puis `openrouter`, et une session par dépôt demandé.
 */
function sessionWorld(patch: (config: HarnessConfig) => void = () => {}) {
  const config = testConfig(harnessRepo(), (c) => {
    c.models = {
      fast: [],
      standard: [{ provider: "anthropic", model: "sonnet" }],
      heavy: [
        { provider: "anthropic", model: "opus" },
        { provider: "openrouter", model: "big" },
      ],
    };
    c.repos.push(repoDefaults({ name: "other", path: harnessRepo(), scope: "other-scope" }));
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
  const spawned: Spawned[] = [];
  const spawn: SpawnRunner = (_command, args, options) => {
    spawned.push({ args, env: options.env });
    const stdout = new PassThrough();
    const events = new EventEmitter();
    // L'arrêt d'une session ferme l'entrée du runner : il sort aussitôt, comme un vrai.
    const stdin = new PassThrough();
    stdin.on("data", () => {});
    stdin.on("end", () => events.emit("exit", 0, null));
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
    queueMicrotask(() => stdout.write(`${JSON.stringify({ type: "ready", protocolVersion: 1 })}\n`));
    return proc;
  };
  const ctx = new HarnessContext({
    config,
    store,
    scheduler,
    git,
    heavy: new HeavyRunner({ config, store, scheduler, git, exec: execProcess }),
    oracle: new MemoryOracle(),
    spawn,
    exec: execProcess,
  });
  /** Ouvre une session neuve sur ce dépôt au tier `heavy` et rend son lancement ; rejette si la politique refuse. */
  const launch = async (repoName: string): Promise<Spawned> => {
    const repo = config.repos.find((candidate) => candidate.name === repoName) as RepoConfig;
    const session = new RunnerSession(
      ctx,
      { repo, cwd: repo.path },
      { onHostTool: async () => ({ text: "" }), event: () => {} },
    );
    const before = spawned.length;
    await session.open("heavy", `u-${before}`, new AbortController().signal);
    await session.stop();
    return spawned[before] as Spawned;
  };
  const space = (name: string, repos: string[], policy: ModelPolicy | null): Space =>
    store.insertSpace({ id: `e-${name}`, ...input(name, repos), policy, by: "mac" });
  return { config, store, spawned, launch, space };
}

const modelOf = (spawned: Spawned): string | undefined => spawned.args[spawned.args.indexOf("--model") + 1];

// -- un serveur HTTP réel sur un monde factice : les dépôts `demo`, `other` et `third` ----------------------

type Body = {
  error: string;
  space: SpaceView;
  spaces: SpaceView[];
  isolation: Isolation;
  next: OnboardStep[];
  warnings: string[];
  intake: { id: string; state: string; reason: string | null };
  result: { isError?: boolean; structuredContent: Body };
};
type Reply = { status: number; json: Body; etag: string | null };
type Call = (
  method: string,
  route: string,
  body?: unknown,
  token?: string,
  headers?: Record<string, string>,
) => Promise<Reply>;
/** Le monde servi : son orchestrateur, un jeton par portée, l'appel HTTP et le journal du service. */
type Served = { world: FakeWorld; tokens: Record<string, string>; call: Call; done: () => Promise<void> };

async function setup(scenario: Record<string, unknown> = {}, patch: (config: HarnessConfig) => void = () => {}) {
  const lines: { message: string; level: string | undefined }[] = [];
  const world = fakeWorld(scenario, {
    patch: (config) => {
      config.repos.push(repoDefaults({ name: "other", path: harnessRepo(), scope: "other-scope" }));
      config.repos.push(repoDefaults({ name: "third", path: harnessRepo(), scope: "third-scope" }));
      patch(config);
    },
    harnessLog: (message, meta) => lines.push({ message, level: meta?.level }),
  });
  const clients = new ClientRegistry(path.join(tmpdir("mc-etancheite-clients-"), "clients.json"), ADMIN);
  const tokens = {
    owner: clients.add("mac", "admin", "*").token,
    ops: clients.add("ops", "operator", "*").token,
    demoAdmin: clients.add("demo-admin", "admin", ["demo"]).token,
    demo: clients.add("mac-demo", "operator", ["demo"]).token,
    other: clients.add("mac-other", "operator", ["other"]).token,
    third: clients.add("mac-third", "operator", ["third"]).token,
  };
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  const listening = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (
    method: string,
    route: string,
    body?: unknown,
    token = tokens.owner,
    headers: Record<string, string> = {},
  ): Promise<Reply> => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      json: (text ? JSON.parse(text) : {}) as Body,
      etag: response.headers.get("etag"),
    };
  };
  const done = async (): Promise<void> => {
    server.closeAllConnections();
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    await world.orchestrator.stop();
  };
  return { world, tokens, call, done, lines };
}

const repoOf = (world: FakeWorld, name: string): RepoConfig =>
  world.config.repos.find((repo) => repo.name === name) as RepoConfig;

/** Les lacunes d'une étanchéité, en couples `[code, dépôt]`. */
const codes = (isolation: Isolation): [string, string | null][] => isolation.gaps.map((gap) => [gap.code, gap.repo]);

// -- l'étanchéité, pure : un espace, des dépôts tout réglés, et rien autour -----------------------------------

/** Ce qu'un dépôt déclare quand il ne doit plus rien au service : jeton mémoire, identité git, compte de forge, clé SSH. */
const OWN = {
  remote: "origin",
  sshKey: "/var/lib/omp-harness/.ssh/repos/acme",
  memory: { tokenEnv: "ACME_MEM0_TOKEN" },
  git: { name: "Agent Acme", email: "agent@acme.example" },
  gh: { tokenEnv: "ACME_GH_TOKEN" },
};

function repo(name: string, scope: string, over: Record<string, unknown> = {}): RepoConfig {
  return repoDefaults({ name, path: `/srv/${name}`, scope, ...OWN, ...over });
}

function spaceOf(over: Partial<Space> = {}): Space {
  return {
    id: "e1",
    name: "Acme",
    repos: ["demo"],
    poste: false,
    identities: [],
    jiraProjects: [],
    dailyBudgetUsd: null,
    autonomy: null,
    policy: null,
    by: "mac",
    createdAt: 0,
    updatedAt: 0,
    rev: 0,
    ...over,
  };
}

function facts(repos: RepoConfig[], over: Partial<IsolationFacts> = {}): IsolationFacts {
  return {
    repos,
    atlassian: { connected: false },
    browsers: 0,
    workstation: true,
    vigie: { mode: "shadow", repos: [] },
    ...over,
  };
}

/** L'unique lacune attendue : son code, son dépôt, et une phrase qui dit quoi faire. */
function only(isolation: Isolation, code: string, repoName: string | null, says: RegExp): void {
  assert.deepEqual(codes(isolation), [[code, repoName]]);
  assert.equal(isolation.sealed, false);
  const [gap] = isolation.gaps;
  assert.match(gap?.text ?? "", says);
  assert.match(gap?.text ?? "", /^[A-ZÀ-Ý].*\.$/s, "une phrase, de la majuscule au point");
}

function dossier(count: number): DreamDossier {
  const at = new Date().toISOString();
  return {
    horizon_us: 1_700_000_000_000_000,
    since: null,
    due: true,
    new_facts: Array.from({ length: count }, (_, i) => ({ id: `f${i}`, memory: `Fait numéro ${i}`, updated_at: at })),
    context: [],
    observations: [],
    models: [],
  };
}

test("mc-etancheite/AC-1 : `strictest` croise la politique d'un dépôt et celle de son espace au plus strict — local-only l'emporte, les fournisseurs se croisent, les chaînes s'enchaînent — et ne touche à rien sans politique d'espace", () => {
  const own: ModelPolicy = { providers: ["anthropic", "openrouter"], models: { heavy: ["anthropic/opus"] } };
  assert.equal(strictest(own, null), own, "sans politique d'espace : la politique du dépôt, telle quelle");
  assert.deepEqual(strictest({}, {}), {});

  // `local-only` l'emporte, d'où qu'il vienne, même face à un dépôt qui se dit `standard`.
  assert.equal(strictest({ privacy: "standard" }, { privacy: "local-only" }).privacy, "local-only");
  assert.equal(strictest({ privacy: "local-only" }, { privacy: "standard" }).privacy, "local-only");
  assert.equal(strictest({ privacy: "local-only" }, {}).privacy, "local-only");
  assert.equal(strictest({ privacy: "standard" }, {}).privacy, "standard");

  // Les listes blanches se croisent ; une seule déclarée vaut pour les deux ; rien en commun : une liste VIDE.
  assert.deepEqual(strictest(own, { providers: ["openrouter", "mistral"] }).providers, ["openrouter"]);
  assert.deepEqual(strictest({}, { providers: ["mistral"] }).providers, ["mistral"]);
  assert.deepEqual(strictest(own, {}).providers, ["anthropic", "openrouter"]);
  assert.deepEqual(strictest({ providers: ["anthropic"] }, { providers: ["mistral"] }).providers, []);
  assert.equal("providers" in strictest({}, {}), false, "aucune liste blanche n'apparaît seule");

  // Les chaînes propres : celle du dépôt d'abord, celle de l'espace ensuite, tier par tier, sans doublon.
  assert.deepEqual(
    strictest(own, { models: { heavy: ["omlx/qwen", "anthropic/opus"], fast: ["omlx/petit"] } }).models,
    { fast: ["omlx/petit"], heavy: ["anthropic/opus", "omlx/qwen"] },
  );

  // L'espace d'un dépôt : celui qui le tient, s'il porte une politique.
  const spaces = [
    { name: "Acme", repos: ["demo"], policy: { privacy: "local-only" } as ModelPolicy },
    { name: "Perso", repos: ["other"], policy: null },
  ];
  assert.deepEqual(spaceRule(spaces, "demo"), { space: "Acme", policy: { privacy: "local-only" } });
  assert.equal(spaceRule(spaces, "other"), null, "un espace sans politique ne change rien");
  assert.equal(spaceRule(spaces, "third"), null, "un dépôt hors de tout espace non plus");
  assert.equal(spaceRule([], "demo"), null);
});

test("mc-etancheite/AC-2 : un espace `local-only` rend ses dépôts local-only quoi que dise le dépôt — modèle local, aucune clé distante — sans changer le dépôt d'à côté, hors espace", async () => {
  await withEnv(REMOTE_KEY, "sk-ant-0123456789", async () => {
    const w = sessionWorld((c) => {
      declareLocal(c);
      // Le dépôt se dit `standard` et veut un modèle distant : son espace l'emporte.
      Object.assign(c.repos[0] as RepoConfig, { privacy: "standard", models: { heavy: ["anthropic/opus"] } });
    });
    const before = await w.launch("demo");
    assert.equal(modelOf(before), "anthropic/opus", "sans espace : la politique du dépôt, comme avant");
    assert.equal(before.env[REMOTE_KEY], "sk-ant-0123456789");
    assert.equal(before.env.OMP_HARNESS_LOCAL_ONLY, undefined);

    w.space("Acme", ["demo"], { privacy: "local-only" });
    const inside = await w.launch("demo");
    assert.equal(modelOf(inside), LOCAL_MODEL);
    assert.equal(inside.env[REMOTE_KEY], undefined, "aucune clé de fournisseur distant chez le runner de l'espace");
    assert.equal(inside.env.OMP_HARNESS_LOCAL_ONLY, "1");

    const outside = await w.launch("other");
    assert.equal(modelOf(outside), "anthropic/opus", "un dépôt hors espace reste chez le fournisseur du serveur");
    assert.equal(outside.env[REMOTE_KEY], "sk-ant-0123456789");
    assert.equal(outside.env.OMP_HARNESS_LOCAL_ONLY, undefined);
  });

  // Sans modèle local déclaré : refus, jamais un fournisseur distant.
  const bare = sessionWorld((c) => {
    c.providersModelsFile = path.join(tmpdir("mc-etancheite-none-"), "absent.yml");
  });
  bare.space("Acme", ["demo"], { privacy: "local-only" });
  await assert.rejects(bare.launch("demo"), (err: unknown) => {
    assert.ok(err instanceof PolicyRefusal);
    assert.match(err.message, /le dépôt demo \(espace « Acme »\) est « local-only »/);
    return true;
  });
  assert.equal(bare.spawned.length, 0, "aucun runner sans modèle local");
});

test("mc-etancheite/AC-3 : les fournisseurs permis sont l'intersection du dépôt et de son espace ; une intersection vide refuse sans lancer de runner ; la politique se relit à chaque lancement", async () => {
  const w = sessionWorld((c) => {
    Object.assign(c.repos[0] as RepoConfig, { providers: ["anthropic", "openrouter"] });
  });
  assert.equal(modelOf(await w.launch("demo")), "anthropic/opus");

  // L'espace ne permet qu'openrouter : le dépôt, qui le permet aussi, y bascule ; `other` suit l'espace seul.
  const acme = w.space("Acme", ["demo", "other"], { providers: ["openrouter"] });
  assert.equal(modelOf(await w.launch("demo")), "openrouter/big");
  assert.equal(modelOf(await w.launch("other")), "openrouter/big");

  // Une chaîne propre à l'espace sert le dépôt qui n'en déclare pas, dans la liste blanche croisée.
  w.store.updateSpace(acme.id, { policy: { providers: ["openrouter"], models: { heavy: ["openrouter/huge"] } } });
  assert.equal(modelOf(await w.launch("demo")), "openrouter/huge");

  // Plus rien en commun : la liste est vide, l'étape est refusée, aucun runner ne part.
  w.store.updateSpace(acme.id, { policy: { providers: ["mistral"] } });
  const launched = w.spawned.length;
  await assert.rejects(w.launch("demo"), (err: unknown) => {
    assert.ok(err instanceof PolicyRefusal);
    assert.equal(err.status, 409);
    assert.match(err.message, /le dépôt demo \(espace « Acme »\)/);
    assert.match(err.message, /liste vide/);
    return true;
  });
  await assert.rejects(w.launch("other"), PolicyRefusal, "mistral n'a aucun modèle déclaré : refus aussi");
  assert.equal(w.spawned.length, launched, "aucun runner sans fournisseur permis");

  // La politique levée : le dépôt retrouve la sienne au lancement suivant.
  w.store.updateSpace(acme.id, { policy: null });
  assert.equal(modelOf(await w.launch("demo")), "anthropic/opus");
});

test("mc-etancheite/AC-4 : la politique de l'espace s'applique aux runs, aux audits et aux rêves de ses dépôts — refusés sans runner, sans relance — et pas au dépôt hors espace", async () => {
  const world = fakeWorld(
    {},
    {
      patch: (c) => {
        c.models.heavy = [{ provider: "anthropic", model: "opus" }];
        c.oracle = { url: "http://127.0.0.1:9", token: null };
        c.dreams.checkMinutes = null;
        c.repos.push(repoDefaults({ name: "other", path: harnessRepo(), scope: "other-scope" }));
      },
    },
  );
  world.oracle.dossier = dossier(6);
  world.orchestrator.spaces.create(input("Acme", ["demo"], { policy: { providers: ["mistral"] } }), HUMAN);
  await world.orchestrator.start();
  try {
    const refused = /le dépôt demo \(espace « Acme »\).*mistral/s;
    const run = world.orchestrator.createRun({ repo: "demo", title: "Politique", request: "Rien" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "failed",
      () => JSON.stringify(world.store.getRun(run.id)),
    );
    assert.match(world.store.getRun(run.id)?.reason ?? "", refused);
    assert.equal(world.store.listSteps(run.id).length, 1, "une seule tentative : le refus ne se relance pas");

    const audit = world.orchestrator.audits.create("demo", "");
    await waitFor(
      () => world.store.getAudit(audit.id)?.state === "failed",
      () => JSON.stringify(world.store.getAudit(audit.id)),
    );
    assert.match(world.store.getAudit(audit.id)?.reason ?? "", refused);

    world.orchestrator.dreams.request("demo");
    const dream = () => world.orchestrator.dreams.list().find((row) => row.repo === "demo");
    await waitFor(
      () => dream()?.state === "failed",
      () => JSON.stringify(world.orchestrator.dreams.list()),
    );
    assert.match(dream()?.reason ?? "", refused);
    assert.equal(world.spawned.length, 0, "aucun runner n'est parti pour l'espace");

    // Le dépôt d'à côté, hors espace : son run part comme avant.
    world.orchestrator.createRun({ repo: "other", title: "Hors espace", request: "Rien" });
    await waitFor(
      () => world.spawned.length > 0,
      () => JSON.stringify(world.store.listRuns().map((row) => [row.repo, row.state, row.reason])),
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("mc-etancheite/AC-5 : la Demande suit la politique de l'espace — celle du dépôt imposé, de son propre espace, ou d'un dépôt visible — sur le modèle local sans clé distante, et échoue lisiblement sur une liste vide", async () => {
  const classify = [{ tool: "intake_classify", args: { kind: "question", answer: "Deux dépôts sont déclarés." } }];
  /** Pose une demande, attend la fin de son classement (écrit en base par le job) et la relit par l'API. */
  const settled = async (w: Served, body: Record<string, unknown>, token?: string) => {
    const posted = await w.call("POST", "/v1/intake", { text: "où en est-on ?", source: "cli", ...body }, token);
    assert.equal(posted.status, 201, JSON.stringify(posted.json));
    const { id } = posted.json.intake;
    await waitFor(
      () => w.world.store.getIntake(id)?.state !== "classifying",
      () => `la demande ${id} reste en classement`,
    );
    return (await w.call("GET", `/v1/intake/${id}`, undefined, token)).json.intake;
  };
  const launches = (world: FakeWorld) =>
    world
      .log()
      .filter((line) => line.kind === "argv")
      .map((line) => ({ argv: line.argv as string[], keys: line.keys as Record<string, string> }));

  await withEnv(REMOTE_KEY, "test-clef-distante", async () => {
    const local = await setup({ demande: [classify] }, declareLocal);
    try {
      const acme = local.world.orchestrator.spaces.create(
        input("Acme", ["demo"], { policy: { privacy: "local-only" } }),
        HUMAN,
      );
      // Le dépôt imposé est dans l'espace ; puis l'auteur voit ce dépôt ; puis un client qui ne voit que `other`.
      await settled(local, { repo: "demo" });
      await settled(local, {});
      await settled(local, {}, local.tokens.other);
      const [imposed, visible, elsewhere] = launches(local.world);
      for (const launch of [imposed, visible]) {
        assert.ok(launch?.argv.includes(LOCAL_MODEL), JSON.stringify(launch?.argv));
        assert.deepEqual(launch?.keys, {}, "aucune clé distante chez le classeur de l'espace");
      }
      assert.ok(!elsewhere?.argv.includes(LOCAL_MODEL), "hors de l'espace : les modèles du serveur");
      assert.deepEqual(elsewhere?.keys, { [REMOTE_KEY]: "test-clef-distante" });

      // La Demande d'un espace (`spaceId`) suit sa politique même sans dépôt visible qui la porte.
      const spaces = local.world.store.listSpaces();
      const row = local.world.store.listIntakes({})[0] as IntakeRow;
      const free: IntakeRow = { ...row, requestedRepo: null, repo: "", scope: ["other"], spaceId: null };
      assert.deepEqual(intakePolicy(local.world.config, free, spaces), {});
      assert.deepEqual(intakePolicy(local.world.config, { ...free, spaceId: acme.id }, spaces), {
        privacy: "local-only",
      });
      // Sans espace, rien ne change : la politique du dépôt imposé, ou rien.
      assert.deepEqual(intakePolicy(local.world.config, row, []), intakePolicy(local.world.config, row));
      assert.deepEqual(intakePolicy(local.world.config, { ...row, requestedRepo: "demo" }, []), {});
    } finally {
      await local.done();
    }
  });

  const closed = await setup({ demande: [classify] });
  try {
    closed.world.orchestrator.spaces.create(input("Acme", ["demo"], { policy: { providers: [] } }), HUMAN);
    const failed = await settled(closed, { repo: "demo" });
    assert.equal(failed.state, "failed");
    assert.match(failed.reason ?? "", /^le classement a échoué : /);
    assert.match(failed.reason ?? "", /liste vide/);
    assert.equal(launches(closed.world).length, 0, "aucun runner lancé");
  } finally {
    await closed.done();
  }
});

test("mc-etancheite/AC-6 : la mémoire d'un dépôt — portée partagée hors de l'espace, portée réservée, jeton global — est une lacune, avec son code et sa phrase", () => {
  const acme = spaceOf({ repos: ["demo", "docs"] });
  // Deux dépôts du MÊME espace peuvent partager une portée ; un dépôt d'ailleurs, non.
  const shared = [repo("demo", "acme"), repo("docs", "acme"), repo("other", "acme"), repo("third", "third-scope")];
  const isolation = isolationOf(acme, facts(shared));
  assert.deepEqual(codes(isolation), [
    ["shared_scope", "demo"],
    ["shared_scope", "docs"],
  ]);
  assert.match(isolation.gaps[0]?.text ?? "", /Le dépôt demo partage sa portée mémoire « acme » avec le dépôt other/);
  assert.match(isolation.gaps[0]?.text ?? "", /`repos\[\]\.scope`/);
  only(isolationOf(spaceOf(), facts([repo("demo", "acme"), repo("other", "acme")])), "shared_scope", "demo", /other/);

  // Les portées du service, et celles de ses espaces (`corpo:<id>`, `workstation:<id>`).
  for (const scope of ["corpo", "workstation", "corpo:e9", "workstation:e9"])
    only(
      isolationOf(spaceOf(), facts([repo("demo", scope)])),
      "reserved_scope",
      "demo",
      /réservée.*`repos\[\]\.scope`/s,
    );
  assert.equal(
    isolationOf(spaceOf(), facts([repo("demo", "corporate")])).sealed,
    true,
    "un préfixe seul ne réserve rien",
  );
  assert.deepEqual(
    [...RESERVED_SCOPES],
    [CORPO_SCOPE, WORKSTATION_SCOPE],
    "les portées réservées sont celles du service",
  );

  only(
    isolationOf(spaceOf(), facts([repo("demo", "acme", { memory: undefined })])),
    "global_memory_token",
    "demo",
    /jeton global.*`repos\[\]\.memory\.tokenEnv`/s,
  );
});

test("mc-etancheite/AC-7 : un dépôt sans compte de forge, sans identité git ou sans clé SSH propres parle sous le compte du service : une lacune chacun, qui dit ce qui manque", () => {
  const gapOf = (over: Record<string, unknown>) => isolationOf(spaceOf(), facts([repo("demo", "acme", over)]));
  only(
    gapOf({ gh: undefined, git: undefined }),
    "service_forge_identity",
    "demo",
    /ni compte de forge ni identité git/,
  );
  only(gapOf({ gh: undefined }), "service_forge_identity", "demo", /compte de forge du service.*`tokenEnv`/s);
  only(gapOf({ git: undefined }), "service_forge_identity", "demo", /identité git du service.*`git \{name, email\}`/s);
  only(gapOf({ gh: {} }), "service_forge_identity", "demo", /compte de forge/);
  // Un compte GitLab, une connexion gh (`configDir`) ou aucune forge : rien à dire.
  assert.equal(gapOf({ gh: undefined, gitlab: { tokenEnv: "ACME_GITLAB_TOKEN" } }).sealed, true);
  assert.equal(gapOf({ gh: { configDir: "/var/lib/omp-harness/gh/acme" } }).sealed, true);
  assert.equal(gapOf({ gh: undefined, forge: "none" }).sealed, true);

  only(gapOf({ sshKey: null }), "service_ssh_key", "demo", /clé SSH du service.*`repos\[\]\.sshKey`/s);
  assert.equal(
    gapOf({ sshKey: null, remote: null }).sealed,
    true,
    "sans distant poussé, la clé du service ne sert pas",
  );
});

test("mc-etancheite/AC-8 : un espace qui attend Atlassian ou le poste sans les avoir, ou dont les incidents n'ont de cible que hors de lui, a une lacune d'espace ; tout réglé, il est étanche", () => {
  const demo = repo("demo", "acme");
  const acme = spaceOf();
  assert.deepEqual(isolationOf(acme, facts([demo])), { sealed: true, gaps: [] });

  // Atlassian : des projets Jira déclarés, ou un dépôt branché, sans connexion de l'espace.
  const jira = spaceOf({ jiraProjects: ["PROJ"] });
  only(isolationOf(jira, facts([demo])), "no_atlassian", null, /projets Jira \(PROJ\).*connect\?space=e1/s);
  only(
    isolationOf(acme, facts([repo("demo", "acme", { atlassian: true })])),
    "no_atlassian",
    null,
    /un dépôt branché sur Atlassian \(demo\)/,
  );
  only(isolationOf(jira, facts([demo], { atlassian: null })), "no_atlassian", null, /désactivé.*`atlassian\.enabled`/s);
  assert.equal(isolationOf(jira, facts([demo], { atlassian: { connected: true } })).sealed, true);

  // Le poste : des identités déclarées, aucun navigateur rattaché.
  const poste = spaceOf({ identities: ["agent@acme.example"] });
  only(isolationOf(poste, facts([demo])), "no_browser", null, /aucun navigateur.*workstation\/browsers/s);
  // Un navigateur rattaché : la lacune se ferme ; il reste celle du poste, sans jeton mémoire propre.
  only(isolationOf(poste, facts([demo], { browsers: 1 })), "global_memory_token", null, /jeton mémoire global/);

  // La vigie publie, et aucun de ses dépôts n'est dans l'espace.
  const publishing = (repos: string[], mode: "report" | "fix" | "shadow" | "off" = "report") =>
    isolationOf(acme, facts([demo, repo("public", "public-scope")], { vigie: { mode, repos } }));
  only(publishing(["public"]), "public_repo_target", null, /ne publie que sur public.*`PUT \/v1\/vigie/s);
  only(publishing(["public"], "fix"), "public_repo_target", null, /hors de cet espace/);
  assert.equal(publishing(["public", "demo"]).sealed, true, "un dépôt de l'espace est une cible");
  assert.equal(publishing(["public"], "shadow").sealed, true, "la vigie qui ne publie pas ne fuit pas");
  assert.equal(publishing([]).sealed, true);

  // Tout à la fois : les lacunes des dépôts d'abord, celles de l'espace ensuite ; chaque code connu — sauf le
  // site Atlassian partagé, qui suppose une connexion vivante (mc-etancheite/AC-19), l'inverse de `no_atlassian`.
  const all = isolationOf(
    spaceOf({ jiraProjects: ["PROJ"], identities: ["agent@acme.example"] }),
    facts([repo("demo", "corpo", { memory: undefined, gh: undefined, sshKey: null }), repo("other", "corpo")], {
      vigie: { mode: "fix", repos: ["other"] },
    }),
  );
  assert.deepEqual(
    all.gaps.map((gap) => gap.code),
    ISOLATION_CODES.filter((code) => code !== "shared_atlassian_site"),
  );
});

test("mc-etancheite/AC-9 : `GET /v1/spaces` et `GET /v1/spaces/{id}` rendent l'étanchéité recalculée à chaque lecture — une lacune se ferme dès que sa cause est réglée — et un espace inconnu rend 404", async () => {
  const w = await setup();
  try {
    const created = await w.call("POST", "/v1/spaces", { name: "Acme", repos: ["demo"] });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const { id } = created.json.space;
    const read = async () => {
      const reply = await w.call("GET", `/v1/spaces/${id}`);
      assert.equal(reply.status, 200, JSON.stringify(reply.json));
      return reply;
    };
    const first = await read();
    assert.equal(first.etag, `"${first.json.space.rev}"`);
    assert.deepEqual(codes(first.json.space.isolation), [
      ["global_memory_token", "demo"],
      ["service_forge_identity", "demo"],
    ]);
    const listed = (await w.call("GET", "/v1/spaces")).json.spaces;
    assert.deepEqual(
      listed[0]?.isolation,
      first.json.space.isolation,
      "la liste et l'espace seul disent la même chose",
    );

    // La configuration du dépôt réglée : plus de lacune, sans rien écrire sur l'espace.
    Object.assign(repoOf(w.world, "demo"), { memory: OWN.memory, git: OWN.git, gh: OWN.gh });
    const sealed = await read();
    assert.deepEqual(sealed.json.space.isolation, { sealed: true, gaps: [] });
    assert.equal(
      sealed.json.space.rev,
      first.json.space.rev,
      "l'étanchéité n'est pas stockée : la révision n'a pas bougé",
    );

    // Des projets Jira sans connexion de l'espace, puis sa connexion (son fichier de jetons).
    await w.call("PUT", `/v1/spaces/${id}`, { jiraProjects: ["PROJ"], identities: ["agent@acme.example"] });
    assert.deepEqual(codes((await read()).json.space.isolation), [
      ["no_atlassian", null],
      ["no_browser", null],
    ]);
    const tokens = {
      clientId: "c",
      redirectUri: "http://127.0.0.1/cb",
      accessToken: "jeton",
      expiresAt: Date.now() + 3_600_000,
      cloudId: "cloud-1",
      siteUrl: "https://acme.example",
      connectedAt: Date.now(),
      connectedBy: "mac",
    };
    fs.writeFileSync(spaceTokenFile(w.world.config.atlassian, id), JSON.stringify(tokens), { mode: 0o600 });
    assert.deepEqual(codes((await read()).json.space.isolation), [["no_browser", null]]);

    // Un navigateur rattaché à l'espace : il ne reste que le poste, qui tourne sous le jeton mémoire global.
    w.world.store.touchWorkstationBrowser({ id: "b-acme", label: "Chrome Acme", version: null, at: Date.now() });
    w.world.store.setWorkstationBrowserSpace("b-acme", id);
    assert.deepEqual(codes((await read()).json.space.isolation), [["global_memory_token", null]]);

    // La vigie se met à publier ailleurs : une lacune de plus.
    const vigie = await w.call("PUT", "/v1/vigie", { mode: "report", repos: ["other"] });
    assert.equal(vigie.status, 200, JSON.stringify(vigie.json));
    assert.deepEqual(
      codes((await read()).json.space.isolation)
        .map(([code]) => code)
        .sort(),
      ["global_memory_token", "public_repo_target"],
    );

    assert.equal((await w.call("GET", "/v1/spaces/e-inconnu")).status, 404);
  } finally {
    await w.done();
  }
});

test("mc-etancheite/AC-10 : un client borné ne lit ni la politique de l'espace, ni les lacunes des dépôts qu'il ne voit pas, ni celles de l'espace entier, ni le nom d'un dépôt invisible ; sans dépôt visible, l'espace n'existe pas (404)", async () => {
  const w = await setup({}, (config) => {
    // `demo` partage sa portée avec `third`, hors de l'espace.
    (config.repos.find((candidate) => candidate.name === "third") as RepoConfig).scope = "demo-scope";
    Object.assign(config.repos[0] as RepoConfig, { memory: OWN.memory, git: OWN.git, gh: OWN.gh });
  });
  try {
    const { space } = w.world.orchestrator.spaces.onboard(
      input("Mixte", ["demo", "other"], { jiraProjects: ["PROJ"], policy: { privacy: "local-only" } }),
      HUMAN,
      Date.now(),
    );
    const whole = (await w.call("GET", `/v1/spaces/${space.id}`)).json.space;
    assert.deepEqual(whole.policy, { privacy: "local-only" });
    assert.deepEqual(codes(whole.isolation), [
      ["shared_scope", "demo"],
      ["global_memory_token", "other"],
      ["service_forge_identity", "other"],
      ["no_atlassian", null],
    ]);
    assert.match(whole.isolation.gaps[0]?.text ?? "", /avec le dépôt third/);

    for (const route of [`/v1/spaces/${space.id}`, "/v1/spaces"]) {
      const reply = (await w.call("GET", route, undefined, w.tokens.demo)).json;
      const seen = reply.space ?? (reply.spaces[0] as SpaceView);
      assert.deepEqual(seen.repos, ["demo"]);
      assert.equal(seen.policy, null, "la politique de l'espace est au propriétaire");
      assert.deepEqual(codes(seen.isolation), [["shared_scope", "demo"]]);
      const text = JSON.stringify(seen);
      assert.doesNotMatch(text, /third|other|PROJ|local-only/, "rien de ce qu'il ne voit pas");
      assert.match(seen.isolation.gaps[0]?.text ?? "", /avec au moins un dépôt hors de cet espace/);
    }
    // Le client de `other` n'a que les lacunes de `other` ; `sealed` ne juge que ce qu'il voit.
    const other = (await w.call("GET", `/v1/spaces/${space.id}`, undefined, w.tokens.other)).json.space;
    assert.deepEqual(codes(other.isolation), [
      ["global_memory_token", "other"],
      ["service_forge_identity", "other"],
    ]);
    Object.assign(repoOf(w.world, "other"), { memory: OWN.memory, git: OWN.git, gh: OWN.gh });
    const settled = (await w.call("GET", `/v1/spaces/${space.id}`, undefined, w.tokens.other)).json.space;
    assert.deepEqual(settled.isolation, { sealed: true, gaps: [] });

    // Aucun dépôt de l'espace dans sa portée : il n'existe pas pour lui.
    const hidden = await w.call("GET", `/v1/spaces/${space.id}`, undefined, w.tokens.third);
    assert.equal(hidden.status, 404);
    assert.match(hidden.json.error, /espace inconnu/);
    assert.deepEqual((await w.call("GET", "/v1/spaces", undefined, w.tokens.third)).json.spaces, []);

    // Le propriétaire qui suit CET espace (`?space=`) le lit entier ; sous un autre espace, il n'existe pas.
    const scoped = (await w.call("GET", `/v1/spaces/${space.id}?space=${space.id}`)).json.space;
    assert.deepEqual(scoped.policy, { privacy: "local-only" });
    assert.deepEqual(scoped.repos, ["demo", "other"]);
    assert.ok(scoped.isolation.gaps.some((gap) => gap.code === "no_atlassian"));
    const libre = w.world.orchestrator.spaces.create(input("Libre", ["third"]), HUMAN);
    assert.equal((await w.call("GET", `/v1/spaces/${space.id}?space=${libre.id}`)).status, 404);
  } finally {
    await w.done();
  }
});

test("mc-etancheite/AC-11 : `PUT /v1/spaces/{id} {policy}` valide la politique comme celle d'un dépôt, la garde, et `null` la lève ; réservée à un admin qui voit tout, jamais à un pilote", async () => {
  const w = await setup();
  try {
    const policy = { privacy: "local-only", providers: ["omlx"], models: { heavy: ["omlx/qwen3-coder"] } };
    const created = await w.call("POST", "/v1/spaces", { name: "Acme", repos: ["demo"], policy });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.deepEqual(created.json.space.policy, policy);
    const { id } = created.json.space;

    const refused: [unknown, RegExp][] = [
      [{ privacy: "local-only", providers: ["anthropic"] }, /local-only.*anthropic/],
      [{ privacy: "secret" }, /policy\.privacy/],
      [{ providers: ["anthropic"], models: { heavy: ["mistral/large"] } }, /hors de la liste blanche/],
      [{ models: { heavy: ["sans-fournisseur"] } }, /"fournisseur\/modèle"/],
      [{ models: { enorme: ["anthropic/opus"] } }, /tier inconnu/],
      [{ providers: "anthropic" }, /policy\.providers/],
      [{ privacy: "local-only", gh: { tokenEnv: "X" } }, /champ inconnu \(gh\)/],
      ["local-only", /policy : \{ models\?, providers\?, privacy\? \}/],
    ];
    for (const [candidate, reason] of refused) {
      const reply = await w.call("PUT", `/v1/spaces/${id}`, { policy: candidate });
      assert.equal(reply.status, 400, JSON.stringify(candidate));
      assert.match(reply.json.error, reason);
      assert.doesNotMatch(reply.json.error, /configuration du harness/);
    }
    assert.deepEqual(w.world.store.getSpace(id)?.policy, policy, "un refus ne change rien");

    const edited = await w.call("PUT", `/v1/spaces/${id}`, { policy: { providers: ["anthropic"] } });
    assert.deepEqual(edited.json.space.policy, { providers: ["anthropic"] });
    // Un autre champ modifié laisse la politique ; `null` la lève.
    assert.deepEqual((await w.call("PUT", `/v1/spaces/${id}`, { name: "Acme SA" })).json.space.policy, {
      providers: ["anthropic"],
    });
    assert.equal((await w.call("PUT", `/v1/spaces/${id}`, { policy: null })).json.space.policy, null);

    // Un admin borné à des dépôts, un operator : 403. Un pilote (un agent) ne règle jamais la politique.
    const edit = { policy: { privacy: "local-only" } };
    assert.equal((await w.call("PUT", `/v1/spaces/${id}`, edit, w.tokens.demoAdmin)).status, 403);
    assert.equal((await w.call("PUT", `/v1/spaces/${id}`, edit, w.tokens.ops)).status, 403);
    const { spaces } = w.world.orchestrator;
    const byPilot = (gesture: () => unknown) =>
      assert.throws(gesture, (err: unknown) => {
        assert.ok(err instanceof HarnessError);
        assert.equal(err.status, 403);
        assert.match(err.message, /réservé à l'humain/);
        return true;
      });
    byPilot(() => spaces.update(id, { policy: null }, PILOT));
    byPilot(() => spaces.update(id, { policy: { privacy: "local-only" } }, PILOT));
    byPilot(() => spaces.create(input("Autre", [], { policy: { privacy: "local-only" } }), PILOT));
    byPilot(() => spaces.onboard(input("Autre", []), PILOT, Date.now()));
    assert.equal(w.world.store.listSpaces().length, 1);
    assert.equal(w.world.store.getSpace(id)?.policy, null);
  } finally {
    await w.done();
  }
});

test("mc-etancheite/AC-12 : des portées mémoire en double ou réservées n'empêchent pas le démarrage : elles sont dites au journal et dans `GET /v1/status` (`warnings`), à chacun selon les dépôts qu'il voit", async () => {
  const clean = await setup();
  try {
    assert.deepEqual(configWarnings(clean.world.config), []);
    assert.deepEqual((await clean.call("GET", "/v1/status")).json.warnings, [], "sans rien à dire : une liste vide");
  } finally {
    await clean.done();
  }

  const w = await setup({}, (config) => {
    (config.repos.find((candidate) => candidate.name === "other") as RepoConfig).scope = "demo-scope";
    (config.repos.find((candidate) => candidate.name === "third") as RepoConfig).scope = "corpo";
  });
  try {
    // La configuration reste valide, et le service démarre.
    assert.doesNotThrow(() => validateConfig(w.world.config));
    await w.world.orchestrator.start();
    const logged = w.lines.filter((line) => line.level === "warn" && line.message.startsWith("configuration : "));
    assert.equal(logged.length, 2, JSON.stringify(w.lines));

    const { warnings } = (await w.call("GET", "/v1/status")).json;
    assert.equal(warnings.length, 2);
    assert.match(warnings[0] ?? "", /dépôt third : la portée mémoire « corpo » est réservée au service/);
    assert.match(warnings[1] ?? "", /les dépôts demo, other partagent la portée mémoire « demo-scope »/);
    assert.deepEqual(
      logged.map((line) => line.message),
      warnings.map((warning) => `configuration : ${warning}`),
    );

    // Un client borné ne lit qu'un avertissement dont il voit TOUS les dépôts.
    assert.deepEqual((await w.call("GET", "/v1/status", undefined, w.tokens.demo)).json.warnings, []);
    assert.deepEqual((await w.call("GET", "/v1/status", undefined, w.tokens.third)).json.warnings, [warnings[0]]);

    // La portée corrigée (rechargement) : l'avertissement part, sans redémarrage.
    repoOf(w.world, "third").scope = "third-scope";
    assert.deepEqual((await w.call("GET", "/v1/status")).json.warnings, [warnings[1]]);
  } finally {
    await w.done();
  }
});

test("mc-etancheite/AC-13 : `POST /v1/spaces/onboard` crée l'espace d'un client en un geste et rend son étanchéité et ce qu'il reste à faire ; admin qui voit tout seulement ; un dépôt déjà pris rend 409 sans rien créer", async () => {
  const w = await setup();
  try {
    const body = {
      name: "Acme",
      repos: ["demo"],
      jiraProjects: ["PROJ"],
      dailyBudgetUsd: 20,
      autonomy: "ask",
      policy: { privacy: "local-only" },
    };
    // Un operator, un admin borné à des dépôts : refusés, rien n'est créé.
    assert.equal((await w.call("POST", "/v1/spaces/onboard", body, w.tokens.ops)).status, 403);
    const bounded = await w.call("POST", "/v1/spaces/onboard", body, w.tokens.demoAdmin);
    assert.equal(bounded.status, 403);
    assert.match(bounded.json.error, /un client qui voit tous les dépôts/);
    assert.equal(
      (await w.call("POST", "/v1/spaces/onboard", { name: "Acme" })).status,
      400,
      "sans la liste des dépôts",
    );
    assert.equal(w.world.store.listSpaces().length, 0);

    const reply = await w.call("POST", "/v1/spaces/onboard", body);
    assert.equal(reply.status, 201, JSON.stringify(reply.json));
    const { space, isolation, next } = reply.json;
    assert.equal(reply.etag, `"${space.rev}"`);
    assert.deepEqual(
      [space.name, space.repos, space.jiraProjects, space.dailyBudgetUsd, space.autonomy, space.policy, space.by],
      ["Acme", ["demo"], ["PROJ"], 20, "ask", { privacy: "local-only" }, "mac"],
    );
    assert.deepEqual(space.isolation, isolation);
    assert.deepEqual(codes(isolation), [
      ["global_memory_token", "demo"],
      ["service_forge_identity", "demo"],
      ["no_atlassian", null],
    ]);
    // Ce qu'il reste à faire : une étape par lacune, puis le navigateur que rien n'exige encore.
    assert.deepEqual(
      next.map((step) => step.code),
      ["global_memory_token", "service_forge_identity", "no_atlassian", "attach_browser"],
    );
    assert.match(next[0]?.text ?? "", /Pose un jeton mémoire par dépôt \(`repos\[\]\.memory\.tokenEnv`\) : demo\./);
    assert.match(next[2]?.text ?? "", new RegExp(`connect\\?space=${space.id}`));
    assert.match(next[3]?.text ?? "", new RegExp(`"space": "${space.id}"`));
    assert.ok(
      w.world.store.eventsSince(0).some((event) => event.type === "space" && event.payload.action === "created"),
    );

    // Le dépôt est pris, le nom aussi : 409, et toujours un seul espace.
    const taken = await w.call("POST", "/v1/spaces/onboard", { name: "Autre", repos: ["demo"] });
    assert.equal(taken.status, 409);
    assert.match(taken.json.error, /appartient déjà à l'espace « Acme »/);
    assert.equal((await w.call("POST", "/v1/spaces/onboard", { name: "acme", repos: [] })).status, 409);
    assert.equal((await w.call("POST", "/v1/spaces/onboard", { name: "Autre", repos: ["absent"] })).status, 400);
    assert.equal(w.world.store.listSpaces().length, 1);

    // L'outil MCP fait le même geste, avec les mêmes gardes.
    let seq = 0;
    const tool = async (token: string, args: Record<string, unknown>) =>
      (
        await w.call(
          "POST",
          "/v1/mcp",
          { jsonrpc: "2.0", id: ++seq, method: "tools/call", params: { name: "space_onboard", arguments: args } },
          token,
          { Accept: "application/json, text/event-stream" },
        )
      ).json.result;
    const viaMcp = await tool(w.tokens.owner, { name: "Perso", repos: ["other"] });
    assert.notEqual(viaMcp.isError, true, JSON.stringify(viaMcp));
    assert.deepEqual([viaMcp.structuredContent.space.name, viaMcp.structuredContent.space.repos], ["Perso", ["other"]]);
    assert.deepEqual(
      viaMcp.structuredContent.next.map((step) => step.code),
      ["global_memory_token", "service_forge_identity", "connect_atlassian", "attach_browser"],
    );
    assert.equal((await tool(w.tokens.demoAdmin, { name: "Tiers", repos: [] })).isError, true);
    assert.equal(w.world.store.listSpaces().length, 2);
  } finally {
    await w.done();
  }
});

test("mc-etancheite/AC-14 : ce qu'il reste à faire regroupe les dépôts d'une même lacune, dit l'espace sans dépôt, et ne propose Atlassian ou un navigateur que s'ils sont possibles et absents", () => {
  const steps = (space: Space, around: IsolationFacts) => nextSteps(space, isolationOf(space, around), around);
  const bare = { memory: undefined, gh: undefined, git: undefined };
  const two = steps(
    spaceOf({ repos: ["demo", "docs"] }),
    facts([repo("demo", "acme", bare), repo("docs", "acme-docs", bare)]),
  );
  assert.deepEqual(
    two.map((step) => step.code),
    ["global_memory_token", "service_forge_identity", "connect_atlassian", "attach_browser"],
  );
  assert.match(two[0]?.text ?? "", /: demo et docs\.$/);
  assert.match(two[1]?.text ?? "", /compte de forge.*identité git.*: demo et docs\.$/s);

  // Un espace sans dépôt le dit d'abord ; tout branché, il ne reste que le poste, qui tourne sous le jeton
  // mémoire global (aucun remède par dépôt : sa phrase) — et rien du tout sans navigateur à rattacher.
  const empty = steps(spaceOf({ repos: [] }), facts([]));
  assert.equal(empty[0]?.code, "no_repos");
  assert.match(empty[0]?.text ?? "", /`PUT \/v1\/spaces\/e1 \{repos\}`/);
  const ready = facts([repo("demo", "acme")], { atlassian: { connected: true }, browsers: 1 });
  assert.deepEqual(
    steps(spaceOf(), ready).map((step) => step.code),
    ["global_memory_token"],
  );
  assert.deepEqual(steps(spaceOf(), { ...ready, workstation: false }), []);
  // Atlassian ou le poste coupés sur le serveur : rien à proposer.
  assert.deepEqual(steps(spaceOf(), facts([repo("demo", "acme")], { atlassian: null, workstation: false })), []);
  // Une lacune d'espace porte sa propre phrase, et ne se double pas d'une proposition.
  const jira = steps(
    spaceOf({ jiraProjects: ["PROJ"], identities: ["agent@acme.example"] }),
    facts([repo("demo", "acme")]),
  );
  assert.deepEqual(
    jira.map((step) => step.code),
    ["no_atlassian", "no_browser"],
  );
  for (const step of [...two, ...empty, ...jira]) assert.match(step.text, /^[A-ZÀ-Ý].*\.$/s);
});

test("mc-etancheite/AC-15 : sans aucun espace, rien ne change — même politique, même lancement, aucune lacune ni avertissement, aucune validation nouvelle au démarrage", async () => {
  const w = sessionWorld((c) => {
    Object.assign(c.repos[0] as RepoConfig, { providers: ["openrouter"] });
  });
  assert.deepEqual(w.store.listSpaces(), []);
  const demo = w.config.repos[0] as RepoConfig;
  assert.equal(strictest(demo, spaceRule(w.store.listSpaces(), "demo")?.policy ?? null), demo);
  assert.equal(modelOf(await w.launch("demo")), "openrouter/big", "la liste blanche du dépôt, comme avant");
  assert.equal(modelOf(await w.launch("other")), "anthropic/opus", "les chaînes du serveur, comme avant");

  const server = await setup();
  try {
    await server.world.orchestrator.start();
    assert.deepEqual((await server.call("GET", "/v1/spaces")).json.spaces, []);
    assert.deepEqual((await server.call("GET", "/v1/status")).json.warnings, []);
    assert.equal(server.lines.filter((line) => line.message.startsWith("configuration : ")).length, 0);
  } finally {
    await server.done();
  }
});

test("mc-etancheite/AC-16 : les routes et l'outil de la tranche sont servis, décrits dans le README du harness, et la capacité `space-policy` est annoncée", () => {
  const routes = apiRoutes({ store: {} } as never, new ClientRegistry(null, "t".repeat(64)));
  const readme = fs.readFileSync(path.join(ROOT, "omp-harness", "README.md"), "utf8");
  const expected = [
    ["GET", "/v1/spaces/{id}", "viewer"],
    ["POST", "/v1/spaces/onboard", "admin"],
  ] as const;
  for (const [method, route, role] of expected) {
    const served = routes.find((candidate) => candidate.method === method && candidate.path === route);
    assert.ok(served, `${method} ${route} absente de apiRoutes()`);
    assert.equal(served.role, role);
    // La ligne du tableau d'API : la route entière entre accents graves (pas le préfixe d'une autre).
    assert.ok(readme.includes(`| \`${method} ${route}\``), `${method} ${route} absente du tableau d'API du README`);
  }
  assert.ok((API_FEATURES as readonly string[]).includes("space-policy"));
  assert.ok(readme.includes("`space-policy`"), "la capacité est dite dans le README");
  const tool = MCP_TOOLS.find((candidate) => candidate.name === "space_onboard");
  assert.ok(tool, "outil MCP space_onboard");
  assert.deepEqual([tool.role, tool.readOnly, tool.required], ["admin", false, ["name", "repos"]]);
  assert.ok(readme.includes("| `space_onboard`"), "space_onboard absent du README");
  for (const code of ISOLATION_CODES) assert.ok(readme.includes(`\`${code}\``), `la lacune ${code} absente du README`);
  for (const word of ["`isolation`", "`warnings`", "`policy`"])
    assert.ok(readme.includes(word), `${word} absent du README`);
});

test("mc-etancheite/AC-17 : un espace durci pendant qu'un runner vit compte dès le prompt suivant — une liste blanche changée bascule le runner sur un modèle permis, jamais sur l'ancien ; passé « local-only », le runner distant s'arrête sans rien recevoir et l'étape repart sur le modèle local, sans clé distante", async () => {
  await withEnv(REMOTE_KEY, "test-clef-distante", async () => {
    const world = fakeWorld(
      { req: [[]] },
      {
        patch: (config) => {
          config.models = {
            fast: [],
            standard: [],
            heavy: [
              { provider: "anthropic", model: "opus" },
              { provider: "openrouter", model: "big" },
            ],
          };
          declareLocal(config);
        },
      },
    );
    const { spaces } = world.orchestrator;
    const acme = spaces.create(input("Acme", ["demo"]), HUMAN);
    const demo = repoOf(world, "demo");
    const session = new RunnerSession(
      new HarnessContext(world.deps),
      { repo: demo, cwd: demo.path },
      { onHostTool: async () => ({ text: "" }), event: () => {} },
    );
    const signal = new AbortController().signal;
    const ask = () => session.prompt("# /req\nUne étape de plus.", signal, Date.now() + 20_000);
    const launches = () => world.log().filter((line) => line.kind === "argv");
    const prompts = () => world.log().filter((line) => line.kind === "prompt").length;
    const switches = () =>
      world
        .log()
        .filter((line) => line.kind === "command" && line.type === "set_model")
        .map((line) => `${String(line.provider)}/${String(line.modelId)}`);
    const modelAt = (index: number) => {
      const argv = launches()[index]?.argv as string[];
      return argv[argv.indexOf("--model") + 1];
    };
    try {
      // Sans politique : le premier modèle du serveur, avec la clé du fournisseur distant.
      await session.open("heavy", "u1", signal);
      assert.equal((await ask()).status, "completed");
      assert.deepEqual([modelAt(0), launches()[0]?.keys], ["anthropic/opus", { [REMOTE_KEY]: "test-clef-distante" }]);

      // La liste blanche de l'espace change sous le runner vivant : le prompt suivant part chez un fournisseur permis.
      spaces.update(acme.id, { policy: { providers: ["openrouter"] } }, HUMAN);
      assert.equal((await ask()).status, "completed");
      assert.deepEqual([switches(), session.model, prompts()], [["openrouter/big"], "openrouter/big", 2]);

      // L'espace passe « local-only » : le runner vivant, lancé avec la clé distante, ne reçoit plus rien.
      spaces.update(acme.id, { policy: { privacy: "local-only" } }, HUMAN);
      const refused = await ask();
      assert.deepEqual(
        [refused.status, refused.error?.retryable, session.alive, prompts()],
        ["error", true, false, 2],
        "le prompt n'est pas parti, le runner est arrêté, l'étape se relance",
      );
      assert.match(refused.error?.message ?? "", /politique de modèles changée pendant la session/);

      // L'étape relancée : un runner neuf, sur le modèle local, sans la clé du fournisseur distant.
      assert.equal(await session.open("heavy", "u2", signal), false);
      assert.equal((await ask()).status, "completed");
      assert.deepEqual([modelAt(1), launches()[1]?.keys, prompts()], [LOCAL_MODEL, {}, 3]);

      // Dans l'autre sens aussi : la politique levée, le runner local ne se réutilise pas tel quel.
      spaces.update(acme.id, { policy: null }, HUMAN);
      assert.equal(await session.open("heavy", "u3", signal), false, "un runner neuf, pas celui d'avant");
      assert.equal(modelAt(2), "anthropic/opus");
    } finally {
      await session.stop();
      await world.orchestrator.stop();
    }
  });
});

test("mc-etancheite/AC-18 : une Demande hors espace dont l'auteur voit un dépôt d'un espace suit la liste blanche de fournisseurs de cet espace — son classeur ne part pas chez un fournisseur que l'espace ne permet pas ; deux espaces aux listes disjointes le refusent ; `--check` signale le dépôt d'un espace « local-only » sans modèle local", async () => {
  const classify = [{ tool: "intake_classify", args: { kind: "question", answer: "Deux dépôts sont déclarés." } }];
  const w = await setup({ demande: [classify] }, (config) => {
    config.models = {
      fast: [
        { provider: "anthropic", model: "haiku" },
        { provider: "openrouter", model: "small" },
      ],
      standard: [
        { provider: "anthropic", model: "sonnet" },
        { provider: "openrouter", model: "mid" },
      ],
      heavy: [
        { provider: "anthropic", model: "opus" },
        { provider: "openrouter", model: "big" },
      ],
    };
  });
  const { world } = w;
  /** Pose une demande hors espace et rend le modèle du runner qui l'a classée (`null` : aucun runner). */
  const classified = async (token?: string) => {
    const before = world.log().filter((line) => line.kind === "argv").length;
    const posted = await w.call("POST", "/v1/intake", { text: "où en est-on ?", source: "cli" }, token);
    assert.equal(posted.status, 201, JSON.stringify(posted.json));
    const { id } = posted.json.intake;
    await waitFor(
      () => world.store.getIntake(id)?.state !== "classifying",
      () => `la demande ${id} reste en classement`,
    );
    const argv = world.log().filter((line) => line.kind === "argv")[before]?.argv as string[] | undefined;
    return { model: argv?.[argv.indexOf("--model") + 1] ?? null, row: world.store.getIntake(id) as IntakeRow };
  };
  try {
    // Sans espace : le premier modèle du serveur, comme avant.
    assert.match((await classified()).model ?? "", /^anthropic\//);

    const acme = world.orchestrator.spaces.create(
      input("Acme", ["demo"], { policy: { providers: ["openrouter"] } }),
      HUMAN,
    );
    // L'auteur voit `demo` : l'« État de l'usine » de son prompt cite les runs d'Acme, sa liste blanche vaut.
    const free = await classified();
    assert.equal(free.row.spaceId, null, "la Demande reste hors espace");
    assert.match(free.model ?? "", /^openrouter\//);
    // Un client qui ne voit aucun dépôt d'Acme garde les modèles du serveur.
    assert.match((await classified(w.tokens.other)).model ?? "", /^anthropic\//);

    const spaces = () => world.store.listSpaces();
    const row: IntakeRow = { ...free.row, requestedRepo: null, repo: "", scope: "*", spaceId: null };
    assert.deepEqual(intakePolicy(world.config, row, spaces()), { providers: ["openrouter"] });
    assert.deepEqual(intakePolicy(world.config, { ...row, scope: ["other"] }, spaces()), {});
    assert.deepEqual(intakePolicy(world.config, row, []), {}, "sans espace, rien ne change");

    // Deux clients aux listes disjointes : aucun fournisseur ne convient aux deux, le classement est refusé.
    world.orchestrator.spaces.create(input("Bêta", ["other"], { policy: { providers: ["anthropic"] } }), HUMAN);
    assert.deepEqual(intakePolicy(world.config, row, spaces()).providers, []);
    const refused = await classified();
    assert.deepEqual([refused.model, refused.row.state], [null, "failed"]);
    assert.match(refused.row.reason ?? "", /fournisseurs permis/);

    // `--check` : la politique EN VIGUEUR d'un dépôt est celle de son espace croisée avec la sienne.
    const checked = (policy: ModelPolicy | null) =>
      runChecks(world.config, {
        exec: execProcess,
        git: new Git(execProcess, world.config.git),
        oracleHealth: async () => true,
        env: { HOME: "/var/lib/omp-harness" },
        servedModels: async () => null,
        spaces: policy === null ? [] : [{ name: "Acme", repos: [acme.repos[0] as string], policy }],
      });
    const about = (lines: CheckLine[]) =>
      lines
        .filter((line) => line.label.startsWith("dépôt") && line.label.includes("modèle"))
        .map((line) => [line.status, line.label]);
    const local = await checked({ privacy: "local-only" });
    assert.deepEqual(about(local), [["fail", "dépôt demo (espace « Acme ») — modèles"]]);
    assert.match(local.find((line) => line.label.endsWith("— modèles"))?.detail ?? "", /local-only/);
    assert.deepEqual(about(await checked(null)), [], "sans politique d'espace : aucune ligne de plus");
  } finally {
    await w.done();
  }
});

test("mc-etancheite/AC-19 : une connexion Atlassian qui lit le même site qu'une autre est une lacune de l'espace (`shared_atlassian_site`), qui nomme l'autre connexion et dit quoi faire ; seule sur son site, ou non branchée, elle ne l'est pas", () => {
  const demo = repo("demo", "acme");
  const acme = spaceOf({ jiraProjects: ["ACME"] });
  const connected = (sharedWith: string[]) => facts([demo], { atlassian: { connected: true, sharedWith } });
  only(
    isolationOf(acme, connected(["la connexion par défaut (hors espace)", "l'espace « Bêta »"])),
    "shared_atlassian_site",
    null,
    /même site que la connexion par défaut \(hors espace\) et l'espace « Bêta ».*`jiraProjects`.*Confluence/s,
  );
  assert.equal(isolationOf(acme, connected([])).sealed, true);
  assert.equal(isolationOf(acme, facts([demo], { atlassian: { connected: true } })).sealed, true);
  // Débranchée, elle ne lit rien : seule la lacune `no_atlassian` reste.
  only(
    isolationOf(acme, facts([demo], { atlassian: { connected: false, sharedWith: ["l'espace « Bêta »"] } })),
    "no_atlassian",
    null,
    /projets Jira/,
  );
  // Un client borné ne lit pas les lacunes de l'espace entier.
  assert.equal(isolationOf(acme, connected(["l'espace « Bêta »"]), ["demo"]).sealed, true);
});
