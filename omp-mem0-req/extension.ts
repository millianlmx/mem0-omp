// omp-mem0-req — Collecte rigoureuse de besoins.
//
// Ce que ça fait, et rien de plus :
//   1. Commande /req : bascule en mode collecte de besoins.
//   2. Hook before_agent_start : injecte une directive système quand le mode
//      est actif, forçant l'agent à utiliser `ask` pour chaque besoin vague.
//      Détecte aussi "fin" dans event.prompt et gère la collecte continue.
//   3. Hook session_stop : envoie un résumé partiel si la session s'arrête
//      en plein mode collecte, en rappelant de persister les besoins clarifiés.
//   4. buildSummary() / buildReqHandoff() : fonctions pures. buildSummary forme
//      le récapitulatif ; buildReqHandoff est le message de clôture qui DÉLÈGUE
//      la persistance des besoins au plugin mémoire (mem0_add), sans en dépendre.
//
// Cette extension est indépendante du plugin omp-mem0-memory. Elle ne dépend
// que de l'API de base d'OMP (pi.registerCommand, pi.on).

import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// State — session-keyed, like the reference extension
// ---------------------------------------------------------------------------

type ReqEntry = { from: "user" | "system"; text: string };
type ReqConfirmation = { question: string; answer: string; index?: number };

type ReqState = {
  reqMode: boolean;
  reqTurns: number;
  reqMessages: ReqEntry[];
  reqConfirmed: ReqConfirmation[];
  reqSummary: string | null;
};

// Session identification adapted from the reference extension (omp-mem0-memory).
// ctx shapes vary across OMP versions; we try multiple accessors for a stable
// key.
function sessionId(ctx: ExtensionContext): string {
  const sm = ctx.sessionManager;
  return (
    String(
      sm?.getSessionId?.() ??
        (ctx as { sessionId?: string }).sessionId ??
        (ctx as { session?: { id?: string } }).session?.id ??
        ctx.cwd ??
        "session"
    ) ?? "session"
  );
}

const states = new Map<string, ReqState>();

function stateOf(ctx: ExtensionContext): ReqState {
  const key = sessionId(ctx);
  let st = states.get(key);
  if (!st) {
    st = {
      reqMode: false,
      reqTurns: 0,
      reqMessages: [],
      reqConfirmed: [],
      reqSummary: null,
    };
    states.set(key, st);
  }
  return st;
}

// ---------------------------------------------------------------------------
// Directive injectée en mode collecte
// ---------------------------------------------------------------------------

const SYSTEM_DIRECTIVE_REQ = `Mode collecte de besoins ACTIF.
Tu es un collecteur de besoins. Ton rôle : comprendre EXACTEMENT ce que l'utilisateur veut, sans rien accepter à la volée.

Règles absolues :

1. EXIGE TOUJOURS des précisions. Aucun mot vague n'est accepté sans clarification. Si l'utilisateur dit "refactorer l'auth", tu ne sais pas quelle auth (JWT, session, OAuth, API key ?), pas pour quoi (migration, sécurisation, cleanup ?), pas avec quelles contraintes (délai, compatibilité, tests ?). TU DOIS utiliser \`ask\` pour chaque flou.

2. ABUSE du \`ask\`. Pas juste quand c'est ambigu — quand c'est MOINS qu'explicite. Pour chaque besoin, tu dois questionner au minimum :
   - L'objet précis (qu'est-ce qu'on modifie/crée ?)
   - Le périmètre (qu'est-ce qui RESTE hors scope ?)
   - Les contraintes (temps, compatibilité, sécurité, perf)
   - Les cas limites (qu'est-ce qui peut échouer ?)
   - La priorité (est-ce bloquant ou Nice-to-have ?)
   - Les dépendances (qu'est-ce que ça impacte d'autre ?)
   Chaque question → un \`ask\` avec 2-4 options. Un \`ask\` par aspect non-explicite.

3. NE propose JAMAIS de solution ni d'action tant que tous les aspects d'un besoin n'ont pas été questionnés. Si l'utilisateur dit "Je veux X", tu poses TOUTES tes questions sur X. Tu ne passes au besoin suivant que quand celui-ci est entièrement clarifié.

4. Avant de \`mem0_add\` un besoin : tu dois t'être assuré qu'aucun aspect important n'a été ignoré. Le besoin mémorisé doit être autoportant et non-ambigu.

5. Quand tu penses avoir posé toutes les questions possibles sur TOUS les besoins : TU DOIS envoyer un \`ask\` à l'utilisateur avec les options :
   - "Tout est bon, c'est complet." → passe au résumé.
   - "Il y a encore des trucs à ajouter." → continue la collecte.
   - "Un des besoins a changé." → reclarque ce besoin.

6. Tu NE PASSES PAS au résumé tant que l'utilisateur n'a pas explicitement dit "tout est bon".

7. Sur le résumé final : chaque besoin est une phrase d'action claire et non-ambiguë :
   \`ACTION : [verbe précis] [objet précis] avec [contraintes].\`
   Les détails validés via \`ask\` sont intégrés directement dans la phrase, pas en notes séparées.

8. Si un besoin a été confirmé par \`mem0_add\` : c'est une décision. Ne le remets pas en question sauf si l'utilisateur le demande explicitement.`;

// ---------------------------------------------------------------------------
// buildSummary — fonction pure, testable sans runtime OMP
// ---------------------------------------------------------------------------

/**
 * Construit le résumé final à partir de l'état de session.
 * Format : phrases d'action claires pour chaque besoin confirmé.
 */
export function buildSummary(st: ReqState): string {
  const confirmed = st.reqConfirmed;

  if (!confirmed || confirmed.length === 0) {
    return "Aucun besoin n'a été confirmé cette session. Redémarrez /req pour commencer une nouvelle collecte.";
  }

  const lines: string[] = [];
  for (let i = 0; i < confirmed.length; i++) {
    const c = confirmed[i];
    if (c.question) {
      const detail = c.answer.trim() ? ` (${c.answer.trim()})` : "";
      lines.push(`${i + 1}. ACTION : ${c.question}${detail}`);
    }
  }

  return lines.length
    ? lines.join("\n")
    : "Aucun besoin n'a été confirmé cette session. Redémarrez /req pour commencer une nouvelle collecte.";
}

/**
 * Message de clôture, envoyé quand l'utilisateur dit "fin". On ne se contente
 * plus d'afficher le récapitulatif : on demande à l'agent de PERSISTER chaque
 * besoin en mémoire projet (mem0_add) pour qu'il soit rappelé pendant les specs
 * et l'implémentation — c'est le pont besoins → mémoire.
 *
 * L'extension reste indépendante du plugin omp-mem0-memory : la persistance est
 * conditionnée à la présence de l'outil mem0_add. Si le plugin mémoire n'est pas
 * installé, l'agent garde les besoins dans sa réponse et rien n'est perdu.
 */
export function buildReqHandoff(st: ReqState): string {
  const specsLine =
    "\n\nQuand les besoins sont figés, lance /specs : cela ouvre une session de spécification " +
    "dédiée, amorcée avec ces besoins, pour produire des specs non ambiguës prêtes à implémenter d'un trait.";
  if (st.reqConfirmed.length > 0) {
    return (
      "[req] Collecte terminée. Besoins confirmés et déjà enregistrés en mémoire projet " +
      "pendant la collecte :\n" +
      buildSummary(st) +
      "\n\nPrésente-moi ce récapitulatif numéroté pour validation. Si un besoin manque, est en " +
      "trop ou doit changer, corrige-le avec mem0_add / mem0_update avant de conclure." +
      specsLine
    );
  }
  return (
    "[req] Collecte terminée. Aucun besoin n'a encore été enregistré en mémoire. " +
    "Pour chaque besoin recueilli dans cette collecte :\n" +
    "1. reformule-le en une phrase d'action claire et autoportante " +
    "(ACTION : verbe précis + objet précis + contraintes) ;\n" +
    "2. si l'outil mem0_add est disponible (plugin mémoire installé), enregistre chaque besoin " +
    "finalisé en mémoire projet — un appel par besoin, infer:false — pour qu'il nourrisse les " +
    "specs et l'implémentation ; sinon, garde-les dans ta réponse ;\n" +
    "3. présente-moi le récapitulatif numéroté final pour validation." +
    specsLine
  );
}

/**
 * Capture opportuniste d'un besoin confirmé. Un besoin est "confirmé" quand
 * l'agent le PERSISTE via mem0_add pendant la collecte (directive rôle §4, §8) —
 * pas quand il pose un `ask`, qui ne sert qu'à clarifier (capturer les `ask`
 * donnerait un récap de questions, pas de besoins). Robuste et sans dépendance
 * dure : si le plugin mémoire est absent, aucun mem0_add ne survient et
 * reqConfirmed reste vide. Mute st.reqConfirmed ; retourne true si un besoin
 * a été ajouté.
 */
export function recordConfirmedNeed(
  st: ReqState,
  toolName: string,
  input: unknown,
  isError?: boolean,
): boolean {
  if (!st.reqMode || isError) return false;
  if (toolName !== "mem0_add") return false;
  const raw = (input as { text?: unknown } | null | undefined)?.text;
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return false;
  if (st.reqConfirmed.some((c) => c.question === text)) return false;
  st.reqConfirmed.push({ question: text, answer: "", index: st.reqConfirmed.length });
  return true;
}

// ---------------------------------------------------------------------------
// Spécifications — /specs fige les besoins et ouvre une session dédiée dont le
// seul but est de transformer les besoins en specs SANS AMBIGUÏTÉ, exécutables
// d'un seul trait à l'implémentation. Le rubric ci-dessous définit ce qu'est une
// bonne spec pour ce contrat one-shot : c'est lui qui guide l'agent.
// ---------------------------------------------------------------------------

const SPECS_DIRECTIVE = `Tu es un rédacteur de spécifications. Ton livrable : des specs qu'un agent d'implémentation exécute d'un seul passage, sans avoir à te reposer une question. L'ambiguïté est l'ennemi : une spec qui laisse un choix ouvert n'est pas finie.

Procédure OBLIGATOIRE, dans l'ordre :
1. Ancre-toi dans le réel AVANT d'écrire. Lis les besoins ci-dessus, puis le dépôt et la mémoire projet (mem0_search) : conventions existantes, patterns à réutiliser, chemins et symboles réels. On ne spécifie pas une nouvelle convention à côté d'une convention existante.
2. Lève CHAQUE ambiguïté restante par un \`ask\` (2-4 options tranchées) avant de figer la spec concernée. Zéro « à décider », zéro TODO, zéro « devrait raisonnablement ».
3. Rédige les specs selon le rubric ci-dessous.
4. Une fois validées, si l'outil mem0_add est disponible, enregistre chaque spec en mémoire projet (une spec par appel, infer:false) pour que la session d'implémentation la retrouve. Puis présente l'ensemble numéroté pour validation et indique à l'utilisateur qu'il peut lancer /impl pour l'implémentation one-shot.

Ce qu'est une BONNE spec (rubric — chaque spec les respecte toutes) :
- TRAÇABLE : elle référence le(s) besoin(s) qu'elle réalise. Aucun besoin non couvert, aucune spec orpheline.
- COMPORTEMENT OBSERVABLE, pas implémentation : décrit ce que le système fait (entrées → sorties, effets de bord), pas comment le coder. L'agent d'implémentation choisit le comment.
- CRITÈRES D'ACCEPTATION VÉRIFIABLES : conditions binaires pass/fail, au format Given/When/Then. C'est ce sur quoi l'implémentation sera jugée.
- CONTRATS EXPLICITES : signatures/schemas d'API, formes de données, types nommés, codes d'erreur, invariants.
- CAS LIMITES ET ERREURS : entrée invalide, vide, concurrence, dépassement de borne, échec de dépendance — chacun avec le comportement attendu.
- PÉRIMÈTRE BORNÉ : liste explicitement les NON-objectifs, ce qui reste hors scope.
- POINTS D'INTÉGRATION : fichiers/modules/symboles touchés, dépendances, migrations, config/env, compatibilité ascendante.
- NON-FONCTIONNEL SI PERTINENT SEULEMENT : perf, sécurité, budgets — ne sur-spécifie pas.
- PLAN D'IMPLÉMENTATION ORDONNÉ : découpe en étapes implémentables et vérifiables, sans dépendance arrière, de sorte que l'implémentation se fasse d'un trait.

Une spec qui ne permet pas d'écrire le test d'acceptation avant le code n'est pas assez précise : reprends-la.`;

/**
 * Amorce de la session de spécification. Fonction pure : injecte les besoins
 * confirmés (récap de /req) puis le rubric. Sans besoins transmis, demande à
 * l'agent de les récupérer d'abord (mémoire projet).
 */
export function buildSpecsSeed(needs: string): string {
  const hasNeeds = needs.trim().length > 0 && !/Aucun besoin/.test(needs);
  return (
    "[specs] Session de spécification. Objectif : transformer les besoins en spécifications " +
    "SANS AMBIGUÏTÉ, exécutables en un seul passage d'implémentation.\n\n" +
    (hasNeeds
      ? `Besoins à spécifier :\n${needs}\n\n`
      : "Aucun besoin n'a été transmis à cette session. Récupère-les d'abord en mémoire projet " +
        "(mem0_search) ou demande-les à l'utilisateur, avant de spécifier.\n\n") +
    SPECS_DIRECTIVE
  );
}

// ---------------------------------------------------------------------------
// Implémentation — /impl ouvre une session dédiée qui récupère les specs figées
// en mémoire projet et les implémente d'un seul trait. Elle ne redéfinit rien :
// pas de spec en mémoire → elle s'arrête et renvoie vers /specs.
// ---------------------------------------------------------------------------

const IMPL_DIRECTIVE = `Tu es un agent d'implémentation. Ton contrat : implémenter d'un seul passage les spécifications déjà figées en mémoire projet, sans les redéfinir ni improviser.

Procédure OBLIGATOIRE, dans l'ordre :
1. Récupère les specs en mémoire projet (mem0_search sur le périmètre / la feature). Si AUCUNE spec n'est trouvée, ARRÊTE-toi et dis-le : l'implémentation one-shot repose sur des specs figées — lance /specs d'abord. N'invente pas de spec.
2. Lis le dépôt aux points d'intégration nommés par les specs. Réutilise les conventions et patterns existants ; ne crée pas une convention à côté d'une existante.
3. Implémente CHAQUE spec en suivant son plan d'implémentation ordonné, en une passe complète : aucun stub, aucun TODO, aucun placeholder, pas de « v1/foundation ».
4. Prouve chaque critère d'acceptation (Given/When/Then) de la spec : écris ou lance le test / smoke test correspondant. Une spec n'est « faite » que quand son critère passe.
5. Respecte le périmètre borné : n'implémente pas les non-objectifs listés par les specs.
6. Si une spec est ambiguë ou contredite par l'état réel du dépôt, NE devine pas : signale-le et propose la correction (mem0_update de la spec) plutôt que d'implémenter à côté.
7. À la fin : récapitule ce qui est fait spec par spec (critère prouvé ou non), et enregistre en mémoire (mem0_add) les décisions et pièges durables rencontrés pendant l'implémentation.

Le livrable n'est pas « du code qui compile » mais « chaque critère d'acceptation des specs vérifié ».`;

/**
 * Amorce de la session d'implémentation. Fonction pure. Les specs ne sont PAS
 * portées ici (elles vivent en mémoire projet, écrites par la session /specs) :
 * la directive dit à l'agent de les récupérer. `focus` restreint la recherche.
 */
export function buildImplSeed(focus: string): string {
  const hasFocus = focus.trim().length > 0;
  return (
    "[impl] Session d'implémentation. Objectif : implémenter d'un seul trait les spécifications " +
    "déjà figées en mémoire projet, sans les redéfinir.\n\n" +
    (hasFocus ? `Périmètre : ${focus}\n\n` : "") +
    IMPL_DIRECTIVE
  );
}
// ---------------------------------------------------------------------------
// Revue — /review ouvre une session de revue one-shot. Il ne redéfinit rien :
// pas de spec en mémoire → il signale qu'il faut passer par /specs ou /req
// d'abord. /review cherche les besoins et specs en mémoire projet.
// ---------------------------------------------------------------------------

const REVIEW_DIRECTIVE = `Tu es un agent de revue. Ton contrat : vérifier qu'une implémentation correspond aux spécifications figées, et qu'elles couvrent les besoins originaux.

Procédure OBLIGATOIRE, dans l'ordre :
1. Récupère les specs en mémoire projet (mem0_search sur le périmètre / la feature). Si AUCUNE spec n'est trouvée, indique-le clairement — la revue ne peut pas se faire sans specs.
2. Récupère aussi les besoins originaux (mem0_search sur le périmètre) si des specs existent mais que les besoins ne sont pas traçables.
3. LIS les fichiers du dépôt qui ont changé depuis les specs : ouvre les fichiers modifiés (read), vérifie les symboles réels (lsp), confirme l'état actuel (grep). Ne révise pas sur un résumé.
4. POUR CHAQUE spec : vérifie que l'implémentation respecte son critère d'acceptation Given/When/Then (lance ou écrit le test correspondant). Une spec n'est revue que quand son critère est prouvé.
5. Vérifie la traçabilité : chaque spec doit pointer vers un besoin original. Spéc sans besoin = spec orpheline à signaler.
6. Évalue les implications sécurité : nouvelles dépendances, exposition d'API, gestion des erreurs critiques.
7. Vérifie les exigences non-fonctionnelles si listées dans les specs (performance, compatibilité).

Sortie attendue (format structuré) :
- STATUT : APPROUVÉ / BLOQUANT / MINEUR
- SPEC PAR SPEC : pass ou fail, avec preuve
- BLOQUANTS : détails des échecs bloquants
- RECOMMANDATIONS : améliorations non-bloquantes
- DÉCISION FINALE : approuvé ou non (avec raison)`;

/**
 * Amorce de la session de revue. Fonction pure. La revue cherche ses propres
 * specs et besoins en mémoire projet : elle ne les porte pas ici.
 * `focus` restreint la recherche mémoire.
 */
export function buildReviewSeed(focus: string): string {
  const hasFocus = focus.trim().length > 0;
  return (
    "[review] Session de revue. Objectif : vérifier que l'implémentation correspond aux spécifications figées en mémoire projet et que celles-ci couvrent les besoins originaux.\n\n" +
    (hasFocus ? `Périmètre : ${focus}\n\n` : "") +
    REVIEW_DIRECTIVE
  );
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function reqExtension(pi: ExtensionAPI) {
  // --- Commande /req -----------------------------------------------------
  //
  // Le handler de commande ne reçoit PAS le prompt utilisateur — OMP ne le
  // transmet pas aux handlers de commande. Il se contente d'activer le mode
  // et d'envoyer un message d'accueil. Le reste est géré dans before_agent_start.

  pi.registerCommand("req", {
    description: "Active le mode collecte de besoins",
    handler: async (_params, ctx) => {
      const st = stateOf(ctx);

      if (!st.reqMode) {
        st.reqMode = true;
        st.reqTurns = 0;
        st.reqMessages = [];
        st.reqConfirmed = [];
        st.reqSummary = null;

        pi.sendUserMessage(
          "[req] Mode collecte activé. Décrivez-moi ce que vous voulez faire.\n" +
            "Je vais vous poser des questions pour clarifier chaque point.\n" +
          "Dites \"fin\" quand vous avez tout dit — je reformulerai alors\n" +
            "l'ensemble de vos besoins pour vérification, ou lancez /specs pour figer\n" +
            "les besoins et passer directement aux spécifications."
        );
      }
      // Si reqMode est déjà true : noop (le mode est déjà actif).
    },
  });

  // --- Commande /specs ---------------------------------------------------
  //
  // Confirme la fin de /req ET ouvre une session dédiée aux spécifications.
  // C'est ici qu'on peut créer une nouvelle session : newSession n'existe que
  // sur le contexte de commande (ExtensionCommandContext), pas sur celui d'un
  // event — d'où le choix d'en faire une commande plutôt qu'une détection de
  // mot-clé dans before_agent_start. Les besoins confirmés sont lus AVANT le
  // switch (le nouvel état de session est vierge) et injectés dans l'amorce.
  pi.registerCommand("specs", {
    description: "Fige les besoins /req et ouvre une session de spécification (specs one-shot)",
    handler: async (args, ctx) => {
      const st = stateOf(ctx);
      if (st.reqMode) {
        st.reqMode = false;
        st.reqSummary = buildSummary(st);
      }
      const needs = buildSummary(st);
      const extra = String(args ?? "").trim();
      const seed = buildSpecsSeed(extra ? `${needs}\n\nContexte ajouté : ${extra}` : needs);
      await ctx.waitForIdle?.();
      // newSession peut manquer sur d'anciens runtimes : on dégrade en restant
      // dans la session courante plutôt que de casser.
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(`[specs] nouvelle session impossible (${(err as Error).message}) — spécification dans la session courante.`, "warning");
        }
      }
      pi.sendUserMessage(seed);
    },
  });

  // --- Commande /impl ----------------------------------------------------
  //
  // Ouvre une session d'implémentation one-shot. Les specs vivent en mémoire
  // projet (écrites par la session /specs), pas dans l'état local : l'amorce ne
  // les porte pas, elle dit à l'agent de les récupérer. Comme /specs, newSession
  // n'est disponible que sur le contexte de commande.
  pi.registerCommand("impl", {
    description: "Ouvre une session d'implémentation one-shot à partir des specs figées en mémoire",
    handler: async (args, ctx) => {
      const seed = buildImplSeed(String(args ?? "").trim());
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(`[impl] nouvelle session impossible (${(err as Error).message}) — implémentation dans la session courante.`, "warning");
        }
      }
      pi.sendUserMessage(seed);
    },
  });
  // --- Commande /review --------------------------------------------------
  //
  // Ouvre une session de revue one-shot. La revue cherche ses propres specs
  // et besoins en mémoire projet (via son seed) : le handler n'a pas besoin
  // de lire l'état local. Commenon/ /specs, /impl, newSession n'est disponible
  // que sur le contexte de commande.
  pi.registerCommand("review", {
    description: "Ouvre une session de revue one-shot (cherche specs + besoins en mémoire)",
    handler: async (args, ctx) => {
      const seed = buildReviewSeed(String(args ?? "").trim());
      await ctx.waitForIdle?.();
      if (typeof ctx.newSession === "function") {
        try {
          await ctx.newSession();
        } catch (err) {
          ctx.ui?.notify?.(`[review] nouvelle session impossible (${(err as Error).message}) — revue dans la session courante.`, "warning");
        }
      }
      pi.sendUserMessage(seed);
    },
  });

  // --- Hook before_agent_start -------------------------------------------
  //
  // Injecte la directive système uniquement quand reqMode est actif.
  // Gère aussi la collecte continue et la détection de "fin".

  pi.on("before_agent_start", async (event, ctx) => {
    const st = stateOf(ctx);
    const prompt = event.prompt.trim();

    if (!st.reqMode) {
      return { systemPrompt: event.systemPrompt };
    }

    // Collecte continue : enregistrer le message utilisateur.
    const containsFin = prompt.toLowerCase().includes("fin");

    if (containsFin) {
      // Clôture : on délègue la persistance des besoins au plugin mémoire.
      st.reqMode = false;
      st.reqMessages.push({ from: "user", text: prompt });
      st.reqSummary = buildSummary(st);

      pi.sendUserMessage(buildReqHandoff(st));
    } else {
      st.reqTurns += 1;
      st.reqMessages.push({ from: "user", text: prompt });

      pi.sendUserMessage(
        "[req] reçu. Précisez ou ajoutez.\n" + "Dites \"fin\" quand vous avez tout dit."
      );
    }

    // Injecter la directive (même en mode collecte, car l'agent a besoin
    // de la directive pour fonctionner correctement).
    const systemPrompt = [...event.systemPrompt, SYSTEM_DIRECTIVE_REQ];
    return { systemPrompt };
  });

  // --- Hook tool_result : capture des besoins persistés ------------------
  //
  // Observateur best-effort. Ne patche rien (retour undefined). Pendant la
  // collecte, chaque mem0_add réussi de l'agent est un besoin confirmé : on le
  // recense dans reqConfirmed pour que le récapitulatif de clôture soit réel.
  pi.on("tool_result", async (event, ctx) => {
    try {
      recordConfirmedNeed(stateOf(ctx), event.toolName, event.input, event.isError);
    } catch {
      /* jamais bloquant */
    }
  });

  // --- Hook session_stop -------------------------------------------------
  //
  // Si la session s'arrête en plein mode collecte, envoyer un résumé
  // partiel pour que l'utilisateur sache où il en est.

  pi.on("session_stop", async (_event, ctx) => {
    const st = stateOf(ctx);
    if (!st.reqMode || st.reqTurns === 0) return;

    pi.sendUserMessage(
      `[req] Fin de session en mode collecte. ${st.reqTurns} tour(s) passé(s), ${st.reqConfirmed.length} besoin(s) confirmé(s).\n` +
        `${buildSummary(st)}\n` +
        `Les besoins confirmés sont déjà en mémoire projet (mem0_add). Relancez /req pour continuer la collecte.`
    );
  });
}
