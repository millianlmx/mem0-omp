// Feature set-modules-refuse-les-artefacts : `.harness/` (artefacts d'étape, hors git) n'est jamais
// un module. `set_modules` refuse tout chemin qui s'y trouve ; `## Modules` des specs et les
// `modules` d'un `split_feature` l'ignorent ; le prompt dit à l'agent de n'y mettre que des chemins du dépôt.
import test from "node:test";
import assert from "node:assert/strict";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { parseModulesSection } from "../../omp-harness/planner.ts";
import { parseSplitFeatures } from "../../omp-harness/host-tools.ts";
import { parseSplitSection } from "../../omp-harness/steps.ts";
import { stepPrompt } from "../../omp-harness/prompts.ts";
import type { PromptContext } from "../../omp-harness/prompts.ts";

const SEEDED = ["docs"];

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

function modulesEvents(world: FakeWorld, runId: string) {
  return world.store.eventsSince(0, runId).filter((event) => event.type === "modules");
}

/** Un run posé avec `docs` ; /req appelle `set_modules` avec `paths`, puis /specs attend : tout /req est observable. */
async function callSetModulesInReq(paths: string[]) {
  const world = fakeWorld({
    req: [[{ tool: "set_modules", args: { paths } }, ...OK.req]],
    specs: [[{ sleep: 60_000 }]],
  });
  await world.orchestrator.start();
  const run = await world.orchestrator.createRun({
    repo: "demo",
    title: "Export CSV",
    request: "Exporter en CSV",
    modules: SEEDED,
  });
  await waitFor(
    () => world.log().some((entry) => entry.kind === "prompt" && entry.step === "specs"),
    () => stateOf(world, run.id),
  );
  const call = world.log().find((entry) => entry.kind === "tool" && entry.tool === "set_modules");
  return { world, run, call };
}

test("set-modules-refuse-les-artefacts/AC-1 : set_modules sur `.harness/req.md` seul → isError, modules du run inchangés, aucun événement `modules`", async () => {
  const { world, run, call } = await callSetModulesInReq([".harness/req.md"]);
  try {
    assert.equal(call?.isError, true);
    assert.match(String(call?.result), /^set_modules refusé : \.harness\/req\.md est sous `\.harness\/`/);
    assert.deepEqual(world.store.getRun(run.id)?.modules, SEEDED);
    assert.equal(modulesEvents(world, run.id).length, 0);
  } finally {
    await world.orchestrator.stop();
  }
});

test("set-modules-refuse-les-artefacts/AC-2 : une liste mixte (chemin du dépôt + `.harness/specs.md`) est refusée entière, jamais filtrée", async () => {
  const { world, run, call } = await callSetModulesInReq(["omp-harness/x.ts", ".harness/specs.md"]);
  try {
    assert.equal(call?.isError, true);
    assert.match(String(call?.result), /\.harness\/specs\.md est sous/);
    assert.deepEqual(world.store.getRun(run.id)?.modules, SEEDED);
    assert.equal(modulesEvents(world, run.id).length, 0);
  } finally {
    await world.orchestrator.stop();
  }
});

test("set-modules-refuse-les-artefacts/AC-3 : set_modules sur un chemin du dépôt est accepté (non-régression)", async () => {
  const { world, run, call } = await callSetModulesInReq(["omp-harness/x.ts"]);
  try {
    assert.equal(call?.isError, undefined);
    assert.equal(call?.result, "modules du run : omp-harness/x.ts");
    assert.deepEqual(world.store.getRun(run.id)?.modules, ["omp-harness/x.ts"]);
    assert.deepEqual(
      modulesEvents(world, run.id).map((event) => event.payload.modules),
      [["omp-harness/x.ts"]],
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("set-modules-refuse-les-artefacts/AC-4 : des specs dont `## Modules` ne liste que `.harness/…` laissent les modules du run inchangés à la fin de /specs", async () => {
  const onlyArtifacts = (OK.specs[0]?.content ?? "").replace(
    "## Modules\n- src/api\n",
    "## Modules\n- .harness/req.md\n- `./.harness/specs.md`\n",
  );
  assert.match(onlyArtifacts, /- \.harness\/req\.md/);
  const world = fakeWorld(
    { req: [OK.req], specs: [[{ write: ".harness/specs.md", content: onlyArtifacts }]] },
    { patch: (config) => (config.runner.stepRetries = 0) },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: "Exporter en CSV",
      modules: SEEDED,
    });
    await waitFor(
      () => ["failed", "awaiting_human", "escalated"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => stateOf(world, run.id),
    );
    // Les specs sans module du dépôt ne passent pas la validation de l'étape : l'agent est relancé…
    const nudge = world.log().find((entry) => entry.kind === "prompt" && entry.nudge === true);
    assert.match(String(nudge?.message), /`## Modules` de specs\.md est vide/);
    // … et le run garde ses modules.
    assert.deepEqual(world.store.getRun(run.id)?.modules, SEEDED);
    assert.equal(modulesEvents(world, run.id).length, 0);
  } finally {
    await world.orchestrator.stop();
  }
});

test("set-modules-refuse-les-artefacts/attendu-modules : parseModulesSection et `## Découpage` ignorent `.harness/`, le reste est gardé", () => {
  const specs =
    "## Modules\n- .harness\n- `.harness/req.md`\n- ./.harness/specs.md\n- src/api\n- docs/\n## Découpage\naucun\n";
  assert.deepEqual(parseModulesSection(specs), ["src/api", "docs"]);
  assert.deepEqual(parseModulesSection("## Modules\n- .harness/req.md\n"), []);
  // Un nom qui ressemble seulement à `.harness` reste un chemin du dépôt.
  assert.deepEqual(parseModulesSection("## Modules\n- .harness-tools/x.ts\n"), [".harness-tools/x.ts"]);

  const split =
    "## Découpage\n- Export JSON — Exporter en JSON — .harness/specs.md, src/api, ./.harness/req.md\n- Export XML — Exporter en XML — .harness/req.md\n";
  assert.deepEqual(parseSplitSection(split), [
    { title: "Export JSON", request: "Exporter en JSON", modules: ["src/api"] },
    { title: "Export XML", request: "Exporter en XML", modules: [] },
  ]);
});

test("set-modules-refuse-les-artefacts/attendu-split : les `modules` d'un split_feature ignorent `.harness/`", () => {
  assert.deepEqual(
    parseSplitFeatures([
      { title: "A", request: "a", modules: [".harness/specs.md", "./src/x/", ".harness"] },
      { title: "B", request: "b", modules: [".harness/req.md"] },
    ]),
    {
      ok: true,
      features: [
        { title: "A", request: "a", modules: ["src/x"] },
        { title: "B", request: "b", modules: [] },
      ],
    },
  );
});

test("set-modules-refuse-les-artefacts/attendu : le prompt de /req présente set_modules avec les chemins du dépôt, jamais les fichiers de `.harness/`", () => {
  const ctx: PromptContext = {
    step: "req",
    title: "Export CSV",
    request: "Exporter les données",
    baseSha: "abc123",
    maxDiffLines: 300,
    memories: "",
    blockers: [],
    previousVerdict: null,
    sinceSha: null,
    previousBlockers: [],
    resume: null,
    decisions: [],
    conflicts: [],
    specsDrift: [],
    direct: false,
  };
  assert.match(
    stepPrompt(ctx),
    /`set_modules` dès que tu connais les chemins que le travail touchera : les chemins du DÉPÔT que la feature touchera, jamais les fichiers de `\.harness\/`/,
  );
});
