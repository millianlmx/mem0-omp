// omp-mem0-req — Pipeline besoins → specs → implémentation → revue, one-shot.
//
// Quatre sessions dédiées (/req, /specs, /impl, /review). L'état traverse les
// sessions par un FICHIER CONTRAT déterministe, .omp/pipeline/contract.md, que
// l'agent écrit et relit avec ses outils standards (write / read).
//
// Pourquoi un fichier et pas la mémoire mem0 : les besoins, les critères
// d'acceptation, les specs et les lots sont des artefacts TRANSITOIRES d'une
// feature. mem0 est un store durable, non déterministe (recall à plancher de
// score) qui déduplique et fusionne à l'écriture — y déposer des specs, c'est en
// perdre au recall, les voir fusionner, et polluer la mémoire durable. Un fichier
// les porte à l'octet près, sans fusion, et laisse le préfixe système stable entre
// sessions (cache local). mem0 ne garde que les décisions DURABLES (choix +
// raison), écrites par /impl.
//
// Le pipeline est piloté par le CRITÈRE D'ACCEPTATION : chaque maillon descend
// d'un id, ce qui rend la chaîne vérifiable au lieu d'être déclarative.
//   B-n (besoin) → AC-n (critère, Given/When/Then) → S-n (spec) → BR-n (lot)
//   → test tagué AC-n → verdict /review
//
//   1. /req    : mode collecte. before_agent_start injecte une directive qui fait
//                clarifier l'INTENTION (ce que seul l'utilisateur sait) — résultat
//                attendu, périmètre, criticité — ET les critères d'acceptation
//                (comportement observable, donc de l'intention) ; pas la technique
//                (ça, c'est /specs, qui lit le dépôt). Clôture refusée tant qu'un
//                besoin n'a pas ≥1 critère falsifiable. « fin » (mot isolé) clôt :
//                l'agent écrit besoins et critères validés dans le contrat.
//   2. /specs  : session qui lit le contrat, lève les ambiguïtés TECHNIQUES contre
//                le dépôt réel, écrit les specs (tracées vers les critères) puis les
//                LOTS — briefs typés (ui / archi / aucun) qui portent le « comment ».
//   3. /impl   : session qui lit le contrat (déterministe) et implémente d'un
//                trait ; s'arrête si le contrat n'a pas de specs ; prouve chaque
//                AC-n par un test qui porte l'id du critère.
//   4. /review : session qui révise le git diff contre le contrat, critère par
//                critère (grep AC-n → test → pass/fail).
//
// Indépendante du plugin omp-mem0-memory : ne dépend que de l'API de base d'OMP
// (pi.registerCommand, pi.on). Sans plugin mémoire, le pipeline fonctionne quand
// même : le contrat est un simple fichier.

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// Contrat unique de la feature active, relatif à la racine du dépôt (même
// convention que .omp/mem0-brief.md). Une seule feature active à la fois : un
// nouveau cycle /req réécrit le contrat.
//
// Sections, dans cet ordre — chaque id référence celui dont il descend :
//   ## Besoins                B-<n>
//   ## Critères d'acceptation AC-<n> (B-<m>) : Given/When/Then (écrits par /req)
//   ## Documentation          doc externe rassemblée par /specs
//   ## Spécifications         S-<n> (AC-<m>) : comportement observable
//   ## Lots                   BR-<n> — type: ui | archi | aucun — sert AC-<m>
//   ## Revue                  verdict de /review ; BLOQUANTS relus par /impl --fix
export const CONTRACT_PATH = ".omp/pipeline/contract.md";

// ---------------------------------------------------------------------------
// State — session-keyed, comme l'extension de référence (omp-mem0-memory)
// ---------------------------------------------------------------------------

type ReqState = {
  reqMode: boolean;
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
    st = { reqMode: false };
    states.set(key, st);
  }
  return st;
}

// ---------------------------------------------------------------------------
// /req — directive injectée en mode collecte. Clarifie l'INTENTION seulement :
// besoins ET critères d'acceptation (un critère est comportemental, donc de
// l'intention — l'utilisateur arbitre les deux). Questionne par enjeu, pas par
// réflexe ; fige le tout dans le contrat à la clôture.
// ---------------------------------------------------------------------------

const SYSTEM_DIRECTIVE_REQ = `Mode collecte de besoins ACTIF.
Tu es un collecteur de besoins. Ton unique rôle : cerner EXACTEMENT ce que l'utilisateur veut obtenir, ET à quoi on reconnaîtra qu'il l'a obtenu. Tu clarifies l'INTENTION, pas la technique.

Frontière stricte :
- CE QUI T'APPARTIENT (seul l'utilisateur peut le trancher) : le résultat attendu, le périmètre (ce qui reste explicitement hors scope), la priorité/criticité, toute contrainte non négociable (délai, compatibilité, sécurité) qui changerait la solution, ET les critères d'acceptation — le comportement OBSERVABLE qui prouvera que le besoin est satisfait. Un critère est comportemental, donc de l'intention : l'utilisateur peut l'arbitrer, et c'est lui qui le valide.
- CE QUI NE T'APPARTIENT PAS : les choix techniques déductibles du dépôt (quelle lib, quel fichier, quel pattern, quelle convention). Tu ne lis pas le code et tu ne le devines pas. Ces ambiguïtés-là seront levées par /specs, qui lit le dépôt. NE les pose PAS ici.

Règles :

1. QUESTIONNE PAR ENJEU, pas par réflexe. Ne pose une question que si une hypothèse fausse changerait l'implémentation OU le test d'acceptation. Un besoin déjà explicite ne se questionne pas. N'inflige pas une check-list mécanique (objet / périmètre / contraintes / cas limites / priorité / dépendances) à un besoin trivial : tu fabriquerais de fausses contraintes.

2. Chaque question = un \`ask\` avec 2 à 4 options TRANCHÉES, PLUS une option d'échappement « peu importe / suis les conventions du dépôt ». L'utilisateur ne doit jamais être forcé d'inventer une réponse sur un point qui lui est égal — une réponse forcée est une fausse décision qui devient une fausse spec.

3. Ne propose ni solution ni action tant qu'un besoin n'est pas clair sur ce qui compte (résultat, périmètre, criticité). Traite un besoin à la fois.

4. FAIS ÉMERGER LES CRITÈRES D'ACCEPTATION. Pour chaque besoin, fais dire ce qui, OBSERVÉ, prouve qu'il est satisfait : une condition binaire pass/fail au format Given/When/Then (contexte → action → résultat observable). Un critère n'existe que si un bug plausible le ferait échouer : pas de cérémonie sur un besoin trivial (« Given un user, When il clique, Then ça clique » n'en est pas un). Ne fabrique pas de critère technique (chiffres de perf, format interne, choix de lib) — sauf si l'utilisateur l'a EXIGÉ comme contrainte, auquel cas c'est une contrainte du besoin.

5. Quand tu penses avoir levé les flous à enjeu de TOUS les besoins, envoie un \`ask\` de contrôle :
   - « Tout est bon, c'est complet. » → clôture.
   - « Il reste des choses à ajouter. » → continue la collecte.
   - « Un besoin a changé. » → reclarifie-le.

6. GARDE-FOU DE CLÔTURE. Ne clôture pas tant que l'utilisateur n'a pas dit explicitement que c'est complet (ou tapé « fin »), ET que chaque besoin n'a pas AU MOINS un critère d'acceptation falsifiable et observable. Un besoin sans critère est un besoin non compris : redemande-le avant de clôturer. C'est là que doit passer l'essentiel de ton temps.

7. CLÔTURE — quand c'est validé : reformule chaque besoin en une phrase d'action autoportante et non ambiguë au format
   \`B-<n> : [verbe précis] [objet précis] [contraintes validées].\`
   puis chaque critère au format
   \`AC-<n> (B-<m>) : Given … When … Then …\`
   et ÉCRIS-les (outil write) dans ${CONTRACT_PATH}, sous DEUX titres à la suite : \`## Besoins\` (un \`B-<n>\` numéroté par ligne) puis \`## Critères d'acceptation\` (un \`AC-<n>\` par ligne, chacun référençant le besoin qu'il prouve). Crée le fichier et son dossier si besoin ; remplace des sections \`## Besoins\` / \`## Critères d'acceptation\` existantes, ne touche pas au reste. Ce fichier est le contrat que /specs puis /impl reliront : il fait foi. Présente ensuite le récap numéroté (besoins ET critères) pour validation. Si l'utilisateur corrige, RÉÉCRIS le fichier pour qu'il reflète toujours l'état validé.

8. N'écris PAS les besoins ni les critères en mémoire mem0 : ce sont des artefacts transitoires de cette feature, ils vivent dans le contrat, pas dans la mémoire durable.`;

// Message d'accueil affiché à l'activation de /req. Il est posté en message
// d'AFFICHAGE (pi.sendMessage, triggerTurn:false), PAS via sendUserMessage : il
// contient « fin » (« Dites « fin » … ») et démarrer un tour l'aurait fait
// détecter comme clôture immédiate par before_agent_start — la collecte se
// terminait avant même que l'utilisateur ait parlé.
export const WELCOME =
  "[req] Mode collecte activé. Décrivez-moi ce que vous voulez obtenir.\n" +
  "Je clarifie l'intention — résultat attendu, périmètre, criticité — et les critères\n" +
  "d'acceptation (Given/When/Then) qui prouveront que c'est fait ; sans toucher aux\n" +
  "choix techniques (ça, c'est /specs, qui lit le dépôt).\n" +
  `Dites « fin » quand tout est dit : je figerai vos besoins validés et leurs critères dans ${CONTRACT_PATH},\n` +
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
 * reformule chaque besoin (B-<n>) et chaque critère d'acceptation (AC-<n>), et
 * les écrit dans le contrat. C'est après validation que le fichier est (ré)écrit,
 * donc les corrections de l'utilisateur y sont capturées — pas de récap
 * pré-validation perdu.
 */
export function buildReqHandoff(): string {
  return (
    "[req] Collecte terminée. Fige maintenant le contrat :\n" +
    "1. reformule chaque besoin clarifié en une phrase d'action autoportante, " +
    "numérotée (B-<n> : verbe précis + objet précis + contraintes validées) ;\n" +
    "2. reformule chaque critère d'acceptation validé au format " +
    "AC-<n> (B-<m>) : Given … When … Then … — une condition binaire pass/fail, chaque " +
    "besoin devant en avoir AU MOINS un ;\n" +
    `3. écris-les (write) dans ${CONTRACT_PATH}, sous deux titres à la suite : \`## Besoins\` ` +
    "(B-<n> numérotés) puis `## Critères d'acceptation` (AC-<n> numérotés, chacun référençant " +
    "le besoin qu'il prouve) — crée le fichier et son dossier si besoin, remplace des sections " +
    "existantes sans toucher au reste ;\n" +
    "4. présente-moi le récap numéroté (besoins ET critères) pour validation. Si je corrige, " +
    "réécris le fichier pour qu'il reflète l'état validé.\n\n" +
    `Ne mets pas les besoins ni les critères en mémoire mem0 : ce contrat (${CONTRACT_PATH}) ` +
    "est leur seul support. Quand besoins et critères sont figés, lance /specs — une session de " +
    "spécification lira ce contrat et produira des specs non ambiguës, tracées vers les " +
    "critères, prêtes à implémenter d'un trait."
  );
}

// ---------------------------------------------------------------------------
// /specs — fige les ambiguïtés techniques contre le dépôt réel, écrit les specs
// (tracées vers les critères d'acceptation) puis les LOTS : les briefs typés qui
// portent le « comment » (ui / archi / aucun) que la spec laisse dehors. Besoins
// et critères viennent du contrat (écrit par /req), pas d'un état local ni de mem0.
// ---------------------------------------------------------------------------

// Rubric des lots. Un lot = un brief : ce que la SPEC ne dit pas (elle décrit le
// comportement observable), le brief le dit (conventions de domaine, surfaces,
// états). Le type conditionne ce que le brief doit couvrir — ui et archi sont les
// deux domaines qui portent du savoir-faire non déductible d'une spec ; « aucun »
// quand le lot n'en mobilise aucun (échappatoire : on n'invente pas un brief).
const BRIEF_RUBRICS = `Ce qu'un LOT (BR-<n>) doit porter — il porte le « comment », que la spec laisse dehors :
- IDENTIFIANT ET TYPE : \`BR-<n> — type: ui | archi | aucun\`. Choisis le type d'après ce que le lot construit réellement ; \`aucun\` si aucune convention de domaine n'est en jeu (le brief reste alors court : surfaces + étapes).
- CRITÈRES SERVIS : les AC-<n> que ce lot fait passer. Aucun lot orphelin (sans AC), aucun AC non servi par au moins un lot.
- SURFACES RÉELLES : fichiers, modules et symboles du dépôt touchés, avec leur chemin — rien d'inventé.
- CONVENTIONS DU DÉPÔT À SUIVRE : le pattern existant à réutiliser, nommé avec sa référence de fichier ; on ne crée pas une convention à côté d'une existante.
- DOC EXTERNE UTILE : renvoi aux entrées pertinentes de \`## Documentation\` (pas de re-cherche).
- ÉTAPES ORDONNÉES : découpe implémentable et vérifiable, sans dépendance arrière.

Si type = ui :
- ÉCRANS / COMPOSANTS : chacun nommé, avec son rôle.
- CHAQUE ÉTAT : vide, chargement, erreur, succès (et dégradé si pertinent) — un état non traité est un bug, pas un détail.
- INTERACTIONS souris ET clavier : focus, navigation, retour visuel.
- MESSAGES À L'UTILISATEUR : formulation exacte des erreurs et des confirmations.
- RÉUTILISATION du design system, des tokens et des composants existants (les nommer) ; responsive et accessibilité (contraste, libellés, ordre de tabulation) si le dépôt les traite déjà.

Si type = archi :
- MODÈLE DE DONNÉES : entités, champs, types, contraintes, invariants ; schéma et migration (réversible) si persistance.
- CONTRATS D'API : route/méthode, payload, réponses, codes d'erreur, authentification.
- TRANSACTIONS ET INTÉGRITÉ : ce qui doit être atomique, comportement en échec partiel.
- PERFORMANCE : index, requêtes, bornes — seulement si un AC l'exige ou si le dépôt s'en soucie déjà.
- CONFIG / ENV / SECRETS, et compatibilité ascendante (migration des données existantes).`;

const SPECS_DIRECTIVE = `Tu es un rédacteur de spécifications. Ton livrable : des specs qu'un agent d'implémentation exécute d'un seul passage, sans avoir à te reposer une question, PLUS les lots (briefs) qui disent comment les construire. L'ambiguïté est l'ennemi : une spec qui laisse un choix ouvert n'est pas finie.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read), sections \`## Besoins\` (B-<n>) et \`## Critères d'acceptation\` (AC-<n>). C'est l'intention validée par l'utilisateur : elle fait foi. Si le contrat est absent, sans besoins ou sans critères, ils n'ont pas été figés — renvoie vers /req (dire « fin »). Ne les réinvente pas et ne re-questionne pas l'intention.
2. Ancre-toi dans le RÉEL : lis le dépôt et la mémoire projet (mem0_search) — conventions existantes, patterns à réutiliser, chemins et symboles réels. On ne spécifie pas une convention neuve à côté d'une convention existante.
3. DOCUMENTE-toi pour la future implémentation. C'est À CETTE ÉTAPE, et pas à /impl, qu'on rassemble la documentation externe : APIs, bibliothèques, frameworks, formats, protocoles que les specs vont mobiliser. Cherche les sources qui font autorité (web_search puis read de la doc officielle) et retiens les faits précis dont /impl aura besoin : versions exactes, signatures, options, contraintes, pièges connus. CONSIGNE-les dans le contrat ${CONTRACT_PATH} sous un titre \`## Documentation\` — pour chaque source : le composant concerné, la version, l'URL, et les extraits/faits réutilisables (jamais un lien nu). /impl s'appuiera sur cette section sans re-chercher. Si aucune doc externe n'est nécessaire, écris-le explicitement dans cette section.
4. Lève les ambiguïtés TECHNIQUES restantes contre le dépôt. L'intention métier est déjà figée dans le contrat : NE la re-questionne pas. Ne pose un \`ask\` (2-4 options tranchées) que pour un choix technique que le dépôt ne tranche pas à lui seul. Zéro « à décider », zéro TODO, zéro « devrait raisonnablement ».
5. Rédige les specs selon le rubric ci-dessous : chacune référence le ou les AC-<n> qu'elle fait passer, et par eux les B-<n>.
6. Découpe en LOTS et écris leurs briefs selon le rubric des lots ci-dessous. C'est la couche qui dit COMMENT construire (conventions ui / archi), là où la spec dit seulement ce qui doit être observable.
7. Une fois l'ensemble cohérent, ÉCRIS (write) dans le contrat ${CONTRACT_PATH} les sections \`## Spécifications\` puis \`## Lots\`, à la suite de \`## Documentation\`, sans supprimer les besoins, les critères ni la documentation. Ce contrat est ce que /impl relira. N'écris PAS les specs en mémoire mem0 : ce sont des artefacts transitoires de la feature. Présente ensuite l'ensemble numéroté (specs ET lots) pour validation et indique que /impl peut être lancé.

Ce qu'est une BONNE spec (rubric — chaque spec les respecte toutes) :
- TRAÇABLE : référence le(s) AC-<n> du contrat qu'elle fait passer (et par eux les besoins). Aucun AC non couvert, aucune spec orpheline.
- COMPORTEMENT OBSERVABLE, pas implémentation : entrées → sorties, effets de bord. Le comment est laissé à l'implémentation — et au lot.
- CRITÈRES D'ACCEPTATION VÉRIFIABLES : conditions binaires pass/fail, Given/When/Then — repris des AC-<n> du contrat, jamais réinventés ici.
- CONTRATS EXPLICITES : signatures/schemas d'API, formes de données, types nommés, codes d'erreur, invariants.
- CAS LIMITES ET ERREURS : entrée invalide, vide, concurrence, dépassement de borne, échec de dépendance — chacun avec le comportement attendu.
- PÉRIMÈTRE BORNÉ : liste explicitement les NON-objectifs, ce qui reste hors scope.
- POINTS D'INTÉGRATION : fichiers/modules/symboles touchés, dépendances, migrations, config/env, compatibilité ascendante.
- NON-FONCTIONNEL SI PERTINENT SEULEMENT : perf, sécurité, budgets — ne sur-spécifie pas.
- PLAN D'IMPLÉMENTATION ORDONNÉ : la découpe ordonnée vit dans le lot (\`## Lots\`) qui implémente la spec, pas dans la spec elle-même.

Une spec qui ne permet pas d'écrire le test d'acceptation avant le code n'est pas assez précise : reprends-la.`;

/**
 * Amorce de la session de spécification. Fonction pure. Besoins ET critères d'acceptation
 * ne sont PAS portés ici : ils vivent dans le contrat (écrit par /req). `extra` = contexte
 * ajouté sur la ligne de commande.
 */
export function buildSpecsSeed(extra: string): string {
  const added = extra.trim();
  return (
    "[specs] Session de spécification. Objectif : transformer l'intention figée dans le contrat " +
    `${CONTRACT_PATH} — besoins ET critères d'acceptation — en spécifications SANS AMBIGUÏTÉ et en ` +
    "lots (briefs) exécutables en un seul passage d'implémentation.\n\n" +
    (added ? `Contexte ajouté : ${added}\n\n` : "") +
    SPECS_DIRECTIVE +
    "\n\n" +
    BRIEF_RUBRICS
  );
}

// ---------------------------------------------------------------------------
// /impl — implémente d'un trait les specs ET les lots figés dans le contrat, et
// prouve chaque critère d'acceptation par un test qui porte son id (AC-<n>),
// retrouvable par grep à /review. Ne redéfinit rien : contrat sans specs → arrêt,
// renvoi vers /specs.
// ---------------------------------------------------------------------------

const IMPL_DIRECTIVE = `Tu es un agent d'implémentation. Ton contrat : implémenter d'un seul passage les spécifications figées dans le contrat de feature, sans les redéfinir ni improviser.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read). S'il est absent ou sans section \`## Spécifications\`, ARRÊTE-toi et dis-le : l'implémentation one-shot repose sur des specs figées — lance /specs d'abord. N'invente pas de spec.
2. Lis le dépôt aux points d'intégration nommés par les specs ET par les lots (\`## Lots\`). Réutilise les conventions et patterns existants ; ne crée pas une convention à côté d'une existante. Lis aussi la section \`## Documentation\` du contrat si elle existe : /specs y a rassemblé la doc externe (APIs, bibliothèques, versions, pièges) — appuie-toi dessus, ne re-cherche pas ce qui y est déjà consigné.
3. Implémente CHAQUE spec en suivant le lot qui la porte et son plan d'implémentation ordonné, en une passe complète : aucun stub, aucun TODO, aucun placeholder, pas de « v1/foundation ». Suis le brief de chaque lot pour le « comment » (type ui : chaque état d'écran, interactions, messages ; type archi : modèle, contrats d'API, transactions).
4. Prouve chaque CRITÈRE D'ACCEPTATION (AC-<n>, Given/When/Then) par un test qui PORTE L'ID : écris ou lance le test / smoke test correspondant, et mets \`AC-<n>\` dans son nom ou sa description (\`test("AC-3 : …")\`). C'est ainsi que /review le retrouvera par grep — une preuve qu'on ne peut pas relier à un AC n'est pas une preuve. Un AC n'est « fait » que quand son test passe ; si un besoin n'a aucun critère, signale-le plutôt que de le déclarer couvert.
5. Respecte le périmètre borné : n'implémente pas les non-objectifs listés par les specs.
6. Si une spec est ambiguë ou contredite par l'état réel du dépôt, NE devine pas : signale-le et corrige la spec DANS LE CONTRAT (édite ${CONTRACT_PATH}) plutôt que d'implémenter à côté.
7. À la fin : récapitule AC par AC (id, test, prouvé ou non), et enregistre en mémoire mem0 (mem0_add) UNIQUEMENT les décisions et pièges DURABLES rencontrés — pas les specs elles-mêmes, qui restent dans le contrat.

Le livrable n'est pas « du code qui compile » mais « chaque critère d'acceptation vérifié par un test traçable ».`;

const IMPL_FIX_DIRECTIVE = `Tu es un agent d'implémentation en mode CORRECTION. Une revue a bloqué l'implémentation ; ton contrat : lever les points bloquants qu'elle a consignés, sans élargir le périmètre.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read) : sections \`## Critères d'acceptation\` (les AC-<n> à re-prouver), \`## Spécifications\` (le contrat à respecter) et \`## Revue\` (le verdict de la dernière revue). Si \`## Revue\` est absente ou ne liste aucun BLOQUANT, ARRÊTE-toi et dis-le : il n'y a rien à corriger — lance /review d'abord.
2. Traite CHAQUE point BLOQUANT de la revue, un par un. Ne touche qu'au code nécessaire pour le lever ; n'ajoute aucune fonctionnalité hors specs (pas de scope creep).
3. Pour chaque bloquant levé, re-prouve le(s) CRITÈRE(S) D'ACCEPTATION concerné(s) (AC-<n>, Given/When/Then) : lance ou écris le test / smoke test correspondant, en portant \`AC-<n>\` dans son nom ou sa description — c'est ainsi que /review le retrouve par grep.
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
// /review — révise le git diff contre le contrat, CRITÈRE PAR CRITÈRE : chaque
// AC-<n> est retrouvé par grep dans la suite de tests, lu et lancé. Le diff est la
// source de vérité de CE QUI a changé (/impl ne commit pas) ; le contrat porte
// besoins, critères, specs et lots à confronter.
// ---------------------------------------------------------------------------

const REVIEW_DIRECTIVE = `Tu es un agent de revue. Ton contrat : vérifier qu'une implémentation correspond aux spécifications figées, que CHAQUE critère d'acceptation est prouvé par un test traçable, et que l'ensemble couvre les besoins originaux.

Procédure OBLIGATOIRE, dans l'ordre :
1. Lis le contrat ${CONTRACT_PATH} (read) : sections \`## Besoins\` (B-<n>), \`## Critères d'acceptation\` (AC-<n>), \`## Spécifications\` (S-<n>) et \`## Lots\` (BR-<n>). S'il est absent ou sans specs, indique-le clairement — la revue ne peut pas se faire sans specs.
2. Constitue le PÉRIMÈTRE réel à réviser via git, ne le devine pas : \`git status\` puis \`git diff\` (les modifications non commitées laissées par la session /impl vivent dans l'arbre de travail). Si l'arbre est propre, \`git diff\` contre le dernier commit ou tag de release. La revue porte sur CE diff, pas sur ta mémoire de ce qui aurait dû changer.
3. LIS chaque fichier du diff : ouvre-le (read), vérifie les symboles réels (lsp), confirme l'état actuel (grep). Ne révise pas sur un résumé.
4. POUR CHAQUE CRITÈRE (AC-<n>) : retrouve son test par \`grep AC-<n>\` dans la suite de tests, LIS-le et LANCE-le. Rapporte \`AC-<n> → fichier:ligne → pass/fail\`. Un critère sans test traçable est un BLOQUANT (l'implémentation ne l'a pas prouvé) ; un critère dont le test échoue est un BLOQUANT.
5. POUR CHAQUE spec (S-<n>) : vérifie que l'implémentation respecte son comportement observable et que le(s) AC qu'elle fait passer passent. Une spec n'est revue que quand ses critères sont prouvés.
6. Traçabilité DANS LES DEUX SENS : (a) chaque spec (S-<n>) et chaque lot (BR-<n>) pointe vers un AC — un S ou un BR sans AC est une spec orpheline à signaler ; (b) chaque AC est couvert par au moins une spec — un AC non couvert est à signaler ; (c) chaque fichier du diff est couvert par au moins une spec — fichier modifié sans spec = changement non spécifié à signaler.
7. Évalue les implications sécurité : nouvelles dépendances, exposition d'API, gestion des erreurs critiques.
8. Vérifie les exigences non-fonctionnelles si listées dans les specs (performance, compatibilité).
9. CONSIGNE le verdict dans le contrat : écris-le (write) dans ${CONTRACT_PATH} sous un titre \`## Revue\` (remplace une section \`## Revue\` existante, ne touche pas au reste). C'est ce que /impl --fix relira pour lever les bloquants. Ne le mets PAS en mémoire mem0.

Format du verdict (dans le contrat ET dans ta réponse) :
- STATUT : APPROUVÉ / BLOQUANT / MINEUR
- AC PAR AC : id → test (fichier:ligne) → pass/fail
- SPEC PAR SPEC : pass ou fail, avec preuve
- BLOQUANTS : détails des échecs bloquants, numérotés et actionnables — c'est la liste que /impl --fix traitera
- RECOMMANDATIONS : améliorations non-bloquantes
- DÉCISION FINALE : approuvé ou non (avec raison)`;

/**
 * Amorce de la session de revue. Fonction pure. Besoins, critères, specs et lots
 * viennent du contrat ; le diff git dit ce qui a changé. `focus` restreint le
 * périmètre.
 */
export function buildReviewSeed(focus: string): string {
  const f = focus.trim();
  return (
    "[review] Session de revue. Objectif : vérifier que l'implémentation correspond aux spécifications " +
    `figées dans le contrat ${CONTRACT_PATH}, que chaque critère d'acceptation est prouvé par un test ` +
    "traçable, et que l'ensemble couvre les besoins originaux.\n\n" +
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
      // Le contrat n'est PAS écrit ici : `pi.fs` n'existe pas sur ExtensionAPI
      // (vérifié dans les types OMP : ni fs, ni readFile, ni writeFile), et un
      // dump brut des messages n'est de toute façon pas le contrat attendu —
      // `## Besoins` doit porter des phrases d'action et `## Critères
      // d'acceptation` des Given/When/Then. C'est l'agent, dans ce
      // même tour, qui lit le handoff et écrit le fichier avec son outil write.
      return { systemPrompt: event.systemPrompt };
    }

    // Pas d'accusé de réception par sendUserMessage : il DÉMARRE un tour
    // supplémentaire à chaque message (deux tours par échange, pour rien). La
    // directive suffit à faire répondre l'agent, et la conversation est déjà
    // dans son contexte — inutile de la recopier dans un état local vide.
    return { systemPrompt: [...event.systemPrompt, SYSTEM_DIRECTIVE_REQ] };
  });

  // Pas de handler `session_stop` ici. OMP l'émet à CHAQUE fin de tour, pas à la
  // fermeture de session : un « filet » qui relançait un tour à chaque yield
  // bouclait indéfiniment (chaque `sendUserMessage` démarre un tour, dont la fin
  // redéclenche le hook), et écrire le contrat à cet instant ne pouvait produire
  // qu'un dump brut des messages — pas les besoins rédigés par l'agent. Le
  // contrat est écrit par l'agent, dans le tour de « fin », à partir du handoff.
}
