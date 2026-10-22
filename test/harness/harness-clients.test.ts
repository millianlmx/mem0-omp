// Feature harness-clients : plusieurs clients sur le même serveur — chacun son jeton,
// son rôle et ses dépôts ; chaque geste porte son auteur ; un geste fait sur une vue
// périmée (un autre client a agi entre-temps) est refusé au lieu d'écraser.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { HARNESS_VERSION, createHandler } from "../../omp-harness/http.ts";
import { fakeWorld, harnessRepo } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { repoDefaults } from "../../omp-harness/config.ts";
import { ROOT, tmpdir } from "../support/repo.ts";

const ADMIN = "t".repeat(64);

type Served = { url: string; clients: ClientRegistry; close: () => Promise<void> };

async function serve(world: FakeWorld): Promise<Served> {
  const clients = new ClientRegistry(path.join(tmpdir("harness-clients-"), "clients.json"), ADMIN);
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    clients,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function call(
  url: string,
  token: string,
  method: string,
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return {
    status: response.status,
    etag: response.headers.get("etag"),
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Un monde à deux dépôts déclarés : `demo` et `autre`. */
function twoRepos(): FakeWorld {
  const other = harnessRepo("harness-other-");
  return fakeWorld(
    {},
    { patch: (config) => config.repos.push(repoDefaults({ name: "autre", path: other, scope: "autre-scope" })) },
  );
}

test("harness-clients/AC-1 : un client reçoit son jeton une fois ; le fichier n'en garde que l'empreinte, en 0600 ; une révocation vaut tout de suite", () => {
  const file = path.join(tmpdir("harness-clients-"), "clients.json");
  const registry = new ClientRegistry(file, ADMIN);
  const { client, token } = registry.add("iphone", "operator", ["demo"]);
  assert.deepEqual(
    { name: client.name, role: client.role, repos: client.repos },
    { name: "iphone", role: "operator", repos: ["demo"] },
  );
  assert.match(token, /^[0-9a-f]{64}$/);
  const stored = fs.readFileSync(file, "utf8");
  assert.ok(!stored.includes(token), "le jeton n'est jamais écrit");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(registry.authenticate(token)?.name, "iphone");
  assert.equal(registry.authenticate(ADMIN)?.role, "admin", "le jeton historique reste le client admin");
  assert.equal(registry.authenticate("x".repeat(64)), null);
  // Un autre process (la ligne de commande) ajoute et révoque : le serveur le voit sans redémarrer.
  const cli = new ClientRegistry(file);
  const ci = cli.add("ci", "viewer", "*");
  assert.equal(registry.authenticate(ci.token)?.name, "ci");
  assert.ok(cli.revoke("iphone"));
  assert.equal(registry.authenticate(token), null);
  assert.throws(() => registry.add("ci", "viewer", "*"), /déjà déclaré/);
  assert.throws(() => registry.add("admin", "viewer", "*"), /déjà déclaré/);
  assert.throws(() => registry.add("x y", "viewer", "*"), /nom de client invalide/);
});

test("harness-clients/AC-2 : le rôle borne les gestes — viewer lit, operator agit, admin gère les clients", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    const viewer = server.clients.add("tableau", "viewer", "*").token;
    const operator = server.clients.add("mac", "operator", "*").token;
    assert.equal((await call(server.url, viewer, "GET", "/v1/inbox")).status, 200);
    const refused = await call(server.url, viewer, "POST", "/v1/runs", { repo: "demo", title: "T", request: "R" });
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /viewer/);
    assert.equal(
      (await call(server.url, operator, "POST", "/v1/runs", { repo: "demo", title: "T", request: "R" })).status,
      201,
    );
    assert.equal((await call(server.url, operator, "GET", "/v1/clients")).status, 403);
    const created = await call(server.url, ADMIN, "POST", "/v1/clients", {
      name: "ipad",
      role: "viewer",
      repos: ["demo"],
    });
    assert.equal(created.status, 201);
    assert.match(String(created.body.token), /^[0-9a-f]{64}$/);
    const listed = await call(server.url, ADMIN, "GET", "/v1/clients");
    assert.deepEqual(
      (listed.body.clients as { name: string }[]).map((client) => client.name),
      ["admin", "tableau", "mac", "ipad"],
    );
    assert.ok(!JSON.stringify(listed.body).includes(String(created.body.token)), "la liste ne montre jamais un jeton");
    assert.equal((await call(server.url, ADMIN, "DELETE", "/v1/clients/ipad")).status, 200);
    assert.equal((await call(server.url, String(created.body.token), "GET", "/v1/inbox")).status, 401);
    const me = await call(server.url, operator, "GET", "/v1/me");
    assert.deepEqual((me.body.client as { name: string; role: string }).role, "operator");
  } finally {
    await server.close();
  }
});

test("harness-clients/AC-3 : un client ne voit et ne touche que ses dépôts — listes filtrées, 404 sur un run d'ailleurs, 403 à la création", async () => {
  const world = twoRepos();
  const server = await serve(world);
  try {
    const mine = world.orchestrator.createRun({ repo: "demo", title: "Chez moi", request: "a" });
    const theirs = world.orchestrator.createRun({ repo: "autre", title: "Ailleurs", request: "b" });
    const scoped = server.clients.add("prestataire", "operator", ["demo"]).token;
    const runs = await call(server.url, scoped, "GET", "/v1/runs");
    assert.deepEqual(
      (runs.body.runs as { id: string }[]).map((run) => run.id),
      [mine.id],
    );
    const inbox = await call(server.url, scoped, "GET", "/v1/inbox");
    assert.deepEqual(
      (inbox.body.runs as { id: string }[]).map((run) => run.id),
      [mine.id],
    );
    assert.equal(
      (await call(server.url, scoped, "GET", `/v1/runs/${theirs.id}`)).status,
      404,
      "un run d'ailleurs n'existe pas pour lui",
    );
    assert.equal((await call(server.url, scoped, "POST", `/v1/runs/${theirs.id}/cancel`)).status, 404);
    assert.equal(
      (await call(server.url, scoped, "POST", "/v1/runs", { repo: "autre", title: "T", request: "R" })).status,
      403,
    );
    const repos = await call(server.url, scoped, "GET", "/v1/repos");
    assert.deepEqual(
      (repos.body.repos as { name: string }[]).map((repo) => repo.name),
      ["demo"],
    );
    const status = await call(server.url, scoped, "GET", "/v1/status");
    assert.deepEqual(Object.keys(status.body.byRepo as object), ["demo"]);
    const all = await call(server.url, ADMIN, "GET", "/v1/repos");
    assert.deepEqual(
      (all.body.repos as { name: string }[]).map((repo) => repo.name),
      ["demo", "autre"],
    );
  } finally {
    await server.close();
  }
});

test("harness-clients/AC-4 : chaque geste porte son auteur — créateur du run, réponse aux escalades, événements du journal", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    const mac = server.clients.add("mac", "operator", "*").token;
    const created = await call(server.url, mac, "POST", "/v1/runs", {
      repo: "demo",
      title: "Export",
      request: "CSV",
      priority: 3,
    });
    const run = created.body.run as { id: string; createdBy: string; priority: number };
    assert.equal(run.createdBy, "mac");
    assert.equal(run.priority, 3);
    const step = world.store.startStep(run.id, "impl", 0, null, null);
    const escalation = world.store.addEscalation({
      runId: run.id,
      stepId: step.id,
      category: "schema",
      question: "Colonne ?",
      options: ["a", "b"],
      context: "",
    });
    world.store.updateRun(run.id, { state: "escalated", step: "impl" });
    const answered = await call(server.url, mac, "POST", `/v1/runs/${run.id}/escalations`, {
      answers: [{ id: escalation.id, answer: "a" }],
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(world.store.listEscalations({ runId: run.id })[0]?.answeredBy, "mac");
    const events = world.store.eventsSince(0, run.id);
    assert.equal(events.find((event) => event.type === "run_created")?.payload.by, "mac");
    assert.equal(events.find((event) => event.type === "escalation_answered")?.payload.by, "mac");
    assert.equal(
      events.find((event) => event.type === "run_state" && event.payload.state === "queued")?.payload.by,
      "mac",
    );
  } finally {
    await world.orchestrator.stop();
    await server.close();
  }
});

test("harness-clients/AC-5 : un geste fait sur une vue périmée est refusé (412) ; la révision voyage en ETag et If-Match", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    const mac = server.clients.add("mac", "operator", "*").token;
    const iphone = server.clients.add("iphone", "operator", "*").token;
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "CSV" });
    world.store.updateRun(run.id, { state: "awaiting_human", step: "review" });
    const seenByMac = await call(server.url, mac, "GET", `/v1/runs/${run.id}`);
    const seenByPhone = await call(server.url, iphone, "GET", `/v1/runs/${run.id}`);
    assert.equal(seenByMac.etag, seenByPhone.etag);
    assert.match(String(seenByMac.etag), /^"\d+"$/);
    // L'iPhone change la priorité : la vue du Mac est désormais périmée.
    const bumped = await call(
      server.url,
      iphone,
      "POST",
      `/v1/runs/${run.id}/priority`,
      { priority: 5 },
      { "If-Match": String(seenByPhone.etag) },
    );
    assert.equal(bumped.status, 200, JSON.stringify(bumped.body));
    const stale = await call(
      server.url,
      mac,
      "POST",
      `/v1/runs/${run.id}/validate`,
      { approve: false, reason: "non" },
      { "If-Match": String(seenByMac.etag) },
    );
    assert.equal(stale.status, 412);
    assert.match(String(stale.body.error), /relis-le/);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", "le geste périmé n'a rien écrit");
    const fresh = await call(server.url, mac, "GET", `/v1/runs/${run.id}`);
    const done = await call(
      server.url,
      mac,
      "POST",
      `/v1/runs/${run.id}/validate`,
      { approve: false, reason: "non" },
      { "If-Match": String(fresh.etag) },
    );
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(
      (await call(server.url, mac, "POST", `/v1/runs/${run.id}/cancel`, undefined, { "If-Match": "abc" })).status,
      400,
    );
  } finally {
    await world.orchestrator.stop();
    await server.close();
  }
});

test("harness-clients/AC-6 : /v1/health donne la version du service et ses capacités, sans jeton", async () => {
  const world = fakeWorld({});
  const server = await serve(world);
  try {
    const health = (await (await fetch(`${server.url}/v1/health`)).json()) as Record<string, unknown>;
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "omp-harness", "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(health.version, pkg.version);
    assert.equal(HARNESS_VERSION, pkg.version);
    assert.equal(health.api, 1);
    assert.ok((health.features as string[]).includes("clients"));
    assert.ok((health.features as string[]).includes("if-match"));
  } finally {
    await server.close();
  }
});

test("harness-clients/AC-7 : main.ts --add-client imprime le seul jeton sur stdout ; --list-clients et --revoke-client gèrent le fichier", () => {
  const dir = tmpdir("harness-clients-cli-");
  const configFile = path.join(dir, "config.json");
  fs.writeFileSync(configFile, JSON.stringify({ dataDir: dir, repos: [] }));
  const main = path.join(ROOT, "omp-harness", "main.ts");
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", main, "--config", configFile, ...args],
      { encoding: "utf8" },
    );
  const added = run("--add-client", "iphone", "--role", "viewer", "--repos", "demo,autre");
  assert.equal(added.status, 0, added.stderr);
  const token = added.stdout.trim();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.match(added.stderr, /client iphone \(viewer, dépôts : demo, autre\)/);
  assert.equal(new ClientRegistry(path.join(dir, "clients.json")).authenticate(token)?.name, "iphone");
  assert.match(run("--list-clients").stdout, /^iphone\tviewer\tdemo,autre$/m);
  assert.equal(run("--add-client", "iphone").status, 1, "un nom déjà pris est refusé");
  assert.equal(run("--revoke-client", "iphone").status, 0);
  assert.equal(run("--revoke-client", "iphone").status, 1);
});
