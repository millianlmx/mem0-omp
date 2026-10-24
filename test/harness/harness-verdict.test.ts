// Feature harness-verdict : le verdict structuré de /review et la règle d'auto-merge.
import test from "node:test";
import assert from "node:assert/strict";
import { mergeDecision, parseAcIds, parseVerdict } from "../../omp-harness/verdict.ts";
import type { MergeEvidence, Verdict } from "../../omp-harness/verdict.ts";

const verdict: Verdict = {
  risk: "low",
  summary: "s",
  blockers: [],
  risks: [],
  files: ["a.ts", "b.ts"],
  unverified: [],
  criteria: [
    { id: "AC-1", test: "x/AC-1", status: "pass" },
    { id: "AC-2", test: "x/AC-2", status: "pass" },
  ],
  confidence: "strong",
};
const evidence: MergeEvidence = {
  fullTests: "pass",
  diffLines: 120,
  maxDiffLines: 300,
  openEscalations: 0,
  acIds: ["AC-1", "AC-2"],
  specsDrift: [],
  autoMergeRisk: "medium",
  touchedFiles: ["a.ts", "b.ts"],
};

test("harness-verdict/AC-1 : un verdict se valide champ par champ ; risque, résumé, fichiers, criteria et confiance sont requis", () => {
  assert.equal(parseVerdict(verdict).ok, true);
  const bad = parseVerdict({ risk: "nul", summary: "", files: [] });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.errors.length, 5);
  assert.equal(parseVerdict([]).ok, false);
  const noConfidence = parseVerdict({ ...verdict, confidence: undefined });
  assert.ok(!noConfidence.ok && noConfidence.errors.some((e) => /confidence/.test(e)), "plus de défaut strong");
  const badCriteria = parseVerdict({ ...verdict, criteria: [{ id: "AC-1", test: "t", status: "peut-être" }] });
  assert.ok(!badCriteria.ok && badCriteria.errors.some((e) => /criteria/.test(e)));
});

test("harness-verdict/AC-2 : risque sous le plafond + suite verte + petite PR + chaque AC prouvé + fichiers relus → auto-merge", () => {
  assert.deepEqual(mergeDecision(verdict, evidence), { auto: true });
  assert.deepEqual(
    mergeDecision({ ...verdict, risk: "medium" }, evidence),
    { auto: true },
    "medium ≤ autoMergeRisk medium",
  );
  assert.deepEqual(mergeDecision(verdict, { ...evidence, autoMergeRisk: "low" }), { auto: true });
});

test("harness-verdict/AC-3 : chaque écart à la règle renvoie à l'humain, avec sa raison", () => {
  const cases: [Partial<Verdict>, Partial<MergeEvidence>, RegExp][] = [
    [{ risk: "medium" }, { autoMergeRisk: "low" }, /risque medium/],
    [{ risk: "high" }, {}, /risque high/],
    [{ blockers: ["b"] }, {}, /1 bloquant/],
    [{}, { fullTests: "fail" }, /suite complète rouge/],
    [{}, { fullTests: "not_run" }, /non lancée/],
    [{}, { diffLines: 301 }, /301 lignes/],
    [{}, { openEscalations: 1 }, /escalade/],
    [{}, { acIds: ["AC-1", "AC-2", "AC-3"] }, /absent.*AC-3/],
    [{ criteria: [verdict.criteria[0]!, { id: "AC-2", test: "x/AC-2", status: "fail" }] }, {}, /non prouvé.*AC-2 fail/],
    [{ criteria: [verdict.criteria[0]!, { id: "AC-2", test: "", status: "untested" }] }, {}, /AC-2 untested/],
    [{ files: ["a.ts"] }, {}, /non relus : b\.ts/],
    [{ unverified: ["AC-2 : la concurrence"] }, {}, /non vérifié.*AC-2/],
  ];
  for (const [v, e, reason] of cases) {
    const decision = mergeDecision({ ...verdict, ...v }, { ...evidence, ...e });
    assert.ok(!decision.auto && decision.reasons.some((r) => reason.test(r)), String(reason));
    assert.equal(
      !decision.auto && decision.readCode,
      v.unverified !== undefined,
      "un verdict fort se lit sans le code",
    );
  }
  const weak = mergeDecision({ ...verdict, confidence: "weak" }, evidence);
  assert.ok(!weak.auto && weak.reasons.includes("verdict faible") && weak.readCode);
});

test("harness-verdict/AC-4 : un point non vérifié sans AC ne bloque pas l'auto-merge ; il fait lire le code quand autre chose bloque", () => {
  const unverified = { ...verdict, unverified: ["le comportement sous charge"] };
  assert.deepEqual(mergeDecision(unverified, evidence), { auto: true });
  const blocked = mergeDecision(unverified, { ...evidence, diffLines: 400 });
  assert.ok(!blocked.auto && blocked.readCode && blocked.reasons.length === 1);
  const strong = mergeDecision(verdict, { ...evidence, diffLines: 400 });
  assert.ok(!strong.auto && !strong.readCode);
});

test("harness-verdict/AC-5 : parseAcIds lit les AC-n en tête de ligne (puce, gras), sans doublon ni faux positif", () => {
  const specs = [
    "## Critères d'acceptation",
    "AC-1 (B-1) : Given…",
    "- AC-2 (B-1) : Given…",
    "* **AC-3** (B-2) : Given…",
    "  **AC-3** encore",
    "S-1 (AC-1, AC-2) : la spec cite AC-9 sans le déclarer",
    "voir AC-10 plus haut",
  ].join("\n");
  assert.deepEqual(parseAcIds(specs), ["AC-1", "AC-2", "AC-3"]);
  assert.deepEqual(parseAcIds(""), []);
});
