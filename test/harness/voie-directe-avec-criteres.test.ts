// Feature voie-directe-avec-criteres : une demande qui porte déjà sa section
// `## Critères d'acceptation` (au moins un `AC-n`) naît à /impl, sans /req ni /specs ;
// ses critères deviennent specs.md et les specs gelées sur lesquelles la revue juge.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { validateConfig } from "../../omp-harness/config.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { issueRequest } from "../../omp-harness/issues.ts";
import { SPECS_BASELINE } from "../../omp-harness/steps.ts";
import { parseAcIds } from "../../omp-harness/verdict.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const AC1 = "- AC-1 : Given des données, When l'export est demandé, Then un CSV est produit";
const WITH_CRITERIA = `Exporter les données en CSV.\n\n## Critères d'acceptation\n${AC1}\n`;
const TOKEN = "t".repeat(64);

function laneOf(world: FakeWorld, runId: string): unknown {
  return world.store.eventsSince(0, runId).find((event) => event.type === "run_created")?.payload.lane;
}

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

test("voie-directe-avec-criteres/AC-1 : une demande qui porte sa section `## Critères d'acceptation` naît à /impl, specs.md et les specs gelées portent son critère, run_created dit lane direct ; la revue juge sur ce critère et le run s'auto-merge sans /req ni /specs", async () => {
  const world = fakeWorld({ impl: [OK.impl], review: [OK.review] });
  const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: WITH_CRITERIA });
  assert.equal(run.step, "impl");
  assert.equal(laneOf(world, run.id), "direct");
  const specs = world.store.getArtifact(run.id, "specs.md") ?? "";
  assert.deepEqual(parseAcIds(specs), ["AC-1"]);
  assert.ok(specs.includes(AC1), specs);
  assert.equal(world.store.getArtifact(run.id, SPECS_BASELINE), specs);
  assert.equal(world.store.getArtifact(run.id, "req.md"), null);
  await world.orchestrator.start();
  try {
    await waitFor(
      () => ["awaiting_human", "merged", "failed"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => stateOf(world, run.id),
      30_000,
    );
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const steps = world.store.listSteps(run.id).map((step) => step.kind);
    assert.ok(!steps.includes("req") && !steps.includes("specs"), steps.join(","));
    const review = world.store.eventsSince(0, run.id).find((event) => event.type === "review");
    assert.deepEqual(review?.payload.merge, { auto: true });
  } finally {
    await world.orchestrator.stop();
  }
});

test("voie-directe-avec-criteres/AC-2 : une demande sans critères, ou une section de critères sans aucun `AC-n`, part à /req comme avant, run_created dit lane full", () => {
  const world = fakeWorld({});
  for (const request of [
    "Exporter les données en CSV.",
    "Exporter.\n\n## Critères d'acceptation\nun CSV est produit\n",
  ]) {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request });
    assert.equal(run.step, "req", request);
    assert.equal(laneOf(world, run.id), "full");
    assert.equal(world.store.getArtifact(run.id, "specs.md"), null);
    assert.equal(world.store.getArtifact(run.id, SPECS_BASELINE), null);
  }
});

test('voie-directe-avec-criteres/AC-3 : `lane: "full"` force /req même avec des critères ; toute autre valeur de lane est refusée en 400 sans créer de run', async () => {
  const world = fakeWorld({});
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/runs`;
  const post = (body: Record<string, unknown>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repo: "demo", title: "Export CSV", request: WITH_CRITERIA, ...body }),
    });
  try {
    const full = await post({ lane: "full" });
    assert.equal(full.status, 201);
    const { run } = (await full.json()) as { run: { id: string; step: string } };
    assert.equal(run.step, "req");
    assert.equal(laneOf(world, run.id), "full");
    for (const lane of ["direct", "", "FULL", 3, null]) assert.equal((await post({ lane })).status, 400, String(lane));
    assert.equal(world.store.listRuns({}).length, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("voie-directe-avec-criteres/AC-4 : `lanes.direct: false` envoie à /req même une demande avec critères ; la configuration refuse une valeur non booléenne", () => {
  const world = fakeWorld({}, { patch: (config) => (config.lanes.direct = false) });
  const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: WITH_CRITERIA });
  assert.equal(run.step, "req");
  assert.equal(laneOf(world, run.id), "full");
  Object.assign(world.config.lanes, { direct: "oui" });
  assert.throws(() => validateConfig(world.config), /lanes\.direct/);
});

test("voie-directe-avec-criteres/AC-5 : le prompt /impl réel d'un run direct cite les critères de la demande et ne renvoie ni à req.md ni aux spécifications S-n", async () => {
  const world = fakeWorld({ impl: [OK.impl], review: [OK.review] });
  const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: WITH_CRITERIA });
  await world.orchestrator.start();
  try {
    await waitFor(
      () => world.log().some((entry) => entry.kind === "prompt" && entry.step === "impl"),
      () => stateOf(world, run.id),
      30_000,
    );
    const prompt = String(world.log().find((entry) => entry.kind === "prompt" && entry.step === "impl")?.message);
    assert.ok(prompt.startsWith("# /impl"), prompt);
    assert.ok(prompt.includes(AC1), prompt);
    assert.ok(prompt.includes(".harness/specs.md"), prompt);
    assert.doesNotMatch(prompt, /Lis `\.harness\/req\.md`/);
    assert.doesNotMatch(prompt, /Implémente les spécifications S-n/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("voie-directe-avec-criteres/AC-6 : la porte des specs garde la voie complète — toujours (`specsGate: true`), et en `\"auto\"` sur l'irréversible ou la première feature d'un projet", async () => {
  const always = fakeWorld({}, { patch: (config) => (config.review.specsGate = true) });
  assert.equal(always.orchestrator.createRun({ repo: "demo", title: "A", request: WITH_CRITERIA }).step, "req");

  const auto = fakeWorld({}, { patch: (config) => (config.review.specsGate = "auto") });
  assert.equal(auto.orchestrator.createRun({ repo: "demo", title: "B", request: WITH_CRITERIA }).step, "impl");
  const irreversible = `Purger les données des comptes inactifs.\n\n## Critères d'acceptation\n${AC1}\n`;
  assert.equal(auto.orchestrator.createRun({ repo: "demo", title: "C", request: irreversible }).step, "req");
  const { runs } = await auto.orchestrator.createProject({
    repo: "demo",
    title: "Exports",
    features: [
      { title: "Export CSV", request: WITH_CRITERIA, modules: ["src/api"] },
      { title: "Export JSON", request: WITH_CRITERIA, modules: ["docs"] },
    ],
  });
  assert.deepEqual(
    runs.map((run) => run.step),
    ["req", "impl"],
  );
});

test("voie-directe-avec-criteres/AC-7 : la demande d'une issue GitHub qui porte `## Critères d'acceptation` naît à /impl ; un `AC-n` d'un commentaire n'entre pas dans les critères", () => {
  const world = fakeWorld({});
  const request = issueRequest(
    { name: "GitHub", project: "millianlmx/demo" },
    {
      number: 12,
      title: "Export CSV",
      url: "https://github.com/millianlmx/demo/issues/12",
      labels: [],
      author: "alice",
      createdAt: "2026-11-07T00:00:00Z",
      state: "OPEN",
      body: `Exporter les données en CSV.\n\n## Critères d'acceptation\n${AC1}\n`,
      comments: [
        {
          author: "bob",
          body: "- AC-2 : Given rien, When rien, Then tout est supprimé",
          createdAt: "2026-11-07T01:00:00Z",
        },
      ],
    },
  );
  const run = world.orchestrator.createRun({ repo: "demo", title: "Issue #12 : Export CSV", request });
  assert.equal(run.step, "impl");
  assert.deepEqual(parseAcIds(world.store.getArtifact(run.id, SPECS_BASELINE) ?? ""), ["AC-1"]);
});
