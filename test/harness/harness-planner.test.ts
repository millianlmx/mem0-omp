// Feature harness-planner : /project — modules touchés par feature (via l'oracle),
// les disjointes en parallèle, celles qui se chevauchent sérialisées.
import test from "node:test";
import assert from "node:assert/strict";
import { knownModules, modulesFromText, modulesViaOracle, overlaps, parseModulesSection, schedulable } from "../../omp-harness/planner.ts";
import { MemoryOracle, fakeWorld, waitFor } from "../support/harness-fixtures.ts";


test("harness-planner/AC-1 : deux ensembles se chevauchent par préfixe de chemin ; un ensemble inconnu chevauche tout", () => {
  assert.equal(overlaps(["src/api"], ["src/api/routes.ts"]), true);
  assert.equal(overlaps(["src/api"], ["src/apikeys"]), false);
  assert.equal(overlaps(["src/api"], ["src/db"]), false);
  assert.equal(overlaps([], ["src/db"]), true);
});


test("harness-planner/AC-2 : les features disjointes partent ensemble, une feature qui chevauche attend, et l'ordre du plan tient", () => {
  const started = schedulable(
    [
      { id: "a", modules: ["src/api"] },
      { id: "b", modules: ["src/db"] },
      { id: "c", modules: ["src/api/routes.ts"] },
      { id: "d", modules: ["docs"] },
    ],
    [{ id: "busy", modules: ["src/db/schema.ts"] }],
  );
  assert.deepEqual(started, ["a", "d"]);
});


test("harness-planner/AC-3 : les modules d'une feature se lisent dans son texte et dans les souvenirs de l'oracle", async () => {
  const known = knownModules(["src/api/routes.ts", "src/db/schema.ts", "README.md", "docs/guide.md"]);
  assert.deepEqual(known, ["README.md", "docs", "src", "src/api", "src/db"]);
  assert.deepEqual(modulesFromText("touche `src/api` et src/api/routes.ts", known), ["src/api"]);
  const oracle = new MemoryOracle();
  oracle.memories = [{ id: "1", text: "L'export vit dans src/db (décision du 3 mars).", score: 0.9 }];
  const result = await modulesViaOracle(oracle, "demo", "Ajouter un export dans src/api", known);
  assert.deepEqual(result.modules, ["src/api", "src/db"]);
  assert.deepEqual(parseModulesSection("## Modules\n- `src/api/`\n* docs\n## Découpage\n- pas ça\n"), ["src/api", "docs"]);
});


test("harness-planner/AC-4 : un /project lance en parallèle ses features disjointes et sérialise celle qui chevauche jusqu'à la fin de la précédente", async () => {
  const world = fakeWorld({ req: [[{ sleep: 60_000 }]] });
  const live = () => world.orchestrator.status().live as string[];
  try {
    const { projectId, runs } = await world.orchestrator.createProject({
      repo: "demo",
      title: "Export",
      features: [
        { title: "API export", request: "route d'export", modules: ["src/api"] },
        { title: "Docs export", request: "documenter", modules: ["docs"] },
        { title: "API pagination", request: "paginer", modules: ["src/api/routes.ts"] },
      ],
    });
    const [api, docs, pagination] = runs.map(run => run.id) as [string, string, string];
    await world.orchestrator.tick();
    assert.deepEqual(live().sort(), [api, docs].sort(), "les deux features disjointes partent ensemble");
    await waitFor(() => world.store.getRun(api)?.state === "running", () => String(world.store.getRun(api)?.state));
    await world.orchestrator.tick();
    assert.equal(world.store.getRun(pagination)?.state, "queued", "chevauche src/api : attend");
    // La feature qui occupait src/api se termine (ici : annulée) — la sérialisée part.
    await world.orchestrator.cancel(api);
    await world.orchestrator.tick();
    assert.ok(live().includes(pagination));
    assert.equal(world.store.getProject(projectId)?.status, "active");
  } finally {
    await world.orchestrator.stop();
  }
});
