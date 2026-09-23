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
  };
  host[STATE_KEY] = created;
  return created;
})();
