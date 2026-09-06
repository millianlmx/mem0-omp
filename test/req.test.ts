// Tests de omp-mem0-req/extension.ts : le pont besoins → mémoire.
// - recordConfirmedNeed : un besoin est confirmé quand l'agent le PERSISTE via
//   mem0_add pendant la collecte (pas via `ask`, qui ne fait que clarifier).
// - buildReqHandoff : message de clôture, adapté selon que des besoins ont été
//   captés (valider) ou non (déléguer la reformulation + persistance).
import test from "node:test";
import assert from "node:assert/strict";
import { buildReqHandoff, buildSummary, buildSpecsSeed, buildImplSeed, buildReviewSeed, recordConfirmedNeed } from "../omp-mem0-req/extension.ts";

type Confirmation = { question: string; answer: string; index?: number };
const st = (confirmed: Confirmation[], reqMode = false) => ({
  reqMode,
  reqTurns: 0,
  reqMessages: [],
  reqConfirmed: confirmed,
  reqSummary: null,
});

test("recordConfirmedNeed: mem0_add pendant la collecte → besoin capté", () => {
  const s = st([], true);
  assert.equal(recordConfirmedNeed(s, "mem0_add", { text: "  Auth : JWT court, refresh 7j  " }, false), true);
  assert.equal(s.reqConfirmed.length, 1);
  assert.equal(s.reqConfirmed[0].question, "Auth : JWT court, refresh 7j");
});

test("recordConfirmedNeed: hors mode collecte → ignoré", () => {
  const s = st([], false);
  assert.equal(recordConfirmedNeed(s, "mem0_add", { text: "un besoin" }, false), false);
  assert.equal(s.reqConfirmed.length, 0);
});

test("recordConfirmedNeed: un autre outil (ask, read) → ignoré", () => {
  const s = st([], true);
  assert.equal(recordConfirmedNeed(s, "ask", { text: "Quelle auth ?" }, false), false);
  assert.equal(recordConfirmedNeed(s, "read", { path: "x" }, false), false);
  assert.equal(s.reqConfirmed.length, 0);
});

test("recordConfirmedNeed: résultat en erreur ou texte vide → ignoré", () => {
  const s = st([], true);
  assert.equal(recordConfirmedNeed(s, "mem0_add", { text: "raté" }, true), false);
  assert.equal(recordConfirmedNeed(s, "mem0_add", { text: "   " }, false), false);
  assert.equal(recordConfirmedNeed(s, "mem0_add", {}, false), false);
  assert.equal(s.reqConfirmed.length, 0);
});

test("recordConfirmedNeed: même texte deux fois → pas de doublon", () => {
  const s = st([], true);
  assert.equal(recordConfirmedNeed(s, "mem0_add", { text: "besoin unique" }, false), true);
  assert.equal(recordConfirmedNeed(s, "mem0_add", { text: "besoin unique" }, false), false);
  assert.equal(s.reqConfirmed.length, 1);
});

test("buildSummary: rend un besoin capté sans détail (answer vide)", () => {
  const s = st([], true);
  recordConfirmedNeed(s, "mem0_add", { text: "activer le rate-limit" }, false);
  assert.equal(buildSummary(s), "1. ACTION : activer le rate-limit");
});

test("buildReqHandoff: sans besoin capté → délègue reformulation + persistance", () => {
  const out = buildReqHandoff(st([]));
  assert.match(out, /Aucun besoin n'a encore été enregistré/);
  assert.match(out, /si l'outil mem0_add est disponible/);
  assert.match(out, /récapitulatif/);
  assert.doesNotMatch(out, /Aucun besoin n'a été confirmé cette session/);
});

test("buildReqHandoff: avec besoins captés → récap à valider, pas de re-persistance", () => {
  const out = buildReqHandoff(st([{ question: "hasher les tokens", answer: "argon2id" }]));
  assert.match(out, /1\. ACTION : hasher les tokens \(argon2id\)/);
  assert.match(out, /mémoire projet/);
  assert.match(out, /validation/);
});

test("buildSpecsSeed: injecte les besoins et le rubric de bonnes specs", () => {
  const out = buildSpecsSeed("1. ACTION : hasher les tokens (argon2id)");
  assert.match(out, /Besoins à spécifier/);
  assert.match(out, /hasher les tokens/);
  assert.match(out, /SANS AMBIGUÏTÉ/);
  assert.match(out, /Given\/When\/Then/);
  assert.match(out, /NON-objectifs/);
  assert.match(out, /PLAN D'IMPLÉMENTATION/);
});

test("buildSpecsSeed: sans besoins transmis → demande de les récupérer d'abord", () => {
  assert.match(buildSpecsSeed(""), /Aucun besoin n'a été transmis/);
  // le fallback buildSummary ne doit pas être pris pour des besoins réels
  assert.match(
    buildSpecsSeed("Aucun besoin n'a été confirmé cette session. Redémarrez /req pour commencer une nouvelle collecte."),
    /Aucun besoin n'a été transmis/,
  );
});

test("buildImplSeed: implémente les specs de la mémoire, ne les redéfinit pas", () => {
  const out = buildImplSeed("");
  assert.match(out, /mémoire projet/);
  assert.match(out, /mem0_search/);
  assert.match(out, /AUCUNE spec/); // stop si pas de spec, renvoie vers /specs
  assert.match(out, /\/specs/);
  assert.match(out, /Given\/When\/Then/);
  assert.match(out, /aucun stub/);
  assert.doesNotMatch(out, /Périmètre :/); // pas de focus fourni
});

test("buildImplSeed: le focus fourni restreint le périmètre", () => {
  const out = buildImplSeed("feature auth");
  assert.match(out, /Périmètre : feature auth/);
});

test("buildReviewSeed: révise contre le diff git, pas contre un résumé", () => {
  const out = buildReviewSeed("");
  // Récupère specs + besoins en mémoire.
  assert.match(out, /mem0_search/);
  // Constitue le périmètre via git plutôt que de le deviner.
  assert.match(out, /git diff/);
  // Traçabilité bidirectionnelle : besoin ⇄ spec ⇄ fichier du diff.
  assert.match(out, /spec orpheline/);
  assert.match(out, /changement non spécifié/);
});

test("buildReviewSeed: le focus fourni restreint le périmètre", () => {
  const out = buildReviewSeed("feature auth");
  assert.match(out, /Périmètre : feature auth/);
});

test("buildReviewSeed: sans focus → pas de ligne Périmètre", () => {
  const out = buildReviewSeed("   ");
  assert.doesNotMatch(out, /Périmètre :/);
});
