// Feature harness-prompts : ce que chaque prompt d'étape exige du runner — fil de
// traçabilité B-n → AC-n (B-m) → S-n (AC-…) → test nommé, sections obligatoires,
// outils hôtes à appeler, revue incrémentale, verdict complet transmis au correcteur.
import test from "node:test";
import assert from "node:assert/strict";
import { auditPrompt, stepPrompt } from "../../omp-harness/prompts.ts";
import type { PromptContext } from "../../omp-harness/prompts.ts";

function ctx(patch: Partial<PromptContext>): PromptContext {
  return {
    step: "req",
    title: "Export CSV",
    request: "Exporter les données",
    baseSha: "abc123",
    maxDiffLines: 300,
    memories: "- [2026-10-01] décision : CSV séparé par des virgules",
    blockers: [],
    previousVerdict: null,
    sinceSha: null,
    previousBlockers: [],
    resume: null,
    decisions: [],
    conflicts: [],
    specsDrift: [],
    ...patch,
  };
}

test("harness-prompts/AC-1 : /req exige B-n « verbe objet contraintes », AC-n (B-m) en Given/When/Then et « Hors périmètre »", () => {
  const prompt = stepPrompt(ctx({ step: "req" }));
  assert.match(prompt, /B-n : verbe objet contraintes/);
  assert.match(prompt, /AC-n \(B-m\) : Given .*When .*Then/);
  assert.match(prompt, /## Hors périmètre/);
  assert.doesNotMatch(prompt, /commence par `oracle_recall`/);
});

test("harness-prompts/AC-2 : /specs exige le relevé du dépôt, la documentation externe, les non-objectifs, des S-n traçables testables, des modules non vides et un découpage", () => {
  const prompt = stepPrompt(ctx({ step: "specs" }));
  for (const expected of [
    /## Relevé du dépôt/,
    /fichier:ligne/,
    /## Documentation/,
    /EXTERNE/,
    /## Non-objectifs/,
    /S-n \(AC-m, AC-p\)/,
    /cas limites et erreurs/i,
    /Une spec qui ne permet pas d'écrire le test avant le code n'est pas assez précise\./,
    /## Modules\n\(OBLIGATOIRE, non vide/,
    /## Découpage/,
    /- titre — demande — modules/,
    /« aucun »/,
    /`set_modules`/,
    /`split_feature`/,
    /~300 lignes/,
  ]) {
    assert.match(prompt, expected, String(expected));
  }
});

test("harness-prompts/AC-3 : /impl exige des tests nommés AC-n, aucun stub, la correction des specs ambiguës, checkpoint, set_modules, split_feature au-delà du plafond et « ## Reste »", () => {
  const prompt = stepPrompt(ctx({ step: "impl" }));
  for (const expected of [
    /NOMMÉ avec son id \(`AC-n`/,
    /Aucun stub, aucun TODO/,
    /spec ambiguë.*corrige `\.harness\/specs\.md`.*plutôt que d'implémenter à côté/,
    /`checkpoint` après chaque incrément cohérent/,
    /`set_modules` dès que les chemins/,
    /< 300 lignes de code\. Au-delà.*`split_feature`/,
    /## Fait/,
    /## Reste/,
    /`mem0_add` pour les SEULS pièges durables/,
    /un fait autoportant par appel/,
  ]) {
    assert.match(prompt, expected, String(expected));
  }
});

test("harness-prompts/AC-4 : /review lit req et specs puis le diff, impl.md seulement après son jugement, rend une table AC par AC ; complète à la 1re passe, incrémentale ensuite (diff depuis le sha, bloquants relus, full seulement sans bloquant)", () => {
  const first = stepPrompt(ctx({ step: "review" }));
  assert.match(first, /Lis `\.harness\/req\.md` et `\.harness\/specs\.md`, puis le diff/);
  assert.match(first, /AVANT d'ouvrir `\.harness\/impl\.md`/);
  assert.match(first, /diff COMPLET, `git diff abc123`/);
  assert.match(first, /`scope: full`/);
  assert.match(first, /table `criteria` AC par AC/);
  assert.match(first, /`confidence` honnête/);
  assert.doesNotMatch(first, /INCRÉMENTALE/);
  const second = stepPrompt(ctx({ step: "review", sinceSha: "def456", previousBlockers: ["AC-2 non testé", "fuite"] }));
  assert.match(second, /Revue INCRÉMENTALE : relis le diff depuis `def456`/);
  assert.match(second, /vérifie chaque bloquant levé/);
  assert.match(second, /- AC-2 non testé\n- fuite/);
  assert.match(second, /`scope: touched` d'abord ; la suite `scope: full` seulement s'il ne reste plus AUCUN bloquant/);
  assert.doesNotMatch(second, /diff COMPLET/);
});

test("harness-prompts/AC-5 : /fix lit specs.md et le verdict complet (bloquants, risques, non vérifié), écrit fix.md avec les preuves", () => {
  const prompt = stepPrompt(
    ctx({
      step: "fix",
      blockers: ["AC-2 échoue"],
      previousVerdict: {
        risk: "medium",
        summary: "export incomplet",
        blockers: ["AC-2 échoue"],
        risks: ["encodage"],
        files: ["a.ts"],
        unverified: ["charge"],
        criteria: [{ id: "AC-2", test: "x/AC-2", status: "fail" }],
        confidence: "weak",
      },
    }),
  );
  assert.match(prompt, /Lis `\.harness\/specs\.md` et le verdict complet/);
  assert.match(prompt, /- AC-2 échoue/);
  assert.match(prompt, /## Risques résiduels relevés par la revue\n- encodage/);
  assert.match(prompt, /## Ce que la revue n'a PAS pu vérifier\n- charge/);
  assert.match(prompt, /export incomplet \(risque medium, confiance weak\)/);
  assert.match(prompt, /Écris `\.harness\/fix\.md`.*PREUVE/);
  const bare = stepPrompt(ctx({ step: "fix", blockers: [] }));
  assert.match(bare, /\(voir la reprise ci-dessous\)/);
  assert.doesNotMatch(bare, /Risques résiduels/);
});

test("harness-prompts/AC-6 : la politique tranche seule les clarifications (chosen + options, renversable) et la section Oracle est injectée à toutes les étapes", () => {
  for (const step of ["req", "specs", "impl", "review", "fix"] as const) {
    const prompt = stepPrompt(ctx({ step }));
    assert.match(prompt, /## Oracle \(rappel du service\)\n- \[2026-10-01\] décision/, step);
    assert.match(
      prompt,
      /`category: clarification`.*tranches SEUL.*`chosen` \+ `options`.*l'humain pourra renverser/,
      step,
    );
    assert.match(prompt, /n'utilise JAMAIS `ask`/, step);
    assert.doesNotMatch(prompt, /oracle_recall/, step);
  }
  assert.doesNotMatch(stepPrompt(ctx({ step: "impl", memories: null })), /## Oracle/);
});

test("harness-prompts/AC-7 : l'audit exige une preuve fichier:ligne par faiblesse, dependsOn, impact et effort", () => {
  const prompt = auditPrompt({ repo: "demo", focus: "", memories: "- souvenir" });
  assert.match(prompt, /`evidence` \(OBLIGATOIRE pour une faiblesse : `fichier:ligne`/);
  assert.match(prompt, /`dependsOn`/);
  assert.match(prompt, /`impact` et `effort`/);
  assert.match(prompt, /## Oracle \(rappel du service\)\n- souvenir/);
  assert.doesNotMatch(prompt, /oracle_recall/);
});
