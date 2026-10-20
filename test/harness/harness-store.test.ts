// Feature harness-store : SQLite, source de vérité du harness — runs, étapes,
// décisions (checkpoints), escalades, journal d'événements rejouable, cache heavy.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { Store } from "../../omp-harness/db.ts";
import { tmpdir } from "../support/repo.ts";

function store(): Store {
  let clock = 1000;
  return new Store(path.join(tmpdir("harness-store-"), "h.sqlite"), () => clock++);
}

test("harness-store/AC-1 : la base se crée migrée, en WAL, et une réouverture garde les données sans remigrer", () => {
  const dir = tmpdir("harness-store-");
  const file = path.join(dir, "h.sqlite");
  const first = new Store(file);
  assert.equal(first.schemaVersion, 2);
  first.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  assert.equal((first.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  first.close();
  const again = new Store(file);
  assert.equal(again.getRun("r1")?.title, "A");
  assert.equal(again.schemaVersion, 2);
  again.close();
});

test("harness-store/AC-2 : un run naît en file à /req ; ses champs JSON (modules, verdict) font l'aller-retour", () => {
  const db = store();
  const run = db.createRun({
    id: "r1",
    repo: "demo",
    slug: "a",
    title: "A",
    request: "a",
    branch: "harness/a",
    modules: ["src/api"],
  });
  assert.equal(run.state, "queued");
  assert.equal(run.step, "req");
  assert.deepEqual(run.modules, ["src/api"]);
  const verdict = {
    risk: "low" as const,
    summary: "s",
    blockers: [],
    risks: [],
    files: ["x"],
    unverified: [],
    confidence: "strong" as const,
  };
  const updated = db.updateRun("r1", { state: "running", step: "review", verdict });
  assert.deepEqual(updated.verdict, verdict);
  assert.ok(updated.updatedAt > run.updatedAt);
  assert.equal(db.slugTaken("demo", "a"), true);
  assert.throws(
    () => db.createRun({ id: "r2", repo: "demo", slug: "a", title: "B", request: "b", branch: "harness/a" }),
    /UNIQUE/,
  );
});

test("harness-store/AC-3 : les décisions sont numérotées par run ; en renverser une rend caduques les suivantes", () => {
  const db = store();
  db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  const step = db.startStep("r1", "impl", 0, null, null);
  const decide = (question: string) =>
    db.addDecision({
      runId: "r1",
      stepId: step.id,
      question,
      options: ["x", "y"],
      chosen: "x",
      rationale: "r",
      category: "reversible",
      checkpointSha: null,
    });
  assert.deepEqual([decide("q1").seq, decide("q2").seq, decide("q3").seq], [1, 2, 3]);
  db.acceptDecision("r1", 1);
  db.reverseDecision("r1", 2, "y", "raison");
  assert.deepEqual(
    db.listDecisions({ runId: "r1" }).map((d) => d.status),
    ["accepted", "reversed", "superseded"],
  );
  assert.equal(db.getDecision("r1", 2)?.reversalReason, "raison");
});

test("harness-store/AC-4 : le journal d'événements notifie ses abonnés et se rejoue depuis un curseur, filtré par run", () => {
  const db = store();
  const seen: string[] = [];
  const off = db.onEvent((event) => seen.push(event.type));
  const a = db.appendEvent("x", "r1", { n: 1 });
  db.appendEvent("y", "r2");
  off();
  db.appendEvent("z", "r1");
  assert.deepEqual(seen, ["x", "y"]);
  assert.deepEqual(
    db.eventsSince(a.id).map((e) => e.type),
    ["y", "z"],
  );
  assert.deepEqual(
    db.eventsSince(0, "r1").map((e) => e.type),
    ["x", "z"],
  );
  assert.deepEqual(db.eventsSince(0, "r1")[0]?.payload, { n: 1 });
});

test("harness-store/AC-5 : au redémarrage, les étapes restées « running » sont marquées interrompues", () => {
  const db = store();
  db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  const step = db.startStep("r1", "impl", 0, "p/m", "omp-runner-r1-1");
  const interrupted = db.interruptRunningSteps();
  assert.deepEqual(
    interrupted.map((s) => s.unit),
    ["omp-runner-r1-1"],
  );
  assert.equal(db.getStep(step.id)?.status, "interrupted");
  assert.deepEqual(db.interruptRunningSteps(), []);
});

test("harness-store/AC-6 : le cache heavy est indexé par clé, et une transaction en échec ne laisse rien", () => {
  const db = store();
  db.cachePut({
    key: "k",
    repo: "demo",
    tree: "t",
    command: "c",
    outcome: "pass",
    exitCode: 0,
    output: "ok",
    durationMs: 5,
  });
  assert.equal(db.cacheGet("k")?.outcome, "pass");
  assert.equal(db.cacheGet("absent"), null);
  assert.throws(() =>
    db.transaction(() => {
      db.createRun({ id: "r9", repo: "demo", slug: "z", title: "Z", request: "z", branch: "b" });
      throw new Error("annulé");
    }),
  );
  assert.equal(db.getRun("r9"), null);
});

test("harness-store/AC-7 : une mise à jour conditionnelle n'écrase jamais un état changé entre-temps (annulation)", () => {
  const db = store();
  db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  db.updateRun("r1", { state: "cancelled" });
  assert.equal(db.updateRunIf("r1", ["queued"], { state: "running" }), null);
  assert.equal(db.getRun("r1")?.state, "cancelled");
  assert.equal(db.updateRunIf("r1", ["cancelled"], { reason: "vu" })?.reason, "vu");
});
