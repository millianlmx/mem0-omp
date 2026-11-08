// Feature harness-gestes-clients : les gestes qui manquaient aux clients du harness.
// Parler à un run en cours (`POST /v1/runs/{id}/instructions` : la consigne est injectée
// dans la session vivante par un `steer` d'OMP, sinon gardée pour le prompt suivant),
// relancer avec une consigne, donner à un run son propre budget (au lancement ou ensuite,
// prioritaire sur `monitoring.runBudgetUsd`), déclarer un dépôt et relire la
// configuration par l'API (ce que `--add-repo` et SIGHUP faisaient en ssh). Les mêmes
// gestes passent par le serveur MCP et par les outils du plugin omp-mem0-req.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { Git } from "../../omp-harness/git.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import { execProcess, type Exec } from "../../omp-harness/proc.ts";
import { ConfigAdmin, type KeyGen } from "../../omp-harness/repos.ts";
import reqExtension from "../../omp-mem0-req/extension.ts";
import { fakeSchema } from "../support/fake-zod.ts";
import { OK, fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);

type Reply = { status: number; body: Record<string, unknown> };

type Api = {
  url: string;
  operator: string;
  viewer: string;
  /** Un admin restreint au dépôt `demo` : la configuration du serveur ne lui est pas ouverte. */
  partial: string;
  call: (
    method: string,
    route: string,
    body?: unknown,
    options?: { token?: string; ifMatch?: string },
  ) => Promise<Reply>;
  /** Un outil du serveur MCP : son résultat (`structuredContent`, `isError`, texte). */
  tool: (name: string, args: Record<string, unknown>, token?: string) => Promise<Record<string, unknown>>;
  close: () => Promise<void>;
};

async function serve(world: FakeWorld, admin: ConfigAdmin | null = null): Promise<Api> {
  const clients = new ClientRegistry(path.join(tmpdir("gestes-clients-"), "clients.json"), ADMIN);
  const operator = clients.add("ops", "operator", "*").token;
  const viewer = clients.add("lecteur", "viewer", "*").token;
  const partial = clients.add("partiel", "admin", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, admin, log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call: Api["call"] = async (method, route, body, options = {}) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.token ?? ADMIN}`,
        ...(options.ifMatch !== undefined ? { "If-Match": options.ifMatch } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    url,
    operator,
    viewer,
    partial,
    call,
    tool: async (name, args, token = operator) => {
      const reply = await call(
        "POST",
        "/v1/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        { token },
      );
      return reply.body.result as Record<string, unknown>;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const assistant = (cost: number) => ({
  role: "assistant",
  provider: "anthropic",
  model: "claude-test",
  content: [{ type: "text", text: "je cherche" }],
  usage: { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0, cost: { total: cost } },
});

const spend = (cost: number) => ({ frame: { type: "message_end", message: assistant(cost) } });

const promptsOf = (world: FakeWorld, step: string) =>
  world.log().filter((entry) => entry.kind === "prompt" && entry.step === step);

const runOf = (reply: Reply) => reply.body.run as { id: string; rev: number; state: string };

test("harness-gestes-clients/AC-1 : une consigne à un run qui tourne est injectée dans sa session vivante — le runner la reçoit pendant le prompt —, journalisée (`instructions`) et visible dans le direct du run", async () => {
  assert.ok((API_FEATURES as readonly string[]).includes("instructions"));
  const world = fakeWorld({ req: [[{ waitSteer: 15_000 }, ...OK.req]], specs: [[{ sleep: 60_000 }]] });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter en CSV",
      modules: ["src/api"],
    });
    await waitFor(
      () => promptsOf(world, "req").length === 1,
      () => JSON.stringify(world.log()),
    );
    const sent = await api.call(
      "POST",
      `/v1/runs/${run.id}/instructions`,
      { text: "  Utilise le point-virgule comme séparateur.  " },
      { token: api.operator },
    );
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.delivered, "session");
    assert.equal(runOf(sent).id, run.id);
    // Le runner l'a reçue en pilotage, pendant son prompt : l'étape continue avec elle.
    const steered = world.log().filter((entry) => entry.kind === "command" && entry.type === "steer");
    assert.equal(steered.length, 1);
    assert.match(String(steered[0]?.message), /Utilise le point-virgule comme séparateur\./);
    assert.match(String(steered[0]?.message), /\(ops\)/, "l'auteur est nommé à l'agent");
    await waitFor(
      () => world.store.listSteps(run.id).some((step) => step.kind === "req" && step.status === "done"),
      () => JSON.stringify(world.store.listSteps(run.id)),
    );
    assert.match(String(world.log().find((entry) => entry.kind === "steered")?.message), /point-virgule/);
    assert.equal(world.store.instructions(run.id), null, "injectée, elle n'est pas gardée en plus pour la suite");
    assert.deepEqual(
      world.store.eventsOfType("instructions").map((event) => [event.runId, event.payload]),
      [[run.id, { text: "Utilise le point-virgule comme séparateur.", delivered: "session", step: "req", by: "ops" }]],
    );
    const session = await api.call("GET", `/v1/runs/${run.id}/session`, undefined, { token: api.viewer });
    const entries = session.body.entries as { kind: string; text: string; step: string | null }[];
    assert.deepEqual(
      entries.filter((entry) => entry.kind === "instructions").map((entry) => [entry.text, entry.step]),
      [["Utilise le point-virgule comme séparateur.", "req"]],
    );
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("harness-gestes-clients/AC-2 : sans session vivante, la consigne est gardée et part avec le prompt de la prochaine étape, une seule fois", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [[{ sleep: 60_000 }]] });
  const api = await serve(world);
  try {
    // Le service n'a pas démarré : le run attend en file, sans runner.
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter en CSV",
      modules: ["src/api"],
    });
    const sent = await api.call(
      "POST",
      `/v1/runs/${run.id}/instructions`,
      { text: "Exporte aussi les en-têtes." },
      { token: api.operator },
    );
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.delivered, "pending");
    assert.match(world.store.instructions(run.id) ?? "", /Exporte aussi les en-têtes\./);
    assert.equal(world.store.eventsOfType("instructions")[0]?.payload.delivered, "pending");
    assert.equal(world.orchestrator.sessions.snapshot(run.id).at(-1)?.kind, "instructions");
    await world.orchestrator.start();
    await waitFor(
      () => promptsOf(world, "specs").length === 1,
      () => JSON.stringify(world.log().map((entry) => [entry.kind, entry.step])),
    );
    const [req] = promptsOf(world, "req");
    assert.match(String(req?.message), /Exporte aussi les en-têtes\./, "la prochaine étape la reçoit");
    assert.doesNotMatch(String(promptsOf(world, "specs")[0]?.message), /Exporte aussi les en-têtes/, "une seule fois");
    assert.equal(world.log().filter((entry) => entry.type === "steer").length, 0);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("harness-gestes-clients/AC-3 : une consigne que le runner refuse en plein prompt est gardée et part au prochain tour de la MÊME étape", async () => {
  const world = fakeWorld({
    steer: "refuse",
    // Le premier prompt ne rend pas req.md : l'étape relance l'agent (nudge) avant de se clore.
    req: [[{ waitSteer: 15_000 }, { sleep: 200 }]],
    "req-nudge": [OK.req],
    specs: [[{ sleep: 60_000 }]],
  });
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter en CSV",
      modules: ["src/api"],
    });
    await waitFor(
      () => promptsOf(world, "req").length === 1,
      () => JSON.stringify(world.log()),
    );
    const sent = await api.call("POST", `/v1/runs/${run.id}/instructions`, { text: "Garde la colonne id." });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.delivered, "pending");
    await waitFor(
      () => world.store.listSteps(run.id).some((step) => step.kind === "req" && step.status === "done"),
      () => JSON.stringify(world.store.listSteps(run.id)),
    );
    const nudge = promptsOf(world, "req").find((entry) => entry.nudge === true);
    assert.match(String(nudge?.message), /## Consignes reçues pendant l'étape\n[^\n]*Garde la colonne id\./);
    assert.equal(world.store.instructions(run.id), null, "lue au prochain tour, elle est effacée");
    assert.doesNotMatch(String(promptsOf(world, "specs")[0]?.message ?? ""), /Garde la colonne id/);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

test("harness-gestes-clients/AC-4 : la consigne suit les règles des gestes — révision périmée 412, run mergé ou annulé 409, consigne vide ou trop longue 400, lecteur 403 — et rien ne change sur un refus", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter", modules: ["src"] });
    const route = `/v1/runs/${run.id}/instructions`;
    const stale = await api.call("POST", route, { text: "a" }, { ifMatch: `"${run.rev + 1}"` });
    assert.equal(stale.status, 412);
    assert.equal((await api.call("POST", route, { text: "   " })).status, 400);
    assert.equal((await api.call("POST", route, { text: "x".repeat(4001) })).status, 400);
    assert.equal((await api.call("POST", route, {})).status, 400);
    assert.equal((await api.call("POST", route, { text: "a" }, { token: api.viewer })).status, 403);
    assert.equal(world.store.instructions(run.id), null);
    assert.deepEqual(world.store.eventsOfType("instructions"), []);
    const fresh = await api.call("POST", route, { text: "Exporte en UTF-8." }, { ifMatch: `"${run.rev}"` });
    assert.equal(fresh.status, 200);
    for (const state of ["merged", "cancelled"] as const) {
      world.store.updateRun(run.id, { state });
      const refused = await api.call("POST", route, { text: "encore" });
      assert.equal(refused.status, 409, state);
      assert.match(String(refused.body.error), new RegExp(`run déjà ${state}`));
    }
    assert.equal(world.store.eventsOfType("instructions").length, 1);
  } finally {
    await api.close();
  }
});

test("harness-gestes-clients/AC-5 : la relance par l'API porte une consigne facultative, que l'étape relancée reçoit", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter", modules: ["src"] });
    world.store.updateRun(run.id, { state: "failed" });
    assert.equal(
      (await api.call("POST", `/v1/runs/${run.id}/retry`, { instructions: 3 }, { token: api.operator })).status,
      400,
    );
    const retried = await api.call(
      "POST",
      `/v1/runs/${run.id}/retry`,
      { instructions: "Repars du schéma existant." },
      { token: api.operator },
    );
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(runOf(retried).state, "queued");
    assert.match(world.store.instructions(run.id) ?? "", /Repars du schéma existant\./);
    // Sans corps, la relance reste celle d'avant.
    world.store.updateRun(run.id, { state: "failed" });
    world.store.setInstructions(run.id, null);
    const bare = await fetch(`${api.url}/v1/runs/${run.id}/retry`, {
      method: "POST",
      headers: { Authorization: `Bearer ${api.operator}` },
    });
    assert.equal(bare.status, 200);
    assert.equal(world.store.instructions(run.id), null);
  } finally {
    await api.close();
  }
});

test("harness-gestes-clients/AC-6 : un run lancé avec `budgetUsd` est jugé sur son budget avant celui de la configuration ; `POST /v1/runs/{id}/budget` le change, `null` y revient", async () => {
  assert.ok((API_FEATURES as readonly string[]).includes("run-budget"));
  const world = fakeWorld(
    { req: [[spend(1.5), ...OK.req]], specs: [[{ sleep: 60_000 }]] },
    { patch: (config) => (config.monitoring.runBudgetUsd = 100) },
  );
  await world.orchestrator.start();
  const api = await serve(world);
  try {
    const launch = (body: Record<string, unknown>) =>
      api.call(
        "POST",
        "/v1/runs",
        { repo: "demo", title: "Export", request: "Exporter", ...body },
        { token: api.operator },
      );
    for (const budgetUsd of [0, -1, "5", 10_001])
      assert.equal((await launch({ budgetUsd })).status, 400, String(budgetUsd));
    assert.deepEqual(world.store.listRuns({}), [], "un budget invalide ne crée rien");
    const own = runOf(await launch({ modules: ["src/api"], budgetUsd: 1 }));
    const shared = runOf(await launch({ title: "Import", modules: ["src/db"] }));
    await waitFor(
      () =>
        [own.id, shared.id].every((id) =>
          world.store.listSteps(id).some((step) => step.kind === "req" && step.status === "done"),
        ),
      () => JSON.stringify([own.id, shared.id].map((id) => world.store.listSteps(id))),
    );
    const exceeded = world.store.eventsOfType("budget_exceeded");
    assert.deepEqual(
      exceeded.map((event) => [event.runId, event.payload.budget, event.payload.cost]),
      [[own.id, 1, 1.5]],
      "1,50 $ dépasse le budget du run (1 $), pas celui de la configuration (100 $)",
    );
    assert.equal(world.store.eventsOfType("run_created")[0]?.payload.budgetUsd, 1);
    const view = await api.call("GET", `/v1/runs/${own.id}`, undefined, { token: api.viewer });
    assert.deepEqual(view.body.budget, { cost: 1.5, budget: 1, threshold: 1, source: "run" });
    const other = await api.call("GET", `/v1/runs/${shared.id}`, undefined, { token: api.viewer });
    assert.deepEqual(other.body.budget, { cost: 1.5, budget: 100, threshold: 100, source: "config" });

    // Relevé au-dessus du coût : l'alerte s'éteint ; `null` revient au budget de la configuration.
    const route = `/v1/runs/${own.id}/budget`;
    for (const body of [{}, { budgetUsd: 0 }, { budgetUsd: "5" }])
      assert.equal((await api.call("POST", route, body, { token: api.operator })).status, 400, JSON.stringify(body));
    assert.equal((await api.call("POST", route, { budgetUsd: 5 }, { token: api.viewer })).status, 403);
    const raised = await api.call("POST", route, { budgetUsd: 5 }, { token: api.operator });
    assert.equal(raised.status, 200, JSON.stringify(raised.body));
    assert.deepEqual(raised.body.budget, { cost: 1.5, budget: 5, threshold: 5, source: "run" });
    assert.deepEqual(
      world.store.eventsOfType("alert_cleared").map((event) => [event.runId, event.payload.kind]),
      [[own.id, "budget_exceeded"]],
    );
    assert.deepEqual(world.orchestrator.monitor.alertsOf(own.id), []);
    const reset = await api.call("POST", route, { budgetUsd: null }, { token: api.operator });
    assert.deepEqual(reset.body.budget, { cost: 1.5, budget: 100, threshold: 100, source: "config" });
    assert.deepEqual(
      world.store.eventsOfType("run_budget").map((event) => [event.payload.budgetUsd, event.payload.by]),
      [
        [5, "ops"],
        [null, "ops"],
      ],
    );
    // Rabaissé sous le coût : le dépassement repart aussitôt, sans attendre un nouveau message.
    await api.call("POST", route, { budgetUsd: 1.2 }, { token: api.operator });
    assert.equal(world.store.eventsOfType("budget_exceeded").filter((event) => event.runId === own.id).length, 2);
    const stale = await api.call("POST", route, { budgetUsd: 3 }, { token: api.operator, ifMatch: "0" });
    assert.equal(stale.status, 412);
  } finally {
    await api.close();
    await world.orchestrator.stop();
  }
});

/** Un distant « GitHub » doublé : l'URL déclarée est servie par un dépôt nu local ; l'écriture peut être refusée. */
function doubledRemote(url: string, options: { denyWrite: boolean }): { git: Git; calls: string[][] } {
  const source = harnessRepo("gestes-clients-src-");
  git(source, "checkout", "-q", "main");
  fs.writeFileSync(path.join(source, "package.json"), '{ "scripts": { "test": "node --test" } }\n');
  git(source, "add", "package.json");
  git(source, "commit", "-q", "-m", "package");
  const remote = path.join(tmpdir("gestes-clients-remote-"), "produit.git");
  git(source, "clone", "-q", "--bare", source, remote);
  const calls: string[][] = [];
  const exec: Exec = (command, args, opts) => {
    calls.push(args);
    if (options.denyWrite && args.includes("push"))
      return Promise.resolve({
        code: 128,
        signal: null,
        stdout: "",
        stderr:
          "ERROR: The key you are authenticating with has been marked as read only.\nfatal: Could not read from remote repository.",
        timedOut: false,
        aborted: false,
      });
    return execProcess(
      command,
      args.map((arg) => (arg === url ? remote : arg)),
      opts,
    );
  };
  return { git: new Git(exec, { authorName: "Harness", authorEmail: "harness@example.com" }), calls };
}

/** Une clé « générée » sans ssh-keygen. */
const fakeKeygen: KeyGen = async (args) => {
  const file = args[args.indexOf("-f") + 1] as string;
  fs.writeFileSync(file, "PRIVATE\n", { mode: 0o600 });
  fs.writeFileSync(`${file}.pub`, `ssh-ed25519 AAAAFAKE omp-harness:${path.basename(file)}\n`);
};

/** Le fichier de configuration du monde : le dépôt `demo`, comme `testConfig`. */
function configFileOf(world: FakeWorld, extra: Record<string, unknown>[] = []): string {
  const file = path.join(tmpdir("gestes-clients-config-"), "config.json");
  const demo = world.config.repos[0];
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        dataDir: world.config.dataDir,
        worktreesDir: world.config.worktreesDir,
        repos: [{ name: "demo", path: demo?.path, scope: "demo-scope", tests: demo?.tests }, ...extra],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

const stateDir = (config: { dataDir: string }) => {
  config.dataDir = path.join(tmpdir("gestes-clients-root-"), "state");
};

test("harness-gestes-clients/AC-7 : `POST /v1/repos` déclare un dépôt comme `--add-repo` (clé, clone, écriture éprouvée, configuration écrite) et le sert aussitôt ; un distant qui refuse la clé rend la clé de déploiement à poser", async () => {
  assert.ok((API_FEATURES as readonly string[]).includes("admin-repos"));
  const url = "git@github.com:moi/produit.git";
  const world = fakeWorld({}, { patch: stateDir });
  const file = configFileOf(world);
  const home = tmpdir("gestes-clients-home-");

  // Écriture refusée : rien n'est déclaré, la clé à poser est rendue avec sa page GitHub.
  const denied = doubledRemote(url, { denyWrite: true });
  const lockedApi = await serve(
    world,
    new ConfigAdmin(file, world.orchestrator, { git: denied.git, keygen: fakeKeygen, home }),
  );
  const before = fs.readFileSync(file, "utf8");
  try {
    const refused = await lockedApi.call("POST", "/v1/repos", { url });
    assert.equal(refused.status, 200, JSON.stringify(refused.body));
    assert.equal(refused.body.added, false);
    assert.deepEqual(refused.body.deployKey, {
      publicKey: "ssh-ed25519 AAAAFAKE omp-harness:produit",
      url: "https://github.com/moi/produit/settings/keys/new",
    });
    assert.equal(fs.readFileSync(file, "utf8"), before, "la configuration reste intacte");
    assert.deepEqual(
      world.orchestrator.config.repos.map((repo) => repo.name),
      ["demo"],
    );
  } finally {
    await lockedApi.close();
  }

  const doubled = doubledRemote(url, { denyWrite: false });
  const api = await serve(
    world,
    new ConfigAdmin(file, world.orchestrator, { git: doubled.git, keygen: fakeKeygen, home }),
  );
  try {
    for (const bad of ["/srv/git/produit.git", "-oProxyCommand=x", "ext::sh -c id", "git@github.com:-u/x", ""])
      assert.equal((await api.call("POST", "/v1/repos", { url: bad })).status, 400, bad);
    assert.equal((await api.call("POST", "/v1/repos", { url, name: "../x" })).status, 400);
    assert.equal((await api.call("POST", "/v1/repos", { url }, { token: api.operator })).status, 403);
    assert.equal((await api.call("POST", "/v1/repos", { url }, { token: api.partial })).status, 403);
    assert.ok(!doubled.calls.some((args) => args.includes("clone")), "un refus ne touche à rien");

    const added = await api.call("POST", "/v1/repos", { url });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.repo, "produit");
    assert.equal(added.body.added, true);
    assert.equal(added.body.deployKey, undefined);
    assert.deepEqual((added.body.reload as { added: string[] }).added, ["produit"]);
    const declared = JSON.parse(fs.readFileSync(file, "utf8")).repos.find(
      (repo: { name: string }) => repo.name === "produit",
    );
    assert.equal(declared.sshKey, path.join(home, ".ssh", "repos", "produit"));
    assert.equal(declared.tests.full, "npm test");
    const listed = await api.call("GET", "/v1/repos", undefined, { token: api.viewer });
    assert.deepEqual(
      (listed.body.repos as { name: string }[]).map((repo) => repo.name),
      ["demo", "produit"],
    );
    // Il sert : un run s'y crée.
    const run = await api.call(
      "POST",
      "/v1/runs",
      { repo: "produit", title: "Doc", request: "Documenter", modules: ["README.md"] },
      { token: api.operator },
    );
    assert.equal(run.status, 201);
    const again = await api.call("POST", "/v1/repos", { url });
    assert.equal(again.status, 200);
    assert.equal(again.body.added, false);
    assert.match(String(again.body.message), /déjà déclaré/);
  } finally {
    await api.close();
  }

  // Un service lancé sans fichier de configuration n'a rien à écrire.
  const bare = await serve(fakeWorld({}));
  try {
    assert.equal((await bare.call("POST", "/v1/repos", { url })).status, 409);
    assert.equal((await bare.call("POST", "/v1/reload")).status, 409);
  } finally {
    await bare.close();
  }
});

test("harness-gestes-clients/AC-8 : `POST /v1/reload` relit la configuration comme SIGHUP et rend les dépôts chargés ; une configuration invalide est un 400 et la courante reste en place", async () => {
  const world = fakeWorld({}, { patch: stateDir });
  const extra = harnessRepo("gestes-clients-extra-");
  const file = configFileOf(world, [
    { name: "outils", path: extra, scope: "outils", tests: { touched: "true", full: "true" } },
  ]);
  const api = await serve(world, new ConfigAdmin(file, world.orchestrator, { git: world.deps.git }));
  try {
    assert.equal((await api.call("POST", "/v1/reload", undefined, { token: api.operator })).status, 403);
    assert.equal((await api.call("POST", "/v1/reload", undefined, { token: api.partial })).status, 403);
    const reloaded = await api.call("POST", "/v1/reload");
    assert.equal(reloaded.status, 200, JSON.stringify(reloaded.body));
    assert.deepEqual(reloaded.body.reload, { repos: ["demo", "outils"], added: ["outils"], removed: [], kept: [] });
    assert.deepEqual(
      world.orchestrator.config.repos.map((repo) => repo.name),
      ["demo", "outils"],
    );

    const valid = fs.readFileSync(file, "utf8");
    for (const broken of [
      "{ pas du json",
      JSON.stringify({ repos: [{ name: "demo", path: "relatif", tests: { touched: "x", full: "x" } }] }),
      JSON.stringify({ repos: [{ name: "demo", path: extra, merge: "bogus", tests: { touched: "x", full: "x" } }] }),
    ]) {
      fs.writeFileSync(file, broken);
      const refused = await api.call("POST", "/v1/reload");
      assert.equal(refused.status, 400, broken);
      assert.match(String(refused.body.error), /^configuration refusée, l'ancienne reste en place/);
      assert.deepEqual(
        world.orchestrator.config.repos.map((repo) => repo.name),
        ["demo", "outils"],
        "la configuration courante est gardée",
      );
    }
    // Le service répond toujours, et relit de nouveau une configuration réparée.
    const declared = JSON.parse(valid) as { repos: unknown[] };
    fs.writeFileSync(file, JSON.stringify({ ...declared, repos: declared.repos.slice(0, 1) }));
    const repaired = await api.call("POST", "/v1/reload");
    assert.equal(repaired.status, 200, JSON.stringify(repaired.body));
    assert.deepEqual(repaired.body.reload, { repos: ["demo"], added: [], removed: ["outils"], kept: [] });
  } finally {
    await api.close();
  }
});

test("harness-gestes-clients/AC-9 : le serveur MCP porte les mêmes gestes — `run_instructions`, `run_budget`, `budgetUsd` de `run_start`, consigne de `run_retry` — avec les mêmes refus", async () => {
  const world = fakeWorld({});
  const api = await serve(world);
  try {
    const started = await api.tool("run_start", {
      repo: "demo",
      title: "Export",
      request: "Exporter",
      modules: ["src"],
      budgetUsd: 2,
    });
    const run = (started.structuredContent as { run: { id: string; rev: number } }).run;
    assert.equal(world.orchestrator.monitor.budget(run.id).source, "run");
    const told = await api.tool("run_instructions", { id: run.id, text: "Pas de dépendance nouvelle." });
    assert.equal(told.isError, undefined, JSON.stringify(told));
    assert.equal((told.structuredContent as { delivered: string }).delivered, "pending");
    assert.match(world.store.instructions(run.id) ?? "", /Pas de dépendance nouvelle\./);
    assert.match(
      JSON.stringify((await api.tool("run_instructions", { id: run.id, text: "x", rev: run.rev + 9 })).content),
      /le run a changé depuis ta lecture/,
    );
    assert.equal((await api.tool("run_instructions", { id: run.id, text: "x" }, api.viewer)).isError, true);
    const budget = await api.tool("run_budget", { id: run.id, budgetUsd: 4 });
    assert.deepEqual((budget.structuredContent as { budget: unknown }).budget, {
      cost: 0,
      budget: 4,
      threshold: 4,
      source: "run",
    });
    assert.equal((await api.tool("run_budget", { id: run.id, budgetUsd: -2 })).isError, true);
    world.store.updateRun(run.id, { state: "failed" });
    world.store.setInstructions(run.id, null);
    const retried = await api.tool("run_retry", { id: run.id, instructions: "Garde l'API publique." });
    assert.equal(retried.isError, undefined, JSON.stringify(retried));
    assert.match(world.store.instructions(run.id) ?? "", /Garde l'API publique\./);
  } finally {
    await api.close();
  }
});

/** Le plugin omp-mem0-req, ses outils capturés par un `pi` factice. */
function reqTools() {
  type Tool = {
    name: string;
    loadMode?: string;
    description: string;
    execute: (
      id: string,
      params: unknown,
      signal: undefined,
      onUpdate: undefined,
      ctx: unknown,
    ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
  };
  const tools = new Map<string, Tool>();
  reqExtension({
    zod: { z: fakeSchema() },
    registerCommand: () => undefined,
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    sendUserMessage: () => undefined,
    sendMessage: () => undefined,
    on: () => undefined,
  } as never);
  return tools;
}

test("harness-gestes-clients/AC-10 : le plugin omp-mem0-req lance avec un budget (`harness_launch`), parle à un run (`harness_instruct`) et relance avec une consigne (`harness_retry`), contre le vrai harness", async () => {
  const world = fakeWorld({ req: [[{ waitSteer: 15_000 }, ...OK.req]], specs: [[{ sleep: 60_000 }]] });
  const api = await serve(world);
  const tools = reqTools();
  const previous = { url: process.env.HARNESS_URL, token: process.env.HARNESS_TOKEN, repo: process.env.HARNESS_REPO };
  process.env.HARNESS_URL = api.url;
  process.env.HARNESS_TOKEN = api.operator;
  process.env.HARNESS_REPO = "demo";
  const ctx = { cwd: tmpdir("gestes-clients-session-"), hasUI: false };
  const call = (name: string, params: unknown) => {
    const tool = tools.get(name);
    if (!tool) throw new Error(`outil absent : ${name}`);
    return tool.execute("t", params, undefined, undefined, ctx);
  };
  let started = false;
  try {
    assert.equal(tools.get("harness_instruct")?.loadMode, "essential");
    const launched = await call("harness_launch", {
      title: "Export",
      request: "Exporter",
      modules: ["src/api"],
      req: "## Besoins\nB-1 : exporter\n",
      budgetUsd: 2,
    });
    assert.equal(launched.isError, undefined, launched.content[0]?.text);
    const [run] = world.store.listRuns({});
    assert.ok(run);
    assert.deepEqual(world.orchestrator.monitor.budget(run.id), { cost: 0, budget: 2, threshold: 2, source: "run" });
    assert.match(
      (await call("harness_run", { id: run.id })).content[0]?.text ?? "",
      /- coût : 0\.00 \$ sur un budget de 2\.00 \$ \(propre au run\)/,
    );

    assert.equal((await call("harness_instruct", { id: run.id, text: "  " })).isError, true);
    const kept = await call("harness_instruct", { id: run.id, text: "Ajoute un test d'export vide." });
    assert.equal(kept.isError, undefined, kept.content[0]?.text);
    assert.match(kept.content[0]?.text ?? "", /^Consigne gardée/);
    assert.match(world.store.instructions(run.id) ?? "", /Ajoute un test d'export vide\./);

    // Le run tourne : la consigne entre dans la session de son agent.
    world.store.setInstructions(run.id, null);
    await world.orchestrator.start();
    started = true;
    await waitFor(
      () => promptsOf(world, "specs").length === 1,
      () => JSON.stringify(world.log().map((entry) => [entry.kind, entry.step])),
    );
    // Les specs dorment une minute : le runner est en plein prompt.
    const live = await call("harness_instruct", { id: run.id, text: "Nomme le fichier export.csv." });
    assert.equal(live.isError, undefined, live.content[0]?.text);
    assert.match(live.content[0]?.text ?? "", /^Consigne transmise à l'agent du run/);
    assert.match(
      String(world.log().find((entry) => entry.type === "steer")?.message),
      /Nomme le fichier export\.csv\./,
    );

    // Le service arrêté, le run échoué se relance avec sa consigne, gardée pour son prochain prompt.
    await world.orchestrator.stop();
    started = false;
    world.store.updateRun(run.id, { state: "failed" });
    const retried = await call("harness_retry", { id: run.id, instructions: "Repars des specs validées." });
    assert.equal(retried.isError, undefined, retried.content[0]?.text);
    assert.match(world.store.instructions(run.id) ?? "", /Repars des specs validées\./);
  } finally {
    for (const [key, value] of [
      ["HARNESS_URL", previous.url],
      ["HARNESS_TOKEN", previous.token],
      ["HARNESS_REPO", previous.repo],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await api.close();
    if (started) await world.orchestrator.stop();
  }
});
