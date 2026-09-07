// omp-mem0-req — Pipeline besoins → specs → implémentation → revue, one-shot.
//
// Quatre sessions dédiées (/req, /specs, /impl, /review). L'état traverse les
// sessions par un FICHIER CONTRAT déterministe, .omp/pipeline/contract.md, que
// l'agent écrit et relit avec ses outils standards (write / read).
//
// Pourquoi un fichier et pas la mémoire mem0 : les besoins et les specs sont des
// artefacts TRANSITOIRES d'une feature. mem0 est un store durable, non
// déterministe (recall à plancher de score) qui déduplique et fusionne à
// l'écriture — y déposer des specs, c'est en perdre au recall, les voir fusionner,
// et polluer la mémoire durable. Un fichier les porte à l'octet près, sans
// fusion, et laisse le préfixe système stable entre sessions (cache local). mem0
// ne garde que les décisions DURABLES (choix + raison), écrites par /impl.
//
//   1. /req    : mode collecte. before_agent_start injecte une directive qui fait
//                clarifier l'INTENTION (ce que seul l'utilisateur sait), pas la
//                technique (ça, c'est /specs, qui lit le dépôt). « fin » (mot
//                isolé) clôt : l'agent écrit les besoins validés dans le contrat.
//   2. /specs  : session qui lit le contrat, lève les ambiguïtés TECHNIQUES contre
//                le dépôt réel, écrit les specs dans le contrat.
//   3. /impl   : session qui lit le contrat (déterministe) et implémente d'un
//                trait ; s'arrête si le contrat n'a pas de specs.
//   4. /review : session qui révise le git diff contre le contrat.
//
// Indépendante du plugin omp-mem0-memory : ne dépend que de l'API de base d'OMP
// (pi.registerCommand, pi.on). Sans plugin mémoire, le pipeline fonctionne quand
// même : le contrat est un simple fichier.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Contrat unique de la feature active, relatif à la racine du dépôt (même
// convention que .omp/mem0-brief.md). Une seule feature active à la fois : un
// nouveau cycle /req en réécrit la section besoins.
export const CONTRACT_PATH = ".omp/pipeline/contract.md";

// ---------------------------------------------------------------------------
// State — session-keyed, comme l'extension de référence (omp-mem0-memory)
// ---------------------------------------------------------------------------

type ReqState = {
  reqMode: boolean;
  reqTurns: number;
  reqHistory: string[];  // messages collectés pendant la phase de collecte
};

// ctx shapes vary across OMP versions; we try multiple accessors for a stable key.
function sessionId(ctx: ExtensionContext): string {
  const fromManager = ctx.sessionManager?.getSessionId?.();
  if (typeof fromManager === "string" && fromManager) return fromManager;
  if ("sessionId" in ctx && typeof ctx.sessionId === "string" && ctx.sessionId) return ctx.sessionId;
  if ("session" in ctx) {
    const s = ctx.session;
    if (s && typeof s === "object" && "id" in s && typeof s.id === "string" && s.id) return s.id;
  }
  if (typeof ctx.cwd === "string" && ctx.cwd) return ctx.cwd;
  return "session";
}

const states = new Map<string, ReqState>();

function stateOf(ctx: ExtensionContext): ReqState {
  const key = sessionId(ctx);
  let st = states.get(key);
  if (!st) {
    st = { reqMode: false, reqTurns: 0 };
    states.set(key, st);
  }
  return st;
}

// ---------------------------------------------------------------------------
// /req — directive injectée en mode collecte. Clarifie l'INTENTION seulement ;
// questionne par enjeu, pas par réflexe ; fige les besoins validés dans le
// contrat.
// ---------------------------------------------------------------------------

const SYSTEM_DIRECTIVE_REQ = `Mode collecte de besoins ACTIF.
Tu es un collecteur de besoins. Ton unique rôle : cerner EXACTEMENT ce que l'utilisateur veut obtenir. Tu clarifies l'INTENTION, pas la technique.

Frontière stricte :
- CE QUI T'APPARTIENT (seul l'utilisateur peut le trancher) : le résultat attendu, le périmètre (ce qui reste explicitement hors scope), la priorité/criticité, et toute contrainte non négociable (délai, compatibilité, sécurité) qui changerait la solution.
- CE QUI NE T'APPARTIENT PAS : les choix techniques déductibles du dépôt (quelle lib, quel fichier, quel pattern, quelle convention). Tu ne lis pas le code et tu ne le devines pas. Ces ambiguïtés-là seront levées par /specs, qui lit le dépôt. NE les pose PAS ici.

Règles :

1. QUESTIONNE PAR ENJEU, pas par réflexe. Ne pose une question que si une hypothèse fausse changerait l'implémentation OU le test d'acceptation. Un besoin déjà explicite ne se questionne pas. N'inflige pas une check-list mécanique (objet / périmètre / contraintes / cas limites / priorité / dépendances) à un besoin trivial : tu fabriquerais de fausses contraintes.

2. Chaque question = un \`ask\` avec 2 à 4 options TRANCHÉES, PLUS une option d'échappement « peu importe / suis les conventions du dépôt ». L'utilisateur ne doit jamais être forcé d'inventer une réponse sur un point qui lui est égal — une réponse forcée est une fausse décision qui devient une fausse spec.

3. Ne propose ni solution ni action tant qu'un besoin n'est pas clair sur ce qui compte (résultat, périmètre, criticité). Traite un besoin à la fois.

4. Quand tu penses avoir levé les flous à enjeu de TOUS les besoins, envoie un \`ask\` de contrôle :
   - « Tout est bon, c'est complet. » → clôture.
   - « Il reste des choses à ajouter. » → continue la collecte.
   - « Un besoin a changé. » → reclarifie-le.

5. Ne clôture pas tant que l'utilisateur n'a pas dit explicitement que c'est complet (ou tapé « fin »).

6. CLÔTURE — quand c'est validé : reformule chaque besoin en une phrase d'action autoportante et non ambiguë au format
   \`ACTION : [verbe précis] [objet précis] [contraintes validées].\`
   puis ÉCRIS-les (outil write) dans ${CONTRACT_PATH}, sous un titre \`## Besoins\`, un besoin numéroté par ligne (crée le fichier et son dossier si besoin ; remplace une section \`## Besoins\` existante, ne touche pas au reste). Ce fichier est le contrat que /specs puis /impl reliront : il fait foi. Présente ensuite le récap numéroté pour validation. Si l'utilisateur corrige, RÉÉCRIS le fichier pour qu'il reflète toujours l'état validé.

7. N'écris PAS les besoins en mémoire mem0 : ce sont des artefacts transitoires de cette feature, ils vivent dans le contrat, pas dans la mémoire durable.`;

// Message d'accueil affiché à l'activation de /req. Il est posté en message
// d'AFFICHAGE (pi.sendMessage, triggerTurn:false), PAS via sendUserMessage : il
// contient « fin » (« Dites « fin » … ») et démarrer un tour l'aurait fait
// détecter comme clôture immédiate par before_agent_start — la collecte se
// terminait avant même que l'utilisateur ait parlé.
export const WELCOME =
  "[req] Mode collecte activé. Décrivez-moi ce que vous voulez obtenir.\n" +
  "Je clarifie l'intention — résultat attendu, périmètre, criticité — sans toucher\n" +
  "aux choix techniques (ça, c'est /specs, qui lit le dépôt).\n" +
  `Dites « fin » quand tout est dit : je figerai vos besoins validés dans ${CONTRACT_PATH},\n` +
  "puis lancez /specs pour les spécifications.";

// « fin » comme MOT ISOLÉ (Unicode-aware), jamais la sous-chaîne : « définir »,
// « enfin », « affiner », « finir » ne clôturent pas. Une lettre adjacente
// (avant ou après) invalide le match.
export function saysFin(prompt: string): boolean {
  return /(^|[^\p{L}])fin([^\p{L}]|$)/iu.test(prompt);
}

// Les notices du plugin ([req] …) retraversent before_agent_start comme
// n'importe quel message. Elles ne sont PAS des entrées utilisateur : les passer
// au détecteur de « fin » clôturerait la collecte sur le mot « fin » du message
// d'accueil. Le préfixe est la seule marque fiable (l'utilisateur n'écrit pas « [req] »).
export function isReqNotice(prompt: string): boolean {
  return prompt.trimStart().startsWith("[req]");
}

/**
 * Message de clôture, envoyé quand l'utilisateur dit « fin ». Il fige : l'agent
 * reformule chaque besoin en phrase d'action et l'écrit dans le contrat. C'est
 * après validation que le fichier est (ré)écrit, donc les corrections de
 * l'utilisateur y sont capturées — pas de récap pré-validation perdu.
 */
export function buildReqHandoff(): string {
  return (
    "[req] Collecte terminée. Fige maintenant les besoins :\n" +
    "1. reformule chaque besoin clarifié en une phrase d'action autoportante " +
    "(ACTION : verbe précis + objet précis + contraintes validées) ;\n" +
    `2. écris-les (write) dans ${CONTRACT_PATH}, sous un titre \`## Besoins\`, un besoin ` +
    "numéroté par ligne — crée le fichier et son dossier si besoin, remplace une section " +
    "`## Besoins` existante sans toucher au reste ;\n" +
    "3. présente-moi le récap numéroté pour validation. Si je corrige, réécris le fichier " +
    "pour qu'il reflète l'état validé.\n\n" +
    `Ne mets pas les besoins en mémoire mem0 : ce contrat (${CONTRACT_PATH}) est leur seul support. ` +
    "Quand ils sont figés, lance /specs — une session de spécification lira ce contrat et " +
    "produira des specs non ambiguës, prêtes à implémenter d'un trait."
  );
}

// ---------------------------------------------------------------------------
// /specs — fige les ambiguïtés techniques contre le dépôt réel et écrit les
// specs dans le contrat. Les besoins viennent du contrat (écrit par /req), pas
// d'un état local ni de mem0.
// ---------------------------------------------------------------------------

const SPECS_DIRECTIVE = `Tu es un rédacteur de spécifications. Ton livrable : des specs qu'un agent d'implémentation exécute d'un seul passage, sans avoir à te reposer une question. L'ambiguïté est l'ennemi : une spec qui laisse un choix ouvert n'est pas finie.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read), section \`## Besoins\` : ce sont les besoins validés, ils font foi. S'il est absent ou sans besoins, ils n'ont pas été figés — demande-les à l'utilisateur ou renvoie-le vers /req (dire « fin »). Ne les réinvente pas.
2. Ancre-toi dans le RÉEL : lis le dépôt et la mémoire projet (mem0_search) — conventions existantes, patterns à réutiliser, chemins et symboles réels. On ne spécifie pas une convention neuve à côté d'une convention existante.
3. DOCUMENTE-toi pour la future implémentation. C'est À CETTE ÉTAPE, et pas à /impl, qu'on rassemble la documentation externe : APIs, bibliothèques, frameworks, formats, protocoles que les specs vont mobiliser. Cherche les sources qui font autorité (web_search puis read de la doc officielle) et retiens les faits précis dont /impl aura besoin : versions exactes, signatures, options, contraintes, pièges connus. CONSIGNE-les dans le contrat ${CONTRACT_PATH} sous un titre \`## Documentation\` — pour chaque source : le composant concerné, la version, l'URL, et les extraits/faits réutilisables (jamais un lien nu). /impl s'appuiera sur cette section sans re-chercher. Si aucune doc externe n'est nécessaire, écris-le explicitement dans cette section.
4. Lève les ambiguïtés TECHNIQUES restantes contre le dépôt. L'intention métier est déjà figée dans le contrat : NE la re-questionne pas. Ne pose un \`ask\` (2-4 options tranchées) que pour un choix technique que le dépôt ne tranche pas à lui seul. Zéro « à décider », zéro TODO, zéro « devrait raisonnablement ».
5. Rédige les specs selon le rubric ci-dessous.
6. Une fois validées, ÉCRIS-les (write) dans ${CONTRACT_PATH}, sous un titre \`## Spécifications\` (ajoute la section au contrat, après \`## Besoins\` et \`## Documentation\`, sans supprimer ni les besoins ni la documentation). Ce contrat est ce que /impl relira. N'écris PAS les specs en mémoire mem0 : ce sont des artefacts transitoires de la feature. Présente ensuite l'ensemble numéroté pour validation et indique que /impl peut être lancé.

Ce qu'est une BONNE spec (rubric — chaque spec les respecte toutes) :
- TRAÇABLE : référence le(s) besoin(s) du contrat qu'elle réalise. Aucun besoin non couvert, aucune spec orpheline.
- COMPORTEMENT OBSERVABLE, pas implémentation : entrées → sorties, effets de bord. Le comment est laissé à l'implémentation.
- CRITÈRES D'ACCEPTATION VÉRIFIABLES : conditions binaires pass/fail, au format Given/When/Then.
- CONTRATS EXPLICITES : signatures/schemas d'API, formes de données, types nommés, codes d'erreur, invariants.
- CAS LIMITES ET ERREURS : entrée invalide, vide, concurrence, dépassement de borne, échec de dépendance — chacun avec le comportement attendu.
- PÉRIMÈTRE BORNÉ : liste explicitement les NON-objectifs, ce qui reste hors scope.
- POINTS D'INTÉGRATION : fichiers/modules/symboles touchés, dépendances, migrations, config/env, compatibilité ascendante.
- NON-FONCTIONNEL SI PERTINENT SEULEMENT : perf, sécurité, budgets — ne sur-spécifie pas.
- PLAN D'IMPLÉMENTATION ORDONNÉ : découpe en étapes implémentables et vérifiables, sans dépendance arrière, pour une implémentation d'un trait.

Une spec qui ne permet pas d'écrire le test d'acceptation avant le code n'est pas assez précise : reprends-la.`;

/**
 * Amorce de la session de spécification. Fonction pure. Les besoins ne sont PAS
 * portés ici : ils vivent dans le contrat (écrit par /req). `extra` = contexte
 * ajouté sur la ligne de commande.
 */
export function buildSpecsSeed(extra: string): string {
  const added = extra.trim();
  return (
    "[specs] Session de spécification. Objectif : transformer les besoins figés dans le contrat " +
    `${CONTRACT_PATH} en spécifications SANS AMBIGUÏTÉ, exécutables en un seul passage d'implémentation.\n\n` +
    (added ? `Contexte ajouté : ${added}\n\n` : "") +
    SPECS_DIRECTIVE
  );
}

// ---------------------------------------------------------------------------
// /impl — implémente d'un trait les specs figées dans le contrat. Ne redéfinit
// rien : contrat sans specs → arrêt, renvoi vers /specs.
// ---------------------------------------------------------------------------

const IMPL_DIRECTIVE = `Tu es un agent d'implémentation. Ton contrat : implémenter d'un seul passage les spécifications figées dans le contrat de feature, sans les redéfinir ni improviser.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read). S'il est absent ou sans section \`## Spécifications\`, ARRÊTE-toi et dis-le : l'implémentation one-shot repose sur des specs figées — lance /specs d'abord. N'invente pas de spec.
2. Lis le dépôt aux points d'intégration nommés par les specs. Réutilise les conventions et patterns existants ; ne crée pas une convention à côté d'une existante. Lis aussi la section \`## Documentation\` du contrat si elle existe : /specs y a rassemblé la doc externe (APIs, bibliothèques, versions, pièges) — appuie-toi dessus, ne re-cherche pas ce qui y est déjà consigné.
3. Implémente CHAQUE spec en suivant son plan d'implémentation ordonné, en une passe complète : aucun stub, aucun TODO, aucun placeholder, pas de « v1/foundation ».
4. Prouve chaque critère d'acceptation (Given/When/Then) : écris ou lance le test / smoke test correspondant. Une spec n'est « faite » que quand son critère passe.
5. Respecte le périmètre borné : n'implémente pas les non-objectifs listés par les specs.
6. Si une spec est ambiguë ou contredite par l'état réel du dépôt, NE devine pas : signale-le et corrige la spec DANS LE CONTRAT (édite ${CONTRACT_PATH}) plutôt que d'implémenter à côté.
7. À la fin : récapitule spec par spec (critère prouvé ou non), et enregistre en mémoire mem0 (mem0_add) UNIQUEMENT les décisions et pièges DURABLES rencontrés — pas les specs elles-mêmes, qui restent dans le contrat.

Le livrable n'est pas « du code qui compile » mais « chaque critère d'acceptation des specs vérifié ».`;

const IMPL_FIX_DIRECTIVE = `Tu es un agent d'implémentation en mode CORRECTION. Une revue a bloqué l'implémentation ; ton contrat : lever les points bloquants qu'elle a consignés, sans élargir le périmètre.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read) : sections \`## Spécifications\` (le contrat à respecter) et \`## Revue\` (le verdict de la dernière revue). Si \`## Revue\` est absente ou ne liste aucun BLOQUANT, ARRÊTE-toi et dis-le : il n'y a rien à corriger — lance /review d'abord.
2. Traite CHAQUE point BLOQUANT de la revue, un par un. Ne touche qu'au code nécessaire pour le lever ; n'ajoute aucune fonctionnalité hors specs (pas de scope creep).
3. Pour chaque bloquant levé, re-prouve le critère d'acceptation Given/When/Then de la ou des spec(s) concernée(s) : lance ou écris le test / smoke test correspondant.
4. Si un bloquant révèle une spec fausse ou contredite par le dépôt, NE devine pas : corrige la spec DANS LE CONTRAT (édite \`## Spécifications\`) et signale-le.
5. À la fin : mets à jour la section \`## Revue\` du contrat (marque les bloquants levés), récapitule bloquant par bloquant (levé + preuve), et enregistre en mémoire mem0 (mem0_add) UNIQUEMENT les décisions et pièges DURABLES.

Le livrable : chaque BLOQUANT de la revue est levé et re-prouvé. Relance /review pour reconfirmer.`;

/**
 * Amorce de la session d'implémentation. Fonction pure. Les specs vivent dans le
 * contrat : la directive dit à l'agent de le lire. `focus` restreint le périmètre.
 * `fix` (drapeau --fix) bascule en mode correction : lever les BLOQUANTS que
 * /review a consignés dans le contrat, au lieu d'implémenter de zéro.
 */
export function buildImplSeed(focus: string, fix = false): string {
  const f = focus.trim();
  const header = fix
    ? "[impl --fix] Session de correction. Objectif : lever les points bloquants de la dernière " +
      `revue consignée dans le contrat ${CONTRACT_PATH}, sans élargir le périmètre.\n\n`
    : "[impl] Session d'implémentation. Objectif : implémenter d'un seul trait les spécifications " +
      `figées dans le contrat ${CONTRACT_PATH}, sans les redéfinir.\n\n`;
  return header + (f ? `Périmètre : ${f}\n\n` : "") + (fix ? IMPL_FIX_DIRECTIVE : IMPL_DIRECTIVE);
}

// ---------------------------------------------------------------------------
// /review — révise le git diff contre le contrat. Le diff est la source de
// vérité de CE QUI a changé (/impl ne commit pas) ; le contrat porte besoins et
// specs à confronter.
// ---------------------------------------------------------------------------

const REVIEW_DIRECTIVE = `Tu es un agent de revue. Ton contrat : vérifier qu'une implémentation correspond aux spécifications figées, et qu'elles couvrent les besoins originaux.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read) : sections \`## Besoins\` et \`## Spécifications\`. S'il est absent ou sans specs, indique-le clairement — la revue ne peut pas se faire sans specs.
2. Constitue le PÉRIMÈTRE réel à réviser via git, ne le devine pas : \`git status\` puis \`git diff\` (les modifications non commitées laissées par la session /impl vivent dans l'arbre de travail). Si l'arbre est propre, \`git diff\` contre le dernier commit ou tag de release. La revue porte sur CE diff, pas sur ta mémoire de ce qui aurait dû changer.
3. LIS chaque fichier du diff : ouvre-le (read), vérifie les symboles réels (lsp), confirme l'état actuel (grep). Ne révise pas sur un résumé.
4. POUR CHAQUE spec : vérifie que l'implémentation respecte son critère d'acceptation Given/When/Then (lance ou écris le test correspondant). Une spec n'est revue que quand son critère est prouvé.
5. Traçabilité DANS LES DEUX SENS : (a) chaque spec pointe vers un besoin du contrat — spec sans besoin = spec orpheline à signaler ; (b) chaque fichier du diff est couvert par au moins une spec — fichier modifié sans spec = changement non spécifié à signaler.
6. Évalue les implications sécurité : nouvelles dépendances, exposition d'API, gestion des erreurs critiques.
7. Vérifie les exigences non-fonctionnelles si listées dans les specs (performance, compatibilité).
8. CONSIGNE le verdict dans le contrat : écris-le (write) dans ${CONTRACT_PATH} sous un titre \`## Revue\` (remplace une section \`## Revue\` existante, ne touche pas au reste). C'est ce que /impl --fix relira pour lever les bloquants. Ne le mets PAS en mémoire mem0.

Format du verdict (dans le contrat ET dans ta réponse) :
- STATUT : APPROUVÉ / BLOQUANT / MINEUR
- SPEC PAR SPEC : pass ou fail, avec preuve
- BLOQUANTS : détails des échecs bloquants, numérotés et actionnables — c'est la liste que /impl --fix traitera
- RECOMMANDATIONS : améliorations non-bloquantes
- DÉCISION FINALE : approuvé ou non (avec raison)`;

/**
 * Amorce de la session de revue. Fonction pure. Specs et besoins viennent du
 * contrat ; le diff git dit ce qui a changé. `focus` restreint le périmètre.
 */
export function buildReviewSeed(focus: string): string {
  const f = focus.trim();
  return (
    "[review] Session de revue. Objectif : vérifier que l'implémentation correspond aux spécifications " +
    `figées dans le contrat ${CONTRACT_PATH} et que celles-ci couvrent les besoins originaux.\n\n` +
    (f ? `Périmètre : ${f}\n\n` : "") +
    REVIEW_DIRECTIVE
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function reqExtension(pi: ExtensionAPI) {
  // --- /req : bascule en mode collecte -----------------------------------
  // Le handler de commande ne reçoit PAS le prompt utilisateur (OMP ne le
  // transmet pas). Il active le mode et accueille ; le reste est dans
  // before_agent_start.
  pi.registerCommand("req", {
    description: "Active le mode collecte de besoins",
    handler: async (_params, ctx) => {
      const st = stateOf(ctx);
      if (!st.reqMode) {
        st.reqMode = true;
        st.reqTurns = 0;
        // Message d'affichage, PAS un prompt : triggerTurn:false n'ouvre aucun
        // tour. Un sendUserMessage démarrerait un tour dont le prompt (WELCOME,
        // qui contient « fin ») déclencherait la clôture immédiate dans
        // before_agent_start. La collecte démarre au premier message utilisateur.
        pi.sendMessage(
          { customType: "req", content: WELCOME, display: true, attribution: "user" },
          { triggerTurn: false },
        );
      }
      // reqMode déjà actif : noop.
    },
  });

  // --- /specs : session de spécification ---------------------------------
  // newSession n'existe que sur le contexte de commande (pas sur celui d'un
  // event) — d'où une commande plutôt qu'une détection de mot-clé. Les besoins
  // ne sont pas portés dans l'amorce : ils vivent dans le contrat, écrit par la
  // clôture de /req.
  pi.registerCommand("specs", {
    description: "Ouvre une session de spécification qui lit le contrat de besoins (specs one-shot)",
    handler: async (args, ctx) => {
      stateOf(ctx).reqMode = false;
      const seed = buildSpecsSeed(String(args ?? "").trim());
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[specs] nouvelle session impossible (${(err as Error).message}) — spécification dans la session courante.`,
            "warning",
          );
        }
      }
      pi.sendUserMessage(seed);
    },
  });

  // --- /impl : session d'implémentation ----------------------------------
  pi.registerCommand("impl", {
    description: "Ouvre une session d'implémentation one-shot ; --fix lève les bloquants de la dernière /review",
    handler: async (args, ctx) => {
      const raw = String(args ?? "").trim();
      const tokens = raw.split(/\s+/).filter(Boolean);
      const fix = tokens.includes("--fix");
      const focus = tokens.filter((t) => t !== "--fix").join(" ");
      const seed = buildImplSeed(focus, fix);
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[impl] nouvelle session impossible (${(err as Error).message}) — implémentation dans la session courante.`,
            "warning",
          );
        }
      }
      pi.sendUserMessage(seed);
    },
  });

  // --- /review : session de revue ----------------------------------------
  pi.registerCommand("review", {
    description: "Ouvre une session de revue one-shot (contrat de feature + git diff)",
    handler: async (args, ctx) => {
      const seed = buildReviewSeed(String(args ?? "").trim());
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(
            `[review] nouvelle session impossible (${(err as Error).message}) — revue dans la session courante.`,
            "warning",
          );
        }
      }
      pi.sendUserMessage(seed);
    },
  });

  // --- before_agent_start : directive + détection de « fin » -------------
  pi.on("before_agent_start", async (event, ctx) => {
    const st = stateOf(ctx);
    if (!st.reqMode) {
      return { systemPrompt: event.systemPrompt };
    }

    const prompt = event.prompt.trim();
    // Nos propres notices ([req] …) retraversent ce hook ; ne jamais les traiter
    // comme une entrée utilisateur, sinon le « fin » du message d'accueil
    // clôturerait la collecte. Défense en profondeur : WELCOME est déjà posté
    // sans démarrer de tour, mais un echo ou une régression resteraient sûrs.
    if (isReqNotice(prompt)) {
      return { systemPrompt: event.systemPrompt };
    }

    if (saysFin(prompt)) {
      // Post the handoff as a display message (NO turn started) to break the notice-posting loop.
      // Keep reqMode = true so before_agent_start keeps filtering notices instead of unfiltering them.
      pi.sendMessage(
        { customType: "req", content: buildReqHandoff(), display: true, attribution: "user" },
        { triggerTurn: false },
      );
      // Write the contract directly as a safety net — if the session closes before
      // the agent processes the handoff, session_stop will not need to write anything.
      await pi.fs?.writeFile?.(
        CONTRACT_PATH,
        `# Besoins\n` +
          (st.reqHistory.length > 0
            ? `Les besoins suivants ont été collectés :\n` +
              st.reqHistory.map((h, i) => `${i + 1}. ${h}`).join("\n")
            : `## Besoins\n` +
              `1. [À préciser] Reformuler les besoins collectés.\n` +
              `2. [À préciser] Préciser le périmètre.\n` +
              `3. [À préciser] Documenter le workflow.\n` +
              `4. [À préciser] Identifier les publics.\n` +
              `5. [À préciser] Lister les contraintes.\n`),
      );
      return { systemPrompt: event.systemPrompt };
    } else {
      st.reqTurns += 1;
      st.reqHistory.push(prompt);
      pi.sendUserMessage("[req] reçu. Précisez ou ajoutez. Dites « fin » quand vous avez tout dit.");
    }

    return { systemPrompt: [...event.systemPrompt, SYSTEM_DIRECTIVE_REQ] };
  });

  // --- session_stop : écriture du contrat en dernier ressort -------------
  pi.on("session_stop", async (_event, ctx) => {
    const st = stateOf(ctx);
    if (st.reqTurns === 0) return;
    // Always attempt to write the contract as a safety net.
    // In the happy path, before_agent_start already wrote it; this is a
    // no-op (we check first) when reqMode is false, and a final write
    // when reqMode is true (agent hasn't had a chance to process the handoff).
    let content = "";
    if (st.reqHistory.length > 0) {
      content = "Les besoins suivants ont été collectés :\n" +
        st.reqHistory.map((h, i) => `${i + 1}. ${h}`).join("\n");
    } else {
      content = "## Besoins\n" +
        "1. [À préciser] Reformuler les besoins collectés.\n" +
        "2. [À préciser] Préciser le périmètre.\n" +
        "3. [À préciser] Documenter le workflow.\n" +
        "4. [À préciser] Identifier les publics.\n" +
        "5. [À préciser] Lister les contraintes.\n" +
        "(Les besoins n'ont pas été précisés — relancez /req pour affiner.)";
    }
    await pi.fs?.writeFile?.(CONTRACT_PATH, content);
    pi.sendUserMessage(
      `[req] Fin de session en pleine collecte (${st.reqTurns} tour(s)). Les besoins ne sont pas ` +
        `encore figés : relancez /req pour continuer, ou dites « fin » pour que je les écrive dans ${CONTRACT_PATH}.`,
    );
  });
}
