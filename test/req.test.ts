// Tests de omp-mem0-req/extension.ts : pipeline piloté par le critère
// d'acceptation — /req (B-<n> + AC-<n>), /specs (S-<n> + lots BR-<n>),
// /impl (test tagué AC-<n>), /review (grep AC-<n>). L'état traverse les sessions
// par le FICHIER CONTRAT .omp/pipeline/contract.md, pas par la mémoire mem0. Les
// amorces sont des fonctions pures : on vérifie qu'elles pointent l'agent vers ce
// contrat et portent le bon contrat de rôle.
import test from "node:test";
import assert from "node:assert/strict";
import {
  buildReqHandoff,
  buildSpecsSeed,
  buildImplSeed,
  buildReviewSeed,
  buildWelcome,
  saysFin,
  isReqNotice,
  CONTRACT_PATH,
} from "../omp-mem0-req/extension.ts";

// Le chemin du contrat contient des points : on l'échappe pour en faire un motif.
const contractRe = new RegExp(CONTRACT_PATH.replace(/[.]/g, "\\."));

// Feature ouverte par /req : sa session vit dans son worktree, donc le contrat —
// relatif au cwd — vit sur sa branche.
const FEATURE = {
  slug: "isolation-worktree",
  branch: "feat/isolation-worktree",
  path: "/home/m/.omp/pipeline-worktrees/mem0-omp-1a2b3c4/isolation-worktree",
};
const welcome = buildWelcome(FEATURE);

test("CONTRACT_PATH : contrat de feature sous .omp/", () => {
  assert.equal(CONTRACT_PATH, ".omp/pipeline/contract.md");
});

test("buildReqHandoff : fige besoins ET critères validés dans le contrat, pas en mémoire", () => {
  const out = buildReqHandoff();
  assert.match(out, /B-</); // besoins identifiés
  assert.match(out, /AC-</); // et critères d'acceptation, le pivot
  assert.match(out, /Given/);
  assert.match(out, contractRe); // écrit dans le contrat
  assert.match(out, /## Besoins/);
  assert.match(out, /## Critères d'acceptation/);
  assert.match(out, /validation/);
  assert.match(out, /Ne mets pas les besoins ni les critères en mémoire mem0/); // pas de transport mem0
  assert.match(out, /\/specs/); // renvoie vers l'étape suivante
});

test("buildSpecsSeed : lit le contrat, y écrit specs ET lots, ambiguïtés techniques seules", () => {
  const out = buildSpecsSeed("");
  assert.match(out, contractRe);
  assert.match(out, /## Besoins/); // lit les besoins figés
  assert.match(out, /## Critères d'acceptation/); // et les critères — le pivot
  assert.match(out, /## Spécifications/); // écrit les specs
  assert.match(out, /## Lots/); // et les briefs typés
  assert.match(out, /SANS AMBIGUÏTÉ/);
  assert.match(out, /Given\/When\/Then/);
  assert.match(out, /NON-objectifs/);
  assert.match(out, /PLAN D'IMPLÉMENTATION/);
  assert.match(out, /ambiguïtés TECHNIQUES/); // ne re-questionne pas l'intention métier
  assert.match(out, /N'écris PAS les specs en mémoire mem0/);
  assert.match(out, /## Documentation/); // rassemble la doc externe pour /impl
  assert.match(out, /DOCUMENTE-toi pour la future implémentation/);
});

test("buildSpecsSeed : les lots portent le « comment » typé (ui / archi)", () => {
  const out = buildSpecsSeed("");
  assert.match(out, /BR-<n> — type: ui \| archi \| aucun/); // type déclaré, avec échappatoire
  assert.match(out, /CHAQUE ÉTAT/); // savoir-faire ui : états d'écran
  assert.match(out, /CONTRATS D'API/); // savoir-faire archi
  assert.match(out, /Aucun lot orphelin/); // traçabilité lot → AC
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
  assert.match(out, /## Documentation/); // s'appuie sur la doc rassemblée par /specs
  assert.match(out, /## Lots/); // et suit les briefs pour le « comment »
  assert.doesNotMatch(out, /Périmètre :/); // pas de focus fourni
});

test("buildImplSeed : la preuve porte l'id du critère, pour le grep de /review", () => {
  const out = buildImplSeed("");
  assert.match(out, /test\("AC-3/); // convention : AC-<n> dans le nom du test
  assert.match(out, /grep/);
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
  assert.match(out, /spec orpheline/); // traçabilité spec → AC
  assert.match(out, /changement non spécifié/); // traçabilité fichier → spec
  assert.match(out, /## Revue/); // consigne le verdict dans le contrat pour /impl --fix
});

test("buildReviewSeed : chaque critère est retrouvé par grep et rejoué", () => {
  const out = buildReviewSeed("");
  assert.match(out, /grep AC-<n>/); // le test se retrouve par l'id, pas par confiance
  assert.match(out, /AC PAR AC/); // le verdict rapporte critère par critère
  assert.match(out, /pass\/fail/);
  assert.match(out, /AC non couvert/); // un critère que rien ne couvre est signalé
});

test("buildReviewSeed : le focus fourni restreint le périmètre", () => {
  assert.match(buildReviewSeed("feature auth"), /Périmètre : feature auth/);
});

test("buildReviewSeed : sans focus → pas de ligne Périmètre", () => {
  assert.doesNotMatch(buildReviewSeed("   "), /Périmètre :/);
});

// --- Clôture de collecte : « fin » comme mot isolé, jamais sous-chaîne -------

test("saysFin : « fin » mot isolé clôture", () => {
  assert.ok(saysFin("fin"));
  assert.ok(saysFin("c'est bon, fin"));
  assert.ok(saysFin("FIN"));
  assert.ok(saysFin("voilà. fin."));
});

test("saysFin : « fin » en sous-chaîne ne clôture pas", () => {
  assert.ok(!saysFin("il faut définir le périmètre"));
  assert.ok(!saysFin("enfin bref"));
  assert.ok(!saysFin("je veux affiner ça"));
  assert.ok(!saysFin("on doit finir la feature"));
  assert.ok(!saysFin("prêt pour les spécifications"));
});

// --- Régression : le message d'accueil ne doit pas auto-clôturer la collecte -
// L'accueil (buildWelcome) contient « fin » (« Dites « fin » … ») ; s'il traverse
// before_agent_start comme une entrée utilisateur, la collecte se ferme avant de
// commencer. La garde isReqNotice l'en empêche : toute notice [req] est ignorée.

test("isReqNotice : les notices [req] (dont l'accueil) sont ignorées, pas les entrées utilisateur", () => {
  assert.ok(isReqNotice(welcome));
  assert.ok(isReqNotice("[req] reçu. Précisez ou ajoutez. Dites « fin » quand vous avez tout dit."));
  assert.ok(!isReqNotice("je veux ajouter une commande /export"));
  assert.ok(!isReqNotice("fin"));
});

test("buildWelcome : contient « fin » mais est une notice — sinon il s'auto-clôturerait", () => {
  assert.ok(saysFin(welcome), "présuppose la présence du mot « fin » dans l'accueil");
  assert.ok(isReqNotice(welcome), "donc la garde de notice DOIT le neutraliser");
});

test("buildWelcome : nomme le worktree, la branche et la collecte des critères", () => {
  assert.ok(welcome.includes(FEATURE.slug));
  assert.ok(welcome.includes(FEATURE.branch));
  assert.ok(welcome.includes(FEATURE.path)); // l'utilisateur sait où vit sa feature
  assert.match(welcome, /dépôt principal/); // et que celui-ci reste intact
  assert.match(welcome, /critères/); // l'utilisateur sait ce qu'on attend de lui
  assert.match(welcome, contractRe); // et où le contrat sera écrit
  assert.match(welcome, /\/specs/); // étape suivante
});
