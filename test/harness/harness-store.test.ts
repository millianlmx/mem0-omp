// Feature harness-store : SQLite, source de vérité du harness — runs, étapes,
// décisions (checkpoints), escalades, journal d'événements rejouable, cache heavy.
import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, Store } from "../../omp-harness/db.ts";
import { tmpdir } from "../support/repo.ts";

function store(): Store {
  let clock = 1000;
  return new Store(path.join(tmpdir("harness-store-"), "h.sqlite"), () => clock++);
}

test("harness-store/AC-1 : la base se crée migrée, en WAL, et une réouverture garde les données sans remigrer", () => {
  const dir = tmpdir("harness-store-");
  const file = path.join(dir, "h.sqlite");
  const first = new Store(file);
  assert.equal(first.schemaVersion, MIGRATIONS.length);
  first.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "harness/a" });
  assert.equal((first.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  first.close();
  const again = new Store(file);
  assert.equal(again.getRun("r1")?.title, "A");
  assert.equal(again.schemaVersion, MIGRATIONS.length);
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
    criteria: [{ id: "AC-1", test: "test/x.test.ts", status: "pass" as const }],
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

test("harness-store/AC-3 : les décisions sont numérotées par run et gardent leurs dépendances ; en renverser une ne rend caduques que celles qu'on désigne", () => {
  const db = store();
  db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  const step = db.startStep("r1", "impl", 0, null, null);
  const decide = (question: string, dependsOn: number[] = []) =>
    db.addDecision({
      runId: "r1",
      stepId: step.id,
      question,
      options: ["x", "y"],
      chosen: "x",
      rationale: "r",
      category: "reversible",
      checkpointSha: null,
      dependsOn,
    });
  assert.deepEqual([decide("q1").seq, decide("q2").seq, decide("q3", [2]).seq, decide("q4").seq], [1, 2, 3, 4]);
  assert.deepEqual(db.getDecision("r1", 3)?.dependsOn, [2]);
  db.acceptDecision("r1", 1);
  db.reverseDecision("r1", 2, "y", "raison", [3]);
  assert.deepEqual(
    db.listDecisions({ runId: "r1" }).map((d) => d.status),
    ["accepted", "reversed", "superseded", "auto"],
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

test("harness-store/AC-8 : une base existante migre sans perte — la consigne `_resume.md` passe en colonne, chaque événement gagne son dépôt", () => {
  const file = path.join(tmpdir("harness-store-"), "h.sqlite");
  // Une base telle que la version 3 du schéma la laissait.
  const old = new DatabaseSync(file);
  for (const sql of MIGRATIONS.slice(0, 3)) old.exec(sql);
  old.exec("PRAGMA user_version = 3");
  old.exec(`INSERT INTO runs (id, repo, slug, title, request, state, step, branch, created_at, updated_at)
            VALUES ('r1', 'demo', 'a', 'A', 'a', 'escalated', 'impl', 'harness/a', 1, 1)`);
  old.exec(
    "INSERT INTO artifacts (run_id, name, content, updated_at) VALUES ('r1', '_resume.md', 'reprends ici', 1), ('r1', 'specs.md', 'S', 1)",
  );
  old.exec(
    `INSERT INTO events (at, run_id, type, payload) VALUES (1, 'r1', 'run_state', '{}'), (2, NULL, 'audit_state', '{"repo":"autre"}')`,
  );
  old.close();
  const db = new Store(file);
  assert.equal(db.schemaVersion, MIGRATIONS.length);
  assert.equal(db.instructions("r1"), "reprends ici");
  assert.deepEqual(
    db.listArtifacts("r1").map((artifact) => artifact.name),
    ["specs.md"],
  );
  assert.deepEqual(
    db.eventsSince(0).map((event) => event.repo),
    ["demo", "autre"],
  );
  const run = db.getRun("r1");
  assert.deepEqual([run?.priority, run?.rev, run?.createdBy], [0, 0, null]);
  // La révision monte à chaque écriture, et un CAS à une révision périmée n'écrit rien.
  assert.equal(db.updateRun("r1", { reason: "x" }).rev, 1);
  assert.equal(db.updateRunIf("r1", null, { reason: "y" }, 0), null);
  assert.equal(db.updateRunIf("r1", null, { reason: "y" }, 1)?.rev, 2);
  db.addInstructions("r1", "et ceci");
  assert.equal(db.instructions("r1"), "reprends ici\n\net ceci");
  db.close();
});

test("harness-store/AC-9 : la migration de l'autonomie est idempotente — un run ancien naît sans attente ni merge relancé, une escalade ancienne sans recommandation", () => {
  const file = path.join(tmpdir("harness-store-"), "h.sqlite");
  const old = new DatabaseSync(file);
  for (const sql of MIGRATIONS.slice(0, 5)) old.exec(sql);
  old.exec("PRAGMA user_version = 5");
  old.exec(`INSERT INTO runs (id, repo, slug, title, request, state, step, branch, created_at, updated_at)
            VALUES ('r1', 'demo', 'a', 'A', 'a', 'queued', 'impl', 'harness/a', 1, 1)`);
  old.exec(`INSERT INTO steps (run_id, kind, attempt, status, started_at) VALUES ('r1', 'impl', 0, 'running', 1)`);
  old.exec(`INSERT INTO escalations (run_id, step_id, category, question, options, context, status, created_at)
            VALUES ('r1', 1, 'schema', 'Q ?', '["a","b"]', 'ctx', 'open', 1)`);
  old.close();
  const db = new Store(file);
  assert.equal(db.schemaVersion, MIGRATIONS.length);
  const run = db.getRun("r1");
  assert.deepEqual([run?.notBefore, run?.mergeRetries, run?.lastFailCause, run?.lastReviewSha], [null, 0, null, null]);
  const [escalation] = db.listEscalations({ runId: "r1" });
  assert.deepEqual([escalation?.recommended, escalation?.answerReason], [null, null]);
  db.close();
  // Réouvrir ne remigre pas et garde tout.
  const again = new Store(file);
  assert.equal(again.schemaVersion, MIGRATIONS.length);
  assert.equal(again.listEscalations({ runId: "r1" }).length, 1);
  again.close();
});

test("harness-store/AC-10 : les nouvelles colonnes font l'aller-retour ; une cause d'échec inconnue en base se lit « other »", () => {
  const db = store();
  db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  const updated = db.updateRun("r1", {
    notBefore: 5000,
    mergeRetries: 2,
    lastFailCause: "rate_limit",
    lastReviewSha: "abc",
  });
  assert.deepEqual(
    [updated.notBefore, updated.mergeRetries, updated.lastFailCause, updated.lastReviewSha],
    [5000, 2, "rate_limit", "abc"],
  );
  db.db.exec("UPDATE runs SET last_fail_cause = 'martien' WHERE id = 'r1'");
  assert.equal(db.getRun("r1")?.lastFailCause, "other");
});

test("harness-store/AC-11 : listRunsDue ne rend que les runs en file dont l'heure est venue", () => {
  const db = store();
  for (const [id, state, notBefore] of [
    ["r1", "queued", null],
    ["r2", "queued", 50],
    ["r3", "queued", 500],
    ["r4", "running", null],
  ] as const) {
    db.createRun({ id, repo: "demo", slug: id, title: id, request: id, branch: id });
    db.updateRun(id, { state, notBefore });
  }
  assert.deepEqual(
    db.listRunsDue(100).map((run) => run.id),
    ["r1", "r2"],
  );
  assert.deepEqual(
    db.listRunsDue(1000).map((run) => run.id),
    ["r1", "r2", "r3"],
  );
});

test("harness-store/AC-12 : une escalade garde la recommandation de l'agent et la raison de l'humain ; les décisions prises seules (auto ou à l'échéance) s'acceptent d'un geste", () => {
  const db = store();
  db.createRun({ id: "r1", repo: "demo", slug: "a", title: "A", request: "a", branch: "b" });
  const step = db.startStep("r1", "impl", 0, null, null);
  const escalation = db.addEscalation({
    runId: "r1",
    stepId: step.id,
    category: "schema",
    question: "Q ?",
    options: ["a", "b"],
    context: "ctx",
    recommended: "a",
  });
  assert.equal(escalation.recommended, "a");
  db.answerEscalation(escalation.id, "b", "mac", "a casse l'index");
  const [answered] = db.listEscalations({ runId: "r1" });
  assert.deepEqual([answered?.answer, answered?.answerReason, answered?.answeredBy], ["b", "a casse l'index", "mac"]);
  // Sans recommandation ni raison : null, pas une chaîne vide.
  const bare = db.addEscalation({
    runId: "r1",
    stepId: step.id,
    category: "public_api",
    question: "?",
    options: [],
    context: "",
  });
  db.answerEscalation(bare.id, "x");
  assert.deepEqual([bare.recommended, db.listEscalations({ runId: "r1" })[1]?.answerReason], [null, null]);
  const decision = {
    runId: "r1",
    stepId: step.id,
    question: "?",
    options: ["x", "y"],
    chosen: "x",
    rationale: "r",
    category: "reversible" as const,
    checkpointSha: null,
    dependsOn: [],
  };
  db.addDecision(decision);
  db.addDecision(decision, "auto_timeout");
  db.addDecision(decision);
  db.acceptDecision("r1", 3, "mac");
  assert.deepEqual(
    db.listDecisions({ runId: "r1" }).map((d) => d.status),
    ["auto", "auto_timeout", "accepted"],
  );
  assert.equal(db.acceptAllDecisions("r1", "iphone"), 2);
  assert.deepEqual(
    db.listDecisions({ runId: "r1" }).map((d) => [d.status, d.decidedBy]),
    [
      ["accepted", "iphone"],
      ["accepted", "iphone"],
      ["accepted", "mac"],
    ],
  );
  assert.equal(db.acceptAllDecisions("r1", "iphone"), 0);
});
