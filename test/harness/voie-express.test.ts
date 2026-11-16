// Feature voie-express : `lane: "express"` (ou `lanes.default: "express"`) fait naître le run à /impl même sans
// critères — un critère est synthétisé de la demande —, la revue ne bloque que sur ce qui casse, sans QA de
// prévisualisation, et une seule correction est prévue avant l'humain. L'irréversible, la porte des specs toujours
// posée et l'autonomie `ask` gardent la voie complète, et `run_created` dit pourquoi.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { defaultConfig, fixCapFor, validateConfig } from "../../omp-harness/config.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { SPECS_BASELINE, expressSpecs } from "../../omp-harness/steps.ts";
import { parseAcIds } from "../../omp-harness/verdict.ts";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const TOKEN = "t".repeat(64);

function created(world: FakeWorld, runId: string): Record<string, unknown> | undefined {
  return world.store.eventsSince(0, runId).find((event) => event.type === "run_created")?.payload;
}

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

async function settled(world: FakeWorld, runId: string): Promise<void> {
  await waitFor(
    () => ["awaiting_human", "merged", "failed"].includes(world.store.getRun(runId)?.state ?? ""),
    () => stateOf(world, runId),
    30_000,
  );
}

const BLOCKED = [
  { tool: "run_tests", args: { scope: "full" } },
  {
    tool: "review_verdict",
    args: {
      risk: "low",
      summary: "les guillemets ne sont pas échappés",
      blockers: ["les guillemets ne sont pas échappés"],
      risks: [],
      files: ["src/api/export.ts"],
      unverified: [],
      criteria: [{ id: "AC-1", test: "harness/AC-1", status: "fail" }],
      confidence: "strong",
      commit: { subject: "feat(api): exporter les données en CSV", body: "Ajoute l'export CSV des données." },
    },
  },
];

const FIX = [
  { write: "src/api/export.ts", content: "export const exportCsv = () => '\"a\",b';\n" },
  { write: ".harness/fix.md", content: "## Levées\n- guillemets échappés\n" },
];

test("voie-express/AC-1 : une demande SANS critères en voie express naît à /impl avec un critère synthétisé, specs gelées comprises ; run.lane et run_created disent express, et le run s'auto-merge sans /req ni /specs", async () => {
  const world = fakeWorld({ impl: [OK.impl], review: [OK.review] });
  const run = world.orchestrator.createRun({
    repo: "demo",
    title: "Export CSV",
    request: "Exporter les données en CSV.",
    lane: "express",
  });
  assert.equal(run.step, "impl");
  assert.equal(run.lane, "express");
  assert.equal(created(world, run.id)?.lane, "express");
  const specs = world.store.getArtifact(run.id, "specs.md") ?? "";
  assert.deepEqual(parseAcIds(specs), ["AC-1"]);
  assert.match(specs, /> Exporter les données en CSV\./);
  assert.equal(world.store.getArtifact(run.id, SPECS_BASELINE), specs);
  assert.equal(world.store.getArtifact(run.id, "req.md"), null);
  // Des critères dans la demande : ce sont eux, pas un critère synthétisé.
  const withCriteria = expressSpecs("T", "Faire.\n\n## Critères d'acceptation\n- AC-1 : un\n- AC-2 : deux\n");
  assert.deepEqual(parseAcIds(withCriteria), ["AC-1", "AC-2"]);
  assert.match(withCriteria, /^Voie express : /m);
  await world.orchestrator.start();
  try {
    await settled(world, run.id);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const steps = world.store.listSteps(run.id).map((step) => step.kind);
    assert.deepEqual(steps, ["impl", "review"]);
  } finally {
    await world.orchestrator.stop();
  }
});

test("voie-express/AC-2 : la revue express reçoit la règle des bloquants resserrée ; /impl reçoit la consigne express ; une revue de voie complète ne la reçoit pas", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  const express = world.orchestrator.createRun({
    repo: "demo",
    title: "Export CSV",
    request: "Exporter",
    lane: "express",
  });
  await world.orchestrator.start();
  try {
    await settled(world, express.id);
    const prompts = world.log().filter((entry) => entry.kind === "prompt" && entry.nudge !== true);
    const review = String(prompts.find((entry) => entry.step === "review")?.message);
    assert.match(review, /## Voie express/);
    assert.match(review, /Un BLOQUANT est seulement/);
    assert.match(String(prompts.find((entry) => entry.step === "impl")?.message), /^Voie express : /m);

    const full = world.orchestrator.createRun({ repo: "demo", title: "Export JSON", request: "Exporter en JSON" });
    assert.equal(full.lane, "full");
    await settled(world, full.id);
    const reviews = world
      .log()
      .filter((entry) => entry.kind === "prompt" && entry.step === "review" && entry.nudge !== true);
    assert.doesNotMatch(String(reviews.at(-1)?.message), /## Voie express/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("voie-express/AC-3 : une seule correction en voie express (`lanes.expressFixCap`), puis l'humain ; la voie complète garde `review.fixCap`", async () => {
  const world = fakeWorld({ impl: [OK.impl], review: [BLOCKED], fix: [FIX] });
  assert.equal(fixCapFor(world.config, { lane: "express" }), 1);
  assert.equal(fixCapFor(world.config, { lane: "full" }), world.config.review.fixCap);
  assert.equal(fixCapFor(world.config, { lane: null }), world.config.review.fixCap);
  const run = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter", lane: "express" });
  await world.orchestrator.start();
  try {
    await settled(world, run.id);
    const after = world.store.getRun(run.id);
    assert.equal(after?.state, "awaiting_human", stateOf(world, run.id));
    assert.equal(after?.fixes, 1);
    assert.match(after?.reason ?? "", /plafond de corrections atteint \(1\)/);
    assert.deepEqual(
      world.store.listSteps(run.id).map((step) => step.kind),
      ["impl", "review", "fix", "review"],
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test('voie-express/AC-4 : `lanes.default: "express"` rend un run sans lane express ; `lane: "full"` le garde complet ; l\'irréversible, l\'autonomie ask et `specsGate: true` refusent l\'express et run_created dit pourquoi', () => {
  const world = fakeWorld({}, { patch: (config) => (config.lanes.default = "express") });
  const plain = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter" });
  assert.equal(plain.lane, "express");
  assert.equal(plain.step, "impl");
  const full = world.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter", lane: "full" });
  assert.equal(full.lane, "full");
  assert.equal(full.step, "req");

  const drop = world.orchestrator.createRun({
    repo: "demo",
    title: "Purge",
    request: "DROP TABLE users en production",
    lane: "express",
  });
  assert.equal(drop.lane, "full");
  assert.equal(drop.step, "req");
  assert.match(String(created(world, drop.id)?.laneRefused), /irréversible/);

  const ask = world.orchestrator.createRun({
    repo: "demo",
    title: "Export",
    request: "Exporter",
    lane: "express",
    autonomy: "ask",
  });
  assert.equal(ask.lane, "full");
  assert.match(String(created(world, ask.id)?.laneRefused), /tout me demander/);

  const gated = fakeWorld({}, { patch: (config) => (config.review.specsGate = true) });
  const held = gated.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter", lane: "express" });
  assert.equal(held.lane, "full");
  assert.match(String(created(gated, held.id)?.laneRefused), /specsGate/);

  const off = fakeWorld({}, { patch: (config) => (config.lanes.express = false) });
  const refused = off.orchestrator.createRun({ repo: "demo", title: "Export", request: "Exporter", lane: "express" });
  assert.equal(refused.lane, "full");
  assert.match(String(created(off, refused.id)?.laneRefused), /lanes\.express: false/);
});

test("voie-express/AC-5 : POST /v1/runs accepte lane express ; la configuration refuse un lanes.default ou un expressFixCap invalides", async () => {
  const world = fakeWorld({});
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/runs`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ repo: "demo", title: "Export CSV", request: "Exporter", lane: "express" }),
    });
    assert.equal(response.status, 201);
    const { run } = (await response.json()) as { run: { step: string; lane: string } };
    assert.deepEqual([run.step, run.lane], ["impl", "express"]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  Object.assign(world.config.lanes, { default: "rapide" });
  assert.throws(() => validateConfig(world.config), /lanes\.default/);
  Object.assign(world.config.lanes, { default: "auto", expressFixCap: -1 });
  assert.throws(() => validateConfig(world.config), /lanes\.expressFixCap/);
});

test("voie-express/AC-6 : la voie express est celle d'un run créé sans lane ; elle ne découpe jamais — split_feature est refusé en /impl, aucun projet ni run enfant n'est créé, et /impl reçoit la consigne de tout livrer", async () => {
  assert.equal(defaultConfig("/tmp/harness-unused").lanes.default, "express");
  const split = {
    tool: "split_feature",
    args: { features: [{ title: "Export JSON", request: "Exporter aussi en JSON", modules: ["docs"] }] },
  };
  const impl = [OK.impl[0], split, ...OK.impl.slice(1)];
  const world = fakeWorld(
    { impl: [impl], review: [OK.review] },
    { patch: (config) => (config.lanes.default = "express") },
  );
  const run = world.orchestrator.createRun({
    repo: "demo",
    title: "Export CSV",
    request: "Exporter les données en CSV.",
  });
  assert.equal(run.lane, "express");
  await world.orchestrator.start();
  try {
    await settled(world, run.id);
    const refused = world.log().find((entry) => entry.kind === "tool" && entry.tool === "split_feature");
    assert.match(String(refused?.result), /voie express : pas de découpage/);
    assert.equal(world.store.listProjects().length, 0);
    assert.deepEqual(
      world.store.listRuns({}).map((row) => row.id),
      [run.id],
    );
    const prompt = world
      .log()
      .find((entry) => entry.kind === "prompt" && entry.step === "impl" && entry.nudge !== true);
    assert.match(String(prompt?.message), /PAS de découpage/);
    assert.doesNotMatch(String(prompt?.message), /appelle `split_feature`/);
  } finally {
    await world.orchestrator.stop();
  }
});
