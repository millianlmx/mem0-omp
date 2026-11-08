// Les gestes de confiance : `chrome.debugger` (protocole CDP) envoie au navigateur de VRAIS
// événements (`isTrusted`) — clic, survol, touches, saisie —, ceux auxquels réagissent les
// applications qui ignorent les événements DOM synthétiques (React contrôlé, composants web).
//
// Chrome affiche, tant qu'une session est ouverte, la bannière « OMP Poste de travail a
// commencé à déboguer ce navigateur » : elle est ASSUMÉE (c'est l'agent qui agit). La session
// s'ouvre au premier geste dans un onglet et se ferme après `IDLE_DETACH_MS` sans geste, à
// l'arrêt (bouton Stop, pause) ou à la fermeture de l'onglet. « Annuler » sur la bannière
// coupe les gestes de confiance jusqu'au redémarrage de Chrome : l'agent passe au repli DOM.
//
// L'exécuteur décide OÙ s'en servir (jamais dans un onglet de l'utilisateur sans
// l'approbation de l'action) ; ce module ne fait qu'ouvrir, tenir et fermer les sessions.

/** La version du protocole demandée à l'attache. */
const PROTOCOL = "1.3";
/** Une session sans geste depuis ce délai est fermée (la bannière disparaît). */
export const IDLE_DETACH_MS = 20_000;
/** `chrome.storage.session` : l'utilisateur a refusé le débogage (« Annuler » sur la bannière). */
export const CDP_REFUSED = "cdpRefused";
const sessions = new Map<number, number>();

if (typeof chrome.debugger !== "undefined") {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    clearTimeout(sessions.get(source.tabId));
    sessions.delete(source.tabId);
    if (reason === "canceled_by_user") void chrome.storage.session.set({ [CDP_REFUSED]: true });
  });
}

/**
 * Ouvre (ou garde) la session CDP de l'onglet ; `false` si les gestes de confiance sont
 * indisponibles : API absente, refus de l'utilisateur, attache impossible (page interne,
 * autre débogueur) — l'appelant passe alors au repli DOM.
 */
export async function attach(tabId: number): Promise<boolean> {
  if (typeof chrome.debugger === "undefined") return false;
  if ((await chrome.storage.session.get(CDP_REFUSED))[CDP_REFUSED] === true) return false;
  const open = sessions.has(tabId);
  if (!open) {
    try {
      await chrome.debugger.attach({ tabId }, PROTOCOL);
    } catch {
      return false;
    }
  }
  clearTimeout(sessions.get(tabId));
  sessions.set(
    tabId,
    setTimeout(() => void detach(tabId), IDLE_DETACH_MS),
  );
  // La fenêtre de l'agent n'a jamais le focus : la page se croit focalisée (focus, sélection, saisie).
  if (!open) await send(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => undefined);
  return true;
}

/** Une commande CDP dans la session ouverte de l'onglet. */
export function send(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

export async function detach(tabId: number): Promise<void> {
  const timer = sessions.get(tabId);
  if (timer === undefined) return;
  clearTimeout(timer);
  sessions.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

/** Ferme toutes les sessions (arrêt d'urgence, pause) : la bannière disparaît. */
export async function detachAll(): Promise<void> {
  await Promise.all([...sessions.keys()].map(detach));
}
