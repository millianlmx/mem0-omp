// Feature harness-verdict : le verdict structuré de /review et la règle d'auto-merge.
import test from "node:test";
import assert from "node:assert/strict";
import { mergeDecision, parseVerdict } from "../../omp-harness/verdict.ts";
import type { MergeEvidence, Verdict } from "../../omp-harness/verdict.ts";

const verdict: Verdict = { risk: "low", summary: "s", blockers: [], risks: [], files: ["a.ts"], unverified: [], confidence: "strong" };
const evidence: MergeEvidence = { fullTests: "pass", diffLines: 120, maxDiffLines: 300, openEscalations: 0 };


test("harness-verdict/AC-1 : un verdict se valide champ par champ ; risque, résumé et fichiers sont requis", () => {
  assert.equal(parseVerdict(verdict).ok, true);
  const bad = parseVerdict({ risk: "nul", summary: "", files: [] });
  assert.equal(bad.ok, false);
  assert.equal((bad as { errors: string[] }).errors.length, 3);
  assert.equal(parseVerdict([]).ok, false);
});


test("harness-verdict/AC-2 : bas risque + suite complète verte + petite PR → auto-merge", () => {
  assert.deepEqual(mergeDecision(verdict, evidence), { auto: true });
});


test("harness-verdict/AC-3 : chaque écart à la règle renvoie à l'humain, avec sa raison", () => {
  const cases: [Partial<Verdict>, Partial<MergeEvidence>, RegExp][] = [
    [{ risk: "medium" }, {}, /risque medium/],
    [{}, { fullTests: "fail" }, /suite complète rouge/],
    [{}, { fullTests: "not_run" }, /non lancée/],
    [{}, { diffLines: 301 }, /301 lignes/],
    [{}, { openEscalations: 1 }, /escalade/],
  ];
  for (const [v, e, reason] of cases) {
    const decision = mergeDecision({ ...verdict, ...v }, { ...evidence, ...e });
    assert.ok(!decision.auto && decision.reasons.some(r => reason.test(r)), String(reason));
    assert.equal(!decision.auto && decision.readCode, false, "un verdict fort se lit sans le code");
  }
});


test("harness-verdict/AC-4 : un verdict faible (confiance faible ou points non vérifiés) fait lire le code", () => {
  for (const weak of [{ confidence: "weak" as const }, { unverified: ["concurrence"] }]) {
    const decision = mergeDecision({ ...verdict, ...weak }, evidence);
    assert.ok(!decision.auto && decision.readCode);
  }
});
