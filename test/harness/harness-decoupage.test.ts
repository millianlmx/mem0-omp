// Feature harness-decoupage : un découpage (`## Découpage` des specs, `split_feature` en
// /impl) ne part qu'avec des specs ACCEPTÉES, et ses features attendent le MERGE de leur
// parent — annulé ou en échec, il les emporte. Faux runner : test/support/fake-omp-rpc.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { HarnessContext } from "../../omp-harness/context.ts";
import type { RunRow } from "../../omp-harness/db.ts";
import { crashed } from "../../omp-harness/machine.ts";
import type { Transition } from "../../omp-harness/machine.ts";

function specsWith(split: string): string {
  return `Ce que fait cette feature : exporter les données au format CSV.\n## Relevé du dépôt\n- src/api : routes\n## Non-objectifs\n## Spécifications\nS-1 (AC-1) : export CSV\n## Critères d'acceptation\nAC-1 (B-1) : Given des données, When l'export est demandé, Then un CSV est produit\n## Modules\n- src/api\n## Découpage\n${split}\n`;
}

// Les features découpées touchent d'autres modules que le parent : seul le préalable du merge les retient.
const FIRST = specsWith("- Export JSON — Exporter aussi en JSON — docs");
const FINAL = specsWith(
  "- Client web — Afficher l'export dans le client web — src/web\n- Doc de l'export — Documenter l'export — docs",
);
const SLEEP = [{ sleep: 60_000 }];

function describe(world: FakeWorld): string {
  return world.store
    .listRuns()
    .map((run) => `${run.title} : ${run.state}/${run.step} — ${run.reason}`)
    .join(" | ");
}

function childrenOf(world: FakeWorld, parentId: string): RunRow[] {
  return world.store.listRuns({ afterRun: parentId });
}

function started(world: FakeWorld, runId: string): boolean {
  return world.store.listSteps(runId).length > 0;
}

/** Le parent à la porte des specs ; `specsRuns` : le nombre de /specs déjà passés. */
async function atSpecsGate(world: FakeWorld, runId: string, specsRuns = 1): Promise<void> {
  await waitFor(
    () =>
      world.store.getRun(runId)?.state === "awaiting_human" &&
      world.store.listSteps(runId).filter((step) => step.kind === "specs" && step.status !== "running").length >=
        specsRuns,
    () => describe(world),
    30_000,
  );
}

async function inImpl(world: FakeWorld, runId: string): Promise<void> {
  await waitFor(
    () => world.store.listSteps(runId).some((step) => step.kind === "impl" && step.status === "running"),
    () => describe(world),
    30_000,
  );
}

/**
 * Le parent va jusqu'au merge, puis chaque feature découpée démarre : sa première étape
 * vient APRÈS le merge du parent dans le journal (sans le préalable, sur d'autres modules,
 * elle serait partie pendant son /impl).
 */
async function startAfterMerge(world: FakeWorld, parentId: string, children: RunRow[]): Promise<void> {
  await waitFor(
    () => world.store.getRun(parentId)?.state === "merged",
    () => describe(world),
    60_000,
  );
  const merged = world.store
    .eventsSince(0, parentId)
    .find((event) => event.type === "run_state" && event.payload.state === "merged");
  assert.ok(merged);
  await waitFor(
    () => children.every((child) => started(world, child.id)),
    () => describe(world),
    60_000,
  );
  for (const child of children) {
    const first = world.store.eventsSince(0, child.id).find((event) => event.type === "step_started");
    assert.ok(first && first.id > merged.id, `${child.title} a démarré avant le merge du parent`);
  }
}

const AUTO_GATE = { patch: (config: FakeWorld["config"]) => (config.review.specsGate = "auto") };

test("harness-decoupage/AC-1 : derrière la porte humaine, aucun run enfant avant la validation ; refusées puis refaites, les specs FINALES découpent", async () => {
  const splitTool = {
    tool: "split_feature",
    args: { features: [{ title: "Export JSON", request: "Exporter aussi en JSON", modules: ["docs"] }] },
  };
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [
        [{ write: ".harness/specs.md", content: FIRST }, splitTool],
        [{ write: ".harness/specs.md", content: FINAL }],
      ],
      impl: [SLEEP],
    },
    AUTO_GATE,
  );
  await world.orchestrator.start();
  try {
    const parent = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await atSpecsGate(world, parent.id);
    // Ni `## Découpage`, ni `split_feature` en /specs ne créent quoi que ce soit avant l'accord.
    assert.equal(world.store.listRuns().length, 1, describe(world));
    assert.equal(world.store.listProjects().length, 0);
    assert.equal(world.store.eventsSince(0, parent.id).filter((event) => event.type === "split").length, 0);

    await world.orchestrator.validate(parent.id, false, "le JSON n'est pas la bonne découpe", { by: "test" });
    await atSpecsGate(world, parent.id, 2);
    assert.equal(world.store.listRuns().length, 1, describe(world));
    assert.equal(world.store.listProjects().length, 0);

    await world.orchestrator.validate(parent.id, true, "", { by: "test" });
    const children = childrenOf(world, parent.id);
    assert.deepEqual(
      children.map((run) => [run.title, run.modules]),
      [
        ["Client web", ["src/web"]],
        ["Doc de l'export", ["docs"]],
      ],
    );
    assert.equal(world.store.listProjects().length, 1);
    const splits = world.store.eventsSince(0, parent.id).filter((event) => event.type === "split");
    assert.equal(splits.length, 1);
    assert.deepEqual(
      ((splits[0]?.payload.features ?? []) as { title: string }[]).map((feature) => feature.title),
      ["Client web", "Doc de l'export"],
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-decoupage/AC-2 : validées, les features naissent en file avec la raison, le lien vers le parent et ses specs gelées ; elles ne démarrent qu'après son merge", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [[{ write: ".harness/specs.md", content: FINAL }], OK.specs],
      impl: [OK.impl],
      review: [OK.review],
    },
    AUTO_GATE,
  );
  await world.orchestrator.start();
  try {
    const parent = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await atSpecsGate(world, parent.id);
    await world.orchestrator.validate(parent.id, true, "", { by: "test" });
    const children = childrenOf(world, parent.id);
    assert.equal(children.length, 2);
    for (const child of children) {
      assert.equal(child.state, "queued");
      assert.equal(child.afterRun, parent.id);
      assert.match(child.reason ?? "", /attend le merge de « Export CSV »/);
      // La demande porte le lien vers le parent et ses specs gelées, en citation : pas de voie directe sur ses critères.
      assert.ok(child.request.includes(parent.id), child.request);
      assert.ok(child.request.includes(parent.branch), child.request);
      assert.match(child.request, /^> S-1 \(AC-1\) : export CSV$/m);
      assert.match(child.request, /^> - Client web — /m);
      assert.equal(child.step, "req");
    }
    // Le client voit pourquoi elles attendent : la boîte les liste avec leur raison, `split` nomme le parent.
    const inbox = world.orchestrator.inboxView() as { runs: RunRow[] };
    for (const child of children) {
      const listed = inbox.runs.find((run) => run.id === child.id);
      assert.equal(listed?.afterRun, parent.id);
      assert.match(listed?.reason ?? "", /attend le merge/);
    }
    const split = world.store.eventsSince(0, parent.id).find((event) => event.type === "split");
    assert.equal(split?.payload.waitsFor, parent.id);
    assert.match(String(split?.payload.reason), /attend le merge de « Export CSV »/);

    await startAfterMerge(world, parent.id, children);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-decoupage/AC-3 : le parent annulé, ses features en attente sont annulées avec la raison et leur projet se clôt", async () => {
  const world = fakeWorld(
    { req: [OK.req], specs: [[{ write: ".harness/specs.md", content: FINAL }]], impl: [SLEEP] },
    AUTO_GATE,
  );
  await world.orchestrator.start();
  try {
    const parent = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await atSpecsGate(world, parent.id);
    await world.orchestrator.validate(parent.id, true, "", { by: "test" });
    await inImpl(world, parent.id);
    const children = childrenOf(world, parent.id);
    assert.equal(children.length, 2);

    await world.orchestrator.cancel(parent.id, { by: "test" });
    for (const child of childrenOf(world, parent.id)) {
      assert.equal(child.state, "cancelled", describe(world));
      assert.match(child.reason ?? "", /« Export CSV ».*a été annulé/);
      assert.equal(started(world, child.id), false);
    }
    const projectId = children[0]?.projectId as string;
    assert.equal(world.store.getProject(projectId)?.status, "done");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-decoupage/AC-4 : sans porte humaine, le découpage part à l'acceptation des specs (/specs → /impl) et attend le merge", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [[{ write: ".harness/specs.md", content: FINAL }], OK.specs],
    impl: [OK.impl],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const parent = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await inImpl(world, parent.id);
    const children = childrenOf(world, parent.id);
    assert.deepEqual(
      children.map((run) => [run.title, run.state, run.afterRun]),
      [
        ["Client web", "queued", parent.id],
        ["Doc de l'export", "queued", parent.id],
      ],
    );
    const split = world.store.eventsSince(0, parent.id).find((event) => event.type === "split");
    assert.deepEqual([split?.payload.step, split?.payload.by], ["specs", "specs"]);
    await startAfterMerge(world, parent.id, children);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-decoupage/AC-5 : `split_feature` en /impl crée des features qui attendent, elles aussi, le merge du parent", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [
        {
          tool: "split_feature",
          args: { features: [{ title: "Doc de l'export", request: "Documenter l'export", modules: ["docs"] }] },
        },
        ...OK.impl,
      ],
      OK.impl,
    ],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const parent = world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => childrenOf(world, parent.id).length === 1,
      () => describe(world),
      30_000,
    );
    const [child] = childrenOf(world, parent.id);
    assert.equal(child?.title, "Doc de l'export");
    assert.match(child?.reason ?? "", /attend le merge de « Export CSV »/);
    assert.ok(child?.request.includes(parent.id));
    const split = world.store.eventsSince(0, parent.id).find((event) => event.type === "split");
    assert.deepEqual([split?.payload.step, split?.payload.by, split?.payload.waitsFor], ["impl", "runner", parent.id]);
    await startAfterMerge(world, parent.id, [child as RunRow]);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-decoupage/AC-6 : un parent en échec annule ses features en attente ; mergé, il les libère", () => {
  const world = fakeWorld({});
  const ctx = new HarnessContext(world.deps);
  const childOf = (parent: RunRow, id: string): RunRow =>
    world.store.createRun({
      id,
      repo: "demo",
      slug: id,
      title: id,
      request: id,
      branch: `harness/${id}`,
      afterRun: parent.id,
      reason: `attend le merge de « ${parent.title} »`,
    });
  const move = (run: RunRow, state: Transition["state"], from: Transition["state"]): RunRow =>
    ctx.transition(
      run,
      {
        state,
        step: run.step,
        fixes: 0,
        attempts: 0,
        keepRunner: false,
        rebase: false,
        notBefore: null,
        reason: state,
      },
      [from],
    ) as RunRow;

  const failing = world.orchestrator.createRun({ repo: "demo", title: "Panne", request: "Panne" });
  const orphan = childOf(failing, "orpheline");
  ctx.transition(failing, crashed(failing, "worktree perdu"), ["queued"]);
  assert.equal(world.store.getRun(orphan.id)?.state, "cancelled");
  assert.match(world.store.getRun(orphan.id)?.reason ?? "", /« Panne ».*a échoué/);

  const landing = world.orchestrator.createRun({ repo: "demo", title: "Socle", request: "Socle" });
  const waiting = childOf(landing, "suivante");
  const merged = move(move(move(landing, "running", "queued"), "merging", "running"), "merged", "merging");
  assert.equal(merged.state, "merged");
  const released = world.store.getRun(waiting.id);
  assert.equal(released?.state, "queued");
  assert.match(released?.reason ?? "", /« Socle » mergé/);
});
