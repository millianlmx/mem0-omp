// Feature harness-decisions : la politique de décision — réversible → checkpoint,
// irréversible (schéma, API publique, suppression) → escalade ; le service ne fait
// que durcir la catégorie déclarée.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointMessage,
  dependentsOf,
  detectIrreversible,
  parseCheckpointTrailer,
  planDecision,
} from "../../omp-harness/decisions.ts";

const base = {
  question: "Nom du champ ?",
  options: ["exportedAt", "exportDate"],
  chosen: "exportedAt",
  rationale: "convention camelCase",
  category: "reversible",
};

test("harness-decisions/AC-1 : une décision réversible valide devient un checkpoint", () => {
  const parsed = planDecision(base);
  assert.equal(parsed.ok && parsed.plan.kind, "checkpoint");
});

test("harness-decisions/AC-2 : schéma, API publique et suppression déclarés partent en escalade", () => {
  for (const category of ["schema", "public_api", "deletion"]) {
    const parsed = planDecision({ ...base, category });
    assert.ok(
      parsed.ok && parsed.plan.kind === "escalate" && parsed.plan.category === category && !parsed.plan.hardened,
    );
  }
});

test("harness-decisions/AC-3 : une décision déclarée réversible mais qui trahit l'irréversible est durcie, jamais l'inverse", () => {
  const drop = planDecision({ ...base, question: "Nettoyer ?", rationale: "on fait DROP COLUMN legacy" });
  assert.ok(drop.ok && drop.plan.kind === "escalate" && drop.plan.category === "schema" && drop.plan.hardened);
  assert.equal(detectIrreversible("exposer dans l'API publique"), "public_api");
  assert.equal(detectIrreversible("supprimer les données des comptes inactifs"), "deletion");
  assert.equal(detectIrreversible("supprimer une variable locale inutile"), null);
  assert.equal(detectIrreversible("renommer une fonction privée"), null);
});

test("harness-decisions/AC-4 : une décision mal formée est refusée avec un motif lisible", () => {
  const error = (raw: unknown) => {
    const parsed = planDecision(raw);
    return parsed.ok ? "" : parsed.error;
  };
  assert.match(error({ ...base, chosen: "autre" }), /une des options/);
  assert.match(error({ ...base, options: ["seule"] }), /deux options/);
  assert.match(error({ ...base, options: undefined }), /deux options/, "options est obligatoire");
  assert.match(error({ ...base, options: ["a", "b", "c", "d", "e"], chosen: "a" }), /au plus 4 options/);
  assert.match(error({ ...base, options: ["a", "a"], chosen: "a" }), /identiques/);
  assert.match(error({ ...base, rationale: "" }), /rationale/);
  assert.match(error({ ...base, category: "peut-être" }), /category/);
  const four = planDecision({ ...base, options: ["a", "b", "c", "d"], chosen: "d" });
  assert.ok(four.ok && four.plan.kind === "checkpoint", "quatre options passent");
});

test("harness-decisions/AC-7 : une clarification (produit, UX) est réversible — checkpoint, jamais d'escalade, sauf si le texte trahit l'irréversible", () => {
  const parsed = planDecision({ ...base, category: "clarification" });
  assert.ok(parsed.ok && parsed.plan.kind === "checkpoint");
  assert.equal(parsed.ok && parsed.plan.input.category, "clarification", "la catégorie déclarée est gardée");
  const hardened = planDecision({ ...base, category: "clarification", rationale: "on fait DROP TABLE legacy" });
  assert.ok(hardened.ok && hardened.plan.kind === "escalate" && hardened.plan.category === "schema");
});

test("harness-decisions/AC-5 : le commit de checkpoint s'appelle « decision: … » et porte un trailer qui survit au rebase", () => {
  const message = checkpointMessage("r1", 4, base);
  assert.match(message, /^decision: Nom du champ \? → exportedAt\n/);
  assert.deepEqual(parseCheckpointTrailer(message), { runId: "r1", seq: 4 });
  assert.equal(parseCheckpointTrailer("wip(impl): x"), null);
});

test("harness-decisions/AC-6 : une décision cite celles dont elle découle ; un renversement n'emporte que ses dépendantes, transitivement", () => {
  const parsed = planDecision({ ...base, dependsOn: [3, 1, 3] });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.ok && parsed.plan.input.dependsOn, [1, 3], "triées, sans doublon");
  const bare = planDecision(base);
  assert.deepEqual(bare.ok && bare.plan.input.dependsOn, []);
  const error = (raw: unknown) => {
    const result = planDecision(raw);
    return result.ok ? "" : result.error;
  };
  assert.match(error({ ...base, dependsOn: [0] }), /dependsOn/);
  assert.match(error({ ...base, dependsOn: "1" }), /dependsOn/);

  const run = [
    { seq: 1, dependsOn: [] },
    { seq: 2, dependsOn: [1] },
    { seq: 3, dependsOn: [] },
    { seq: 4, dependsOn: [2] },
    { seq: 5, dependsOn: [3] },
  ];
  assert.deepEqual(dependentsOf(run, 1), [2, 4]);
  assert.deepEqual(dependentsOf(run, 3), [5]);
  assert.deepEqual(dependentsOf(run, 4), []);
});
