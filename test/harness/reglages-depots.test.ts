// Feature reglages-depots : les réglages d'un dépôt se lisent, se changent et le dépôt se retire par l'API,
// sans éditer config.json à la main (écran « Dépôts » d'omp-console). Les commandes (tests, checks,
// prévisualisation), les chemins et les comptes restent au fichier : ils s'exécutent ou se lisent sur le serveur.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import { ConfigAdmin } from "../../omp-harness/repos.ts";
import { fakeWorld } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);

async function serve(world: FakeWorld, admin: ConfigAdmin) {
  const clients = new ClientRegistry(path.join(tmpdir("reglages-depots-"), "clients.json"), ADMIN);
  const operator = clients.add("ops", "operator", "*").token;
  const partial = clients.add("partiel", "admin", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients, admin, log: () => {} }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, route: string, body?: unknown, token = ADMIN) => {
    const response = await fetch(`${url}${route}`, {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    call,
    operator,
    partial,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Un serveur à deux dépôts déclarés dans un vrai fichier de configuration ; `demo` a sa clé de déploiement. */
async function setup() {
  const world = fakeWorld({});
  const demo = world.config.repos[0];
  assert.ok(demo);
  const dir = tmpdir("reglages-depots-config-");
  const key = path.join(dir, "demo-key");
  fs.writeFileSync(`${key}.pub`, "ssh-ed25519 AAAAPUBLIQUE omp-harness:demo\n");
  const file = path.join(dir, "config.json");
  const entry = (name: string, extra: Record<string, unknown> = {}) => ({
    name,
    path: demo.path,
    scope: name,
    tests: demo.tests,
    checks: { lint: "bash scripts/lint.sh" },
    ...extra,
  });
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        dataDir: world.config.dataDir,
        worktreesDir: world.config.worktreesDir,
        repos: [entry("demo", { sshKey: key }), entry("autre")],
      },
      null,
      2,
    )}\n`,
  );
  const api = await serve(world, new ConfigAdmin(file, world.orchestrator, { git: world.deps.git }));
  await api.call("POST", "/v1/reload");
  return { world, file, api };
}

test("reglages-depots/AC-1 : `GET /v1/repos/{name}` rend les réglages en vigueur, défauts compris, la clé PUBLIQUE de déploiement et l'espace du dépôt ; jamais un chemin ni la clé privée, et au propriétaire seul", async () => {
  assert.ok((API_FEATURES as readonly string[]).includes("repo-settings"));
  const { world, api } = await setup();
  try {
    world.store.insertSpace({
      id: "e-acme",
      name: "Acme",
      repos: ["demo"],
      jiraProjects: [],
      dailyBudgetUsd: null,
      autonomy: null,
      policy: null,
      by: "mac",
    });
    assert.equal((await api.call("GET", "/v1/repos/demo", undefined, api.operator)).status, 403);
    assert.equal((await api.call("GET", "/v1/repos/demo", undefined, api.partial)).status, 403);
    assert.equal((await api.call("GET", "/v1/repos/inconnu")).status, 404);

    const read = await api.call("GET", "/v1/repos/demo");
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const repo = read.body.repo as Record<string, unknown>;
    assert.equal(repo.name, "demo");
    assert.equal(repo.merge, "local");
    assert.equal(repo.corporate, "redacted", "le défaut est rendu, pas l'absence");
    assert.deepEqual(repo.tests, {
      touched: (world.config.repos[0] as { tests: { touched: string } }).tests.touched,
      full: (world.config.repos[0] as { tests: { full: string } }).tests.full,
      pattern: (world.config.repos[0] as { tests: { pattern: string | null } }).tests.pattern,
      judge: "local",
      ciTimeoutSec: 3600,
    });
    assert.deepEqual(repo.checks, { lint: "bash scripts/lint.sh" });
    assert.equal((repo.deployKey as { publicKey: string }).publicKey, "ssh-ed25519 AAAAPUBLIQUE omp-harness:demo");
    assert.deepEqual(read.body.spaces, ["Acme"]);
    const text = JSON.stringify(read.body);
    assert.ok(!text.includes('demo-key"'), "le chemin de la clé privée n'est jamais rendu");
    assert.ok(!("path" in repo) && !("sshKey" in repo));
    assert.equal(((await api.call("GET", "/v1/repos/autre")).body.repo as { deployKey: unknown }).deployKey, null);
  } finally {
    await api.close();
  }
});

test("reglages-depots/AC-2 : `PATCH /v1/repos/{name}` change les champs présents, `null` rend le défaut ; l'écrit dans config.json et le recharge à chaud ; une commande, un chemin ou un réglage refusé par la validation est un 400 et rien ne change", async () => {
  const { world, file, api } = await setup();
  try {
    assert.equal((await api.call("PATCH", "/v1/repos/demo", { merge: "gh" }, api.partial)).status, 403);
    const before = fs.readFileSync(file, "utf8");
    for (const bad of [
      {},
      { path: "/tmp/ailleurs" },
      { sshKey: "/tmp/cle" },
      { checks: { lint: "rm -rf /" } },
      { tests: { full: "rm -rf /" } },
      { mainBranch: "--force" },
      { merge: "rebase" },
      { maxParallel: 0 },
      { git: { name: "x" } },
      { models: { enorme: ["a/b"] } },
      { forge: "none", merge: "gh" },
    ]) {
      const refused = await api.call("PATCH", "/v1/repos/demo", bad);
      assert.equal(refused.status, 400, JSON.stringify(bad));
    }
    assert.equal(fs.readFileSync(file, "utf8"), before, "un refus n'écrit rien");

    const set = await api.call("PATCH", "/v1/repos/demo", {
      mainBranch: "trunk",
      merge: "gh",
      forge: "github",
      maxParallel: 2,
      git: { name: "Usine", email: "usine@example.com" },
      corporate: "forbid",
      tests: { judge: "ci" },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const repo = set.body.repo as Record<string, unknown>;
    assert.equal(repo.mainBranch, "trunk");
    assert.equal(repo.maxParallel, 2);
    assert.equal(repo.corporate, "forbid");
    assert.equal(set.body.judge, "ci");
    const live = world.orchestrator.config.repos.find((candidate) => candidate.name === "demo");
    assert.equal(live?.mainBranch, "trunk", "le réglage sert dès le rechargement");
    assert.equal(live?.merge, "gh");
    const written = (JSON.parse(fs.readFileSync(file, "utf8")) as { repos: Record<string, unknown>[] }).repos[0];
    assert.deepEqual(written?.issues, { corporate: "forbid" });
    assert.deepEqual(written?.checks, { lint: "bash scripts/lint.sh" }, "ce que le corps ne nomme pas reste tel quel");

    const reset = await api.call("PATCH", "/v1/repos/demo", {
      merge: null,
      forge: null,
      maxParallel: null,
      git: null,
      corporate: null,
      tests: { judge: null },
    });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    const back = (JSON.parse(fs.readFileSync(file, "utf8")) as { repos: Record<string, unknown>[] }).repos[0];
    for (const key of ["merge", "forge", "maxParallel", "git", "issues"]) assert.ok(!(key in (back ?? {})), key);
    assert.equal((reset.body.repo as { merge: string }).merge, "local");
    assert.equal((reset.body.repo as { corporate: string }).corporate, "redacted");
  } finally {
    await api.close();
  }
});

test("reglages-depots/AC-3 : `DELETE /v1/repos/{name}` exige `?confirm=1`, refuse un dépôt rangé dans un espace (409 qui le nomme), puis le retire du fichier et du service", async () => {
  const { world, file, api } = await setup();
  try {
    world.store.insertSpace({
      id: "e-acme",
      name: "Acme",
      repos: ["demo"],
      jiraProjects: [],
      dailyBudgetUsd: null,
      autonomy: null,
      policy: null,
      by: "mac",
    });
    assert.equal((await api.call("DELETE", "/v1/repos/autre?confirm=1", undefined, api.partial)).status, 403);
    assert.equal((await api.call("DELETE", "/v1/repos/inconnu?confirm=1")).status, 404);
    assert.equal((await api.call("DELETE", "/v1/repos/autre")).status, 409);
    const held = await api.call("DELETE", "/v1/repos/demo?confirm=1");
    assert.equal(held.status, 409);
    assert.match(String(held.body.error), /Acme/);

    const removed = await api.call("DELETE", "/v1/repos/autre?confirm=1");
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.kept, false);
    assert.deepEqual(
      (JSON.parse(fs.readFileSync(file, "utf8")) as { repos: { name: string }[] }).repos.map((repo) => repo.name),
      ["demo"],
    );
    assert.deepEqual(
      world.orchestrator.config.repos.map((repo) => repo.name),
      ["demo"],
    );
  } finally {
    await api.close();
  }
});
