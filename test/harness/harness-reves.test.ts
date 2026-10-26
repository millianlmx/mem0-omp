// Feature harness-reves : le rêve de la mémoire (phases 3 et 4). Un dépôt au repos dont
// la mémoire a assez de faits nouveaux est confié à un runner, qui consolide le dossier
// de mem0-rs en observations, causes et mental models par `dream_consolidate` ; le
// service mémoire valide, un refus revient au modèle qui corrige.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import { loadConfig, validateConfig, defaultConfig } from "../../omp-harness/config.ts";
import { dreamDue, parseConsolidation } from "../../omp-harness/dreams.ts";
import { createHandler } from "../../omp-harness/http.ts";
import type { DreamDossier } from "../../omp-harness/oracle.ts";
import { dreamPrompt } from "../../omp-harness/prompts.ts";
import { hostToolsFor } from "../../omp-harness/runner.ts";
import { fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const TOKEN = "t".repeat(64);
const HOUR = 3_600_000;

function dossier(facts: number, ageMs = 0): DreamDossier {
  const at = new Date(Date.now() - ageMs).toISOString();
  return {
    horizon_us: 1_700_000_000_000_000,
    since: null,
    due: facts > 0,
    new_facts: Array.from({ length: facts }, (_, i) => ({
      id: `f${i}`,
      memory: `Fait numéro ${i} : systemd-run confine chaque étape`,
      updated_at: at,
    })),
    context: [],
    observations: [],
    models: [{ name: "pieges", question: "Quels pièges ?", content: "", sources: [], stale: true }],
  };
}

const CONSOLIDATION = {
  observations: [{ text: "Chaque étape est confinée par systemd-run.", evidence: ["f0", "f1"] }],
  obsolete: [],
  causes: [{ source: "f0", target: "f1", reason: "le confinement a exposé le cgroup" }],
  models: [{ name: "pieges", content: "- cgroup délégué sous podman", sources: ["f1"] }],
};

/** Un monde dont l'oracle est déclaré et rend `facts` faits nouveaux ; les rêves sont examinés à chaque tour. */
function dreamWorld(scenario: Record<string, unknown>, facts = 6): FakeWorld {
  const world = fakeWorld(scenario, {
    patch: (config) => {
      config.oracle = { url: "http://127.0.0.1:9", token: null };
      config.dreams.checkMinutes = 0.0001;
    },
  });
  world.oracle.dossier = dossier(facts);
  return world;
}

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

async function settled(world: FakeWorld, states = ["done", "failed"]): Promise<void> {
  await waitFor(
    () => world.orchestrator.dreams.list().some((row) => states.includes(row.state)),
    () => JSON.stringify(world.orchestrator.dreams.list()),
  );
}

test("harness-reves/AC-1 : la forme de dream_consolidate et la règle du déclenchement", () => {
  const ok = parseConsolidation(CONSOLIDATION);
  assert.ok(ok.ok);
  assert.deepEqual(ok.consolidation.observations, [
    { text: "Chaque étape est confinée par systemd-run.", evidence: ["f0", "f1"] },
  ]);
  for (const faux of [
    { ...CONSOLIDATION, observations: [{ text: "x", evidence: [] }] },
    { ...CONSOLIDATION, observations: [{ text: " ", evidence: ["f0"] }] },
    { ...CONSOLIDATION, causes: [{ source: "f0" }] },
    { ...CONSOLIDATION, models: [{ name: "pieges", content: "", sources: [] }] },
    { observations: [], obsolete: [], causes: [] },
  ])
    assert.ok(!parseConsolidation(faux as Record<string, unknown>).ok, JSON.stringify(faux));

  const rules = { minFacts: 5, maxDelayHours: 24, requested: false };
  const now = Date.now();
  assert.match(dreamDue(dossier(0), rules, now) ?? "", /rien de nouveau/);
  assert.match(dreamDue(dossier(2), rules, now) ?? "", /2 fait\(s\) nouveau\(x\), en attente de 5 ou de 24 h/);
  assert.equal(dreamDue(dossier(5), rules, now), null);
  assert.equal(dreamDue(dossier(2, 25 * HOUR), rules, now), null, "un fait qui attend depuis 24 h suffit");
  assert.equal(dreamDue(dossier(1), { ...rules, requested: true }, now), null, "un rêve demandé passe sous le seuil");
  assert.match(dreamDue(dossier(0), { ...rules, requested: true }, now) ?? "", /rien de nouveau/);
});

test("harness-reves/AC-2 : un dépôt au repos rêve : prompt avec le dossier, consolidation transmise avec son horizon, worktree rendu", async () => {
  const world = dreamWorld({ reve: [[{ tool: "dream_consolidate", args: CONSOLIDATION }]] });
  await world.orchestrator.start();
  try {
    await settled(world);
    const [row] = world.orchestrator.dreams.list();
    assert.equal(row?.state, "done", row?.reason ?? "");
    assert.equal(row?.facts, 6);
    assert.equal(row?.report?.observations_added, 1);
    assert.deepEqual(world.oracle.dossiers[0], "demo-scope");
    const sent = world.oracle.consolidations[0];
    assert.equal(sent?.scope, "demo-scope");
    assert.equal(sent?.body.horizon_us, 1_700_000_000_000_000);
    assert.deepEqual(sent?.body.causes, CONSOLIDATION.causes);
    const prompt = world.log().find((e) => e.kind === "prompt" && e.step === "reve");
    assert.ok(String(prompt?.message).startsWith("# /reve — consolidation de la mémoire de « demo »"));
    assert.ok(String(prompt?.message).includes("Fait numéro 0"), "le dossier est dans le prompt");
    assert.ok(!String(prompt?.message).includes("horizon_us"), "l'horizon reste au harness");
    const events = world.store.eventsSince(0).filter((e) => e.type === "dream_state");
    assert.deepEqual(
      events.map((e) => e.payload.state),
      ["dreaming", "done"],
    );
    // Le worktree de rêve est rendu.
    const dir = path.join(world.config.worktreesDir, "demo");
    await waitFor(
      () => !fs.existsSync(dir) || fs.readdirSync(dir).every((name) => !name.startsWith("_dream-")),
      () => fs.readdirSync(dir).join(", "),
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-reves/AC-3 : une consolidation refusée revient au modèle avec sa raison ; il corrige et rappelle l'outil", async () => {
  const world = dreamWorld({
    reve: [
      [
        { tool: "dream_consolidate", args: { ...CONSOLIDATION, observations: [{ text: "x", evidence: [] }] } },
        { tool: "dream_consolidate", args: CONSOLIDATION },
      ],
    ],
  });
  await world.orchestrator.start();
  try {
    await settled(world);
    const tools = world.log().filter((e) => e.kind === "tool" && e.tool === "dream_consolidate");
    assert.equal(tools.length, 2);
    assert.match(String(tools[0]?.result), /consolidation refusée : observations\[0\]/);
    assert.equal(world.orchestrator.dreams.list()[0]?.state, "done");
    assert.equal(world.oracle.consolidations.length, 1);
  } finally {
    await world.orchestrator.stop();
  }

  // Un refus du service mémoire (ids inconnus…) revient aussi au modèle ; sans consolidation acceptée, le rêve échoue.
  const refused = dreamWorld({ reve: [[{ tool: "dream_consolidate", args: CONSOLIDATION }]] });
  refused.oracle.refuse = "mem0 422: evidence : f9 n'est pas un fait de la portée";
  await refused.orchestrator.start();
  try {
    await settled(refused);
    const row = refused.orchestrator.dreams.list()[0];
    assert.equal(row?.state, "failed");
    assert.match(row?.reason ?? "", /n'a pas été rendue/);
    const tool = refused.log().find((e) => e.kind === "tool" && e.tool === "dream_consolidate");
    assert.match(String(tool?.result), /refusée par le service mémoire : mem0 422/);
  } finally {
    await refused.orchestrator.stop();
  }
});

test("harness-reves/AC-4 : sous le seuil, rien ne part ; POST /v1/dreams demande un rêve qui passe le seuil", async () => {
  const world = dreamWorld({ reve: [[{ tool: "dream_consolidate", args: CONSOLIDATION }]] }, 2);
  await world.orchestrator.start();
  const server = await serve(world);
  try {
    await settled(world, ["skipped"]);
    assert.match(world.orchestrator.dreams.list()[0]?.reason ?? "", /en attente de 5/);
    assert.equal(world.spawned.length, 0, "aucun runner sans dossier dû");
    const response = await fetch(`${server.url}/v1/dreams`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "demo" }),
    });
    assert.equal(response.status, 202);
    await settled(world, ["done"]);
    const list = await fetch(`${server.url}/v1/dreams`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const body = (await list.json()) as { dreams: { repo: string; state: string }[] };
    assert.deepEqual(
      body.dreams.map((d) => [d.repo, d.state]),
      [["demo", "done"]],
    );
    const unknown = await fetch(`${server.url}/v1/dreams`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "nulle-part" }),
    });
    assert.equal(unknown.status, 404);
  } finally {
    await server.close();
    await world.orchestrator.stop();
  }
});

test("harness-reves/AC-5 : sans oracle, aucun rêve ; un dépôt qui a un run en cours n'est pas examiné", async () => {
  const sans = fakeWorld({ req: [[{ sleep: 60_000 }]] }, { patch: (config) => (config.dreams.checkMinutes = 0.0001) });
  sans.oracle.dossier = dossier(6);
  assert.throws(() => sans.orchestrator.dreams.request("demo"), /aucun service mémoire/);
  const busy = dreamWorld({ req: [[{ sleep: 60_000 }]], reve: [[{ tool: "dream_consolidate", args: CONSOLIDATION }]] });
  // Le run existe avant le premier tour : le dépôt n'est jamais au repos.
  await busy.orchestrator.createRun({ repo: "demo", title: "Long", request: "dure" });
  await sans.orchestrator.start();
  await busy.orchestrator.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(sans.oracle.dossiers, []);
    assert.deepEqual(busy.oracle.dossiers, [], "un dépôt occupé ne rêve pas");
  } finally {
    await sans.orchestrator.stop();
    await busy.orchestrator.stop();
  }
});

test("harness-reves/AC-6 : la configuration `dreams` est validée ; l'outil et le prompt du rêve", () => {
  const base = defaultConfig(tmpdir("harness-reves-"));
  assert.deepEqual(base.dreams, { checkMinutes: 60, minFacts: 5, maxDelayHours: 24, tier: "standard" });
  for (const [patch, message] of [
    [{ checkMinutes: 0 }, /dreams.checkMinutes/],
    [{ minFacts: 0 }, /dreams.minFacts/],
    [{ maxDelayHours: -1 }, /dreams.maxDelayHours/],
    [{ tier: "énorme" }, /dreams.tier/],
  ] as const) {
    const config = defaultConfig(tmpdir("harness-reves-"));
    Object.assign(config.dreams, patch);
    assert.throws(() => validateConfig(config), message);
  }
  const file = path.join(tmpdir("harness-reves-"), "config.json");
  fs.writeFileSync(file, JSON.stringify({ dreams: { checkMinutes: null } }));
  assert.equal(loadConfig(file).dreams.checkMinutes, null);
  assert.deepEqual(
    hostToolsFor("dream").map((t) => t.name),
    ["progress", "oracle_recall", "dream_consolidate"],
  );
  const prompt = dreamPrompt({ repo: "demo", dossier: dossier(1) as unknown as Record<string, unknown> });
  assert.ok(prompt.includes("dream_consolidate"));
  assert.ok(prompt.includes("LECTURE SEULE"));
});
