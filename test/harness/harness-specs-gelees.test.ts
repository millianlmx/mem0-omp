// Feature harness-specs-gelees : les specs closes par /specs (celles que l'humain valide)
// sont gelées ; la revue et l'auto-merge jugent sur leurs critères, pas sur ceux que /impl
// aurait retirés ou réécrits dans specs.md.
import test from "node:test";
import assert from "node:assert/strict";
import { OK, fakeWorld, waitFor } from "../support/harness-fixtures.ts";
import type { FakeWorld } from "../support/harness-fixtures.ts";
import { stepPrompt } from "../../omp-harness/prompts.ts";
import type { PromptContext } from "../../omp-harness/prompts.ts";
import { SPECS_BASELINE } from "../../omp-harness/steps.ts";
import { criteriaDrift, driftLabel, mergeDecision, parseAcLines } from "../../omp-harness/verdict.ts";
import type { MergeEvidence, Verdict } from "../../omp-harness/verdict.ts";

const AC1 = "AC-1 (B-1) : Given des données, When l'export est demandé, Then un CSV est produit";
const AC2 =
  "AC-2 (B-1) : Given un champ avec une virgule, When l'export est demandé, Then le champ est entre guillemets";

const REQ = `## Besoins\nB-1 : exporter les données au format CSV\n## Critères d'acceptation\n${AC1}\n${AC2}\n## Hors périmètre\n## Contraintes\n`;
const SPECS = `## Relevé du dépôt\n- src/api : routes\n## Non-objectifs\n## Spécifications\nS-1 (AC-1) : export CSV\nS-2 (AC-2) : échappement\n## Critères d'acceptation\n${AC1}\n${AC2}\n## Modules\n- src/api\n## Découpage\naucun\n`;

function verdictOf(criteria: Verdict["criteria"]): Verdict {
  return {
    risk: "low",
    summary: "s",
    blockers: [],
    risks: [],
    files: ["a.ts"],
    unverified: [],
    criteria,
    confidence: "strong",
  };
}

const evidence: MergeEvidence = {
  fullTests: "pass",
  diffLines: 50,
  maxDiffLines: 300,
  openEscalations: 0,
  acIds: ["AC-1", "AC-2"],
  specsDrift: [],
  autoMergeRisk: "medium",
  touchedFiles: ["a.ts"],
};

test("harness-specs-gelees/AC-1 : criteriaDrift relève les critères validés retirés ou réécrits, puis ceux ajoutés ; puce, gras et espaces ne comptent pas", () => {
  assert.deepEqual(criteriaDrift(SPECS, SPECS), []);
  assert.deepEqual(criteriaDrift(SPECS, SPECS.replace(AC1, `- **${AC1.replace(" : ", " :  ")}**`)), []);
  const weakened = SPECS.replace(`${AC2}\n`, "").replace(AC1, AC1.replace("un CSV est produit", "un fichier existe"));
  const drift = criteriaDrift(SPECS, `${weakened}AC-3 (B-1) : Given rien, When rien, Then rien\n`);
  assert.deepEqual(drift.map(driftLabel), ["AC-1 réécrit", "AC-2 retiré", "AC-3 ajouté"]);
  assert.equal(drift[0]?.validated, AC1);
  assert.match(drift[0]?.current ?? "", /un fichier existe/);
  assert.equal(drift[1]?.current, null);
  assert.equal(drift[2]?.validated, null);
  assert.deepEqual([...parseAcLines(SPECS).keys()], ["AC-1", "AC-2"]);
});

test("harness-specs-gelees/AC-2 : un critère validé retiré ou réécrit refuse l'auto-merge ; un critère ajouté ne le refuse pas mais doit être prouvé", () => {
  const all = verdictOf([
    { id: "AC-1", test: "t/AC-1", status: "pass" },
    { id: "AC-2", test: "t/AC-2", status: "pass" },
  ]);
  assert.deepEqual(mergeDecision(all, evidence), { auto: true });
  const removed = mergeDecision(all, {
    ...evidence,
    specsDrift: [{ id: "AC-2", validated: AC2, current: null }],
  });
  assert.equal(removed.auto, false);
  assert.ok(
    !removed.auto && removed.reasons.includes("critère(s) validé(s) modifié(s) depuis /specs : AC-2 retiré"),
    JSON.stringify(removed),
  );
  const added = { id: "AC-3", validated: null, current: "AC-3 (B-1) : …" };
  assert.deepEqual(mergeDecision(all, { ...evidence, specsDrift: [added] }), { auto: true });
  const unproven = mergeDecision(all, { ...evidence, acIds: [...evidence.acIds, "AC-3"], specsDrift: [added] });
  assert.ok(!unproven.auto && unproven.reasons.some((reason) => /absent\(s\) du verdict : AC-3/.test(reason)));
});

test("harness-specs-gelees/AC-3 : le prompt de revue cite chaque critère modifié avec son texte validé et son texte actuel", () => {
  const ctx: PromptContext = {
    step: "review",
    title: "Export CSV",
    request: "Exporter",
    baseSha: "abc123",
    maxDiffLines: 300,
    memories: null,
    blockers: [],
    previousVerdict: null,
    sinceSha: null,
    previousBlockers: [],
    resume: null,
    decisions: [],
    conflicts: [],
    specsDrift: [],
  };
  assert.doesNotMatch(stepPrompt(ctx), /Critères modifiés depuis la validation/);
  const prompt = stepPrompt({ ...ctx, specsDrift: [{ id: "AC-2", validated: AC2, current: null }] });
  assert.match(prompt, /## Critères modifiés depuis la validation des specs/);
  assert.match(prompt, /Le contrat validé fait foi/);
  assert.ok(prompt.includes(`- AC-2 — validé : ${AC2}\n  actuel : (retiré de specs.md)`), prompt);
});

function stateOf(world: FakeWorld, runId: string): string {
  const run = world.store.getRun(runId);
  return `${run?.state}/${run?.step} — ${run?.reason}`;
}

test("harness-specs-gelees/AC-4 : /impl retire un critère de specs.md — la revue le voit, la table doit le couvrir, et le run attend l'humain au lieu de s'auto-merger", async () => {
  const impl = [
    { write: "src/api/export.ts", content: "export const exportCsv = () => 'a,b';\n" },
    { write: ".harness/specs.md", content: SPECS.replace(`${AC2}\n`, "").replace("S-2 (AC-2) : échappement\n", "") },
    { write: ".harness/impl.md", content: "## Fait\nAC-1 fait\n## Reste\n" },
  ];
  const review = [
    { tool: "run_tests", args: { scope: "full" } },
    {
      tool: "review_verdict",
      args: {
        risk: "low",
        summary: "export CSV",
        blockers: [],
        risks: [],
        files: ["src/api/export.ts"],
        unverified: [],
        criteria: [{ id: "AC-1", test: "harness/AC-1", status: "pass" }],
        confidence: "strong",
      },
    },
  ];
  const world = fakeWorld({
    req: [[{ write: ".harness/req.md", content: REQ }]],
    specs: [[{ write: ".harness/specs.md", content: SPECS }]],
    impl: [impl],
    review: [review],
  });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => ["awaiting_human", "merged", "failed"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => stateOf(world, run.id),
      30_000,
    );
    const after = world.store.getRun(run.id);
    assert.equal(after?.state, "awaiting_human", stateOf(world, run.id));
    assert.match(after?.reason ?? "", /critère\(s\) absent\(s\) du verdict : AC-2/);
    assert.match(after?.reason ?? "", /critère\(s\) validé\(s\) modifié\(s\) depuis \/specs : AC-2 retiré/);
    // La copie gelée est celle de /specs ; specs.md, lui, porte la version de /impl.
    assert.equal(world.store.getArtifact(run.id, SPECS_BASELINE), SPECS);
    assert.doesNotMatch(world.store.getArtifact(run.id, "specs.md") ?? "", /AC-2/);
    const reviewPrompt = world.log().find((entry) => entry.kind === "prompt" && entry.step === "review");
    assert.match(String(reviewPrompt?.message), /## Critères modifiés depuis la validation des specs/);
    assert.ok(String(reviewPrompt?.message).includes(`- AC-2 — validé : ${AC2}`));
  } finally {
    await world.orchestrator.stop();
  }
});

test("harness-specs-gelees/AC-5 : sans modification des critères, rien ne change — le run s'auto-merge et la revue ne voit aucune section de critères modifiés", async () => {
  const world = fakeWorld({ req: [OK.req], specs: [OK.specs], impl: [OK.impl], review: [OK.review] });
  await world.orchestrator.start();
  try {
    const run = await world.orchestrator.createRun({ repo: "demo", title: "Export CSV", request: "Exporter en CSV" });
    await waitFor(
      () => ["awaiting_human", "merged", "failed"].includes(world.store.getRun(run.id)?.state ?? ""),
      () => stateOf(world, run.id),
      30_000,
    );
    assert.equal(world.store.getRun(run.id)?.state, "merged", stateOf(world, run.id));
    const reviewPrompt = world.log().find((entry) => entry.kind === "prompt" && entry.step === "review");
    assert.doesNotMatch(String(reviewPrompt?.message), /Critères modifiés/);
  } finally {
    await world.orchestrator.stop();
  }
});
