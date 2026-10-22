// Feature harness-gestures : la boucle humaine quand l'humain n'est pas là — l'échéance
// des escalades tranche par l'option recommandée (jamais une suppression), un run
// échoué se relance, les décisions prises seules s'acceptent d'un geste, un renversement
// ne défait que les commits de la décision (ou revient au checkpoint si le revert
// entre en conflit), et l'inbox ne compte que ce qui bloque.
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { OK, fakeWorld, git, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { HarnessError } from "../../omp-harness/errors.ts";
import { Store } from "../../omp-harness/db.ts";
import { inboxOf } from "../../omp-harness/queries.ts";
import { tmpdir } from "../support/repo.ts";

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

async function until(world: FakeWorld, runId: string, states: string[], timeoutMs = 30_000): Promise<void> {
  await waitFor(
    () => states.includes(world.store.getRun(runId)?.state ?? ""),
    () => stateOf(world, runId),
    timeoutMs,
  );
}

function decide(question: string, options: string[], dependsOn: number[] = []) {
  return {
    tool: "decision",
    args: { question, options, chosen: options[0], rationale: "le plus réversible", category: "reversible", dependsOn },
  };
}

function escalate(question: string, category: "schema" | "deletion", options = ["ajouter une colonne", "table séparée"]) {
  return { tool: "decision", args: { question, options, chosen: options[0], rationale: "simple", category } };
}

const MEDIUM_REVIEW = [
  { tool: "run_tests", args: { scope: "full" } },
  {
    tool: "review_verdict",
    args: {
      risk: "medium",
      summary: "export ok",
      blockers: [],
      risks: ["volumétrie"],
      files: ["src/api/export.ts"],
      unverified: [],
      confidence: "strong",
      criteria: [{ id: "AC-1", test: "export", status: "pass" }],
    },
  },
];

/** Un verdict « medium » attend l'humain : seul le risque faible s'auto-merge. */
function gated(config: HarnessConfig): void {
  config.review.autoMergeRisk = "low";
}

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    if (err instanceof HarnessError) return err.status;
    throw err;
  }
}

test("harness-gestures/AC-1 : passé l'échéance, une escalade ouverte est tranchée par l'option recommandée — décision auto_timeout, consigne au run, souvenir, reprise ; jamais avant l'échéance", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[escalate("Où stocker la date d'export ?", "schema"), ...OK.impl], OK.impl],
      review: [OK.review],
    },
    { patch: (config) => void (config.review.escalationTimeoutSec = 1) },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await until(world, run.id, ["escalated", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "escalated", stateOf(world, run.id));
    assert.equal(world.store.listDecisions({ runId: run.id }).length, 0, "rien n'est tranché avant l'échéance");
    const open = world.store.listEscalations({ runId: run.id, status: "open" });
    assert.equal(open[0]?.recommended, "ajouter une colonne");

    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const decisions = world.store.listDecisions({ runId: run.id });
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.status, "auto_timeout");
    assert.equal(decisions[0]?.chosen, "ajouter une colonne");
    assert.equal(decisions[0]?.category, "schema");
    assert.match(decisions[0]?.rationale ?? "", /échéance de 1 s sans réponse humaine/);
    assert.ok(decisions[0]?.checkpointSha, "la décision à l'échéance a son checkpoint");
    const answered = world.store.listEscalations({ runId: run.id, status: "answered" })[0];
    assert.equal(answered?.answer, "ajouter une colonne");
    assert.equal(answered?.answeredBy, null);
    assert.match(answered?.answerReason ?? "", /échéance/);
    const event = world.store.eventsSince(0, run.id).find((e) => e.type === "decision_auto_timeout");
    assert.equal(event?.payload.chosen, "ajouter une colonne");
    assert.equal(event?.payload.seq, 1);
    const resumed = world
      .log()
      .filter((e) => e.kind === "prompt" && e.step === "impl")
      .pop();
    assert.match(String(resumed?.message), /Où stocker la date d'export \? → ajouter une colonne \(à l'échéance\)/);
    const memory = world.oracle.retained.find((m) => m.tags.includes("auto_timeout"));
    assert.ok(memory, "le souvenir de l'auto-décision");
    assert.match(memory?.text ?? "", /tranchée à l'échéance/);
    assert.match(memory?.text ?? "", /Options : ajouter une colonne \| table séparée/);
    assert.deepEqual(memory?.tags, ["harness", "decision", "auto_timeout"]);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-2 : sans échéance (null), une escalade attend l'humain indéfiniment", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[escalate("Où stocker la date d'export ?", "schema"), ...OK.impl], OK.impl],
      review: [OK.review],
    },
    { patch: (config) => void (config.review.escalationTimeoutSec = null) },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await until(world, run.id, ["escalated", "merged", "failed"]);
    // Des tours d'horloge entiers : l'échéance nulle n'y tranche rien.
    for (let i = 0; i < 3; i += 1) await world.orchestrator.tick();
    assert.equal(world.store.getRun(run.id)?.state, "escalated", stateOf(world, run.id));
    assert.equal(world.store.listDecisions({ runId: run.id }).length, 0);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-3 : une suppression n'est jamais tranchée à l'échéance ; la réponse humaine, avec sa raison, est stockée et retourne à l'oracle avec options et contexte", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [
        [
          escalate("Où stocker la date d'export ?", "schema"),
          escalate("Purger l'historique ?", "deletion", ["non", "oui"]),
          ...OK.impl,
        ],
        OK.impl,
      ],
      review: [OK.review],
    },
    { patch: (config) => void (config.review.escalationTimeoutSec = 1) },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await until(world, run.id, ["escalated", "merged", "failed"]);
    // L'échéance tranche le schéma, pas la suppression : le run attend toujours.
    await waitFor(
      () => world.store.listDecisions({ runId: run.id, status: ["auto_timeout"] }).length === 1,
      () => stateOf(world, run.id),
    );
    await world.orchestrator.tick();
    assert.equal(world.store.getRun(run.id)?.state, "escalated", stateOf(world, run.id));
    const open = world.store.listEscalations({ runId: run.id, status: "open" });
    assert.deepEqual(
      open.map((item) => item.category),
      ["deletion"],
    );

    const deletion = open[0];
    assert.ok(deletion);
    await world.orchestrator.answerEscalations(
      run.id,
      [{ id: deletion.id, answer: "non", reason: "l'historique sert aux audits" }],
      { by: "mac" },
    );
    const answered = world.store.listEscalations({ runId: run.id, status: "answered" }).find((i) => i.id === deletion.id);
    assert.equal(answered?.answer, "non");
    assert.equal(answered?.answerReason, "l'historique sert aux audits");
    assert.equal(answered?.answeredBy, "mac");
    const event = world.store
      .eventsSince(0, run.id)
      .find((e) => e.type === "escalation_answered" && e.payload.id === deletion.id);
    assert.equal(event?.payload.reason, "l'historique sert aux audits");
    assert.equal(event?.payload.by, "mac");
    const memory = world.oracle.retained.find((m) => /Purger l'historique/.test(m.text) && m.tags.includes("deletion"));
    assert.ok(memory, "le souvenir de la réponse humaine");
    assert.match(memory?.text ?? "", /l'historique sert aux audits/);
    assert.match(memory?.text ?? "", /non/);
    assert.match(memory?.text ?? "", /oui/, "les options sont dans le souvenir");

    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const resumed = world
      .log()
      .filter((e) => e.kind === "prompt" && e.step === "impl")
      .pop();
    assert.match(String(resumed?.message), /Purger l'historique \? → non$/m);
    assert.match(String(resumed?.message), /ajouter une colonne \(à l'échéance\)/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-4 : une décision prise à l'échéance se renverse comme les autres (rework, l'option s'applique par-dessus)", async () => {
  const world = fakeWorld(
    {
      req: [OK.req],
      specs: [OK.specs],
      impl: [[escalate("Où stocker la date d'export ?", "schema"), ...OK.impl], OK.impl],
      review: [MEDIUM_REVIEW, OK.review],
      fix: [OK.impl],
    },
    {
      patch: (config) => {
        gated(config);
        config.review.escalationTimeoutSec = 1;
      },
    },
  );
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export daté", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    assert.equal(world.store.getDecision(run.id, 1)?.status, "auto_timeout");
    await world.orchestrator.reverseDecision(run.id, 1, "table séparée", "la table principale est déjà large");
    assert.equal(world.store.getDecision(run.id, 1)?.status, "reversed");
    const reversed = world.store.eventsSince(0, run.id).find((e) => e.type === "decision_reversed");
    assert.equal(reversed?.payload.mode, "rework");
    await until(world, run.id, ["merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const fix = world.log().find((e) => e.kind === "prompt" && e.step === "fix");
    assert.match(String(fix?.message), /remplace « ajouter une colonne » par « table séparée »/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-5 : relancer — 200 sur un run échoué (même étape, tout de suite), 200 sur un run en attente, 409 sur un run qui tourne ou mergé", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [OK.impl],
    review: [MEDIUM_REVIEW, OK.review],
  }, { patch: gated });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export relancé", request: "Exporter" });
    await until(world, run.id, ["running", "awaiting_human", "merged", "failed"]);
    assert.equal(await status(world.orchestrator.retry(run.id)), 409, "un run qui tourne ne se relance pas");

    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    // L'attente humaine du verdict : la relance refait la revue, puis le verdict vert merge.
    const relaunched = await world.orchestrator.retry(run.id, { by: "iphone" });
    assert.equal(relaunched.state, "queued");
    assert.equal(relaunched.step, "review");
    assert.equal(relaunched.attempts, 0);
    const event = world.store.eventsSince(0, run.id).find((e) => e.type === "retried");
    assert.equal(event?.payload.from, "awaiting_human");
    assert.equal(event?.payload.by, "iphone");
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    assert.equal(await status(world.orchestrator.retry(run.id)), 409, "un run mergé ne se relance pas");

    // Un run échoué : la relance le remet en file à son étape, tentatives à zéro.
    const failed = await world.orchestrator.createRun({ repo: "demo", title: "Export échoué", request: "Exporter" });
    await until(world, failed.id, ["running", "awaiting_human", "merged", "failed"]);
    await world.orchestrator.cancel(failed.id);
    assert.equal(await status(world.orchestrator.retry(failed.id)), 409, "un run annulé ne se relance pas");
    world.store.updateRun(failed.id, { state: "failed", step: "impl", attempts: 2, reason: "runner mort" });
    const again = await world.orchestrator.retry(failed.id);
    assert.equal(again.state, "queued");
    assert.equal(again.step, "impl");
    assert.equal(again.attempts, 0);
    assert.equal(again.notBefore, null);
    await world.orchestrator.cancel(failed.id);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-6 : « tout accepter » passe les décisions auto et auto_timeout du run en accepted, un événement par décision", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[decide("Séparateur CSV ?", ["virgule", "point-virgule"]), decide("Nom ?", ["a.csv", "b.csv"]), ...OK.impl]],
    review: [MEDIUM_REVIEW],
  }, { patch: gated });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export accepté", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    assert.equal(world.store.listDecisions({ runId: run.id, status: ["auto", "auto_timeout"] }).length, 2);
    const result = await world.orchestrator.acceptAllDecisions(run.id, { by: "mac" });
    assert.deepEqual(result, { accepted: 2 });
    assert.deepEqual(
      world.store.listDecisions({ runId: run.id }).map((d) => [d.status, d.decidedBy]),
      [
        ["accepted", "mac"],
        ["accepted", "mac"],
      ],
    );
    assert.deepEqual(
      world.store
        .eventsSince(0, run.id)
        .filter((e) => e.type === "decision_accepted")
        .map((e) => e.payload.seq),
      [1, 2],
    );
    assert.deepEqual(inboxOf(world.store).decisions, []);
    assert.deepEqual(await world.orchestrator.acceptAllDecisions(run.id), { accepted: 0 }, "rien de plus à accepter");
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-7 : si le revert des commits de la décision entre en conflit, retour dur au checkpoint — tout le travail postérieur est annulé, les indépendantes sont réappliquées par consigne", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [
      [
        decide("Séparateur CSV ?", ["virgule", "point-virgule"]),
        { write: "src/api/separator.ts", content: "export const SEP = ',';\n" },
        decide("Échappement des guillemets ?", ["doublés", "antislash"], [1]),
        { write: "src/api/separator.ts", content: "export const SEP = ',';\nexport const QUOTE = '\"\"';\n" },
        decide("Nom du fichier ?", ["export.csv", "donnees.csv"]),
        // Le même fichier est retouché après la plage : le revert ne peut pas s'appliquer proprement.
        { write: "src/api/separator.ts", content: "export const SEP = ';';\nexport const QUOTE = '\"\"';\n" },
        ...OK.impl,
      ],
      OK.impl,
    ],
    review: [MEDIUM_REVIEW, OK.review],
  }, { patch: gated });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export séparateur", request: "Exporter" });
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    assert.equal(world.store.getRun(run.id)?.state, "awaiting_human", stateOf(world, run.id));
    const worktree = world.store.getRun(run.id)?.worktree;
    assert.ok(worktree);
    await world.orchestrator.reverseDecision(run.id, 1, "point-virgule", "Excel FR attend le point-virgule");
    const reversed = world.store.eventsSince(0, run.id).find((e) => e.type === "decision_reversed");
    assert.equal(reversed?.payload.mode, "reset");
    assert.ok(
      (reversed?.payload.conflicts as string[]).some((file) => /separator\.ts/.test(file)),
      JSON.stringify(reversed?.payload),
    );
    assert.deepEqual(
      world.store.listDecisions({ runId: run.id }).map((d) => d.status),
      ["reversed", "superseded", "auto"],
    );
    assert.ok(!fs.existsSync(path.join(worktree, "src/api/separator.ts")), "retour au checkpoint #1");
    assert.ok(!fs.existsSync(path.join(worktree, "src/api/export.ts")), "le travail postérieur est annulé");
    assert.match(git(worktree, "log", "-1", "--format=%s"), /^decision: Séparateur CSV \? \(renversée\) → point-virgule/);
    // Les survivantes repartent du nouveau checkpoint.
    const sha = git(worktree, "rev-parse", "HEAD");
    assert.equal(world.store.getDecision(run.id, 3)?.checkpointSha, sha);
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const resumed = world
      .log()
      .filter((e) => e.kind === "prompt" && e.step === "impl")
      .pop();
    assert.match(String(resumed?.message), /Reprise au checkpoint #1/);
    assert.match(String(resumed?.message), /entrait en conflit/);
    assert.match(String(resumed?.message), /décisions #3 n'en dépendaient pas : réapplique-les/);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-8 : renverser une décision d'un run mergé reverte le commit squash sur main puis ouvre un run de suite qui porte l'option", async () => {
  const world = fakeWorld({
    req: [OK.req],
    specs: [OK.specs],
    impl: [[decide("Séparateur CSV ?", ["virgule", "point-virgule"]), ...OK.impl]],
    review: [OK.review],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export mergé", request: "Exporter" });
    await until(world, run.id, ["merged", "failed", "awaiting_human"]);
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const squash = git(world.repo, "rev-parse", "main");
    const follow = await world.orchestrator.reverseDecision(run.id, 1, "point-virgule", "Excel FR", { by: "mac" });
    assert.notEqual(follow.id, run.id, "un run de suite");
    assert.equal(git(world.repo, "rev-parse", "main^"), squash, "un commit de revert au-dessus du squash");
    assert.throws(() => git(world.repo, "show", "main:src/api/export.ts"), "la feature est défaite sur main");
    assert.equal(world.store.getDecision(run.id, 1)?.status, "reversed");
    const events = world.store.eventsSince(0, run.id).map((e) => e.type);
    assert.ok(events.includes("reverted"), events.join(","));
    assert.ok(!events.includes("revert_failed"));
    const reversed = world.store.eventsSince(0, run.id).find((e) => e.type === "decision_reversed");
    assert.equal(reversed?.payload.followUp, true);
    assert.match(world.store.instructions(follow.id) ?? "", /point-virgule/);
    assert.match(world.store.instructions(follow.id) ?? "", /reverté sur main/);
    await world.orchestrator.cancel(follow.id);
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-gestures/AC-9 : l'inbox compte ce qui bloque (escalades ouvertes + runs en attente) ; les décisions auto et auto_timeout sont listées à part, avec leur statut", () => {
  let clock = 1000;
  const store = new Store(path.join(tmpdir("harness-gestures-"), "h.sqlite"), () => clock++);
  for (const id of ["r1", "r2", "r3"])
    store.createRun({ id, repo: "demo", slug: id, title: id, request: id, branch: `harness/${id}` });
  const step = store.startStep("r1", "impl", 0, null, null);
  store.addEscalation({
    runId: "r1",
    stepId: step.id,
    category: "schema",
    question: "q",
    options: ["a", "b"],
    context: "",
    recommended: "a",
  });
  store.addEscalation({
    runId: "r1",
    stepId: step.id,
    category: "deletion",
    question: "q2",
    options: ["a", "b"],
    context: "",
    recommended: null,
  });
  store.updateRun("r1", { state: "escalated" });
  store.updateRun("r2", { state: "awaiting_human", step: "review" });
  const base = {
    runId: "r2",
    stepId: store.startStep("r2", "impl", 0, null, null).id,
    options: ["x", "y"],
    chosen: "x",
    rationale: "r",
    category: "reversible" as const,
    checkpointSha: null,
    dependsOn: [],
  };
  store.addDecision({ ...base, question: "auto" });
  store.addDecision({ ...base, question: "échue" }, "auto_timeout");
  store.acceptDecision("r2", 1);
  store.addDecision({ ...base, runId: "r3", question: "autre" });
  store.updateRun("r3", { state: "merged" });

  const inbox = inboxOf(store);
  assert.equal(inbox.pendingCount, 3, "deux escalades ouvertes + un run en attente");
  assert.deepEqual(
    (inbox.decisions as { runId: string; question: string; status: string }[]).map((d) => [d.runId, d.question, d.status]),
    [
      ["r2", "échue", "auto_timeout"],
      ["r3", "autre", "auto"],
    ],
  );
  assert.deepEqual((inbox.awaiting as { id: string }[]).map((r) => r.id), ["r2"]);
  assert.deepEqual(
    (inbox.runs as { id: string }[]).map((r) => r.id).sort(),
    ["r1", "r2", "r3"],
    "un run mergé reste visible tant qu'une décision est à relire",
  );
  assert.equal(inboxOf(store, ["autre"]).pendingCount, 0);
  store.close();
});
