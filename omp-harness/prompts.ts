// Les prompts d'étape : ce que chaque runner lit (artefacts N-1), produit (les siens),
// et la politique de décision commune. Fonctions PURES, testées sur leur contenu.
//
// Fil de traçabilité : B-n (besoin) → AC-n (B-m) (critère, co-signé par son besoin)
// → S-n (AC-…) (spec) → test nommé avec l'id AC-n → table AC par AC du verdict.
import type { StepKind } from "./machine.ts";
import { ARTIFACTS_DIR } from "./git.ts";
import type { Verdict } from "./verdict.ts";

/** Le fichier d'artefact que chaque étape DOIT écrire (la revue rend son verdict par outil). */
export const STEP_ARTIFACT: Record<StepKind, string | null> = {
  req: "req.md",
  specs: "specs.md",
  impl: "impl.md",
  review: null,
  fix: null,
};

export type PromptContext = {
  step: StepKind;
  title: string;
  request: string;
  /** Le sha de `main` sur lequel le run est basé (diff de la revue). */
  baseSha: string;
  maxDiffLines: number;
  /** Les souvenirs de l'oracle, déjà rendus : la section Oracle de TOUTES les étapes. */
  memories: string | null;
  /** Les bloquants de la dernière revue (fix). */
  blockers: string[];
  /** Le verdict complet de la dernière revue (fix) : risques et points non vérifiés compris. */
  previousVerdict: Verdict | null;
  /** HEAD à la fin de la revue précédente (review incrémentale) ; null à la première revue. */
  sinceSha: string | null;
  /** Les bloquants que la revue précédente avait levés (review incrémentale). */
  previousBlockers: string[];
  /** Ce que le service doit dire en reprise : escalades répondues, décision renversée, refus humain. */
  resume: string | null;
  /** Les décisions déjà prises dans ce run (elles tiennent, sauf renversement). */
  decisions: string[];
  /** Le rebase sur main a échoué : le service a fusionné main, ces fichiers sont en conflit. */
  conflicts: string[];
};

const POLICY = `## Politique de décision (non négociable)
- Personne ne répondra à une question pendant l'étape : n'utilise JAMAIS \`ask\`.
- Ce que les specs, l'oracle ou le code ne tranchent pas, tu le tranches : choisis l'option la PLUS RÉVERSIBLE et appelle l'outil \`decision\` avec \`chosen\` et les \`options\` envisagées (2 à 4). Le service pose un checkpoint ; l'humain relira et pourra renverser.
- \`category: reversible\` pour un choix technique ; \`category: clarification\` pour une question de produit ou d'UX que la demande ne tranche pas : tu la tranches SEUL de la même façon (\`chosen\` + \`options\`), l'humain pourra renverser après coup — elle ne bloque jamais l'étape.
- Un choix qui s'appuie sur une décision déjà prise la cite dans \`dependsOn\` (#N) : si l'humain renverse #N, seules ses dépendantes sont refaites. Un choix qui tiendrait quelle que soit l'issue des autres n'en cite aucune.
- Irréversible = schéma de données, API publique, suppression (données, fichiers d'utilisateurs). Appelle \`decision\` avec la catégorie correspondante, N'APPLIQUE PAS le choix, contourne, et termine tout ce qui n'en dépend pas : les escalades partent ensemble à la fin de l'étape.
- Une décision tranchée par l'humain (section Oracle) s'impose : ne la rouvre pas.
- \`checkpoint\` après chaque incrément cohérent (le service commite l'état courant) ; \`set_modules\` dès que tu connais les chemins que le travail touchera.
- \`progress\` à chaque jalon franchi, une phrase.
- En fin d'étape, \`mem0_add\` pour les SEULS pièges durables que tu as rencontrés (un fait autoportant par appel) ; rien de trivial ni de temporaire.`;

function section(title: string, body: string | null): string {
  return body === null || body.trim() === "" ? "" : `\n## ${title}\n${body.trim()}\n`;
}

function bullets(lines: string[]): string | null {
  return lines.length === 0 ? null : lines.map((line) => `- ${line}`).join("\n");
}

const ART = ARTIFACTS_DIR;

const TESTABLE_SPEC = "Une spec qui ne permet pas d'écrire le test avant le code n'est pas assez précise.";

function reviewBody(ctx: PromptContext): string {
  const head = `# /review — revue de « ${ctx.title} »

Lis \`${ART}/req.md\`, \`${ART}/specs.md\` et \`${ART}/impl.md\` : la revue juge le code contre les critères AC-n (B-m), pas contre une impression.`;
  const scope =
    ctx.sinceSha === null
      ? `Première revue : relis le diff COMPLET, \`git diff ${ctx.baseSha}\` (base = main), critère par critère.
- Lance la suite COMPLÈTE une fois : \`run_tests\` avec \`scope: full\` (le service l'a déjà mise en route à l'entrée de la revue ; l'appel rejoint ce job).`
      : `Revue INCRÉMENTALE : relis le diff depuis \`${ctx.sinceSha}\` (\`git diff ${ctx.sinceSha}\`), c'est la correction ; vérifie chaque bloquant levé par la revue précédente, un par un, avec sa preuve :
${bullets(ctx.previousBlockers) ?? "- (aucun bloquant transmis : relis \`.harness/fix.md\`)"}
- \`run_tests\` avec \`scope: touched\` d'abord ; la suite \`scope: full\` seulement s'il ne reste plus AUCUN bloquant.`;
  return `${head}

${scope}
- Ne modifie PAS le code pendant la revue : un bloquant part en correction.
- Termine par \`review_verdict\`, une fois : la table \`criteria\` AC par AC (chaque AC-n de specs.md, le nom du test qui le prouve, \`pass\` | \`fail\` | \`untested\`), le risque, les bloquants, les risques résiduels, les fichiers touchés (tous ceux du diff), ce que tu n'as PAS vérifié (\`unverified\`), et une \`confidence\` honnête : \`weak\` dès que tu doutes de ta propre revue — un \`strong\` mensonger coûte plus qu'un \`weak\` sincère.`;
}

function fixBody(ctx: PromptContext): string {
  const verdict = ctx.previousVerdict;
  const blockers = bullets(ctx.blockers) ?? "- (voir la reprise ci-dessous)";
  const extra =
    verdict === null
      ? ""
      : `${section("Risques résiduels relevés par la revue", bullets(verdict.risks))}${section("Ce que la revue n'a PAS pu vérifier", bullets(verdict.unverified))}${section("Résumé de la revue", `${verdict.summary} (risque ${verdict.risk}, confiance ${verdict.confidence})`)}`;
  return `# /impl --fix — corrections de « ${ctx.title} »

Lis \`${ART}/specs.md\` et le verdict complet ci-dessous. Corrige ces bloquants de la revue, et rien d'autre :
${blockers}
${extra}
- Vérifie avec \`run_tests\` (\`scope: touched\`) ; un test nommé avec l'id AC-n prouve chaque correction.
- Écris \`${ART}/fix.md\` : pour chaque bloquant, la levée et sa PREUVE (fichier:ligne, test). Un bloquant que tu contestes y est expliqué, avec les faits.
- \`checkpoint\` après chaque bloquant levé. La revue reprendra ensuite sur le diff depuis ton point de départ.`;
}

const BODY: Record<StepKind, (ctx: PromptContext) => string> = {
  req: (ctx) => `# /req — besoins de « ${ctx.title} »

Établis les BESOINS de cette demande, sans concevoir la solution. Lis le code juste assez pour comprendre le contexte ; la section Oracle ci-dessous est le rappel du service.

Écris \`${ART}/req.md\` avec exactement ces sections :
## Besoins
(une ligne par besoin, \`B-n : verbe objet contraintes\` — ce que l'utilisateur doit pouvoir faire, observable)
## Critères d'acceptation
(une ligne par critère, \`AC-n (B-m) : Given <état>, When <action>, Then <résultat observable>\` — co-signé par le besoin qu'il prouve ; chaque B-n a au moins un AC)
## Hors périmètre
(ce que cette feature ne fera pas, pour que /specs ne l'invente pas)
## Contraintes
(celles de l'oracle et du dépôt : compatibilité, perf, sécurité)

Ne modifie AUCUN autre fichier.`,

  specs: (ctx) => `# /specs — spécifications de « ${ctx.title} »

Lis \`${ART}/req.md\`. Écris \`${ART}/specs.md\` avec exactement ces sections :
## Relevé du dépôt
(chemins, symboles et conventions avec leurs lignes — \`fichier:ligne\` — tout ce que /impl aura besoin de savoir pour ne PAS relire le dépôt)
## Documentation
(seulement si une API ou une bibliothèque EXTERNE est en jeu : les extraits utiles, sinon omets la section)
## Non-objectifs
(repris de « Hors périmètre », complétés par ce que la conception écarte)
## Spécifications
(\`S-n (AC-m, AC-p) : comportement\`, traçable au critère qu'elle sert ; cas limites et erreurs explicités. ${TESTABLE_SPEC})
## Critères d'acceptation
(recopiés de req.md, \`AC-n (B-m) : Given/When/Then\`, chacun vérifiable par un test automatisé nommé avec son id)
## Modules
(OBLIGATOIRE, non vide : une puce par chemin du dépôt que l'implémentation touchera — dossiers ou fichiers ; c'est ce qui décide du parallélisme. Appelle aussi \`set_modules\` avec ces chemins.)
## Découpage
(si l'implémentation dépassera ~${ctx.maxDiffLines} lignes de diff de code : une liste \`- titre — demande — modules\` par sous-feature AUTRE que celle que ce run garde, et appelle \`split_feature\` avec les mêmes ; sinon exactement « aucun »)

Ne modifie AUCUN autre fichier.`,

  impl: (ctx) => `# /impl — implémentation de « ${ctx.title} »

Lis \`${ART}/req.md\` et \`${ART}/specs.md\` (le relevé du dépôt t'évite de le relire). Implémente les spécifications S-n, avec un test par critère d'acceptation, NOMMÉ avec son id (\`AC-n\` dans le nom du test).
- Aucun stub, aucun TODO, aucun « à faire plus tard » : ce qui est livré est complet.
- Une spec ambiguë ou fausse ⇒ corrige \`${ART}/specs.md\` (et cite la S-n modifiée dans impl.md) plutôt que d'implémenter à côté.
- \`set_modules\` dès que les chemins touchés sont connus, s'ils diffèrent de specs.md.
- \`checkpoint\` après chaque incrément cohérent (tests verts sur ce qui est écrit).
- Diff visé : < ${ctx.maxDiffLines} lignes de code. Au-delà, arrête-toi à un incrément cohérent, appelle \`split_feature\` avec les sous-features restantes, et note-les dans \`## Reste\`.
- Tests : \`run_tests\` avec \`scope: touched\` (tests des fichiers touchés, slot heavy isolé) ; \`scope: check\` avec \`check\` pour une commande nommée du dépôt. La suite complète est réservée à /review.
- Ne commite pas toi-même : \`checkpoint\` et la fin d'étape commitent.

Termine par \`${ART}/impl.md\` avec exactement ces sections :
## Fait
(AC par AC : \`AC-n\` → test nommé, fichiers)
## Reste
(ce qui n'est PAS livré, ou vide si tout l'est — le service en fait une feature de suite)`,

  review: reviewBody,
  fix: fixBody,
};

/** Le prompt complet d'une étape. */
export function stepPrompt(ctx: PromptContext): string {
  const parts = [BODY[ctx.step](ctx)];
  parts.push(section("Demande d'origine", ctx.request));
  parts.push(section("Oracle (rappel du service)", ctx.memories));
  parts.push(section("Décisions déjà prises dans ce run (elles tiennent)", bullets(ctx.decisions)));
  if (ctx.conflicts.length > 0) {
    parts.push(
      section(
        "Conflits avec main",
        `Le rebase sur main a échoué ; le service a fusionné main dans la branche. Ces fichiers portent des marqueurs de conflit : ${ctx.conflicts.join(", ")}. ` +
          "Résous-les DANS LES FICHIERS en gardant l'intention des deux côtés (n'appelle pas git : le service conclura la fusion), puis fais la revue.",
      ),
    );
  }
  parts.push(section("Reprise", ctx.resume));
  parts.push(`\n${POLICY}\n`);
  return parts.filter((part) => part !== "").join("\n");
}

/** La relance unique d'une étape qui n'a pas rendu son artefact ou son verdict. */
export function nudgePrompt(step: StepKind, missing: string): string {
  return `L'étape /${step} n'est pas terminée : ${missing}. Termine-la maintenant, sans rien rouvrir.`;
}

/** Le prompt de reprise après une bascule de fournisseur sur rate limit. */
export const FAILOVER_PROMPT =
  "Reprends exactement où tu t'es arrêté : le fournisseur précédent a atteint sa limite de débit, tu tournes maintenant sur un autre modèle.";

/**
 * Le prompt de l'audit d'un dépôt : lecture seule, propositions par `audit_propose`.
 * `inFlight` (runs ouverts du dépôt) et `delivered` (souvenirs « Feature mergée ») évitent
 * de proposer ce qui est déjà en cours ou livré.
 */
export function auditPrompt(ctx: {
  repo: string;
  focus: string;
  memories: string | null;
  inFlight?: string[];
  delivered?: string | null;
}): string {
  const focus = ctx.focus.trim() === "" ? "le dépôt entier" : ctx.focus.trim();
  return [
    `# /audit — audit de « ${ctx.repo} »

Audite ${focus}, sur \`main\`, en LECTURE SEULE : ne modifie AUCUN fichier. La section Oracle ci-dessous rappelle les besoins et décisions tranchées.

Repère :
- les FAIBLESSES : bugs probables, failles de sécurité, dette qui freine, tests manquants sur du code critique ;
- les FEATURES qui manquent au regard des besoins connus.

Termine par \`audit_propose\`, une fois : au plus 10 propositions, les plus utiles d'abord, chacune livrable seule en moins de ~300 lignes de diff. Pour chacune : \`evidence\` (OBLIGATOIRE pour une faiblesse : \`fichier:ligne\` qui la prouve — une faiblesse sans preuve dans le code n'est pas une proposition), \`dependsOn\` (les titres des propositions à livrer avant), \`impact\` et \`effort\`.`,
    section("Oracle (rappel du service)", ctx.memories),
    section(
      "Déjà en cours ou livré — ne propose pas de doublon",
      [
        (ctx.inFlight ?? []).length > 0 ? `Runs ouverts :\n${(ctx.inFlight ?? []).map((t) => `- ${t}`).join("\n")}` : "",
        ctx.delivered ?? "",
      ]
        .filter((part) => part !== "")
        .join("\n\n"),
    ),
    `\n- \`progress\` à chaque partie du dépôt parcourue, une phrase. N'utilise JAMAIS \`ask\`.\n`,
  ]
    .filter((part) => part !== "")
    .join("\n");
}
