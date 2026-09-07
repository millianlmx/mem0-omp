// Tests de omp-mem0-req/extension.ts : pipeline besoins → specs → impl → review.
// L'état traverse les sessions par le FICHIER CONTRAT .omp/pipeline/contract.md,
// pas par la mémoire mem0. Les amorces sont des fonctions pures : on vérifie
// qu'elles pointent l'agent vers ce contrat et portent le bon contrat de rôle.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReqHandoff,
  buildSpecsSeed,
  buildImplSeed,
  buildReviewSeed,
  CONTRACT_PATH,
} from "../omp-mem0-req/extension.ts";

// Le chemin du contrat contient des points : on l'échappe pour en faire un motif.
const contractRe = new RegExp(CONTRACT_PATH.replace(/[.]/g, "\\."));

test("CONTRACT_PATH : contrat de feature sous .omp/", () => {
  assert.equal(CONTRACT_PATH, ".omp/pipeline/contract.md");
});

test("buildReqHandoff : fige les besoins validés dans le contrat, pas en mémoire", () => {
  const out = buildReqHandoff();
  assert.match(out, /ACTION/);
  assert.match(out, contractRe); // écrit dans le contrat
  assert.match(out, /## Besoins/);
  assert.match(out, /validation/);
  assert.match(out, /Ne mets pas les besoins en mémoire mem0/); // pas de transport mem0
  assert.match(out, /\/specs/); // renvoie vers l'étape suivante
});

test("buildSpecsSeed : lit les besoins du contrat, y écrit les specs, ambiguïtés techniques seules", () => {
  const out = buildSpecsSeed("");
  assert.match(out, contractRe);
  assert.match(out, /## Besoins/); // lit les besoins figés
  assert.match(out, /## Spécifications/); // écrit les specs
  assert.match(out, /SANS AMBIGUÏTÉ/);
  assert.match(out, /Given\/When\/Then/);
  assert.match(out, /NON-objectifs/);
  assert.match(out, /PLAN D'IMPLÉMENTATION/);
  assert.match(out, /ambiguïtés TECHNIQUES/); // ne re-questionne pas l'intention métier
  assert.match(out, /N'écris PAS les specs en mémoire mem0/);
});

test("buildSpecsSeed : le contexte ajouté par l'utilisateur est injecté", () => {
  assert.match(buildSpecsSeed("cible le module auth"), /Contexte ajouté : cible le module auth/);
});

test("buildSpecsSeed : sans contexte ajouté → pas de ligne Contexte", () => {
  assert.doesNotMatch(buildSpecsSeed("  "), /Contexte ajouté/);
});

test("buildImplSeed : lit les specs du contrat, s'arrête si absentes", () => {
  const out = buildImplSeed("");
  assert.match(out, contractRe);
  assert.match(out, /ARRÊTE/); // stop si pas de specs figées
  assert.match(out, /\/specs/); // renvoie vers /specs
  assert.match(out, /Given\/When\/Then/);
  assert.match(out, /aucun stub/);
  assert.doesNotMatch(out, /Périmètre :/); // pas de focus fourni
});

test("buildImplSeed : mode --fix lit la revue et lève les bloquants", () => {
  const out = buildImplSeed("", true);
  assert.match(out, /\[impl --fix\]/);
  assert.match(out, /CORRECTION/);
  assert.match(out, contractRe);
  assert.match(out, /## Revue/); // lit le verdict consigné par /review
  assert.match(out, /BLOQUANT/);
  assert.match(out, /ARRÊTE/); // rien à corriger → stop, renvoie /review
  assert.match(out, /scope creep/); // ne pas élargir le périmètre
});

test("buildImplSeed : sans --fix → mode implémentation, pas correction", () => {
  const out = buildImplSeed("");
  assert.doesNotMatch(out, /--fix/);
  assert.doesNotMatch(out, /CORRECTION/);
});

test("buildImplSeed : --fix respecte le focus fourni", () => {
  assert.match(buildImplSeed("auth", true), /Périmètre : auth/);
});

test("buildImplSeed : le focus fourni restreint le périmètre", () => {
  assert.match(buildImplSeed("feature auth"), /Périmètre : feature auth/);
});

test("buildReviewSeed : révise le git diff contre le contrat", () => {
  const out = buildReviewSeed("");
  assert.match(out, contractRe); // besoins + specs viennent du contrat
  assert.match(out, /git diff/); // source de vérité du changement
  assert.match(out, /spec orpheline/); // traçabilité spec → besoin
  assert.match(out, /changement non spécifié/); // traçabilité fichier → spec
  assert.match(out, /## Revue/); // consigne le verdict dans le contrat pour /impl --fix
});

test("buildReviewSeed : le focus fourni restreint le périmètre", () => {
  assert.match(buildReviewSeed("feature auth"), /Périmètre : feature auth/);
});

test("buildReviewSeed : sans focus → pas de ligne Périmètre", () => {
  assert.doesNotMatch(buildReviewSeed("   "), /Périmètre :/);
});
