// Feature usine-autonome : la file ne reste plus figée pour rien.
// - Un run garé chez l'humain (`awaiting_human`) ne retient plus les modules d'un run en file :
//   constaté le 2026-11-09, quatre runs attendaient depuis six heures deux runs garés.
// - Le juge de la suite complète d'un dépôt (`tests.judge`) se change par l'API
//   (`PATCH /v1/repos/{name}`) : la configuration du VPS n'avait aucun autre chemin, et un
//   dépôt rouge d'environnement dans le slot heavy envoyait chaque revue à l'humain.
// - Le pilote tranche aussi les runs qui ne descendent d'aucun audit (`pilot.allRuns`) :
//   lancés à la main ou par une issue, ils finissaient tous chez l'humain.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { testsJudge } from "../../omp-harness/config.ts";
import { API_FEATURES, createHandler } from "../../omp-harness/http.ts";
import { ConfigAdmin } from "../../omp-harness/repos.ts";
import { FACTORY_PILOT } from "../../omp-harness/pilot.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const ADMIN = "a".repeat(64);

test("usine-autonome/AC-1 : un run garé chez l'humain ne retient pas les modules d'un run en file ; une escalade en cours les retient toujours", async () => {
  const world = fakeWorld({ req: [[{ sleep: 60_000 }]] });
  const park = (id: string, state: "awaiting_human" | "escalated", modules: string[]) =>
    world.store.createRun({
      id,
      repo: "demo",
      slug: id,
      title: id,
      request: id,
      branch: `harness/${id}`,
      state,
      step: "review",
      modules,
    });
  park("gare", "awaiting_human", ["src/api"]);
  await world.orchestrator.start();
  try {
    const fresh = world.orchestrator.createRun({
      repo: "demo",
      title: "Suite",
      request: "touche aussi l'API",
      modules: ["src/api"],
    });
    await waitFor(
      () => world.store.getRun(fresh.id)?.state === "running",
      () =>
        `${world.store.getRun(fresh.id)?.state} — ${world.orchestrator.withWait(world.store.getRun(fresh.id)!).reason}`,
    );

    // Une escalade en cours tient encore ses modules : le run suivant attend, et dit pourquoi.
    park("question", "escalated", ["src/db"]);
    const held = world.orchestrator.createRun({
      repo: "demo",
      title: "Après",
      request: "touche la base",
      modules: ["src/db"],
    });
    await waitFor(
      () => world.orchestrator.withWait(world.store.getRun(held.id)!).waitCause === "modules",
      () => String(world.orchestrator.withWait(world.store.getRun(held.id)!).reason),
    );
    assert.equal(world.store.getRun(held.id)?.state, "queued");
  } finally {
    await world.orchestrator.stop();
  }
});

async function serve(world: FakeWorld, admin: ConfigAdmin) {
  const clients = new ClientRegistry(path.join(tmpdir("usine-autonome-"), "clients.json"), ADMIN);
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

test("usine-autonome/AC-2 : `PATCH /v1/repos/{name}` change le juge de la suite complète, l'écrit dans config.json et le recharge à chaud ; un réglage invalide est un 400 et rien ne change", async () => {
  assert.ok((API_FEATURES as readonly string[]).includes("repo-tests"));
  const world = fakeWorld({});
  const demo = world.config.repos[0];
  assert.ok(demo);
  const file = path.join(tmpdir("usine-autonome-config-"), "config.json");
  const entry = (extra: Record<string, unknown>) => ({
    name: "demo",
    path: demo.path,
    scope: "demo",
    tests: demo.tests,
    ...extra,
  });
  const write = (extra: Record<string, unknown>) =>
    fs.writeFileSync(
      file,
      `${JSON.stringify({ dataDir: world.config.dataDir, worktreesDir: world.config.worktreesDir, repos: [entry(extra)] }, null, 2)}\n`,
    );
  write({ merge: "gh" });
  const api = await serve(world, new ConfigAdmin(file, world.orchestrator, { git: world.deps.git }));
  try {
    assert.equal((await api.call("PATCH", "/v1/repos/demo", { tests: { judge: "ci" } }, api.operator)).status, 403);
    assert.equal((await api.call("PATCH", "/v1/repos/demo", { tests: { judge: "ci" } }, api.partial)).status, 403);
    assert.equal((await api.call("PATCH", "/v1/repos/inconnu", { tests: { judge: "ci" } })).status, 404);
    const before = fs.readFileSync(file, "utf8");
    for (const bad of [
      {},
      { tests: [] },
      { tests: { judge: "ailleurs" } },
      { tests: { ciTimeoutSec: 0 } },
      { tests: { full: "rm -rf /" } },
    ]) {
      const refused = await api.call("PATCH", "/v1/repos/demo", bad);
      assert.equal(refused.status, 400, JSON.stringify(bad));
    }
    assert.equal(fs.readFileSync(file, "utf8"), before, "un refus n'écrit rien");

    const set = await api.call("PATCH", "/v1/repos/demo", { tests: { judge: "ci", ciTimeoutSec: 1800 } });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.judge, "ci");
    assert.equal(set.body.ciTimeoutSec, 1800);
    const live = world.orchestrator.config.repos.find((repo) => repo.name === "demo");
    assert.ok(live);
    assert.equal(testsJudge(live), "ci", "le juge sert dès le rechargement");
    const written = JSON.parse(fs.readFileSync(file, "utf8")).repos[0].tests;
    assert.equal(written.judge, "ci");
    assert.equal(written.ciTimeoutSec, 1800);
    assert.equal(written.full, demo.tests.full, "les autres réglages des tests sont gardés");
    const listed = await api.call("GET", "/v1/repos");
    assert.equal((listed.body.repos as { judge: string }[])[0]?.judge, "ci");

    // `null` rend le défaut.
    const reset = await api.call("PATCH", "/v1/repos/demo", { tests: { judge: null, ciTimeoutSec: null } });
    assert.equal(reset.status, 200, JSON.stringify(reset.body));
    assert.equal(reset.body.judge, "local");
    assert.equal(reset.body.ciTimeoutSec, 3600);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).repos[0].tests.judge, undefined);

    // `ci` sans forge : refusé par la validation de la configuration, le fichier et le service restent tels quels.
    write({ forge: "none" });
    await api.call("POST", "/v1/reload");
    const noForge = fs.readFileSync(file, "utf8");
    const refused = await api.call("PATCH", "/v1/repos/demo", { tests: { judge: "ci" } });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    assert.match(String(refused.body.error), /forge/);
    assert.equal(fs.readFileSync(file, "utf8"), noForge);
    assert.equal(testsJudge(world.orchestrator.config.repos[0]!), "local");
  } finally {
    await api.close();
  }
});

const REVIEW_HIGH = [
  OK.review[0],
  { tool: "review_verdict", args: { ...(OK.review[1]?.args as Record<string, unknown>), risk: "high" } },
];

function factoryWorld(allRuns: boolean): FakeWorld {
  return fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [OK.impl],
      review: [REVIEW_HIGH],
      pilote: [[{ tool: "pilot_act", args: { action: "approve", reason: "AC-1 livré et prouvé par harness/AC-1" } }]],
    },
    {
      patch: (config) => {
        config.pilot.allRuns = allRuns;
      },
    },
  );
}

test("usine-autonome/AC-3 : un run lancé hors audit dont le verdict attend l'humain est tranché par le pilote de l'usine, et fusionne sans geste humain", async () => {
  const world = factoryWorld(true);
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "merged",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      60_000,
    );
    const pilot = world.store.eventsSince(0, run.id).filter((event) => event.type === "pilot");
    assert.ok(pilot.length > 0, "le pilote a tranché");
    assert.deepEqual(
      pilot.map((event) => [event.payload.action, event.payload.by, event.payload.auditId]),
      pilot.map(() => ["approve", FACTORY_PILOT, null]),
    );
    const prompt = String(
      world.log().find((entry) => entry.kind === "prompt" && entry.step === "pilote" && !entry.nudge)?.message ?? "",
    );
    assert.match(prompt, /les features de « demo » qui attendent l'humain/);
    assert.doesNotMatch(prompt, /focus :/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("usine-autonome/AC-4 : `pilot.allRuns: false` laisse un run hors audit à l'humain, sans session de pilote", async () => {
  const world = factoryWorld(false);
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter en CSV" });
    await waitFor(
      () => world.store.getRun(run.id)?.state === "awaiting_human",
      () => `${world.store.getRun(run.id)?.state} — ${world.store.getRun(run.id)?.reason}`,
      60_000,
    );
    await world.orchestrator.tick();
    await world.orchestrator.tick();
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human");
    assert.deepEqual(
      world.store.eventsSince(0, run.id).filter((event) => event.type === "pilot"),
      [],
    );
    assert.equal(world.log().filter((entry) => entry.kind === "prompt" && entry.step === "pilote").length, 0);
  } finally {
    await world.orchestrator.stop();
  }
});
