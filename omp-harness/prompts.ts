// Les prompts d'étape : ce que chaque runner lit (artefacts N-1), produit (les siens),
// et la politique de décision commune. Fonctions PURES, testées sur leur contenu.
import type { StepKind } from "./machine.ts";
import { ARTIFACTS_DIR } from "./git.ts";


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
  /** Les souvenirs de l'oracle, déjà rendus (req, specs). */
  memories: string | null;
  /** Les bloquants de la dernière revue (fix). */
  blockers: string[];
  /** Ce que le service doit dire en reprise : escalades répondues, décision renversée, refus humain. */
  resume: string | null;
  /** Les décisions déjà prises dans ce run (elles tiennent, sauf renversement). */
  decisions: string[];
  /** Le rebase sur main a échoué : le service a fusionné main, ces fichiers sont en conflit. */
  conflicts: string[];
};


const POLICY = `## Politique de décision (non négociable)
- Personne ne répondra à une question pendant l'étape : n'utilise JAMAIS \`ask\`.
- Ce que les specs, l'oracle ou le code ne tranchent pas, tu le tranches : choisis l'option la PLUS RÉVERSIBLE et appelle l'outil \`decision\` (category: reversible). Le service pose un checkpoint ; l'humain relira et pourra renverser.
- Irréversible = schéma de données, API publique, suppression (données, fichiers d'utilisateurs). Appelle \`decision\` avec la catégorie correspondante, N'APPLIQUE PAS le choix, contourne, et termine tout ce qui n'en dépend pas : les escalades partent ensemble à la fin de l'étape.
- Une décision tranchée par l'humain (oracle) s'impose : ne la rouvre pas.
- \`progress\` à chaque jalon franchi, une phrase.`;


function section(title: string, body: string | null): string {
  return body === null || body.trim() === "" ? "" : `\n## ${title}\n${body.trim()}\n`;
}


function decisionsBlock(decisions: string[]): string | null {
  return decisions.length === 0 ? null : decisions.map(line => `- ${line}`).join("\n");
}


const ART = ARTIFACTS_DIR;


const BODY: Record<StepKind, (ctx: PromptContext) => string> = {
  req: ctx => `# /req — besoins de « ${ctx.title} »

Établis les BESOINS de cette demande, sans concevoir la solution. Lis le code juste assez pour comprendre le contexte ; commence par \`oracle_recall\` sur le sujet.

Écris \`${ART}/req.md\` avec exactement ces sections :
## Besoins
(numérotés B-1, B-2… : ce que l'utilisateur doit pouvoir faire, observable)
## Hors périmètre
## Contraintes
(celles de l'oracle et du dépôt : compatibilité, perf, sécurité)

Ne modifie AUCUN autre fichier.`,

  specs: ctx => `# /specs — spécifications de « ${ctx.title} »

Lis \`${ART}/req.md\`. Écris \`${ART}/specs.md\` avec exactement ces sections :
## Spécifications
(le comportement attendu, module par module)
## Critères d'acceptation
(AC-1, AC-2… : chacun vérifiable par un test automatisé nommé)
## Modules
(une puce par chemin du dépôt que l'implémentation touchera — dossiers ou fichiers ; c'est ce qui décide du parallélisme)
## Découpage
(si l'implémentation dépassera ~${ctx.maxDiffLines} lignes de diff : propose des features plus petites ; sinon « aucun »)

Ne modifie AUCUN autre fichier.`,

  impl: ctx => `# /impl — implémentation de « ${ctx.title} »

Lis \`${ART}/req.md\` et \`${ART}/specs.md\`. Implémente les spécifications, avec un test par critère d'acceptation.
- Diff visé : < ${ctx.maxDiffLines} lignes. Au-delà, arrête-toi à un incrément cohérent et note le reste dans \`${ART}/impl.md\`.
- Tests : \`run_tests\` avec \`scope: touched\` (tests des fichiers touchés, slot heavy isolé). La suite complète est réservée à /review.
- Ne commite pas : le service commite (checkpoints de décision et fin d'étape).

Termine par \`${ART}/impl.md\` : ce qui est fait, AC par AC, et ce qui reste.`,

  review: ctx => `# /review — revue de « ${ctx.title} »

Relis le diff complet : \`git diff ${ctx.baseSha}\` (base = main), contre \`${ART}/specs.md\` critère par critère.
- Lance la suite COMPLÈTE une fois : \`run_tests\` avec \`scope: full\`.
- Ne modifie PAS le code pendant la revue : un bloquant part en correction.
- Termine par \`review_verdict\` : risque, bloquants, risques résiduels, fichiers touchés, ce que tu n'as PAS vérifié, confiance.`,

  fix: ctx => `# /impl --fix — corrections de « ${ctx.title} »

Corrige ces bloquants de la revue, et rien d'autre :
${ctx.blockers.map(blocker => `- ${blocker}`).join("\n") || "- (voir la reprise ci-dessous)"}

Vérifie avec \`run_tests\` (\`scope: touched\`). Ne commite pas. La revue reprendra ensuite dans cette même session.`,
};


/** Le prompt complet d'une étape. */
export function stepPrompt(ctx: PromptContext): string {
  const parts = [BODY[ctx.step](ctx)];
  parts.push(section("Demande d'origine", ctx.request));
  if (ctx.step === "req" || ctx.step === "specs") parts.push(section("Oracle (rappel du service)", ctx.memories));
  parts.push(section("Décisions déjà prises dans ce run (elles tiennent)", decisionsBlock(ctx.decisions)));
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
  return parts.filter(part => part !== "").join("\n");
}


/** La relance unique d'une étape qui n'a pas rendu son artefact ou son verdict. */
export function nudgePrompt(step: StepKind, missing: string): string {
  return `L'étape /${step} n'est pas terminée : ${missing}. Termine-la maintenant, sans rien rouvrir.`;
}


/** Le prompt de reprise après une bascule de fournisseur sur rate limit. */
export const FAILOVER_PROMPT = "Reprends exactement où tu t'es arrêté : le fournisseur précédent a atteint sa limite de débit, tu tournes maintenant sur un autre modèle.";
