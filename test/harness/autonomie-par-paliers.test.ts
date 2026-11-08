// Feature autonomie-par-paliers : la configuration, le type des runs, la porte des specs et celle de la revue,
// les exclusions, l'inscription et le renversement des décisions prises seules, l'apprentissage borné et la route
// de lecture. Faux runner : test/support/fake-omp-rpc.ts.
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import test from "node:test";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import type { Client } from "../../omp-harness/auth.ts";
import { autonomyProposals } from "../../omp-harness/autonomy-learning.ts";
import type { AutonomyProposal } from "../../omp-harness/autonomy-learning.ts";
import type { AutonomyProof, AutonomyRule, WorkKind } from "../../omp-harness/autonomy-rules.ts";
import { repoDefaults, validateConfig } from "../../omp-harness/config.ts";
import type { HarnessConfig, RepoConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { digestOf } from "../../omp-harness/digest.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { newRunInput } from "../../omp-harness/input.ts";
import { WAIT_REASON, humanWaitOf } from "../../omp-harness/machine.ts";
import { REVIEW_EVIDENCE } from "../../omp-harness/steps.ts";
import { mergeDecision } from "../../omp-harness/verdict.ts";
import type { ReviewEvidence, Verdict } from "../../omp-harness/verdict.ts";
import { BUG_REVIEW_RULE, autonomyDecisions, bugWorld, configure, eventsOf, implOf, lines, reviewOf, stateOf, until } from "../support/autonomie-fixtures.ts";
import { OK, fakeWorld, git, harnessRepo, testConfig, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { tmpdir } from "../support/repo.ts";

const HOUR_L = 60 * 60 * 1000;
const DAY_L = 24 * HOUR_L;
const START_L = 1000 * DAY_L;

type ValidationL = { gate?: "specs" | "verdict"; approve: boolean; liftable?: boolean; by?: string; pilot?: boolean };

/** Une base à l'horloge réglable et une configuration à deux dépôts (`demo`, `autre`). */
function worldL(patch: (config: HarnessConfig) => void = () => {}) {
  const clock = { now: START_L };
  const store = new Store(path.join(tmpdir("autonomie-learning-"), "h.sqlite"), () => clock.now);
  const config = testConfig("/nonexistent/autonomie-learning", (c) => {
    c.review.specsGate = true;
    c.review.maxDiffLines = 30;
    c.autonomyLearning.minRuns = 4;
    c.repos.push(repoDefaults({ name: "autre", path: "/nonexistent/autre", scope: "autre-scope" }));
    patch(c);
  });
  const rulesOf = (repo: string, rules: AutonomyRule[]) => {
    const declared = config.repos.find((r) => r.name === repo);
    if (declared === undefined) throw new Error(`dépôt inconnu : ${repo}`);
    declared.autonomy = { rules };
  };
  const proposals = (repos: readonly string[] | null = null) => autonomyProposals(store, config, clock.now, repos);
  return { clock, store, config, rulesOf, proposals };
}

type WorldL = {
  clock: { now: number };
  store: Store;
  config: HarnessConfig;
  rulesOf: (repo: string, rules: AutonomyRule[]) => void;
  proposals: (repos?: readonly string[] | null) => AutonomyProposal[];
};

function runL(world: { store: Store }, id: string, kind: WorkKind | null = "bug", repo = "demo") {
  return world.store.createRun({ id, repo, slug: id, title: id, request: "x", branch: `harness/${id}`, kind });
}

function validateL(world: { store: Store }, runId: string, v: ValidationL): void {
  world.store.appendEvent("validation", runId, {
    gate: v.gate ?? "verdict",
    approve: v.approve,
    liftable: v.liftable ?? true,
    ...(v.by !== undefined ? { by: v.by } : {}),
    ...(v.pilot !== undefined ? { pilot: v.pilot } : {}),
  });
}

/** `count` runs `prefix-0…` de ce type, chacun avec un passage ; `refused` premiers refusés par l'humain. */
function groupL(world: WorldL, prefix: string, count: number, refused: number, extra: Partial<ValidationL> = {}) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `${prefix}-${i}`;
    runL(world, id);
    validateL(world, id, { approve: i >= refused, ...extra });
    ids.push(id);
  }
  return ids;
}

const AUTO_REVIEW_L: AutonomyRule = {
  match: { kind: "bug" },
  require: {},
  gates: { specs: "human", review: "auto" },
};

function proofOf(gate: "specs" | "review", rank = 1): AutonomyProof {
  return {
    gate,
    rule: { rank, match: { kind: "bug" }, require: {}, gates: { specs: "human", review: "auto" } },
    proofs: {},
  };
}

function decideL(world: { store: Store }, runId: string, question: string, autonomy: AutonomyProof | null) {
  const step = world.store.startStep(runId, "impl", 1, null, null);
  return world.store.addDecision(
    {
      runId,
      stepId: step.id,
      question,
      options: ["valider", "laisser à l'humain"],
      chosen: "valider",
      rationale: "parce que",
      category: "reversible",
      checkpointSha: null,
      dependsOn: [],
      autonomy,
    },
    "auto",
  );
}

test("autonomie-par-paliers/AC-19 : le revert d'un run auto-mergé sans validation ne change ni runs ni corrections, celui d'un run validé seul compte comme correction", () => {
  const world = worldL((c) => {
    c.autonomyLearning.minRuns = 20;
  });
  try {
    // Porte `human` (aucune règle), 20 runs approuvés par un humain : 0 correction, le seuil de montée est tenu.
    groupL(world, "ok", 20, 0);
    const base = world.proposals();
    assert.equal(base.length, 1);
    assert.deepEqual([base[0]?.direction, base[0]?.runs, base[0]?.corrections], ["raise", 20, 0]);

    // Un run auto-mergé (aucun passage) et un run dont l'attente n'était pas levable : leurs reverts ne comptent nulle part.
    runL(world, "automerge");
    world.store.appendEvent("reverted", "automerge", { by: "humain" });
    runL(world, "faible");
    validateL(world, "faible", { approve: true, liftable: false });
    world.store.appendEvent("reverted", "faible", { by: "humain" });
    const unchanged = world.proposals();
    assert.deepEqual(unchanged, base, "cas : reverts de runs sans passage levable, rien ne change");

    // Le revert d'un run mergé après une validation prise seule est une correction humaine (1/20 = borne incluse).
    validateL(world, "ok-3", { approve: true, by: "autonomie:demo#1", pilot: true });
    world.store.appendEvent("reverted", "ok-3", { by: "humain" });
    const counted = world.proposals();
    assert.equal(counted.length, 1);
    assert.deepEqual([counted[0]?.runs, counted[0]?.corrections, counted[0]?.rate], [20, 1, 0.05]);

    // Un second revert du même run ne compte pas deux fois.
    world.store.appendEvent("reverted", "ok-3", { by: "humain" });
    assert.equal(world.proposals()[0]?.corrections, 1);
  } finally {
    world.store.close();
  }
});

test("autonomie-par-paliers/AC-20 : après N refus humains d'une attente verdict levable ou N approbations puis reverts, la baisse est proposée et la règle reste identique", () => {
  const cases: [string, (world: WorldL) => void][] = [
    ["N refus humains (diff seul)", (world) => void groupL(world, "r", 4, 4)],
    [
      "N approbations levables puis reverts",
      (world) => {
        for (const id of groupL(world, "a", 4, 0)) world.store.appendEvent("reverted", id, { by: "humain" });
      },
    ],
    [
      "N approbations de l'autonomie puis reverts",
      (world) => {
        for (const id of groupL(world, "z", 4, 0, { by: "autonomie:demo#1", pilot: true }))
          world.store.appendEvent("reverted", id, { by: "humain" });
      },
    ],
  ];
  for (const [name, simulate] of cases) {
    const world = worldL();
    try {
      world.rulesOf("demo", [AUTO_REVIEW_L]);
      const rulesBefore = structuredClone(world.config.repos.find((r) => r.name === "demo")?.autonomy);
      const configBefore = structuredClone(world.config);
      simulate(world);
      const [proposal, ...others] = world.proposals();
      assert.equal(others.length, 0, `cas : ${name} : une seule proposition`);
      assert.equal(proposal?.direction, "lower", `cas : ${name} : direction`);
      assert.deepEqual(
        [proposal?.repo, proposal?.kind, proposal?.gate, proposal?.current, proposal?.rule],
        ["demo", "bug", "review", "auto", 1],
        `cas : ${name} : groupe`,
      );
      assert.deepEqual([proposal?.runs, proposal?.corrections, proposal?.rate], [4, 4, 1], `cas : ${name} : taux`);
      assert.deepEqual(
        proposal?.changes,
        [{ path: "repos.demo.autonomy.rules[0].gates.review", value: "human" }],
        `cas : ${name} : changes`,
      );
      assert.deepEqual(world.config.repos.find((r) => r.name === "demo")?.autonomy, rulesBefore, `cas : ${name} : règle`);
      assert.deepEqual(world.config, configBefore, `cas : ${name} : configuration`);
    } finally {
      world.store.close();
    }
  }

  // Sous N runs, rien.
  const short = worldL();
  try {
    short.rulesOf("demo", [AUTO_REVIEW_L]);
    groupL(short, "s", 3, 3);
    assert.deepEqual(short.proposals(), [], "cas : N - 1 refus ne proposent rien");
  } finally {
    short.store.close();
  }
});

test("autonomie-par-paliers/S-17 : la forme de changes, le tri, le filtre repos, le pilote d'audit et la fenêtre", () => {
  const world = worldL();
  try {
    world.rulesOf("demo", [
      { match: { kind: "bug" }, require: {}, gates: { specs: "human", review: "human" } },
      { match: { kind: "feature", maxDiffLines: 20 }, require: {}, gates: { specs: "human", review: "human" } },
      { match: { kind: "docs", maxDiffLines: 50 }, require: {}, gates: { specs: "human", review: "human" } },
      { match: { kind: "deps" }, require: {}, gates: { specs: "human", review: "human" } },
    ]);
    const group = (prefix: string, kind: WorkKind, repo: string, gate: "specs" | "verdict") => {
      for (let i = 0; i < 4; i++) {
        runL(world, `${prefix}-${i}`, kind, repo);
        validateL(world, `${prefix}-${i}`, { gate, approve: true });
      }
    };
    group("autre-bug", "bug", "autre", "verdict");
    group("bug", "bug", "demo", "verdict");
    group("feature", "feature", "demo", "verdict");
    group("docs", "docs", "demo", "verdict");
    group("deps-r", "deps", "demo", "verdict");
    group("deps-s", "deps", "demo", "specs");
    group("test-s", "test", "demo", "specs");

    const at = (p: AutonomyProposal) => `${p.repo}/${p.kind}/${p.gate}`;
    const all = world.proposals();
    assert.deepEqual(
      all.map(at),
      [
        "autre/bug/review",
        "demo/bug/review",
        "demo/deps/review",
        "demo/deps/specs",
        "demo/docs/review",
        "demo/feature/review",
        "demo/test/specs",
      ],
      "cas : tri par dépôt, type puis porte",
    );
    const changes = Object.fromEntries(all.map((p) => [at(p), p.changes]));
    const gateOf = (i: number, gate: string) => ({ path: `repos.demo.autonomy.rules[${i}].gates.${gate}`, value: "auto" });
    const wide = (i: number) => ({ path: `repos.demo.autonomy.rules[${i}].match.maxDiffLines`, value: 60 });
    assert.deepEqual(changes["demo/bug/review"], [gateOf(0, "review"), wide(0)], "cas : règle sans maxDiffLines");
    assert.deepEqual(changes["demo/feature/review"], [gateOf(1, "review"), wide(1)], "cas : maxDiffLines ≤ serveur");
    assert.deepEqual(changes["demo/docs/review"], [gateOf(2, "review")], "cas : maxDiffLines > serveur, inchangé");
    assert.deepEqual(changes["demo/deps/review"], [gateOf(3, "review"), wide(3)], "cas : revue avec règle");
    assert.deepEqual(changes["demo/deps/specs"], [gateOf(3, "specs")], "cas : specs avec règle, sans maxDiffLines");
    assert.deepEqual(
      changes["autre/bug/review"],
      [
        {
          path: "repos.autre.autonomy.rules[+]",
          value: {
            match: { kind: "bug", maxDiffLines: 60 },
            require: { reproTest: true, greenChecks: true, proofs: true },
            gates: { specs: "human", review: "auto" },
          },
        },
      ],
      "cas : revue sans règle",
    );
    assert.deepEqual(
      changes["demo/test/specs"],
      [
        {
          path: "repos.demo.autonomy.rules[+]",
          value: { match: { kind: "test" }, require: {}, gates: { specs: "auto", review: "human" } },
        },
      ],
      "cas : specs sans règle",
    );
    assert.deepEqual(world.proposals(["autre"]).map(at), ["autre/bug/review"], "cas : filtre repos du lecteur");
    assert.deepEqual(world.proposals([]), [], "cas : lecteur sans dépôt");
  } finally {
    world.store.close();
  }

  // Le pilote d'audit ne compte pas ; ce qui sort de la fenêtre non plus.
  const second = worldL();
  try {
    groupL(second, "h", 2, 0);
    // Une approbation de l'autonomie (geste du pilote porté par `autonomie:`) compte ; les refus du pilote non.
    runL(second, "auto-1");
    validateL(second, "auto-1", { approve: true, by: "autonomie:demo#1", pilot: true });
    runL(second, "pilote-1");
    validateL(second, "pilote-1", { approve: false, pilot: true });
    runL(second, "pilote-2");
    validateL(second, "pilote-2", { approve: true, pilot: true });
    runL(second, "pilote-3");
    validateL(second, "pilote-3", { approve: false, pilot: true });
    // Hors fenêtre : un refus, un revert.
    second.clock.now = START_L - 31 * DAY_L;
    runL(second, "vieux");
    validateL(second, "vieux", { approve: false });
    second.store.appendEvent("reverted", "h-0", { by: "humain" });
    second.clock.now = START_L;
    runL(second, "dernier");
    validateL(second, "dernier", { approve: true });
    const [proposal, ...others] = second.proposals();
    assert.equal(others.length, 0);
    assert.deepEqual(
      [proposal?.direction, proposal?.runs, proposal?.passages, proposal?.corrections],
      ["raise", 4, 4, 0],
      "cas : ni pilote d'audit ni hors fenêtre",
    );
  } finally {
    second.store.close();
  }
});

test("autonomie-par-paliers/AC-21 : N approbations levables proposent la montée sans changer la règle, pas celles des attentes non levables", () => {
  const world = worldL();
  try {
    world.rulesOf("demo", [{ match: { kind: "bug" }, require: {}, gates: { specs: "human", review: "human" } }]);
    const before = structuredClone(world.config);
    groupL(world, "up", 4, 0);
    const [proposal, ...others] = world.proposals();
    assert.equal(others.length, 0);
    assert.deepEqual(
      [proposal?.direction, proposal?.current, proposal?.rule, proposal?.runs, proposal?.corrections, proposal?.rate],
      ["raise", "human", 1, 4, 0, 0],
    );
    assert.equal(proposal?.changes[0]?.path, "repos.demo.autonomy.rules[0].gates.review");
    assert.equal(proposal?.changes[0]?.value, "auto");
    assert.deepEqual(world.config, before, "la règle lue dans la configuration reste identique");
  } finally {
    world.store.close();
  }

  const cases: [string, boolean | "auto", "specs" | "verdict", boolean][] = [
    ["specsGate true, specs non levables (découpage)", true, "specs", false],
    ["specsGate auto, specs levables en apparence", "auto", "specs", true],
    ["specsGate auto, specs non levables", "auto", "specs", false],
    ["revue, verdict faible (non levable)", true, "verdict", false],
  ];
  for (const [name, specsGate, gate, liftable] of cases) {
    const other = worldL((c) => {
      c.review.specsGate = specsGate;
    });
    try {
      for (let i = 0; i < 4; i++) {
        runL(other, `n-${i}`);
        validateL(other, `n-${i}`, { gate, approve: true, liftable });
      }
      assert.deepEqual(other.proposals(), [], `cas : ${name} : aucune proposition`);
    } finally {
      other.store.close();
    }
  }

  // Témoin : sous specsGate true, les mêmes approbations levables donnent bien la montée à la porte specs.
  const witness = worldL();
  try {
    for (let i = 0; i < 4; i++) {
      runL(witness, `w-${i}`);
      validateL(witness, `w-${i}`, { gate: "specs", approve: true, liftable: true });
    }
    assert.deepEqual(
      witness.proposals().map((p) => [p.gate, p.direction]),
      [["specs", "raise"]],
      "cas : témoin specsGate true, levables",
    );
  } finally {
    witness.store.close();
  }
});

test("autonomie-par-paliers/AC-22 : les seuils de taux et de runs avec les défauts, bornes incluses", () => {
  // [nom, porte courante, runs, runs corrigés, direction attendue]
  const cases: [string, "auto" | "human", number, number, "lower" | "raise" | null][] = [
    ["auto 1/10 → rien", "auto", 10, 1, null],
    ["auto 2/10 → lower (borne incluse)", "auto", 10, 2, "lower"],
    ["auto 9/9 corrigés → rien (runs < minRuns)", "auto", 9, 9, null],
    ["human 1/10 → rien", "human", 10, 1, null],
    ["human 1/20 → raise (borne incluse)", "human", 20, 1, "raise"],
    ["human 9 sans correction → rien (runs < minRuns)", "human", 9, 0, null],
  ];
  for (const [name, current, runs, corrected, expected] of cases) {
    const world = worldL((c) => {
      c.autonomyLearning = { windowDays: 30, minRuns: 10, raiseMaxRate: 0.05, lowerMinRate: 0.2 };
    });
    try {
      if (current === "auto") world.rulesOf("demo", [AUTO_REVIEW_L]);
      groupL(world, "t", runs, corrected);
      const found = world.proposals();
      assert.deepEqual(
        found.map((p) => p.direction),
        expected === null ? [] : [expected],
        `cas : ${name}`,
      );
      if (expected !== null) assert.equal(found[0]?.corrections, corrected, `cas : ${name} : corrections`);
    } finally {
      world.store.close();
    }
  }
});

test("autonomie-par-paliers/AC-31 : le renversement d'un run mergé validé seul (décision reversed puis reverted) compte une seule correction", () => {
  const world = worldL((c) => {
    c.autonomyLearning.minRuns = 2;
  });
  try {
    world.rulesOf("demo", [AUTO_REVIEW_L]);
    for (const id of ["m-0", "m-1"]) {
      runL(world, id);
      validateL(world, id, { approve: true, by: "autonomie:demo#1", pilot: true });
    }
    assert.deepEqual(world.proposals(), [], "témoin : aucune correction, aucune baisse");

    const decision = decideL(world, "m-0", "Valider le verdict et fusionner sans geste humain (autonomie) ?", proofOf("review"));
    world.store.reverseDecision("m-0", decision.seq, "laisser à l'humain", "à revoir", [], "humain");
    world.store.appendEvent("reverted", "m-0", { by: "humain" });
    const [proposal, ...others] = world.proposals();
    assert.equal(others.length, 0);
    assert.deepEqual(
      [proposal?.direction, proposal?.runs, proposal?.corrections, proposal?.rate],
      ["lower", 2, 1, 0.5],
      "une seule correction pour le run, pas deux",
    );

    // Un renversement de la porte specs ne compte pas à la porte revue.
    const other = worldL((c) => {
      c.autonomyLearning.minRuns = 2;
    });
    try {
      other.rulesOf("demo", [AUTO_REVIEW_L]);
      for (const id of ["p-0", "p-1"]) {
        runL(other, id);
        validateL(other, id, { approve: true, by: "autonomie:demo#1", pilot: true });
      }
      const specs = decideL(other, "p-0", "Valider les specs sans geste humain (autonomie) ?", proofOf("specs"));
      other.store.reverseDecision("p-0", specs.seq, "laisser à l'humain", "specs à revoir", [], "humain");
      assert.deepEqual(other.proposals(), [], "cas : renversement d'une autre porte, aucune correction à la revue");
    } finally {
      other.store.close();
    }
  } finally {
    world.store.close();
  }
});

test("autonomie-par-paliers/AC-30 : une décision d'autonomie reste au rapport du matin tant qu'elle n'est pas acceptée, puis le quitte, avec /v1/inbox", async () => {
  const since = 100 * HOUR_L;
  const question = "Valider le verdict et fusionner sans geste humain (autonomie) ?";
  const world = fakeWorld({});
  const clock = { now: since + HOUR_L };
  // La base du faux monde a l'horloge système : on écrit la décision par un Store à horloge réglée sur le même fichier.
  const file = path.join(world.config.dataDir, "harness.sqlite");
  const timed = new Store(file, () => clock.now);
  const clients = new ClientRegistry(path.join(tmpdir("autonomie-learning-"), "clients.json"), "t".repeat(64));
  const viewer = clients.add("tableau", "viewer", "*").token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  try {
    timed.createRun({ id: "auto", repo: "demo", slug: "auto", title: "Export CSV", request: "x", branch: "harness/auto", kind: "bug" });
    const taken = decideL({ store: timed }, "auto", question, proofOf("review"));
    // Une décision d'agent prise seule avant la fenêtre ultérieure : fenêtrée comme avant.
    const agent = decideL({ store: timed }, "auto", "Séparateur du CSV ?", null);
    assert.equal(agent.status, "auto");

    const own = digestOf(timed, since, since + 2 * HOUR_L);
    assert.ok(own.text.includes(question), own.text);
    assert.ok(own.text.includes("Séparateur du CSV ?"), "la décision d'agent de la fenêtre");
    assert.equal(own.counts.decisions, 2);

    const later = digestOf(timed, since + 10 * HOUR_L, since + 11 * HOUR_L);
    assert.ok(later.text.includes(question), "avant accept : listée dans une fenêtre ultérieure");
    assert.ok(!later.text.includes("Séparateur du CSV ?"), "la décision d'agent hors fenêtre reste absente");
    assert.equal(later.counts.decisions, 1);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const inbox = async () => {
      const response = await fetch(`${url}/v1/inbox`, { headers: { Authorization: `Bearer ${viewer}` } });
      // La forme de /v1/inbox est figée par queries.ts (inboxOf).
      const body: { decisions: { question: string }[] } = await response.json();
      return body.decisions.map((d) => d.question);
    };
    assert.ok((await inbox()).includes(question), "avant accept : À traiter la liste");

    clock.now = since + 3 * HOUR_L;
    assert.ok(timed.acceptDecision("auto", taken.seq, "mac") !== null);
    const accepted = digestOf(timed, since, since + 4 * HOUR_L);
    assert.ok(!accepted.text.includes(question), "après accept : retirée du rapport de sa fenêtre");
    assert.equal(accepted.counts.decisions, 1);
    assert.ok(!digestOf(timed, since + 10 * HOUR_L, since + 11 * HOUR_L).text.includes(question));
    assert.ok(!(await inbox()).includes(question), "après accept : /v1/inbox ne la liste plus");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    timed.close();
  }
});

test("autonomie-par-paliers/AC-7 : un bug de 40 lignes avec test et suite verte, sous une règle review: auto, est fusionné seul", async () => {
  const world = bugWorld({ rules: [BUG_REVIEW_RULE] });
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({
      repo: "demo",
      title: "Corriger l'export",
      request: "Corriger",
      kind: "bug",
      labels: ["export"],
    });
    const done = await until(world, run.id, ["merged", "awaiting_human", "failed"]);
    assert.equal(done.state, "merged", stateOf(world, run.id));
    const [decision, ...others] = autonomyDecisions(world, run.id);
    assert.equal(others.length, 0);
    assert.equal(decision?.status, "auto");
    assert.equal(decision?.autonomy?.gate, "review");
    assert.equal(decision?.autonomy?.rule.rank, 1);
    assert.deepEqual(decision?.autonomy?.rule.match, { kind: "bug", maxDiffLines: 50 });
    const proofs = decision?.autonomy?.proofs;
    assert.equal(proofs?.diffLines, 40);
    assert.equal(proofs?.reviewMaxDiffLines, 30);
    assert.equal(proofs?.ruleMaxDiffLines, 50);
    assert.equal(proofs?.fullTests, "pass");
    assert.deepEqual(proofs?.reproTests, ["test/export.test.ts"]);
    assert.deepEqual(proofs?.provenCriteria, ["AC-1"]);
    assert.deepEqual(
      eventsOf(world, run.id, "autonomy").map((e) => e.payload.action),
      ["hold", "validate"],
    );
    assert.equal(eventsOf(world, run.id, "verdict").length, 0, "la notification est retenue");
    const validation = eventsOf(world, run.id, "validation")[0];
    assert.equal(validation?.payload.gate, "verdict");
    assert.equal(validation?.payload.liftable, true);
    assert.match(String(validation?.payload.by), /^autonomie:demo#1$/);
    assert.equal(humanWaitOf({ state: "awaiting_human", step: null, reason: "validation humaine : x" }), "verdict");
  } finally {
    await world.orchestrator.stop();
  }
});

// ── Lot R-A : les refus de la porte de revue ────────────────────────────────────────────────────

type CaseOptionsRA = {
  rules: AutonomyRule[] | null;
  diff?: number;
  test?: "none" | "added";
  review?: unknown[];
  untyped?: boolean;
};

/** Mène un run `bug` (ou sans type si `untyped`) jusqu'à un état d'arrêt, et rend monde, id et run. */
async function runCaseRA(options: CaseOptionsRA) {
  const world = bugWorld({ rules: options.rules, diff: options.diff, test: options.test, review: options.review });
  await world.orchestrator.start();
  const run = world.orchestrator.createRun({
    repo: "demo",
    title: "Corriger l'export",
    request: "Corriger",
    ...(options.untyped === true ? {} : { kind: "bug" as const, labels: ["export"] }),
  });
  const done = await until(world, run.id, ["merged", "awaiting_human", "failed"]);
  return { world, runId: run.id, done };
}

/** La raison d'attente du même run dans un monde sans règle d'autonomie. */
async function baselineReasonRA(options: CaseOptionsRA): Promise<string | null> {
  const { world, done } = await runCaseRA({ ...options, rules: null });
  try {
    assert.equal(done.state, "awaiting_human", `le monde sans autonomie attend l'humain : ${done.state}/${done.reason}`);
    return done.reason;
  } finally {
    await world.orchestrator.stop();
  }
}

/** Le run attend l'humain, pour la raison d'un monde sans autonomie, et l'autonomie n'a laissé aucune trace. */
async function assertWaitsHumanRA(options: CaseOptionsRA & { untyped?: boolean }, message: string): Promise<void> {
  const expected = await baselineReasonRA(options);
  const { world, runId, done } = await runCaseRA(options);
  try {
    assert.equal(done.state, "awaiting_human", `${message} : ${stateOf(world, runId)}`);
    assert.equal(done.reason, expected, `${message} : raison inchangée`);
    assert.equal(eventsOf(world, runId, "autonomy").length, 0, `${message} : aucun événement autonomy`);
    assert.equal(autonomyDecisions(world, runId).length, 0, `${message} : aucune décision d'autonomie`);
    assert.equal(eventsOf(world, runId, "verdict").length, 1, `${message} : la notification part`);
    assert.match(String(expected), /diff de \d+ lignes/, `${message} : le diff est bien la raison de l'attente`);
  } finally {
    await world.orchestrator.stop();
  }
}

test("autonomie-par-paliers/AC-8 : le même run avec 80 lignes de diff reste awaiting_human, sans décision prise seule", async () => {
  await assertWaitsHumanRA({ rules: [BUG_REVIEW_RULE], diff: 80 }, "80 lignes > match.maxDiffLines 50");
});

test("autonomie-par-paliers/AC-9 : sans test ajouté ou avec une suite complète rouge, le run attend l'humain", async () => {
  // Cas 1 : aucun test ajouté ni modifié (suite verte, diff seul en cause) → l'humain.
  await assertWaitsHumanRA({ rules: [BUG_REVIEW_RULE], diff: 40, test: "none" }, "sans test de reproduction");

  // Cas 2 : suite complète rouge sur l'arbre — le test de reproduction n'est pas vert. L'auto-merge refuse
  // pour autre chose que le diff (bloquant « suite complète rouge ») : le run repart en correction, il n'est
  // ni fusionné ni validé seul.
  const impl = [
    { write: "src/api/export.ts", content: lines(40) },
    { write: "test/export.test.ts", content: "import test from 'node:test';\ntest('export', () => {});\n" },
    { write: "FAIL_FULL", content: "" },
    { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\n## Reste\n" },
  ];
  const world = fakeWorld(
    { req: [OK.req], specs: [OK.specs], impl: [impl], review: [reviewOf()], fix: [[{ sleep: 60_000 }]] },
    { patch: configure([BUG_REVIEW_RULE]) },
  );
  await world.orchestrator.start();
  try {
    const run = world.orchestrator.createRun({ repo: "demo", title: "Corriger l'export", request: "Corriger", kind: "bug" });
    await waitFor(
      () =>
        world.store.getRun(run.id)?.step === "fix" ||
        ["merged", "failed", "awaiting_human"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => stateOf(world, run.id),
      30_000,
    );
    const current = world.store.getRun(run.id);
    assert.equal(current?.step, "fix", `suite rouge : ni fusionné ni validé seul — ${stateOf(world, run.id)}`);
    assert.notEqual(current?.state, "merged");
    assert.equal(autonomyDecisions(world, run.id).length, 0, "suite rouge : aucune décision prise seule");
    assert.equal(eventsOf(world, run.id, "autonomy").length, 0, "suite rouge : aucun événement autonomy");
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-10 : avec require.proofs, un critère non prouvé pass (absent, non testé, en échec ou non vérifié) laisse l'attente à l'humain", async () => {
  const proofsRule: AutonomyRule = {
    match: { kind: "bug", maxDiffLines: 50 },
    require: { reproTest: true, greenChecks: true, proofs: true },
    gates: { specs: "human", review: "auto" },
  };
  const verdictOf = (args: Record<string, unknown>) => reviewOf(args);
  const cases: { name: string; review: unknown[] }[] = [
    { name: "AC-1 non testé", review: verdictOf({ criteria: [{ id: "AC-1", test: "", status: "untested" }] }) },
    { name: "AC-1 en échec", review: verdictOf({ criteria: [{ id: "AC-1", test: "harness/AC-1", status: "fail" }] }) },
    { name: "AC-1 absent du verdict", review: verdictOf({ criteria: [{ id: "AC-2", test: "harness/AC-2", status: "pass" }] }) },
    { name: "AC-1 non vérifié", review: verdictOf({ unverified: ["AC-1 : export non rejoué"] }) },
  ];
  for (const item of cases) {
    const expected = await baselineReasonRA({ rules: null, review: item.review });
    const { world, runId, done } = await runCaseRA({ rules: [proofsRule], review: item.review });
    try {
      assert.equal(done.state, "awaiting_human", `${item.name} : ${stateOf(world, runId)}`);
      assert.equal(done.reason, expected, `${item.name} : raison inchangée`);
      assert.match(String(done.reason), /critère/, `${item.name} : le critère est la raison de l'attente`);
      assert.equal(eventsOf(world, runId, "autonomy").length, 0, `${item.name} : aucun événement autonomy`);
      assert.equal(autonomyDecisions(world, runId).length, 0, `${item.name} : aucune décision d'autonomie`);
    } finally {
      await world.orchestrator.stop();
    }
  }
  // Témoin : la même règle, tous les critères prouvés pass → la règle n'est pas ce qui bloque.
  const { world, runId, done } = await runCaseRA({ rules: [proofsRule] });
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    assert.deepEqual(autonomyDecisions(world, runId)[0]?.autonomy?.proofs.provenCriteria, ["AC-1"]);
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-11 : match.paths [docs/] ne correspond pas à un fichier hors de docs/ ; une règle suivante qui correspond s'applique", async () => {
  const docsOnly: AutonomyRule = { ...BUG_REVIEW_RULE, match: { kind: "bug", maxDiffLines: 50, paths: ["docs/"] } };
  await assertWaitsHumanRA({ rules: [docsOnly] }, "seule règle limitée à docs/");

  const srcRule: AutonomyRule = { ...BUG_REVIEW_RULE, match: { kind: "bug", maxDiffLines: 50, paths: ["src/", "test/"] } };
  const { world, runId, done } = await runCaseRA({ rules: [docsOnly, srcRule] });
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    const [decision, ...others] = autonomyDecisions(world, runId);
    assert.equal(others.length, 0);
    assert.equal(decision?.autonomy?.rule.rank, 2, "la seconde règle s'applique");
    assert.deepEqual(decision?.autonomy?.rule.match, { kind: "bug", maxDiffLines: 50, paths: ["src/", "test/"] });
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-12 : deux règles correspondantes, la première review: human et la seconde auto, laissent l'attente à l'humain", async () => {
  const human: AutonomyRule = { match: { kind: "bug", maxDiffLines: 50 }, require: {}, gates: { specs: "human", review: "human" } };
  await assertWaitsHumanRA({ rules: [human, BUG_REVIEW_RULE] }, "la première règle retenue est human");
  // Contre-épreuve : dans l'ordre inverse, la règle auto vient d'abord et le run est fusionné.
  const { world, runId, done } = await runCaseRA({ rules: [BUG_REVIEW_RULE, human] });
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    assert.equal(autonomyDecisions(world, runId)[0]?.autonomy?.rule.rank, 1);
  } finally {
    await world.orchestrator.stop();
  }
});

test("autonomie-par-paliers/AC-26 : une règle sans match.maxDiffLines ne lève pas l'attente de diff", async () => {
  const unbounded: AutonomyRule = {
    match: { kind: "bug" },
    require: { reproTest: true, greenChecks: true },
    gates: { specs: "human", review: "auto" },
  };
  await assertWaitsHumanRA({ rules: [unbounded] }, "règle sans maxDiffLines");
});

test("autonomie-par-paliers/AC-5 : un run créé sans type attend l'humain, mêmes preuves vertes et règle bug en auto", async () => {
  await assertWaitsHumanRA({ rules: [BUG_REVIEW_RULE], untyped: true }, "run sans type");
});

test("autonomie-par-paliers/AC-18 : un run validé seul est lu dans /v1/inbox et /v1/decisions?status=auto : run, porte, règle et preuves, hors pendingCount", async () => {
  const { world, runId, done } = await runCaseRA({ rules: [BUG_REVIEW_RULE] });
  const token = "t".repeat(64);
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token }));
  try {
    assert.equal(done.state, "merged", stateOf(world, runId));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const get = async (route: string) => {
      const response = await fetch(`${url}${route}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(response.status, 200, route);
      return (await response.json()) as Record<string, unknown>;
    };
    type Seen = { runId: string; status: string; autonomy: { gate: string; rule: { rank: number; match: unknown }; proofs: Record<string, unknown> } | null };
    const decisions = ((await get("/v1/decisions?status=auto")).decisions as Seen[]).filter((d) => d.autonomy !== null);
    const inbox = await get("/v1/inbox");
    const inboxed = (inbox.decisions as Seen[]).filter((d) => d.autonomy !== null);
    for (const [where, seen] of [["decisions", decisions], ["inbox", inboxed]] as const) {
      assert.equal(seen.length, 1, `${where} : une décision d'autonomie`);
      const [decision] = seen;
      assert.equal(decision?.runId, runId, `${where} : nomme le run`);
      assert.equal(decision?.status, "auto");
      assert.equal(decision?.autonomy?.gate, "review", `${where} : la porte franchie`);
      assert.equal(decision?.autonomy?.rule.rank, 1, `${where} : le rang`);
      assert.deepEqual(decision?.autonomy?.rule.match, { kind: "bug", maxDiffLines: 50 }, `${where} : le match`);
      const proofs = decision?.autonomy?.proofs;
      assert.equal(proofs?.diffLines, 40, `${where} : diff`);
      assert.equal(proofs?.reviewMaxDiffLines, 30);
      assert.equal(proofs?.ruleMaxDiffLines, 50);
      assert.equal(proofs?.fullTests, "pass");
      assert.deepEqual(proofs?.reproTests, ["test/export.test.ts"]);
      assert.deepEqual(proofs?.provenCriteria, ["AC-1"]);
    }
    assert.equal(inbox.pendingCount, 0, "une décision prise seule ne bloque rien : hors de pendingCount");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});

const SPECS_S = String(OK.specs[0]?.content);

/** La règle de référence de la porte des specs : tout run `docs`, specs en auto. */
const DOCS_SPECS_RULE_S: AutonomyRule = { match: { kind: "docs" }, require: {}, gates: { specs: "auto", review: "human" } };

const HUMAN_RULES_S: AutonomyRule[] = [
  { match: { kind: "docs" }, require: {}, gates: { specs: "human", review: "human" } },
  { match: { kind: "bug" }, require: {}, gates: { specs: "human", review: "human" } },
];

const BLOQUANT_S = {
  target: "AC-1",
  kind: "critere_faible",
  severity: "bloquant",
  claim: "un CSV vide satisfait AC-1 : le critère ne prouve pas l'export des données",
  evidence: "AC-1 (B-1) : … Then un CSV est produit",
  suggestion: "Then le CSV a une ligne par enregistrement",
};

const BLOCKED_IMPL_S = [[{ sleep: 60_000 }]];

type SpecsGateS = true | "auto";

/** Un monde dont /specs écrit `specs` ; /impl, s'il part, dort (le test juge la porte, pas la suite). */
function worldS(options: {
  rules: AutonomyRule[] | null;
  gate: SpecsGateS;
  specs?: string;
  challenge?: boolean;
  impl?: unknown[];
}): FakeWorld {
  const specs = options.specs === undefined ? OK.specs : [{ write: ".harness/specs.md", content: options.specs }];
  return fakeWorld(
    {
      req: [OK.req],
      specs: options.challenge === true ? [specs, specs] : [specs],
      ...(options.challenge === true ? { contradicteur: [[{ tool: "challenge_report", args: { findings: [BLOQUANT_S] } }]] } : {}),
      impl: options.impl ?? BLOCKED_IMPL_S,
      review: [reviewOf()],
    },
    {
      patch: configure(options.rules, (config: HarnessConfig) => {
        config.review.specsGate = options.gate;
        if (options.challenge === true) config.challenge.steps = ["specs"];
      }),
    },
  );
}

function docsRunS(world: FakeWorld, extra: { projectId?: string; projectOrder?: number } = {}) {
  return world.orchestrator.createRun({
    repo: "demo",
    title: "Documenter l'export",
    request: "Documenter",
    kind: "docs",
    lane: "full",
    ...extra,
  });
}

/** Laisse passer quelques tours : l'autonomie a eu toute occasion d'agir. */
async function ticksS(world: FakeWorld): Promise<void> {
  for (let i = 0; i < 6; i++) await world.orchestrator.tick();
}

/** Le run attend l'humain à la porte des specs, sans aucune trace d'autonomie, et `specs_ready` est parti. */
async function assertHumanSpecsS(world: FakeWorld, runId: string, wait: "specs" | "irreversible", label: string) {
  await until(world, runId, ["awaiting_human", "merged", "failed"]);
  await ticksS(world);
  const run = world.store.getRun(runId);
  assert.equal(run?.state, "awaiting_human", `${label} : ${stateOf(world, runId)}`);
  assert.equal(run?.step, "specs", label);
  assert.equal(humanWaitOf(run as never), wait, `${label} : ${stateOf(world, runId)}`);
  assert.equal(autonomyDecisions(world, runId).length, 0, `${label} : aucune décision d'autonomie`);
  assert.equal(eventsOf(world, runId, "autonomy").length, 0, `${label} : aucun événement autonomy`);
  assert.equal(eventsOf(world, runId, "specs_ready").length, 1, `${label} : specs_ready publié une fois`);
  assert.equal(eventsOf(world, runId, "specs_ready")[0]?.payload.reason, run?.reason, label);
  assert.equal(world.store.listRuns({}).length, 1, `${label} : aucun run enfant`);
}

async function withWorldS<T>(world: FakeWorld, body: () => Promise<T>): Promise<T> {
  await world.orchestrator.start();
  try {
    return await body();
  } finally {
    await world.orchestrator.stop();
  }
}

test("autonomie-par-paliers/AC-6 : specsGate true, règle docs en specs: auto, specs sans raison de porte → /impl part seul, décision citant la règle", async () => {
  const world = worldS({ rules: [DOCS_SPECS_RULE_S], gate: true });
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    await waitFor(
      () => autonomyDecisions(world, run.id).length > 0 && world.store.getRun(run.id)?.step === "impl",
      () => stateOf(world, run.id),
      60_000,
    );
    const live = world.store.getRun(run.id);
    assert.notEqual(live?.state, "awaiting_human", stateOf(world, run.id));
    const [decision, ...others] = autonomyDecisions(world, run.id);
    assert.equal(others.length, 0);
    assert.equal(decision?.status, "auto");
    assert.equal(decision?.autonomy?.gate, "specs");
    assert.equal(decision?.autonomy?.rule.rank, 1);
    assert.deepEqual(decision?.autonomy?.rule.match, { kind: "docs" });
    assert.equal(decision?.autonomy?.rule.gates.specs, "auto");
    assert.equal(decision?.autonomy?.proofs.kind, "docs");
    assert.deepEqual(decision?.autonomy?.proofs.gateReasons, []);
    assert.match(decision?.question ?? "", /Valider les specs sans geste humain/);
    assert.deepEqual(
      eventsOf(world, run.id, "autonomy").map((event) => event.payload.action),
      ["hold", "validate"],
    );
    assert.equal(eventsOf(world, run.id, "specs_ready").length, 0, "la notification est retenue");
    const states = eventsOf(world, run.id, "run_state").map((event) => event.payload);
    const validated = states.find((payload) => payload.reason === "specs validées par l'autonomie");
    assert.ok(validated, `une transition « specs validées par l'autonomie » : ${JSON.stringify(states)}`);
    assert.equal(validated.by, "autonomie:demo#1");
    const validation = eventsOf(world, run.id, "validation")[0];
    assert.equal(validation?.payload.gate, "specs");
    assert.equal(validation?.payload.approve, true);
    assert.equal(validation?.payload.liftable, true);
  });
});

test("autonomie-par-paliers/AC-27 : découpage, modules vides, première feature, désaccord ouvert → l'humain, sous specsGate auto comme true", async () => {
  const cases = [
    {
      reason: "découpage proposé",
      specs: SPECS_S.replace(
        "## Découpage\naucun\n",
        "## Découpage\n- Export JSON — Exporter aussi en JSON — src/api, docs\n- Export XML — Exporter en XML\n",
      ),
    },
    { reason: "première feature d'un projet", project: true },
    { reason: "désaccord avec le contradicteur", challenge: true },
  ];
  const gates: SpecsGateS[] = ["auto", true];
  await Promise.all(
    cases.flatMap((entry) =>
      gates.map(async (gate) => {
        const label = `${entry.reason} (specsGate ${String(gate)})`;
        const world = worldS({
          rules: [DOCS_SPECS_RULE_S],
          gate,
          ...(entry.specs !== undefined ? { specs: entry.specs } : {}),
          ...(entry.challenge === true ? { challenge: true } : {}),
        });
        await withWorldS(world, async () => {
          if (entry.project === true) world.store.createProject({ id: "proj-s", repo: "demo", title: "Projet" });
          const run = docsRunS(world, entry.project === true ? { projectId: "proj-s", projectOrder: 0 } : {});
          await assertHumanSpecsS(world, run.id, "specs", label);
          const reason = world.store.getRun(run.id)?.reason ?? "";
          if (gate === "auto") assert.ok(reason.includes(entry.reason), `${label} : raison « ${reason} »`);
        });
      }),
    ),
  );

  // Modules vides : /specs refuse lui-même un `## Modules` vide (missing_output), la raison n'est donc atteinte que si
  // les specs sont réécrites après la pose de l'attente. Le serveur recalcule les raisons à l'évaluation (S-8).
  const world = worldS({ rules: null, gate: true });
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    await until(world, run.id, ["awaiting_human", "merged", "failed"]);
    const waiting = world.store.getRun(run.id);
    assert.equal(humanWaitOf(waiting as never), "specs", stateOf(world, run.id));
    const step = world.store.listSteps(run.id).at(-1);
    assert.ok(step, "une étape où écrire les specs");
    world.store.putArtifact(run.id, "specs.md", SPECS_S.replace("## Modules\n- src/api\n", "## Modules\n"), step.id);
    repoOf(world.config).autonomy = { rules: [DOCS_SPECS_RULE_S] };
    world.store.appendEvent("autonomy", run.id, { action: "hold", gate: "specs", rev: waiting?.rev }, "demo");
    await ticksS(world);
    const after = world.store.getRun(run.id);
    assert.equal(after?.state, "awaiting_human", `modules vides (recalculés) : ${stateOf(world, run.id)}`);
    assert.equal(autonomyDecisions(world, run.id).length, 0, "modules vides (recalculés) : aucune décision");
    const autonomy = eventsOf(world, run.id, "autonomy");
    assert.equal(autonomy.at(-1)?.payload.action, "defer", "modules vides (recalculés) : defer");
    assert.match(String(autonomy.at(-1)?.payload.why), /modules vides/);
    assert.equal(eventsOf(world, run.id, "specs_ready").length, 2, "modules vides (recalculés) : la notification part");
    assert.equal(world.store.listRuns({}).length, 1, "modules vides (recalculés) : aucun run enfant");
  });
});

test("autonomie-par-paliers/AC-28 : une règle docs portant paths, maxDiffLines ou require ne lève pas les specs ; une seconde règle docs le fait", async () => {
  const variants: { name: string; rule: AutonomyRule }[] = [
    { name: "match.paths", rule: { ...DOCS_SPECS_RULE_S, match: { kind: "docs", paths: ["docs/"] } } },
    { name: "match.maxDiffLines", rule: { ...DOCS_SPECS_RULE_S, match: { kind: "docs", maxDiffLines: 50 } } },
    { name: "require.reproTest", rule: { ...DOCS_SPECS_RULE_S, require: { reproTest: true } } },
    { name: "require.greenChecks", rule: { ...DOCS_SPECS_RULE_S, require: { greenChecks: true } } },
    { name: "require.proofs", rule: { ...DOCS_SPECS_RULE_S, require: { proofs: true } } },
  ];
  await Promise.all(
    variants.map(async ({ name, rule }) => {
      const alone = worldS({ rules: [rule], gate: true });
      await withWorldS(alone, async () => {
        const run = docsRunS(alone);
        await assertHumanSpecsS(alone, run.id, "specs", `${name}, seule`);
      });
      const followed = worldS({ rules: [rule, DOCS_SPECS_RULE_S], gate: true });
      await withWorldS(followed, async () => {
        const run = docsRunS(followed);
        await waitFor(
          () => autonomyDecisions(followed, run.id).length > 0 && followed.store.getRun(run.id)?.step === "impl",
          () => `${name}, suivie : ${stateOf(followed, run.id)}`,
          60_000,
        );
        assert.notEqual(followed.store.getRun(run.id)?.state, "awaiting_human", `${name}, suivie`);
        const [decision] = autonomyDecisions(followed, run.id);
        assert.equal(decision?.autonomy?.rule.rank, 2, `${name} : la seconde règle s'applique`);
        const validated = eventsOf(followed, run.id, "run_state").find(
          (event) => event.payload.reason === "specs validées par l'autonomie",
        );
        assert.equal(validated?.payload.by, "autonomie:demo#2", name);
        assert.equal(eventsOf(followed, run.id, "specs_ready").length, 0, name);
      });
    }),
  );
});

test("autonomie-par-paliers/AC-13 : des specs à geste irréversible restent à l'humain, sous specsGate auto (irreversible) comme true", async () => {
  const specs = SPECS_S.replace(
    "S-1 (AC-1) : export CSV",
    "S-1 (AC-1) : export CSV, puis supprimer les données exportées",
  );
  const auto = worldS({ rules: [DOCS_SPECS_RULE_S], gate: "auto", specs });
  await withWorldS(auto, async () => {
    const run = docsRunS(auto);
    await assertHumanSpecsS(auto, run.id, "irreversible", "specsGate auto");
    assert.match(auto.store.getRun(run.id)?.reason ?? "", /geste irréversible/);
  });
  const strict = worldS({ rules: [DOCS_SPECS_RULE_S], gate: true, specs });
  await withWorldS(strict, async () => {
    const run = docsRunS(strict);
    await assertHumanSpecsS(strict, run.id, "specs", "specsGate true");
    const reason = strict.store.getRun(run.id)?.reason ?? "";
    assert.equal(reason, WAIT_REASON.specs, "la raison de l'attente ne nomme pas le geste irréversible");
    assert.doesNotMatch(reason, /irréversible/);
  });
});

test("autonomie-par-paliers/AC-1 : sans champ autonomy, specsGate true, un run docs attend l'humain aux specs comme avant, sans décision", async () => {
  const world = worldS({ rules: null, gate: true });
  assert.equal(world.config.repos.find((repo) => repo.name === "demo")?.autonomy, undefined);
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    await assertHumanSpecsS(world, run.id, "specs", "sans autonomy");
    assert.equal(world.store.getRun(run.id)?.reason, WAIT_REASON.specs);
  });
});

test("autonomie-par-paliers/AC-3 : des règles toutes human laissent les specs à l'humain, specs_ready publié", async () => {
  const world = worldS({ rules: HUMAN_RULES_S, gate: true });
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    await assertHumanSpecsS(world, run.id, "specs", "règles human");
    assert.equal(world.store.getRun(run.id)?.reason, WAIT_REASON.specs);
  });
});

test("autonomie-par-paliers/AC-34 : validation des specs renversée pendant /impl → l'humain aux specs, travail gardé ; la revue qui suit n'est plus levée seule", async () => {
  const partial = [{ write: "src/api/export.ts", content: lines(40) }, { sleep: 60_000 }];
  const rules: AutonomyRule[] = [
    { match: { kind: "docs", maxDiffLines: 50 }, require: {}, gates: { specs: "human", review: "auto" } },
    DOCS_SPECS_RULE_S,
  ];
  const world = worldS({ rules, gate: true, impl: [partial, implOf(40, "added")] });
  await withWorldS(world, async () => {
    const run = docsRunS(world);
    // La règle 2 lève les specs ; /impl démarre, écrit son travail et dort.
    await waitFor(
      () => {
        const live = world.store.getRun(run.id);
        return (
          autonomyDecisions(world, run.id).length === 1 &&
          live?.step === "impl" &&
          live.state === "running"
        );
      },
      () => stateOf(world, run.id),
      60_000,
    );
    await waitFor(
      () => world.store.getRun(run.id)?.worktree != null,
      () => stateOf(world, run.id),
    );
    const [decision] = autonomyDecisions(world, run.id);
    assert.equal(decision?.autonomy?.gate, "specs");
    assert.equal(decision?.autonomy?.rule.rank, 2, "la règle 1 ne correspond jamais à la porte specs");
    const worktree = world.store.getRun(run.id)?.worktree as string;
    await waitFor(
      () => git(worktree, "status", "--porcelain").includes("src/api/export.ts") || tracked(worktree),
      () => "le travail de /impl n'est pas écrit",
    );

    // Le renversement, avant le merge.
    const reversed = await world.orchestrator.reverseDecision(
      run.id,
      decision?.seq as number,
      "laisser à l'humain",
      "je relis les specs",
      { by: "humain" },
    );
    assert.equal(reversed.state, "awaiting_human", stateOf(world, run.id));
    assert.equal(humanWaitOf(reversed), "specs");
    assert.equal(eventsOf(world, run.id, "specs_ready").length, 1, "un seul specs_ready (celui du renversement)");
    assert.equal(world.store.getDecision(run.id, decision?.seq as number)?.status, "reversed");
    const rework = eventsOf(world, run.id, "decision_reversed");
    assert.equal(rework.length, 1);
    assert.equal(rework[0]?.payload.mode, "rework");
    assert.match(world.store.instructions(run.id) ?? "", /renversé la validation des specs par l'autonomie/);
    assert.ok(tracked(worktree), "le travail de /impl est commité sur la branche");
    assert.equal(git(worktree, "status", "--porcelain").trim(), "", "rien n'est défait ni laissé sale");

    // L'humain valide les specs : /impl reprend sur la branche gardée, puis la revue juge 40 > 30 lignes.
    await world.orchestrator.validate(run.id, true, "specs relues", { by: "humain" });
    await waitFor(
      () => {
        const live = world.store.getRun(run.id);
        if (live?.state === "merged" || live?.state === "failed") throw new Error(`le run ne devait pas finir : ${stateOf(world, run.id)}`);
        return live?.state === "awaiting_human" && humanWaitOf(live) === "verdict";
      },
      () => stateOf(world, run.id),
      60_000,
    );
    await ticksS(world);
    const waiting = world.store.getRun(run.id);
    assert.equal(waiting?.state, "awaiting_human", stateOf(world, run.id));
    assert.equal(humanWaitOf(waiting as never), "verdict");
    const evidence = JSON.parse(world.store.getArtifact(run.id, "_review-evidence.json") ?? "null") as {
      merge: { auto: boolean };
      evidence: { diffLines: number; maxDiffLines: number; fullTests: string };
    };
    assert.equal(evidence.merge.auto, false);
    assert.equal(evidence.evidence.diffLines, 40);
    assert.equal(evidence.evidence.maxDiffLines, 30);
    assert.equal(evidence.evidence.fullTests, "pass");
    assert.equal(eventsOf(world, run.id, "verdict").length, 1, "le verdict est notifié à l'humain");
    assert.deepEqual(
      eventsOf(world, run.id, "autonomy").map((event) => event.payload.action),
      ["hold", "validate"],
      "aucun nouveau hold ni validate depuis le renversement",
    );
    assert.equal(autonomyDecisions(world, run.id).length, 1, "aucune nouvelle décision d'autonomie");
  });
});

/** Le fichier de /impl est dans l'arbre de `HEAD` (commité). */
function tracked(worktree: string): boolean {
  return git(worktree, "ls-tree", "-r", "--name-only", "HEAD").split("\n").includes("src/api/export.ts");
}

function repoOf(config: HarnessConfig, name = "demo"): RepoConfig {
  const repo = config.repos.find((candidate) => candidate.name === name);
  if (repo === undefined) throw new Error(`dépôt inconnu : ${name}`);
  return repo;
}

function runOf(world: FakeWorld, runId: string) {
  const run = world.store.getRun(runId);
  if (run === null) throw new Error(`run inconnu : ${runId}`);
  return run;
}

// Feature autonomie-par-paliers, partie T : la configuration (AC-2), le type des runs (AC-4, AC-29), les
// exclusions (AC-14 à AC-17, AC-25) et la route de lecture (AC-33).

// ── AC-2 : la configuration refuse une règle mal formée ─────────────────────────────────────────

test("autonomie-par-paliers/AC-2 : une règle au kind inconnu, à la porte inconnue ou mal formée refuse la configuration en nommant le dépôt et le champ", () => {
  const rule = (patch: Record<string, unknown>): unknown => ({ match: { kind: "bug" }, ...patch });
  const cases: [string, unknown, RegExp][] = [
    ["autonomy n'est pas un objet", "oui", /repos\.demo\.autonomy : \{ rules/],
    ["rules n'est pas une liste", { rules: {} }, /repos\.demo\.autonomy\.rules : liste de règles/],
    ["règle avec une clé inconnue", { rules: [rule({ extra: 1 })] }, /repos\.demo\.autonomy\.rules\[0\] : \{ match, require\?, gates\? \}/],
    ["kind inconnu", { rules: [{ match: { kind: "chore" } }] }, /repos\.demo\.autonomy\.rules\[0\]\.match\.kind : bug \| feature \| docs \| deps \| test/],
    ["kind absent", { rules: [{ match: {} }] }, /repos\.demo\.autonomy\.rules\[0\]\.match\.kind/],
    ["clé de match inconnue", { rules: [{ match: { kind: "bug", size: 3 } }] }, /rules\[0\]\.match : kind, maxDiffLines\?, paths\?, labels\?/],
    ["maxDiffLines nul", { rules: [{ match: { kind: "bug", maxDiffLines: 0 } }] }, /rules\[0\]\.match\.maxDiffLines : entier ≥ 1/],
    ["paths absolu", { rules: [{ match: { kind: "bug", paths: ["/etc"] } }] }, /rules\[0\]\.match\.paths : chemins relatifs/],
    ["paths avec ..", { rules: [{ match: { kind: "bug", paths: ["a/../b"] } }] }, /rules\[0\]\.match\.paths : chemins relatifs/],
    ["labels vide", { rules: [{ match: { kind: "bug", labels: [] } }] }, /rules\[0\]\.match\.labels : liste de labels non vides/],
    ["require non booléen", { rules: [rule({ require: { reproTest: "oui" } })] }, /rules\[0\]\.require : \{ reproTest\?, greenChecks\?, proofs\? \} booléens/],
    ["porte specs inconnue", { rules: [rule({ gates: { specs: "maybe" } })] }, /rules\[0\]\.gates\.specs : human \| auto/],
    ["porte review inconnue", { rules: [rule({ gates: { review: "yes" } })] }, /rules\[0\]\.gates\.review : human \| auto/],
    ["clé de gates inconnue", { rules: [rule({ gates: { merge: "auto" } })] }, /rules\[0\]\.gates : \{ specs\?, review\? \}/],
    ["seconde règle fautive", { rules: [rule({}), { match: { kind: "oups" } }] }, /rules\[1\]\.match\.kind/],
  ];
  for (const [name, autonomy, message] of cases) {
    const config = testConfig(harnessRepo("autonomie-cfg-"));
    repoOf(config).autonomy = autonomy as never;
    assert.throws(() => validateConfig(config), message, name);
    assert.throws(() => validateConfig(config), /configuration du harness : /, `${name} : préfixe`);
  }

  // Une règle bien formée est acceptée et normalisée ; un dépôt sans `autonomy` n'en reçoit pas.
  const good = testConfig(harnessRepo("autonomie-cfg-"));
  repoOf(good).autonomy = { rules: [{ match: { kind: "bug" } } as AutonomyRule] };
  validateConfig(good);
  assert.deepEqual(repoOf(good).autonomy, {
    rules: [{ match: { kind: "bug" }, require: {}, gates: { specs: "human", review: "human" } }],
  });
  assert.equal("autonomy" in repoDefaults({ name: "x", path: "/x" }), false);
});

// ── AC-4, AC-29 : le type et les labels d'un run ────────────────────────────────────────────────

const TOKEN = "t".repeat(64);

async function withServer<T>(world: FakeWorld, use: (call: (method: string, route: string, body?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<T>): Promise<T> {
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, token: TOKEN }));
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return await use(async (method, route, body) => {
      const response = await fetch(`${url}${route}`, {
        method,
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, unknown> };
    });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("autonomie-par-paliers/AC-4 : POST /v1/runs déclare type et labels, la vue du run les rend tels quels, et ni le store, ni MCP ne les modifient", async () => {
  const world = bugWorld({ rules: null });
  await world.orchestrator.start();
  try {
    await withServer(world, async (call) => {
      const base = { repo: "demo", title: "Corriger l'export", request: "Corriger" };
      const created = await call("POST", "/v1/runs", { ...base, kind: "bug", labels: [" export ", "export", "ui"] });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const run = created.body.run as { id: string; kind: string; labels: string[] };
      assert.equal(run.kind, "bug");
      assert.deepEqual(run.labels, ["export", "ui"], "rognés, doublons retirés");
      const read = await call("GET", `/v1/runs/${run.id}`);
      const view = (read.body.run ?? read.body) as { kind: string; labels: string[] };
      assert.equal(view.kind, "bug");
      assert.deepEqual(view.labels, ["export", "ui"]);

      const plain = (await call("POST", "/v1/runs", base)).body.run as { kind: unknown; labels: unknown };
      assert.equal(plain.kind, null);
      assert.deepEqual(plain.labels, []);

      const refused: [string, Record<string, unknown>, RegExp][] = [
        ["kind inconnu", { kind: "chore" }, /kind : bug \| feature \| docs \| deps \| test/],
        ["labels n'est pas une liste", { labels: "export" }, /labels : liste de chaînes attendue/],
        ["trop de labels", { labels: Array.from({ length: 21 }, (_, i) => `l${i}`) }, /labels : 20 au plus, de 1 à 50 caractères chacun/],
        ["label vide", { labels: ["  "] }, /labels : 20 au plus/],
        ["label trop long", { labels: ["x".repeat(51)] }, /labels : 20 au plus/],
      ];
      for (const [name, extra, message] of refused) {
        const answer = await call("POST", "/v1/runs", { ...base, ...extra });
        assert.equal(answer.status, 400, name);
        assert.match(JSON.stringify(answer.body), message, name);
      }
    });

    // Aucun chemin ne les modifie ensuite : le patch d'un run ne les connaît pas, et MCP ne les lit pas.
    const [first] = world.store.listRuns({});
    assert.throws(() => world.store.updateRun(first?.id as string, { kind: "docs" } as never), /colonne de run inconnue/);
    assert.throws(() => world.store.updateRun(first?.id as string, { labels: ["x"] } as never), /colonne de run inconnue/);
    const client: Client = { name: "agent", role: "operator", repos: "*", createdAt: 0, approver: false, pilot: false };
    const viaMcp = newRunInput({ repo: "demo", title: "t", request: "r", kind: "bug", labels: ["x"] }, client);
    assert.equal("kind" in viaMcp, false, "run_start ne pose pas de type");
    assert.equal("labels" in viaMcp, false);
  } finally {
    await world.orchestrator.stop();
  }
});

const SPLIT_SPECS = String(OK.specs[0]?.content).replace("## Découpage\naucun", "## Découpage\n- Export JSON — Exporter aussi en JSON — docs");

test("autonomie-par-paliers/AC-29 : un run de suite (revert) et une feature découpée n'héritent ni du type ni des labels de leur parent", async () => {
  // Le revert d'un run mergé seul par l'autonomie ouvre un run de suite sans type.
  const world = bugWorld({ rules: [BUG_REVIEW_RULE] });
  await world.orchestrator.start();
  try {
    const parent = world.orchestrator.createRun({ repo: "demo", title: "Corriger l'export", request: "Corriger", kind: "bug", labels: ["export"] });
    const done = await until(world, parent.id, ["merged", "awaiting_human", "failed"]);
    assert.equal(done.state, "merged", stateOf(world, parent.id));
    assert.deepEqual([done.kind, done.labels], ["bug", ["export"]]);
    const followUp = await world.orchestrator.revert(parent.id, { by: "humain" });
    assert.notEqual(followUp.id, parent.id);
    assert.equal(followUp.kind, null, "le run de suite n'a pas de type");
    assert.deepEqual(followUp.labels, []);
    assert.equal(world.store.getRun(followUp.id)?.kind, null);
    assert.equal(autonomyDecisions(world, followUp.id).length, 0);
  } finally {
    await world.orchestrator.stop();
  }

  // La feature découpée d'un run `bug` : ses enfants naissent sans type.
  const splitWorld = fakeWorld(
    { req: [OK.req], specs: [[{ write: ".harness/specs.md", content: SPLIT_SPECS }]], impl: [[{ sleep: 60_000 }]] },
    { patch: configure([BUG_REVIEW_RULE], (c) => (c.review.specsGate = "auto")) },
  );
  await splitWorld.orchestrator.start();
  try {
    const parent = splitWorld.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter", kind: "bug", labels: ["export"] });
    await until(splitWorld, parent.id, ["awaiting_human", "failed"]);
    assert.equal(humanWaitOf(runOf(splitWorld, parent.id)), "specs", stateOf(splitWorld, parent.id));
    await splitWorld.orchestrator.validate(parent.id, true, "", { by: "humain" });
    await waitFor(() => splitWorld.store.listRuns({ afterRun: parent.id }).length > 0, () => stateOf(splitWorld, parent.id));
    for (const child of splitWorld.store.listRuns({ afterRun: parent.id })) {
      assert.equal(child.kind, null, `${child.title} : sans type`);
      assert.deepEqual(child.labels, [], `${child.title} : sans labels`);
    }
  } finally {
    await splitWorld.orchestrator.stop();
  }
});

// ── AC-14 à AC-17, AC-25 : les exclusions, tenues par le serveur ────────────────────────────────

type Held = { world: FakeWorld; runId: string };

/** Un run `bug` de 40 lignes, preuves vertes, arrivé à l'attente `verdict` (sans règle : l'humain attend). */
async function heldRun(options: { createdBy?: string } = {}): Promise<Held> {
  const world = bugWorld({ rules: null });
  await world.orchestrator.start();
  const run = world.orchestrator.createRun(
    { repo: "demo", title: "Corriger l'export", request: "Corriger", kind: "bug", labels: ["export"] },
    options.createdBy !== undefined ? { by: options.createdBy } : undefined,
  );
  const done = await until(world, run.id, ["awaiting_human", "merged", "failed"]);
  assert.equal(done.state, "awaiting_human", stateOf(world, run.id));
  assert.equal(humanWaitOf(done), "verdict");
  return { world, runId: run.id };
}

function lastAutonomy(held: Held) {
  const events = eventsOf(held.world, held.runId, "autonomy");
  return events[events.length - 1];
}

/**
 * Pose la règle, retient l'attente comme `#drive` l'aurait fait (événement `hold`, en DERNIER pour qu'aucun
 * tour ne passe avant l'exclusion à tester), puis laisse l'autonomie jouer un tour.
 */
async function holdAndTick(held: Held, rules: AutonomyRule[] = [BUG_REVIEW_RULE]): Promise<void> {
  const { world, runId } = held;
  repoOf(world.config).autonomy = { rules };
  const run = world.store.getRun(runId);
  world.store.appendEvent("autonomy", runId, { action: "hold", gate: "review", rev: run?.rev }, "demo");
  await world.orchestrator.tick();
  await waitFor(
    () => lastAutonomy(held)?.payload.action !== "hold" || world.store.getRun(runId)?.state !== "awaiting_human",
    () => `l'autonomie n'a pas joué : ${stateOf(world, runId)}`,
    20_000,
  );
}

/** L'autonomie a renoncé : l'humain attend toujours, `defer` est écrit, l'événement `verdict` est republié, aucune décision. */
function assertDeferred(held: Held, message: string, why?: RegExp): void {
  const { world, runId } = held;
  assert.equal(world.store.getRun(runId)?.state, "awaiting_human", `${message} : ${stateOf(world, runId)}`);
  assert.equal(lastAutonomy(held)?.payload.action, "defer", `${message} : defer écrit`);
  if (why) assert.match(String(lastAutonomy(held)?.payload.why), why, `${message} : raison du renoncement`);
  assert.equal(autonomyDecisions(world, runId).length, 0, `${message} : aucune décision prise seule`);
  assert.equal(eventsOf(world, runId, "autonomy").filter((e) => e.payload.action === "validate").length, 0, `${message} : aucun validate`);
  assert.equal(eventsOf(world, runId, "verdict").length, 2, `${message} : la notification part (à la pose, puis au renoncement)`);
}

async function withHeld(options: { createdBy?: string }, use: (held: Held) => Promise<void>): Promise<void> {
  const held = await heldRun(options);
  try {
    await use(held);
  } finally {
    await held.world.orchestrator.stop();
  }
}

function stepIdOf(held: Held): number {
  const last = held.world.store.listSteps(held.runId).at(-1);
  if (last === undefined) throw new Error("aucune étape");
  return last.id;
}

test("autonomie-par-paliers/AC-14 : une attente de budget ou un budget dépassé n'est jamais levé seul ; une priorité changée n'empêche pas la validation", async () => {
  // Témoin (S-11, AC-7) : la priorité change entre la pose de l'attente et le tour ; le run est quand même fusionné.
  await withHeld({}, async (held) => {
    await held.world.orchestrator.setPriority(held.runId, 5, { by: "humain" });
    await holdAndTick(held);
    const done = await until(held.world, held.runId, ["merged", "failed"]);
    assert.equal(done.state, "merged", stateOf(held.world, held.runId));
    assert.equal(autonomyDecisions(held.world, held.runId).length, 1);
  });

  // Une attente de budget (humanWaitOf = budget) : jamais retenue ni levée.
  await withHeld({}, async (held) => {
    held.world.store.updateRun(held.runId, { reason: `${WAIT_REASON.budget} (12 $ sur 10 $)` });
    assert.equal(humanWaitOf(runOf(held.world, held.runId)), "budget");
    await holdAndTick(held);
    assertDeferred(held, "attente budget", /budget/);
  });

  // Le budget est dépassé avant le tour, après un geste qui ne tranche pas l'attente : defer, `verdict` publié une fois.
  await withHeld({}, async (held) => {
    await held.world.orchestrator.setPriority(held.runId, 5, { by: "humain" });
    held.world.config.monitoring.runBudgetUsd = 0;
    await holdAndTick(held);
    assertDeferred(held, "budget dépassé", /budget dépassé/);
  });
});

test("autonomie-par-paliers/AC-15 : un run qui a porté une escalade schema, public_api ou deletion, close ou non, n'est jamais validé seul", async () => {
  const cases: { category: "schema" | "public_api" | "deletion"; by: "humain" | "échéance" | "ouverte" }[] = [
    { category: "schema", by: "échéance" },
    { category: "public_api", by: "échéance" },
    { category: "schema", by: "humain" },
    { category: "public_api", by: "humain" },
    { category: "deletion", by: "humain" },
    { category: "deletion", by: "ouverte" },
  ];
  for (const item of cases) {
    const name = `${item.category} (${item.by})`;
    await withHeld({}, async (held) => {
      const { store } = held.world;
      const escalation = store.addEscalation({
        runId: held.runId,
        stepId: stepIdOf(held),
        category: item.category,
        question: "Que faire ?",
        options: ["a", "b"],
        context: "contexte",
      });
      if (item.by === "humain") store.answerEscalation(escalation.id, "a", "humain", "ok");
      if (item.by === "échéance") store.answerEscalation(escalation.id, "a", null, "échéance");
      await holdAndTick(held);
      assertDeferred(held, name, /escalade/);
    });
  }
  // Une escalade ouverte d'une catégorie réversible bloque aussi ; close, elle ne bloque plus (témoin : le run est fusionné).
  await withHeld({}, async (held) => {
    const escalation = held.world.store.addEscalation({
      runId: held.runId,
      stepId: stepIdOf(held),
      category: "reversible",
      question: "Quel nom ?",
      options: ["a", "b"],
      context: "contexte",
    });
    await holdAndTick(held);
    assertDeferred(held, "escalade réversible ouverte", /escalade ouverte/);
    held.world.store.answerEscalation(escalation.id, "a", "humain", "ok");
  });
});

test("autonomie-par-paliers/AC-16 : un run créé par le client de la vigie, sa correction d'incident ou sa descendance n'est jamais validé seul", async () => {
  const vigieClient: Client = { name: "sentinelle", role: "operator", repos: "*", createdAt: 0, approver: false, pilot: true };

  await withHeld({ createdBy: "sentinelle" }, async (held) => {
    held.world.orchestrator.vigie.heartbeat({}, vigieClient, Date.now());
    await holdAndTick(held);
    assertDeferred(held, "run créé par le client de la vigie", /vigie/);
  });

  await withHeld({}, async (held) => {
    const { store } = held.world;
    store.createVigieIncident({
      fingerprint: "fp-1",
      source: "server",
      location: "src/api/export.ts",
      message: "TypeError",
      repo: "demo",
      runId: null,
      status: "bug",
      context: null,
      note: null,
      at: Date.now(),
    });
    store.updateVigieIncident("fp-1", { fixRunId: held.runId });
    await holdAndTick(held);
    assertDeferred(held, "run de correction d'un incident", /vigie/);
  });

  await withHeld({}, async (held) => {
    const { store } = held.world;
    held.world.orchestrator.vigie.heartbeat({}, vigieClient, Date.now());
    store.createRun({ id: "vigie-parent", repo: "demo", slug: "vigie-parent", title: "Correction", request: "x", branch: "harness/vigie-parent", createdBy: "sentinelle" });
    store.appendEvent("follow_up", "vigie-parent", { runId: held.runId });
    await holdAndTick(held);
    assertDeferred(held, "descendant d'un run de la vigie", /vigie/);
  });

  // Témoin : sans lien avec la vigie, le même montage est fusionné.
  await withHeld({}, async (held) => {
    held.world.orchestrator.vigie.heartbeat({}, vigieClient, Date.now());
    await holdAndTick(held);
    const done = await until(held.world, held.runId, ["merged", "failed"]);
    assert.equal(done.state, "merged", stateOf(held.world, held.runId));
  });
});

test("autonomie-par-paliers/AC-17 : un arbitrage (plafond de corrections, contestation) ou une relance après panne n'est jamais levé seul", async () => {
  const cases: [string, string, string][] = [
    ["plafond de corrections", `${WAIT_REASON.fixCap} (2) avec 1 bloquant(s)`, "arbitration"],
    ["contestation", WAIT_REASON.contest, "arbitration"],
    ["échecs répétés", "3 échecs consécutifs de /impl", "failure"],
    ["merge arrêté", "suite complète rouge — plafond de tentatives de merge atteint", "failure"],
  ];
  for (const [name, reason, wait] of cases) {
    await withHeld({}, async (held) => {
      held.world.store.updateRun(held.runId, { reason });
      assert.equal(humanWaitOf(runOf(held.world, held.runId)), wait, name);
      await holdAndTick(held);
      assertDeferred(held, name);
    });
  }
});

/** Réécrit l'évidence et le verdict de la revue d'un run (le merge est recalculé comme `#close` l'aurait fait). */
function rewriteReview(held: Held, change: (verdict: Verdict, evidence: ReviewEvidence) => void): void {
  const { store } = held.world;
  const run = store.getRun(held.runId);
  const saved = JSON.parse(store.getArtifact(held.runId, REVIEW_EVIDENCE) as string) as { evidence: ReviewEvidence };
  const verdict = structuredClone(run?.verdict) as Verdict;
  const evidence = structuredClone(saved.evidence);
  change(verdict, evidence);
  const merge = mergeDecision(verdict, evidence);
  const stepId = stepIdOf(held);
  store.transaction(() => {
    store.updateRun(held.runId, { verdict });
    store.putArtifact(held.runId, REVIEW_EVIDENCE, JSON.stringify({ merge, evidence }), stepId);
  });
}

test("autonomie-par-paliers/AC-25 : toute autre raison d'auto-merge refusé que le diff, seule ou jointe à un diff de 40 lignes, laisse l'attente à l'humain", async () => {
  const reasons: [string, (verdict: Verdict, evidence: ReviewEvidence) => void][] = [
    ["bloquant", (v) => void v.blockers.push("une régression")],
    ["risque au-dessus du plafond", (v) => void (v.risk = "high")],
    ["suite complète rouge", (_v, e) => void (e.fullTests = "fail")],
    ["suite complète non lancée", (_v, e) => void (e.fullTests = "not_run")],
    ["escalade ouverte", (_v, e) => void (e.openEscalations = 1)],
    ["critère absent du verdict", (_v, e) => void (e.acIds = ["AC-1", "AC-2"])],
    ["critère non prouvé", (v) => void (v.criteria = [{ id: "AC-1", test: "x", status: "fail" }])],
    ["critère non vérifié", (v) => void v.unverified.push("AC-1 : export non rejoué")],
    ["critère validé modifié depuis /specs", (_v, e) => void (e.specsDrift = [{ id: "AC-1", validated: "Given a", current: "Given b" }])],
    ["fichier touché non relu", (_v, e) => void e.touchedFiles.push("src/api/autre.ts")],
    ["verdict faible", (v) => void (v.confidence = "weak")],
  ];
  const held = await heldRun();
  try {
    // Témoin : tel quel, le diff est la seule raison — mais on ne le laisse pas fusionner ici (on le réécrit à chaque cas).
    const original = {
      verdict: structuredClone(held.world.store.getRun(held.runId)?.verdict) as Verdict,
      saved: held.world.store.getArtifact(held.runId, REVIEW_EVIDENCE) as string,
    };
    for (const [name, apply] of reasons) {
      for (const joined of [false, true]) {
        const label = `${name}${joined ? " + diff de 40 lignes" : " seule (diff sous le seuil)"}`;
        held.world.store.transaction(() => {
          held.world.store.updateRun(held.runId, { verdict: structuredClone(original.verdict) });
          held.world.store.putArtifact(held.runId, REVIEW_EVIDENCE, original.saved, stepIdOf(held));
        });
        rewriteReview(held, (verdict, evidence) => {
          if (!joined) evidence.diffLines = 10;
          apply(verdict, evidence);
        });
        const before = eventsOf(held.world, held.runId, "verdict").length;
        await holdAndTick(held);
        const run = held.world.store.getRun(held.runId);
        assert.equal(run?.state, "awaiting_human", `${label} : ${stateOf(held.world, held.runId)}`);
        assert.equal(lastAutonomy(held)?.payload.action, "defer", `${label} : defer`);
        assert.equal(autonomyDecisions(held.world, held.runId).length, 0, `${label} : aucune décision prise seule`);
        assert.equal(eventsOf(held.world, held.runId, "verdict").length, before + 1, `${label} : la notification part`);
      }
    }
  } finally {
    await held.world.orchestrator.stop();
  }
});

// ── AC-33 : GET /v1/autonomy ────────────────────────────────────────────────────────────────────

function proofOfT(rule: AutonomyRule): AutonomyProof {
  return { gate: "review", rule: { rank: 1, ...rule }, proofs: { diffLines: 40 } };
}

test("autonomie-par-paliers/AC-33 : GET /v1/autonomy rend règles, validations et propositions des seuls dépôts visibles, et aucune route n'écrit une règle", async () => {
  const other = harnessRepo("autonomie-autre-");
  const world = bugWorld({
    rules: [BUG_REVIEW_RULE],
    patch: (config: HarnessConfig) => {
      config.autonomyLearning.minRuns = 2;
      const autre = repoDefaults({ name: "autre", path: other, scope: "autre-scope" });
      autre.autonomy = { rules: [BUG_REVIEW_RULE] };
      config.repos.push(autre);
    },
  });
  await world.orchestrator.start();
  const clients = new ClientRegistry(path.join(tmpdir("autonomie-clients-"), "clients.json"), TOKEN);
  const all = clients.add("tableau", "viewer", "*").token;
  const narrow = clients.add("ipad", "viewer", ["demo"]).token;
  const server = http.createServer(createHandler({ orchestrator: world.orchestrator, clients }));
  try {
    // Une validation prise seule dans `demo` (le pipeline complet).
    const run = world.orchestrator.createRun({ repo: "demo", title: "Corriger l'export", request: "Corriger", kind: "bug", labels: ["export"] });
    const done = await until(world, run.id, ["merged", "awaiting_human", "failed"]);
    assert.equal(done.state, "merged", stateOf(world, run.id));

    // Une validation prise seule dans `autre`, et deux refus humains par dépôt : une proposition `lower` de chacun.
    const { store } = world;
    for (const repo of ["demo", "autre"]) {
      for (const n of [1, 2]) {
        const id = `${repo}-refus-${n}`;
        store.createRun({ id, repo, slug: id, title: id, request: "x", branch: `harness/${id}`, kind: "bug" });
        store.appendEvent("validation", id, { gate: "verdict", approve: false, liftable: true, by: "humain" });
      }
    }
    store.createRun({ id: "autre-auto", repo: "autre", slug: "autre-auto", title: "Autre", request: "x", branch: "harness/autre-auto", kind: "bug" });
    const step = store.startStep("autre-auto", "impl", 1, null, null);
    store.addDecision(
      { runId: "autre-auto", stepId: step.id, question: "Valider ?", options: ["valider", "laisser à l'humain"], chosen: "valider", rationale: "r", category: "reversible", checkpointSha: null, dependsOn: [], autonomy: proofOfT(BUG_REVIEW_RULE) },
      "auto",
    );

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const call = async (token: string, method: string, route: string) => {
      const response = await fetch(`${url}${route}`, { method, headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, body: (await response.json().catch(() => ({}))) as Record<string, any> };
    };
    const rulesBefore = JSON.stringify(repoOf(world.config).autonomy);

    const seen = await call(narrow, "GET", "/v1/autonomy");
    assert.equal(seen.status, 200);
    assert.deepEqual(seen.body.repos, [{ repo: "demo", rules: [BUG_REVIEW_RULE] }], "les règles du seul dépôt visible");
    assert.equal(seen.body.validations.length, 1, "la seule validation de demo");
    const [validation] = seen.body.validations;
    assert.equal(validation.runId, run.id);
    assert.equal(validation.autonomy.gate, "review");
    assert.equal(validation.autonomy.rule.rank, 1);
    assert.deepEqual(validation.autonomy.rule.match, BUG_REVIEW_RULE.match);
    assert.equal(validation.autonomy.proofs.diffLines, 40);
    assert.ok(validation.step, "la décision porte son étape");
    assert.ok(seen.body.proposals.length >= 1);
    for (const proposal of seen.body.proposals) assert.equal(proposal.repo, "demo", "aucune proposition d'un autre dépôt");
    const lower = seen.body.proposals.find((p: Record<string, unknown>) => p.direction === "lower" && p.kind === "bug" && p.gate === "review");
    assert.deepEqual(lower?.changes, [{ path: "repos.demo.autonomy.rules[0].gates.review", value: "human" }]);

    const full = await call(all, "GET", "/v1/autonomy");
    assert.deepEqual(full.body.repos.map((r: { repo: string }) => r.repo).sort(), ["autre", "demo"]);
    assert.equal(full.body.validations.length, 2);
    assert.ok(full.body.proposals.some((p: { repo: string }) => p.repo === "autre"));

    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const refused = await call(all, method, "/v1/autonomy");
      assert.equal(refused.status, 405, `${method} /v1/autonomy`);
    }
    const health = await call(all, "GET", "/v1/health");
    assert.ok((health.body.features as string[]).includes("autonomy"), "drapeau de capacité");
    assert.equal(JSON.stringify(repoOf(world.config).autonomy), rulesBefore, "les règles sont inchangées");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.orchestrator.stop();
  }
});
