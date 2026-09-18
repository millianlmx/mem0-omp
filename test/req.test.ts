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
  buildNextStepNotice,
  buildSweepMessage,
  buildWelcome,
  contractHasSection,
  contractSection,
  nextStepFor,
  reviewVerdict,
  saysFin,
  isPipelineNotice,
  CONTRACT_PATH,
  type NextStep,
  type PipelinePhase,
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
// commencer. La garde isPipelineNotice l'en empêche : toute notice du plugin est
// ignorée — y compris la notice de fin de maillon, dont le contenu peut citer un
// chemin contenant « fin » (ex. /x/fin-de-feature).

test("isPipelineNotice : les notices [req] et [pipeline] sont ignorées, pas les entrées utilisateur", () => {
  assert.ok(isPipelineNotice(welcome));
  assert.ok(isPipelineNotice("[req] reçu. Précisez ou ajoutez. Dites « fin » quand vous avez tout dit."));
  assert.ok(isPipelineNotice("[pipeline] Phase /req terminée — commande suivante : /specs"));
  assert.ok(!isPipelineNotice("je veux ajouter une commande /export"));
  assert.ok(!isPipelineNotice("fin"));
});

test("buildWelcome : contient « fin » mais est une notice — sinon il s'auto-clôturerait", () => {
  assert.ok(saysFin(welcome), "présuppose la présence du mot « fin » dans l'accueil");
  assert.ok(isPipelineNotice(welcome), "donc la garde de notice DOIT le neutraliser");
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

// ---------------------------------------------------------------------------
// Fin de maillon — routage de la suite annoncée (S-1, S-2, S-3)
// ---------------------------------------------------------------------------

// Contrats réduits à ce que la lecture du verdict regarde : la présence de la
// section `## Spécifications`, et le corps du champ BLOQUANTS de `## Revue`.
const WITH_SPECS = "## Besoins\n\nB-1 : …\n\n## Spécifications\n\nS-1 (AC-1) : …\n";
const WITHOUT_SPECS = "## Besoins\n\nB-1 : …\n\n## Critères d'acceptation\n\nAC-1 (B-1) : Given … When … Then …\n";
const REVIEW_BLOCKERS =
  "## Revue\n\n- STATUT : BLOQUANT\n- AC PAR AC : AC-3 → test/handlers.test.ts → fail\n" +
  "- BLOQUANTS :\n  1. Le test AC-3 manque.\n- RECOMMANDATIONS : aucune\n- DÉCISION FINALE : non\n";
const REVIEW_CLEAN =
  "## Revue\n\n- STATUT : APPROUVÉ\n- BLOQUANTS : aucun\n- RECOMMANDATIONS : aucune\n- DÉCISION FINALE : approuvé\n";

// Table de routage de S-1/S-3 : maillon terminé → commande annoncée (`""` = fin de
// cycle, aucune commande — le seul cas que la pipeline ne doit pas proposer).
const ROUTING: Array<[PipelinePhase, string, string]> = [
  ["req", "", "/specs"],
  ["specs", WITH_SPECS, "/impl"],
  ["specs", WITHOUT_SPECS, "/specs"],
  ["specs", "", "/specs"],
  ["impl", WITH_SPECS, "/review"],
  ["impl", WITHOUT_SPECS, "/specs"],
  ["impl", "", "/specs"],
  ["review", REVIEW_BLOCKERS, "/impl --fix"],
  ["review", REVIEW_CLEAN, ""],
  ["review", "## Revue\n\n- STATUT : APPROUVÉ\n", "/review"], // verdict illisible
  ["review", "", "/review"], // contrat absent
];

test("nextStepFor : la table de routage de S-1/S-3 est respectée, maillon par maillon", () => {
  for (const [phase, contract, command] of ROUTING) {
    const step: NextStep = nextStepFor(phase, contract);
    assert.equal(step.kind, command ? "command" : "cycle-end", `/${phase} : type de la suite`);
    if (step.kind === "command") {
      assert.equal(step.command, command, `/${phase} : commande annoncée`);
    } else {
      assert.equal(phase, "review", "la fin de cycle n'existe que pour /review");
    }
  }
});

test("buildNextStepNotice : annonce la commande à l'octet près, fin de cycle comprise", () => {
  for (const [phase, contract, command] of ROUTING) {
    const notice = buildNextStepNotice(phase, nextStepFor(phase, contract));
    if (command) {
      assert.equal(
        notice,
        `[pipeline] Phase /${phase} terminée — commande suivante : ${command}`,
        `/${phase} : la notice porte la commande exacte`,
      );
    } else {
      assert.equal(
        notice,
        "[pipeline] Phase /review terminée — cycle terminé : aucun BLOQUANT consigné dans ## Revue, " +
          "rien à corriger.",
      );
    }
  }
});

test("reviewVerdict : le champ BLOQUANTS est lu, les échappatoires « aucun » comprises", () => {
  assert.equal(reviewVerdict("## Besoins\n\nB-1 : …\n"), "unreadable", "section absente");
  assert.equal(reviewVerdict("## Revue\n\n- STATUT : APPROUVÉ\n- DÉCISION FINALE : approuvé\n"), "unreadable", "champ absent");
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS : aucun\n- RECOMMANDATIONS : aucune\n- DÉCISION FINALE : approuvé\n"), "clean");
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS : néant\n"), "clean");
  assert.equal(reviewVerdict("## Revue\n\n- **BLOQUANTS** : `0`\n"), "clean");
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS : —\n"), "clean");
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS : (aucun)\n"), "clean");
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS :\n  1. Le test AC-3 manque.\n"), "blockers", "numéroté multiligne");
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS : 1) Le test AC-3 manque.\n"), "blockers", "numéroté même ligne");
});

test("reviewVerdict : le corps du champ s'arrête au libellé suivant et au titre de section", () => {
  // `- BLOQUANTS : aucun` suivi d'un AUTRE champ : la recommandation n'est pas un bloquant.
  assert.equal(
    reviewVerdict("## Revue\n\n- BLOQUANTS : aucun\n- RECOMMANDATIONS :\n  1. Renommer le helper.\n"),
    "clean",
  );
  // Une section suivante a ses propres champs : ils ne comptent pas pour `## Revue`.
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS : aucun\n\n## Annexe\n\n- BLOQUANTS :\n  1. Hors périmètre.\n"), "clean");
  // Le champ DÉCISION FINALE n'est PAS lu : un « non » n'est pas un bloquant.
  assert.equal(reviewVerdict("## Revue\n\n- BLOQUANTS : aucun\n- DÉCISION FINALE : non\n"), "clean");
});

test("contractHasSection : titre exact, casse et accents respectés", () => {
  assert.ok(contractHasSection(WITH_SPECS, "Spécifications"));
  assert.ok(contractHasSection("  ## Spécifications  \n", "Spécifications"), "espaces de bord tolérés");
  assert.ok(!contractHasSection("## Specifications\n", "Spécifications"));
  assert.ok(!contractHasSection("### Spécifications\n", "Spécifications"));
  assert.ok(!contractHasSection("## Spécifications détaillées\n", "Spécifications"));
  assert.ok(!contractHasSection("", "Spécifications"));
});

test("contractSection : corps de la section, null si absente", () => {
  const contract = "## A\n\ncorps A\n\n## Revue\n\n- BLOQUANTS : aucun\n\n## Z\n\ncorps Z\n";
  assert.equal(contractSection(contract, "Revue"), "\n- BLOQUANTS : aucun\n");
  assert.equal(contractSection(contract, "Absente"), null);
});

test("aucune notice du plugin ne porte « fin » isolé, même quand elle cite un chemin", () => {
  // Le piège : une notice de balayage cite un chemin de worktree qui contient
  // « fin » — `saysFin` y voit un mot isolé, seul le préfixe [pipeline] protège.
  const sweep = buildSweepMessage({
    removed: [],
    kept: [{ path: "/x/fin-de-feature", reason: "branche non poussée" }],
  });
  assert.ok(saysFin(sweep), "présuppose un « fin » isolé dans le chemin cité");
  const notices = [
    sweep,
    buildWelcome(FEATURE),
    buildReqHandoff(),
    ...ROUTING.map(([phase, contract]) => buildNextStepNotice(phase, nextStepFor(phase, contract))),
  ];
  for (const notice of notices) {
    assert.ok(isPipelineNotice(notice), `notice non reconnue par la garde : ${notice.split("\n")[0]}`);
  }
});

test("buildReviewSeed : impose la forme lisible du verdict (« BLOQUANTS : aucun »)", () => {
  assert.match(buildReviewSeed(""), /- BLOQUANTS : aucun/);
});
