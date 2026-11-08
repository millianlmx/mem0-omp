// Feature autonomie-par-paliers, partie L : l'apprentissage borné (autonomyProposals, S-17) et le rapport du matin (AC-30).
import test from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { autonomyProposals } from "../../omp-harness/autonomy-learning.ts";
import type { AutonomyProposal } from "../../omp-harness/autonomy-learning.ts";
import type { AutonomyProof, AutonomyRule, WorkKind } from "../../omp-harness/autonomy-rules.ts";
import { ClientRegistry } from "../../omp-harness/auth.ts";
import { repoDefaults } from "../../omp-harness/config.ts";
import type { HarnessConfig } from "../../omp-harness/config.ts";
import { Store } from "../../omp-harness/db.ts";
import { digestOf } from "../../omp-harness/digest.ts";
import { createHandler } from "../../omp-harness/http.ts";
import { fakeWorld, testConfig } from "../support/harness-fixtures.ts";
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

test("autonomie-par-paliers/AC-20 : la forme de changes, le tri, le filtre repos, le pilote d'audit et la fenêtre (S-17)", () => {
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
