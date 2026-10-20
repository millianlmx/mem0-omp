// Tests de l'audit pertinence × rapidité, volet VERDICT : le champ BLOQUANTS est
// croisé avec la table AC PAR AC (omp-mem0-req/contract.ts), une ligne ambiguë
// rend le verdict illisible, et la revue illisible reprend sa session avec une
// consigne de réécriture (omp-mem0-req/chain.ts). Un test par critère, titre
// `verdict-croise/AC-<n> : …`.
import test from "node:test";
import assert from "node:assert/strict";
import {
  isAmbiguous,
  isVacuous,
  reviewAcTable,
  reviewBlockerList,
  reviewBlockers,
  reviewImpliedBlockers,
  reviewVerdict,
} from "../../omp-mem0-req/contract.ts";
import { REVIEW_UNREADABLE_REFOCUS, nextChainAction, reviewScopeFor } from "../../omp-mem0-req/chain.ts";
import { buildImplSeed } from "../../omp-mem0-req/seeds.ts";

const CRITERES = "## Critères d'acceptation\n\nAC-1 (B-1) : un.\nAC-2 (B-1) : deux.\nAC-3 (B-1) : trois.\n";

/** Un contrat à trois AC dont la `## Revue` a le corps `lines`. */
function contract(...lines: string[]): string {
  return [CRITERES, "## Revue", "", ...lines, ""].join("\n");
}

/** Verdict et compte, lus ensemble : l'invariant verdict/compte tient toujours. */
function read(c: string): [string, number] {
  const verdict = reviewVerdict(c);
  const count = reviewBlockers(c);
  assert.equal(verdict === "blockers", count >= 1, `invariant verdict/compte : ${verdict} / ${count}`);
  return [verdict, count];
}

test("verdict-croise/AC-1 : contradiction — BLOQUANTS : aucun avec un AC en fail dans AC PAR AC rend blockers, un bloquant par AC", () => {
  const c = contract(
    "- STATUT : APPROUVÉ",
    "- AC PAR AC :",
    "  - AC-1 → test/x.test.ts:10 → pass",
    "  - AC-2 → test/x.test.ts:20 → fail",
    "  - AC-3 → aucun test",
    "- BLOQUANTS : aucun",
  );
  assert.deepEqual(reviewAcTable(c), [
    { id: "AC-1", status: "pass" },
    { id: "AC-2", status: "fail" },
    { id: "AC-3", status: "missing" },
  ]);
  assert.deepEqual(reviewImpliedBlockers(c), [
    "AC-2 : échec en AC PAR AC",
    "AC-3 : non prouvé en AC PAR AC (aucun test)",
  ]);
  assert.deepEqual(read(c), ["blockers", 2]);
  assert.deepEqual(reviewBlockerList(c), reviewImpliedBlockers(c));
});

test("verdict-croise/AC-2 : AC manquant — un id du contrat absent d'une table présente est un bloquant", () => {
  const c = contract(
    "- AC PAR AC :",
    "  - AC-1 → test/x.test.ts:10 → pass",
    "  - AC-2 : test/x.test.ts:20 -> pass",
    "- BLOQUANTS : aucun",
  );
  assert.deepEqual(reviewImpliedBlockers(c), ["AC-3 : non prouvé en AC PAR AC (absent de la table)"]);
  assert.deepEqual(read(c), ["blockers", 1]);
  // Sans aucune table, rien n'est croisé : le champ BLOQUANTS seul décide (limite connue).
  assert.deepEqual(read(contract("- STATUT : APPROUVÉ", "- BLOQUANTS : aucun")), ["clean", 0]);
  assert.deepEqual(reviewImpliedBlockers(contract("- BLOQUANTS : aucun")), []);
});

test("verdict-croise/AC-3 : cohérent — table complète en pass et BLOQUANTS : aucun rend clean ; formes tolérées", () => {
  const forms = [
    [
      "- AC PAR AC :",
      "  - AC-1 → test/x.test.ts:10 → pass",
      "  - AC-2 -> test/x.test.ts:20 -> pass",
      "  - AC-3 : test/x.test.ts:30 : pass",
    ],
    [
      "- AC PAR AC :",
      "| AC-1 | test/x.test.ts:10 | pass |",
      "| AC-2 | test/x.test.ts:20 | ok |",
      "| AC-3 | test/x.test.ts:30 | passe |",
    ],
    ["- **AC PAR AC** : AC-1 → t:1 → pass", "  AC-2 → t:2 → pass", "  AC-3 → t:3 → pass"],
  ];
  for (const table of forms) {
    const c = contract(...table, "- BLOQUANTS : aucun", "- RECOMMANDATIONS : x");
    assert.deepEqual(
      reviewAcTable(c).map((row) => row.status),
      ["pass", "pass", "pass"],
      table.join(" | "),
    );
    assert.deepEqual(read(c), ["clean", 0], table.join(" | "));
  }
  // Un statut hors vocabulaire n'est pas un bloquant ; « sans test » en est un.
  assert.deepEqual(
    reviewAcTable(
      contract(
        "- AC PAR AC :",
        "  - AC-1 → t:1 → voir plus bas",
        "  - AC-2 → sans test → fail",
        "  - AC-3 → sans test",
      ),
    ),
    [
      { id: "AC-1", status: "unknown" },
      { id: "AC-2", status: "fail" },
      { id: "AC-3", status: "missing" },
    ],
  );
  // Un champ BLOQUANTS explicite s'ajoute aux impliqués.
  const both = contract(
    "- AC PAR AC :",
    "  - AC-1 → t:1 → pass",
    "  - AC-2 → t:2 → fail",
    "  - AC-3 → t:3 → pass",
    "- BLOQUANTS :",
    "1. le README manque",
  );
  assert.deepEqual(read(both), ["blockers", 2]);
  assert.deepEqual(reviewBlockerList(both), ["1. le README manque", "AC-2 : échec en AC PAR AC"]);
});

test("verdict-croise/AC-4 : « aucun bloquant » suivi d'un texte ou une ligne numérotée barrée est ambigu : illisible, plus jamais clean", () => {
  for (const line of [
    "Aucun bloquant ; voir recommandations",
    "Aucun bloquant mais AC-2 reste à prouver",
    "aucun bloquant sauf le README",
    "1. ~~AC-4 manquant~~",
  ]) {
    assert.equal(isAmbiguous(line), true, line);
    assert.equal(isVacuous(line), false, line);
  }
  for (const line of ["Aucun bloquant.", "aucun", "~~AC-4 manquant~~", "0 (les 2 bloquants précédents sont levés)"]) {
    assert.equal(isAmbiguous(line), false, line);
    assert.equal(isVacuous(line), true, line);
  }
  assert.deepEqual(read(contract("- BLOQUANTS : Aucun bloquant ; voir recommandations")), ["unreadable", 0]);
  assert.deepEqual(read(contract("- BLOQUANTS :", "1. ~~levé~~")), ["unreadable", 0]);
  // Un bloquant explicite prime sur l'ambigu : il y a de quoi corriger.
  assert.deepEqual(read(contract("- BLOQUANTS :", "1. ~~levé~~", "2. le test AC-2 manque")), ["blockers", 1]);
  // Un jeton nu suivi d'un texte reste un bloquant, pas une ambiguïté.
  assert.deepEqual(read(contract("- BLOQUANTS : 0 ; manque le test AC-2")), ["blockers", 1]);
});

test("verdict-croise/AC-5 : une revue illisible sous le plafond reprend sa session avec la consigne de réécriture ; le plafond bloque", () => {
  const base = { phase: "review" as const, outcome: "ok" as const, fixes: 0, cap: 3 };
  const ambiguous = contract("- BLOQUANTS : Aucun bloquant ; voir recommandations");
  assert.deepEqual(nextChainAction({ ...base, contract: ambiguous, unreadableRuns: 0 }), {
    kind: "run",
    phase: "review",
    fix: false,
    resume: true,
    refocus: REVIEW_UNREADABLE_REFOCUS,
  });
  assert.deepEqual(nextChainAction({ ...base, contract: ambiguous, unreadableRuns: 3 }), {
    kind: "blocked",
    reason: "verdict de revue illisible après 3 passes",
  });
  // La contradiction table/champ n'est pas illisible : elle part en correction.
  const contradiction = contract(
    "- AC PAR AC :",
    "  - AC-1 → t:1 → fail",
    "  - AC-2 → t:2 → pass",
    "  - AC-3 → t:3 → pass",
    "- BLOQUANTS : aucun",
  );
  assert.deepEqual(nextChainAction({ ...base, contract: contradiction }), { kind: "run", phase: "impl", fix: true });
  assert.match(REVIEW_UNREADABLE_REFOCUS, /- BLOQUANTS : aucun/);
});

test("verdict-croise/AC-6 : la graine --fix cite les bloquants impliqués par la table", () => {
  const seed = buildImplSeed("", true, {
    impliedBlockers: ["AC-2 : échec en AC PAR AC", "AC-3 : non prouvé en AC PAR AC (aucun test)"],
  });
  assert.match(seed, /^\[impl --fix\]/);
  assert.ok(
    seed.includes(
      "Bloquants impliqués par la table AC PAR AC de la revue (à lever comme ceux du champ BLOQUANTS) :\n- AC-2 : échec en AC PAR AC\n- AC-3 : non prouvé en AC PAR AC (aucun test)\n\n",
    ),
  );
  assert.equal(buildImplSeed("", true).includes("Bloquants impliqués"), false);
  assert.equal(
    buildImplSeed("", false, { impliedBlockers: ["x"] }).includes("Bloquants impliqués"),
    false,
    "sans --fix, rien à lever",
  );
});

test("verdict-croise/AC-7 : reviewScopeFor — intégrale au premier tour et aux deux derniers, incrémentale entre", () => {
  assert.equal(reviewScopeFor({ fixes: 0, cap: 3 }), "full");
  assert.equal(reviewScopeFor({ fixes: 1, cap: 3 }), "incremental");
  assert.equal(reviewScopeFor({ fixes: 2, cap: 3 }), "full");
  assert.equal(reviewScopeFor({ fixes: 3, cap: 3 }), "full");
  assert.equal(reviewScopeFor({ fixes: 1, cap: 5 }), "incremental");
  assert.equal(reviewScopeFor({ fixes: 3, cap: 5 }), "incremental");
  assert.equal(reviewScopeFor({ fixes: 4, cap: 5 }), "full");
  assert.equal(reviewScopeFor({ fixes: 1, cap: 1 }), "full");
});
