// Feature harness-decisions : la politique de décision — réversible → checkpoint,
// irréversible (schéma, API publique, suppression) → escalade ; le service ne fait
// que durcir la catégorie déclarée.
import test from "node:test";
import assert from "node:assert/strict";
import {
  checkpointMessage,
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
  assert.match((planDecision({ ...base, chosen: "autre" }) as { error: string }).error, /une des options/);
  assert.match((planDecision({ ...base, options: ["seule"] }) as { error: string }).error, /deux options/);
  assert.match((planDecision({ ...base, rationale: "" }) as { error: string }).error, /rationale/);
  assert.match((planDecision({ ...base, category: "peut-être" }) as { error: string }).error, /category/);
});

test("harness-decisions/AC-5 : le commit de checkpoint s'appelle « decision: … » et porte un trailer qui survit au rebase", () => {
  const message = checkpointMessage("r1", 4, base);
  assert.match(message, /^decision: Nom du champ \? → exportedAt\n/);
  assert.deepEqual(parseCheckpointTrailer(message), { runId: "r1", seq: 4 });
  assert.equal(parseCheckpointTrailer("wip(impl): x"), null);
});
