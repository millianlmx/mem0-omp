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
//
// L'état est désormais indexé par SESSION (S-3) : le service héberge plusieurs
// sessions dans un seul process — un maillon par dépôt, plus les sessions de
// l'app — et deux maillons ne doivent partager ni boîte, ni question en vol, ni
// compteur d'approbations. La clé est le fichier de session (à défaut son
// identifiant), donc deux instances de l'extension qui servent la MÊME session
// partagent bien le même état ; `""` est l'état du process, celui d'un contexte
// sans session (un run enfant, un test).
import type { AskAnswer } from "./inbox.ts";
import type { PanelPendingAsk } from "./store.ts";

export type ArmedRunState = {
  /** La clé de session de cet état : `""` pour l'état du process. */
  key: string;
  /** La boîte de cette session (`--panel-inbox`) — `null` si elle n'est pas armée. */
  inbox: string | null;
  /** La question `ask` en vol, publiée dans l'entrée du run. */
  pendingAsk: PanelPendingAsk | null;
  /** Les questions en vol, par identifiant d'appel : la pompe y résout la réponse. */
  askWaiters: Map<string, (answer: AskAnswer) => void>;
  /** La minuterie de la pompe : une seule par session. */
  pumpStop: (() => void) | null;
  /** L'outil `ask` de la session : enregistré une seule fois par session. */
  askTool: boolean;
  /** L'armement a-t-il eu lieu ? (l'état `states` ci-dessus n'est pas partagé) */
  armed: boolean;
  /**
   * La session publiée par cette entrée — celle du maillon, ou la session
   * TERMINALE dont le process publie l'entrée. Retenue ici et non dans
   * `publish.ts` : un sous-agent (`task`) rebinde la fabrique dans le MÊME process,
   * et publierait sa propre session dans l'entrée du worktree si la publication ne
   * s'appuyait que sur le contexte courant.
   */
  sessionFile: string | null;
  /**
   * Le battement de cette session : un seul, remplacé au réarmement et jamais
   * cloné — deux instances de l'extension (plugin installé + `-e`) partageraient
   * sinon deux minuteries, dont l'une battrait avec un contexte périmé.
   */
  heartbeatStop: (() => void) | null;
  /**
   * Les appels d'outil en vol de CETTE session : un `ask` ou une approbation en
   * attente ailleurs ne doit pas faire dire « attend » à une autre session.
   * Incrémentés et décrémentés, jamais posés à zéro sur un événement — un
   * `tool_execution_end` manquant (processus tué, tour interrompu) ne doit pas
   * figer l'état.
   */
  pendingAsks: Set<string>;
  pendingApprovals: Set<string>;
  /**
   * Surveiller `process.ppid` : vrai pour un run lancé en PROCESS ENFANT par un
   * pilote, faux pour un maillon exécuté en process par le service (S-3). Posé à
   * l'armement, il décide ce que l'outil `ask` doit vérifier.
   */
  watchParent: boolean;
};


const STATE_KEY = Symbol.for("omp-mem0-req.runStates");

/** Le porte-états du process : une entrée par session, plus celle du process. */
type StateHolder = { states: Map<string, ArmedRunState> };

function holder(): StateHolder {
  const host = globalThis as typeof globalThis & { [STATE_KEY]?: StateHolder };
  let known = host[STATE_KEY];
  if (!known) {
    known = { states: new Map<string, ArmedRunState>() };
    host[STATE_KEY] = known;
  }
  return known;
}


/** L'état d'une session (clé = fichier de session ou identifiant), ou du process. */
export function runStateFor(key: string): ArmedRunState {
  const states = holder().states;
  const known = states.get(key);
  if (known) return known;
  const created: ArmedRunState = {
    key,
    inbox: null,
    pendingAsk: null,
    askWaiters: new Map(),
    pumpStop: null,
    askTool: false,
    armed: false,
    sessionFile: null,
    heartbeatStop: null,
    pendingAsks: new Set(),
    pendingApprovals: new Set(),
    watchParent: false,
  };
  states.set(key, created);
  return created;
}


/**
 * L'état du PROCESS : celui d'un run enfant (une session, un process) et celui de
 * tout contexte sans session identifiable. Les tests et les handlers qui n'ont pas
 * de session à portée écrivent ici.
 */
export const runState: ArmedRunState = runStateFor("");


/**
 * Remet à zéro TOUS les états d'exécution — TEST-ONLY : un test qui simule un
 * process neuf ne doit pas hériter de l'état du test précédent. L'état du process
 * (`runState`) est recréé et réinstallé sous la même clé, donc la constante
 * exportée reste l'objet vivant.
 */
export function resetRunStatesForTests(): void {
  const states = holder().states;
  states.clear();
  states.set("", runState);
}
