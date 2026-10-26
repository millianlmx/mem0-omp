// Feature harness-fairness : plusieurs projets et plusieurs dépôts en même temps sur
// un même serveur, sans qu'aucun ne prenne tout — admission équitable entre dépôts et
// projets, priorité, plafond par dépôt, file d'attente des tests dans l'ordre,
// merges sérialisés par dépôt, dépôts ajoutés à chaud.
import test from "node:test";
import assert from "node:assert/strict";
import { repoDefaults } from "../../omp-harness/config.ts";
import { defaultConfig } from "../../omp-harness/config.ts";
import { Scheduler } from "../../omp-harness/scheduler.ts";
import { Store } from "../../omp-harness/db.ts";
import type { Slot } from "../../omp-harness/scheduler.ts";
import { OK, fakeWorld, git, harnessRepo, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";

/** Un /req qui dure : le run garde son runner le temps du test. */
const HOLD = { req: [[{ sleep: 60_000 }]] };

function running(world: FakeWorld): string[] {
  return world.store
    .listRuns({ state: ["running"] })
    .map((run) => run.title)
    .sort();
}

test("harness-fairness/AC-1 : deux dépôts se partagent les runners — un gros arriéré sur l'un ne prive pas l'autre", async () => {
  const other = harnessRepo("harness-other-");
  const world = fakeWorld(HOLD, {
    patch: (config) => {
      config.runner.slots = 2;
      config.repos.push(repoDefaults({ name: "autre", path: other, scope: "autre-scope" }));
    },
  });
  try {
    // Trois features disjointes sur `demo`, créées AVANT celle d'`autre`.
    for (const [index, module] of ["src/api", "src/db", "docs"].entries()) {
      world.orchestrator.createRun({ repo: "demo", title: `demo-${index}`, request: "x", modules: [module] });
    }
    world.orchestrator.createRun({ repo: "autre", title: "autre-0", request: "y", modules: ["src/api"] });
    await world.orchestrator.start();
    await waitFor(
      () => running(world).length === 2,
      () => running(world).join(", "),
    );
    assert.deepEqual(running(world), ["autre-0", "demo-0"], "un runner par dépôt, pas deux pour le premier arrivé");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-fairness/AC-2 : la priorité passe devant l'ancienneté ; elle se change en cours de file", async () => {
  const world = fakeWorld(HOLD, { patch: (config) => (config.runner.slots = 1) });
  try {
    const old = world.orchestrator.createRun({ repo: "demo", title: "ancien", request: "x", modules: ["src/api"] });
    world.orchestrator.createRun({ repo: "demo", title: "urgent", request: "y", modules: ["src/db"], priority: 10 });
    await world.orchestrator.start();
    await waitFor(
      () => running(world).length === 1,
      () => running(world).join(", "),
    );
    assert.deepEqual(running(world), ["urgent"]);
    const bumped = await world.orchestrator.setPriority(old.id, 20, { by: "mac" });
    assert.equal(bumped.priority, 20);
    assert.ok(
      world.store.eventsSince(0, old.id).some((event) => event.type === "priority" && event.payload.by === "mac"),
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-fairness/AC-3 : `maxParallel` borne les runs vivants d'un dépôt, même quand des runners sont libres", async () => {
  const world = fakeWorld(HOLD, {
    patch: (config) => {
      config.runner.slots = 5;
      (config.repos[0] as { maxParallel: number | null }).maxParallel = 1;
    },
  });
  try {
    world.orchestrator.createRun({ repo: "demo", title: "a", request: "x", modules: ["src/api"] });
    world.orchestrator.createRun({ repo: "demo", title: "b", request: "y", modules: ["src/db"] });
    await world.orchestrator.start();
    await waitFor(
      () => running(world).length === 1,
      () => running(world).join(", "),
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(running(world).length, 1, "le second attend, alors que 4 runners sont libres");
    assert.equal(world.store.listRuns({ state: ["queued"] }).length, 1);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-fairness/AC-4 : les tests attendent leur slot heavy dans l'ordre — priorité, puis arrivée ; un nouveau venu ne double personne", async () => {
  const config = defaultConfig("/tmp/harness-unused");
  const scheduler = new Scheduler({
    runnerSlots: 1,
    heavySlots: 1,
    admission: config.admission,
    providers: {},
    memAvailableMiB: () => null,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
  });
  const first = (await scheduler.acquire("heavy", "premier")) as Slot;
  const served: Slot[] = [];
  for (const [label, priority] of [
    ["a", 0],
    ["b", 5],
    ["c", 0],
  ] as const) {
    void scheduler.acquire("heavy", label, undefined, priority).then((slot) => served.push(slot));
  }
  assert.equal(scheduler.waiting().heavy, 3);
  const controller = new AbortController();
  const abandoned = scheduler.acquire("heavy", "abandon", controller.signal);
  controller.abort();
  await assert.rejects(abandoned, /annulée/);
  first.release();
  for (let i = 0; i < 4; i++) {
    await waitFor(
      () => served.length > i,
      () => served.map((slot) => slot.label).join(", "),
    );
    // Un nouveau venu, arrivé pendant que la file se vide, passe derrière elle.
    if (i === 0) void scheduler.acquire("heavy", "d").then((slot) => served.push(slot));
    (served[i] as Slot).release();
  }
  assert.deepEqual(
    served.map((slot) => slot.label),
    ["b", "a", "c", "d"],
  );
  assert.equal(scheduler.waiting().heavy, 0);
});

test("harness-fairness/AC-5 : deux features du même dépôt validées en même temps mergent l'une après l'autre, sans course sur main", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const before = git(world.repo, "rev-parse", "main");
    // Deux modules disjoints : les deux runs avancent en parallèle jusqu'au merge.
    const { runs } = await world.orchestrator.createProject({
      repo: "demo",
      title: "Deux exports",
      features: [
        { title: "Export A", request: "a", modules: ["src/api"] },
        { title: "Export B", request: "b", modules: ["docs"] },
      ],
    });
    await waitFor(
      () =>
        runs.every((run) => ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? "")),
      () => runs.map((run) => `${world.store.getRun(run.id)?.state}/${world.store.getRun(run.id)?.reason}`).join(" ; "),
      60_000,
    );
    const states = runs.map((run) => world.store.getRun(run.id)?.state);
    assert.deepEqual(states, ["merged", "merged"]);
    const all = runs.flatMap((run) => world.store.eventsSince(0, run.id));
    assert.ok(!all.some((event) => event.type === "merge_retry"), "la file évite la course sur update-ref");
    // main reste linéaire : des squash l'un après l'autre, jamais de commit de fusion.
    assert.equal(git(world.repo, "rev-list", "--merges", "--count", `${before}..main`), "0");
    assert.equal(
      world.store.getProject(world.store.getRun(runs[0]?.id as string)?.projectId as string)?.status,
      "done",
    );
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-fairness/AC-6 : un dépôt ajouté à chaud (SIGHUP) sert tout de suite ; un dépôt retiré qui a des runs vivants est gardé", async () => {
  const world = fakeWorld(HOLD);
  await world.orchestrator.start();
  try {
    const live = world.orchestrator.createRun({ repo: "demo", title: "vivant", request: "x" });
    await waitFor(
      () => world.store.getRun(live.id)?.state === "running",
      () => String(world.store.getRun(live.id)?.state),
    );
    const other = harnessRepo("harness-hot-");
    const result = await world.orchestrator.reloadRepos([repoDefaults({ name: "nouveau", path: other })]);
    assert.deepEqual(result, { added: ["nouveau"], removed: [], kept: ["demo"] });
    assert.deepEqual(
      world.orchestrator.config.repos.map((repo) => repo.name),
      ["nouveau", "demo"],
    );
    assert.notEqual(world.orchestrator.config.repos[0]?.scope, "", "la scope du nouveau dépôt est calculée");
    const fresh = world.orchestrator.createRun({ repo: "nouveau", title: "à chaud", request: "y" });
    assert.equal(fresh.repo, "nouveau");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-fairness/AC-7 : des runs créés à la même milliseconde gardent leur ordre de création, quel que soit leur id", () => {
  const store = new Store(":memory:", () => 1_700_000_000_000);
  // Des ids qui trient à l'envers de la création : seul l'ordre d'insertion départage.
  const ids = ["rz", "rm", "ra"];
  for (const id of ids) {
    store.createRun({ id, repo: "demo", slug: id, title: id, request: id, branch: `b/${id}` });
  }
  assert.deepEqual(
    store.listRunsDue(Date.now()).map((run) => run.id),
    ids,
  );
  assert.deepEqual(
    store.listRuns({ state: ["queued"] }).map((run) => run.id),
    ids,
  );
});
