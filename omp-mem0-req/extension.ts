// omp-mem0-req — Collecte rigoureuse de besoins.
//
// Ce que ça fait, et rien de plus :
//   1. Commande /req : bascule en mode collecte de besoins.
//   2. Hook before_agent_start : injecte une directive système quand le mode
//      est actif, forçant l'agent à utiliser `ask` pour chaque besoin vague.
//      Détecte aussi "fin" dans event.prompt et gère la collecte continue.
//   3. Hook session_stop : envoie un résumé partiel si la session s'arrête
//      en plein mode collecte.
//   4. buildSummary() : fonction pure qui forme le résumé final à partir de
//      st.reqMessages[] et st.reqConfirmed[].
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
    if (c.answer && c.question) {
      const detail = c.answer.trim() ? ` (${c.answer.trim()})` : "";
      lines.push(`${i + 1}. ACTION : ${c.question}${detail}`);
    }
  }

  return lines.length
    ? lines.join("\n")
    : "Aucun besoin n'a été confirmé cette session. Redémarrez /req pour commencer une nouvelle collecte.";
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

  pi.registerCommand("req", async (_params, ctx) => {
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
          "l'ensemble de vos besoins pour vérification."
      );
    }
    // Si reqMode est déjà true : noop (le mode est déjà actif).
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
      // Clôture du mode collecte
      st.reqMode = false;
      st.reqSummary = buildSummary(st);
      st.reqMessages.push({ from: "user", text: prompt });

      pi.sendUserMessage(st.reqSummary!);
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

  // --- Hook session_stop -------------------------------------------------
  //
  // Si la session s'arrête en plein mode collecte, envoyer un résumé
  // partiel pour que l'utilisateur sache où il en est.

  pi.on("session_stop", async (_event, ctx) => {
    const st = stateOf(ctx);
    if (!st.reqMode || st.reqTurns === 0) return;

    const summary = buildSummary(st);
    pi.sendUserMessage(
      `[req] Fin de session en mode collecte. ${st.reqTurns} tour(s) passé(s), ${st.reqConfirmed.length} besoin(s) confirmé(s).\n${summary}\nRelancez /req pour continuer la collecte.`
    );
  });
}
