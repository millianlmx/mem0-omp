// Checkpoint d'exploration et relance d'écriture de fin de session (politique pure).
import type { ToolResultEvent, ToolResultEventResult } from "@oh-my-pi/pi-coding-agent";
import { EXPLORE_TOOLS, MUTATE_TOOLS } from "./config.ts";
import type { SessionState } from "./state.ts";

// ---------------------------------------------------------------------------
// Checkpoint exploration — déclenche un rappel d'écriture quand l'agent explore
// trop sans écrire. Il est posé au MILIEU du tour, en tête du résultat de
// l'outil qui franchit le seuil : `before_agent_start` ne tire qu'à la demande
// suivante de l'utilisateur, souvent des dizaines de lectures plus tard, et le
// checkpoint y prenait la place du rappel du tour.
// ---------------------------------------------------------------------------

export const CHECKPOINT_THRESHOLD_NORMAL = 15;

// Session de pure discussion (needs, specs, archi) : aucune édition de fichier,
// donc le nudge de fin fondé sur `mutations` ne tire jamais. Au-delà de ce
// nombre de tours substantiels sans écriture mémoire, on relance une fois en
// fin de session pour capturer ce qui a été décidé.
export const DISCUSSION_MIN_TURNS = 4;

export function nudgeText(mutations: number): string {
  return (
    `[mem0] Cette session a modifié ${mutations} fichier(s) et n'a rien écrit en mémoire. ` +
    `Avant de conclure : un fait de cette session sera-t-il encore vrai dans six mois — décision ` +
    `d'architecture et sa raison, bug avec sa cause racine et son correctif, convention du dépôt, ` +
    `exigence non négociable ? Si oui, appelle mem0_add maintenant : un fait par appel, autoportant, ` +
    `en nommant fichiers et symboles. Si non, dis en une phrase qu'il n'y a rien à retenir et termine.`
  );
}

export function discussionNudgeText(turns: number): string {
  return (
    `[mem0] Cette session a échangé ${turns} tour(s) substantiel(s) sans modifier de fichier ` +
    `ni rien écrire en mémoire. Une discussion de besoins, de specs ou d'architecture produit ` +
    `souvent du durable : besoin arrêté, décision et sa raison, contrainte non négociable, ` +
    `convention retenue. Si c'est le cas, appelle mem0_add maintenant — un fait par appel, ` +
    `autoportant, en nommant fichiers et symboles. Si la session n'a rien décidé de permanent, ` +
    `dis-le en une phrase et termine.`
  );
}

/**
 * Politique de relance de fin de session — pure et exportée pour être testée
 * hors runtime. Rend le message à injecter, ou null s'il n'y a rien à capturer.
 * L'idempotence (`nudged`) reste au handler ; cette fonction ne décide que du
 * QUOI, pas du COMBIEN DE FOIS. Priorité : rien si déjà écrit (adds), sinon le
 * travail de code (mutations), sinon la discussion substantielle sans édition.
 */
export function pickSessionStopNudge(input: {
  adds: number;
  mutations: number;
  substantiveTurns: number;
}): string | null {
  if (input.adds > 0) return null;
  if (input.mutations > 0) return nudgeText(input.mutations);
  if (input.substantiveTurns >= DISCUSSION_MIN_TURNS) return discussionNudgeText(input.substantiveTurns);
  return null;
}

/** Message de checkpoint, posé en tête du résultat d'outil qui franchit le seuil. */
export function checkpointMessage(explorations: number): string {
  return (
    `[mem0 checkpoint] ${explorations} exploration(s) faites sans écriture. ` +
    `Tu as lu/grepé/parcouru des fichiers qui contiennent probablement des connaissances ` +
    `permanentes (architecture, conventions, bugs, décisions). ` +
    `Écris maintenant avec mem0_add ce qui sera vrai dans 6 mois. ` +
    `Un fait par appel, autoportant, en nommant fichiers et symboles.`
  );
}

/**
 * Compteurs par outil d'un résultat réussi : une modification, ou une
 * exploration — qui rapproche aussi du checkpoint d'écriture.
 */
export function countToolResult(st: SessionState, toolName: string): void {
  if (MUTATE_TOOLS[toolName]) st.mutations += 1;
  else if (EXPLORE_TOOLS[toolName]) {
    st.explorations += 1;
    st.explorationSinceLastWrite += 1;
  }
}

/**
 * Pose le checkpoint en tête du résultat d'outil quand le compteur d'exploration
 * atteint le seuil, puis remet le compteur à zéro. `base` est le résultat déjà
 * réécrit par l'agrafage, s'il y en a un : rien de ce qu'il porte n'est perdu.
 * Rend `base` tel quel quand le seuil n'est pas atteint.
 */
export function checkpointToolResult(
  st: SessionState,
  event: ToolResultEvent,
  base: ToolResultEventResult | undefined,
): ToolResultEventResult | undefined {
  if (st.explorationSinceLastWrite < CHECKPOINT_THRESHOLD_NORMAL) return base;
  const explorations = st.explorationSinceLastWrite;
  st.explorationSinceLastWrite = 0;
  return {
    content: [{ type: "text" as const, text: checkpointMessage(explorations) }, ...(base?.content ?? event.content)],
  };
}
