// Feature harness-audits : les propositions d'audit portent preuves, dépendances, impact et
// effort ; le lancement ordonne le projet selon les dépendances ; une analyse en échec repart une fois.
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { launchOrder, parseProposals } from "../../omp-harness/audits.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

const TOKEN = "t".repeat(64);

const BASE = { modules: ["src/db"], rationale: "lu dans le code", dependsOn: [], impact: "medium", effort: "low" };

const SCHEMA = { ...BASE, title: "Indexer le schéma", request: "Indexer les colonnes lues", kind: "feature", evidence: [] };
const TESTS = {
  ...BASE,
  title: "Tester le schéma",
  request: "Ajouter les tests du schéma",
  kind: "faiblesse",
  evidence: ["src/db/schema.ts:12"],
  dependsOn: ["Indexer le schéma"],
  impact: "high",
};

async function serve(world: FakeWorld): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function proposed(world: FakeWorld, id: string): Promise<void> {
  await waitFor(
    () => ["proposed", "failed"].includes(world.store.getAudit(id)?.state ?? ""),
    () => JSON.stringify(world.store.getAudit(id)),
  );
  assert.equal(world.store.getAudit(id)?.state, "proposed", world.store.getAudit(id)?.reason ?? "");
}

test("harness-audits/AC-1 : une faiblesse sans evidence, une dépendance inconnue, soi-même ou un cycle sont refusés", () => {
  const refused = parseProposals({ proposals: [{ ...TESTS, evidence: [] }] });
  assert.ok(!refused.ok);
  assert.match(refused.error, /faiblesse cite au moins un fichier:ligne/);
  assert.match(parseProposals({ proposals: [{ ...SCHEMA, impact: "énorme" }] }).ok ? "" : "impact", /impact/);
  const unknown = parseProposals({ proposals: [{ ...SCHEMA, dependsOn: ["Nulle part"] }] });
  assert.ok(!unknown.ok && /inconnue/.test(unknown.error));
  const self = parseProposals({ proposals: [{ ...SCHEMA, dependsOn: ["Indexer le schéma"] }] });
  assert.ok(!self.ok && /elle-même/.test(self.error));
  const cycle = parseProposals({ proposals: [{ ...SCHEMA, dependsOn: ["Tester le schéma"] }, TESTS] });
  assert.ok(!cycle.ok && /cycle/.test(cycle.error));
  // Les titres sont résolus en index ; les index sont acceptés tels quels.
  const ok = parseProposals({ proposals: [SCHEMA, { ...TESTS, dependsOn: [0, "Indexer le schéma"] }] });
  assert.ok(ok.ok);
  assert.deepEqual(
    ok.proposals.map((p) => [p.dependsOn, p.evidence, p.impact, p.effort]),
    [
      [[], [], "medium", "low"],
      [[0], ["src/db/schema.ts:12"], "high", "low"],
    ],
  );
  assert.deepEqual(launchOrder(ok.proposals, [1, 0]), [0, 1]);
  assert.deepEqual(launchOrder(ok.proposals, [1]), [1]);
  assert.equal(launchOrder([{ dependsOn: [1] }, { dependsOn: [0] }], [0, 1]), null);
});

test("harness-audits/AC-2 : les champs sont persistés, rendus par la vue, et le projet lancé suit les dépendances", async () => {
  // Le runner propose la faiblesse (qui dépend de la feature) AVANT la feature.
  const world = fakeWorld({
    audit: [[{ tool: "audit_propose", args: { proposals: [TESTS, SCHEMA] } }]],
    req: [[{ sleep: 60_000 }]],
  });
  await world.orchestrator.start();
  const server = await serve(world);
  try {
    const audit = world.orchestrator.audits.create("demo", "src/db");
    await proposed(world, audit.id);
    // Le prompt d'audit porte la section anti-doublons (vide ici : aucun run ouvert, aucun souvenir).
    assert.ok(world.oracle.queries.includes("feature mergée demo"));
    const response = await fetch(`${server.url}/v1/audits/${audit.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const view = (await response.json()) as {
      audit: { proposals: { title: string; evidence: string[]; dependsOn: number[]; impact: string; effort: string }[] };
    };
    assert.deepEqual(
      view.audit.proposals.map((p) => [p.title, p.evidence, p.dependsOn, p.impact, p.effort]),
      [
        ["Tester le schéma", ["src/db/schema.ts:12"], [1], "high", "low"],
        ["Indexer le schéma", [], [], "medium", "low"],
      ],
    );
    const { projectId } = await world.orchestrator.audits.launch(audit.id, [0, 1]);
    const runs = world.store.listRuns({ projectId });
    assert.deepEqual(
      runs.map((run) => [run.title, run.projectOrder]),
      [
        ["Indexer le schéma", 0],
        ["Tester le schéma", 1],
      ],
    );
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});

test("harness-audits/AC-3 : un runner d'audit qui plante est relancé une fois ; le second passage rend les propositions", async () => {
  const world = fakeWorld({
    audit: [
      [{ error: { message: "runner cassé", httpStatus: 400 } }],
      [{ tool: "audit_propose", args: { proposals: [SCHEMA] } }],
    ],
    req: [[{ sleep: 60_000 }]],
  });
  await world.orchestrator.start();
  try {
    const audit = world.orchestrator.audits.create("demo", "");
    await proposed(world, audit.id);
    assert.equal(world.log().filter((e) => e.kind === "prompt" && e.step === "audit").length, 2);
    assert.ok(world.store.eventsSince(0).some((e) => e.type === "audit_state" && e.payload.retry === true));
  } finally {
    await world.orchestrator.stop();
  }
  // Deux échecs de suite : l'audit finit `failed` avec la raison du runner.
  const broken = fakeWorld({ audit: [[{ error: { message: "runner cassé", httpStatus: 400 } }]] });
  await broken.orchestrator.start();
  try {
    const audit = broken.orchestrator.audits.create("demo", "");
    await waitFor(
      () => broken.store.getAudit(audit.id)?.state === "failed",
      () => JSON.stringify(broken.store.getAudit(audit.id)),
    );
    assert.match(broken.store.getAudit(audit.id)?.reason ?? "", /runner cassé/);
    assert.equal(broken.log().filter((e) => e.kind === "prompt" && e.step === "audit").length, 2);
  } finally {
    await broken.orchestrator.stop();
  }
});

test("harness-audits/AC-4 : le prompt d'audit nomme les runs ouverts et les features mergées du dépôt", async () => {
  const world = fakeWorld({ audit: [[{ tool: "audit_propose", args: { proposals: [] } }]], req: [[{ sleep: 60_000 }]] });
  world.oracle.memories = [
    { id: "m1", text: "Feature mergée « Export CSV » (abc) : export simple", score: 0.9, tags: ["harness"], createdAt: null },
  ];
  await world.orchestrator.start();
  try {
    world.orchestrator.createRun({ repo: "demo", title: "Import JSON", request: "importer du JSON", modules: ["src/io"] });
    const audit = world.orchestrator.audits.create("demo", "");
    await proposed(world, audit.id);
    const prompt = world.log().find((e) => e.kind === "prompt" && e.step === "audit");
    assert.match(String(prompt?.message), /ne propose pas de doublon/);
    assert.match(String(prompt?.message), /- Import JSON/);
    assert.match(String(prompt?.message), /Feature mergée « Export CSV »/);
  } finally {
    await world.orchestrator.stop();
  }
});
