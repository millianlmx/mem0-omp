// L'état d'un process ARMÉ : la boîte de réception qu'il consomme, et la
// question `ask` qu'il a en vol.
//
// Il vit dans un objet MUTABLE et non dans deux liaisons `let` : l'armement
// (`inbox.ts`) et la publication de l'entrée du magasin (`publish.ts`) écrivent
// tous les deux, et une liaison `let` exportée n'est pas réassignable par son
// importateur.
//
// L'objet est posé sur `globalThis` sous un `Symbol.for` : un process qui charge
// l'extension DEUX fois — ce qui arrive à un run de lot, dont le plugin installé
// et le `-e <chemin du cache>` sont deux modules distincts pour le runtime — n'a
// qu'UNE pompe, UNE question en vol, et donc une seule consommation des
// livraisons. Sans cela, la pompe de la première instance tire la livraison
// `ask` de la seconde et la jette (S-6, S-7).
import type { AskAnswer } from "./inbox.ts";
import type { PanelPendingAsk } from "./store.ts";

export type ArmedRunState = {
  /** La boîte de ce process (`--panel-inbox`) — `null` s'il n'est pas armé. */
  inbox: string | null;
  /** La question `ask` en vol, publiée dans l'entrée du run. */
  pendingAsk: PanelPendingAsk | null;
  /** Les questions en vol, par identifiant d'appel : la pompe y résout la réponse. */
  askWaiters: Map<string, (answer: AskAnswer) => void>;
  /** La minuterie de la pompe : une seule par process. */
  pumpStop: (() => void) | null;
  /** L'outil `ask` du run : enregistré une seule fois par process. */
  askTool: boolean;
  /** L'armement a-t-il eu lieu ? (l'état `states` ci-dessus n'est pas partagé) */
  armed: boolean;
  /**
   * La session du PREMIER contexte armé — celle que l'entrée du run publie.
   * Retenue ici et non dans `publish.ts` : un sous-agent (`task`) rebinde la
   * fabrique dans le MÊME process, et publierait sa propre session dans l'entrée
   * du worktree si la publication ne s'appuyait que sur le contexte courant.
   */
  sessionFile: string | null;
  /**
   * Le battement de ce process : un seul, remplacé au réarmement et jamais
   * cloné — deux instances de l'extension (plugin installé + `-e`) partageraient
   * sinon deux minuteries, dont l'une battrait avec un contexte périmé.
   */
  heartbeatStop: (() => void) | null;
};

const STATE_KEY = Symbol.for("omp-mem0-req.runState");

export const runState: ArmedRunState = (() => {
  const host = globalThis as unknown as Record<symbol, ArmedRunState | undefined>;
  const existing = host[STATE_KEY];
  if (existing) return existing;
  const created: ArmedRunState = {
    inbox: null,
    pendingAsk: null,
    askWaiters: new Map(),
    pumpStop: null,
    askTool: false,
    armed: false,
    sessionFile: null,
    heartbeatStop: null,
  };
  host[STATE_KEY] = created;
  return created;
})();
