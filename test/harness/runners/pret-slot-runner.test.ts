// Feature pret-slot-runner : un agent bloqué sur `run_tests` (file heavy, job, CI de la forge) prête son
// slot runner — il ne compte plus dans `scheduler.runner.used`, un autre run part pendant ce temps — et le
// reprend au retour de l'outil. Les process d'agents restent bornés à `runner.slots + runner.lendMax`.
import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, loadConfig } from "../../../omp-harness/config/config.ts";
import { Scheduler } from "../../../omp-harness/runners/scheduler.ts";
import type { Slot } from "../../../omp-harness/runners/scheduler.ts";
import { OK, fakeWorld, waitFor } from "../../support/harness-fixtures.ts";
import type { FakeWorld } from "../../support/harness-fixtures.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "../../support/repo.ts";

function scheduler(options: { runnerSlots?: number; lendMax?: number; lendAfterMs?: number } = {}): Scheduler {
  const config = defaultConfig("/tmp/harness-unused");
  return new Scheduler({
    runnerSlots: options.runnerSlots ?? 2,
    heavySlots: 1,
    runnerLendMax: options.lendMax ?? 1,
    lendAfterMs: options.lendAfterMs ?? 0,
    admission: config.admission,
    providers: {},
    memAvailableMiB: () => null,
    sleep: async () => {},
  });
}

function slot(value: Slot | { refused: string }): Slot {
  assert.ok(!("refused" in value), `slot refusé : ${JSON.stringify(value)}`);
  return value as Slot;
}

test("pret-slot-runner/AC-1 : un slot prêté ne compte plus, un autre run le prend ; la reprise passe outre la capacité, les process restent bornés à slots + lendMax", () => {
  const s = scheduler({ runnerSlots: 2, lendMax: 1 });
  const a = slot(s.tryAcquire("runner", "run-a"));
  slot(s.tryAcquire("runner", "run-b"));
  assert.equal("refused" in s.tryAcquire("runner", "run-c"), true);

  const reclaim = s.lend("runner", "run-a");
  assert.ok(reclaim);
  assert.deepEqual(s.snapshot().runner, { used: 1, capacity: 2, labels: ["run-b"], waiting: 0, lent: 1 });
  // Déjà prêté, ou inconnu : rien à prêter.
  assert.equal(s.lend("runner", "run-a"), null);
  assert.equal(s.lend("runner", "run-z"), null);

  // Le slot prêté laisse partir un run de plus — et pas deux : 2 slots + 1 prêté au plus.
  slot(s.tryAcquire("runner", "run-c"));
  assert.equal("refused" in s.tryAcquire("runner", "run-d"), true);
  // B prête à son tour : un slot se libère, mais 3 process d'agents tournent déjà (2 slots + 1 prêtable).
  const reclaimB = s.lend("runner", "run-b");
  assert.ok(reclaimB);
  const refused = s.tryAcquire("runner", "run-d");
  assert.equal("refused" in refused && refused.refused, "slots");
  assert.equal((refused as { detail: string }).detail, "process runner au plafond : 3/3 (2 slots + 1 prêtables)");
  reclaimB();

  // La reprise ne s'attend pas : l'agent repart, au-delà de la capacité ; personne d'autre n'entre.
  reclaim();
  reclaim();
  assert.deepEqual(s.snapshot().runner, {
    used: 3,
    capacity: 2,
    labels: ["run-a", "run-b", "run-c"],
    waiting: 0,
    lent: 0,
  });
  assert.equal("refused" in s.tryAcquire("runner", "run-d"), true);

  // Un slot rendu pendant son prêt (run arrêté) ne revient pas à la reprise.
  const again = s.lend("runner", "run-a");
  a.release();
  again?.();
  assert.deepEqual(s.snapshot().runner.labels, ["run-b", "run-c"]);
  assert.equal(s.snapshot().runner.lent, 0);
});

test("pret-slot-runner/AC-2 : lendDuring ne prête qu'une attente qui dure, prévient l'admission, et reprend le slot même si l'attente échoue ; lendMax 0 coupe le prêt", async () => {
  const s = scheduler({ runnerSlots: 1, lendMax: 1, lendAfterMs: 30 });
  const lent: string[] = [];
  s.onLend((kind) => lent.push(kind));
  slot(s.tryAcquire("runner", "run-a"));

  // Un résultat de cache rend avant le délai : aucun prêt.
  assert.equal(await s.lendDuring("runner", "run-a", Promise.resolve("cache")), "cache");
  assert.deepEqual(lent, []);

  let finish: (value: string) => void = () => {};
  const work = s.lendDuring("runner", "run-a", new Promise<string>((resolve) => (finish = resolve)));
  await waitFor(
    () => s.snapshot().runner.lent === 1,
    () => JSON.stringify(s.snapshot().runner),
    2000,
  );
  assert.deepEqual(lent, ["runner"]);
  assert.equal(s.snapshot().runner.used, 0);
  finish("vert");
  assert.equal(await work, "vert");
  assert.deepEqual(s.snapshot().runner, { used: 1, capacity: 1, labels: ["run-a"], waiting: 0, lent: 0 });

  let fail: (error: Error) => void = () => {};
  const failing = s.lendDuring("runner", "run-a", new Promise((_, reject) => (fail = reject)));
  await waitFor(
    () => s.snapshot().runner.lent === 1,
    () => JSON.stringify(s.snapshot().runner),
    2000,
  );
  fail(new Error("job heavy annulé"));
  await assert.rejects(failing, /job heavy annulé/);
  assert.equal(s.snapshot().runner.used, 1);

  const off = scheduler({ runnerSlots: 1, lendMax: 0 });
  slot(off.tryAcquire("runner", "run-a"));
  assert.equal(off.lend("runner", "run-a"), null);
});

async function until(world: FakeWorld, runId: string, states: string[]): Promise<void> {
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? ""),
    () => `${runId} : ${world.store.getRun(runId)?.state} — ${world.store.getRun(runId)?.reason}`,
    30_000,
  );
}

const AC =
  "\n\n## Critères d'acceptation\nAC-1 : Given des données, When l'export est demandé, Then un CSV est produit\n";

test("pret-slot-runner/AC-3 : pendant que l'étape d'un run attend son slot heavy, scheduler.runner.used ne le compte pas, un autre run part, et /v1/status dit pourquoi le suivant attend", async () => {
  const world = fakeWorld(
    { impl: [OK.impl], review: [OK.review] },
    {
      patch: (config) => {
        config.runner.slots = 1;
        config.runner.lendMax = 1;
        config.heavy.slots = 1;
      },
    },
  );
  // Le seul slot heavy est tenu ailleurs : le run_tests de /impl attendra.
  const blocker = slot(world.scheduler.tryAcquire("heavy", "ailleurs"));
  await world.orchestrator.start();
  try {
    const a = world.orchestrator.createRun({
      repo: "demo",
      title: "Export CSV",
      request: `Exporter en CSV${AC}`,
      modules: ["src/api"],
    });
    await waitFor(
      () => world.scheduler.snapshot().heavy.waiting === 1 && world.scheduler.snapshot().runner.lent === 1,
      () => JSON.stringify(world.scheduler.snapshot()),
    );
    const during = world.scheduler.snapshot().runner;
    assert.equal(during.used, 0);
    assert.ok(!during.labels.includes(a.id));

    // Le slot prêté laisse partir B, qui fait travailler son agent pendant que A attend ses tests.
    const b = world.orchestrator.createRun({
      repo: "demo",
      title: "Schéma",
      request: `Ajouter une table${AC}`,
      modules: ["src/db"],
    });
    await waitFor(
      () => world.scheduler.snapshot().runner.labels.includes(b.id),
      () => JSON.stringify(world.scheduler.snapshot()),
    );
    // C attend : 1 slot + 1 prêté, la borne est atteinte — et la file le dit.
    const c = world.orchestrator.createRun({
      repo: "demo",
      title: "Guide",
      request: `Documenter l'export${AC}`,
      modules: ["docs"],
    });
    await waitFor(
      () => world.orchestrator.withWait(world.store.getRun(c.id) as never).waitCause === "slots",
      () => JSON.stringify(world.orchestrator.queueWaits()),
    );
    const queue = (world.orchestrator.status() as { queue: ReturnType<FakeWorld["orchestrator"]["queueWaits"]> }).queue;
    assert.equal(queue.held, 1);
    assert.deepEqual(queue.byCause, { slots: 1 });
    assert.equal(queue.dominant?.cause, "slots");

    blocker.release();
    for (const run of [a, b, c]) await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(a.id)?.state, "merged");
    const after = world.scheduler.snapshot().runner;
    assert.deepEqual([after.used, after.lent], [0, 0]);
  } finally {
    await world.orchestrator.stop();
  }
});

test("pret-slot-runner/AC-4 : par défaut 3 slots heavy et 3 slots runner prêtables ; un lendMax négatif refuse la configuration", () => {
  const config = defaultConfig("/tmp/harness-unused");
  assert.equal(config.heavy.slots, 3);
  assert.equal(config.runner.lendMax, 3);
  const file = path.join(tmpdir("harness-lend-"), "config.json");
  fs.writeFileSync(file, JSON.stringify({ runner: { lendMax: -1 } }));
  assert.throws(() => loadConfig(file), /runner\.lendMax doit être un entier ≥ 0/);
});
