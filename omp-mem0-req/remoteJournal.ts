// Le JOURNAL DES GESTES de l'API distante : le portage de `ActionsModel.journal`
// (`omp-console/Sources/OMPConsole/Actions/ActionsModel.swift`, `append`, `settle`,
// `journalLimit`) et de `ActionJournalEntry`/`ActionJournalState`
// (`ConsoleCore/Actions/ActionJournal.swift`).
//
// En mémoire (comme sur le Mac : il ne survit pas au redémarrage), 20 entrées, la
// plus récente en tête. Les gestes de carte (`remoteActions.ts`) y inscrivent une
// entrée `awaitingAck`, puis la règlent (`settle`) à la fin du geste ; chaque
// changement réveille les abonnés (trame SSE `journal`, attente d'un `resume`).
import type { WireJournalEntry, WireJournalState } from "./remoteWire.ts";

/** `ActionsModel.journalLimit`. */
export const JOURNAL_LIMIT = 20;

/**
 * L'état d'une entrée : en attente d'accusé, prise en charge, refusée (motif du
 * pilote, ou sans), déposée, en échec d'écriture (motif), ou restée sans accusé.
 */
export type JournalState =
  | { kind: "awaitingAck" | "taken" | "delivered" | "unacknowledged" }
  | { kind: "refused"; reason?: string | null }
  | { kind: "failed"; reason: string };

/** Ce qu'un geste inscrit : `at` vaut l'horloge du journal quand il est absent. */
export type JournalEntryInput = {
  /** L'identifiant de la commande (ou de la livraison) du geste. */
  id: string;
  /** Le libellé du geste : `réponse`, `texte`, `jalon specs`, `jalon revue`, `lancement`, `arrêt`… */
  kindLabel: string;
  /** La cible : label du run, slug, titre, nom du dépôt. */
  targetLabel: string;
  state: JournalState;
  at?: number;
};

/** L'encodage synthétisé de Swift : `{"cas":{}}`, ou `{"cas":{"reason":…}}` pour un cas à valeur. */
function wireState(state: JournalState): WireJournalState {
  switch (state.kind) {
    case "refused":
      return { refused: state.reason === undefined || state.reason === null ? {} : { reason: state.reason } };
    case "failed":
      return { failed: { reason: state.reason } };
    default:
      return { [state.kind]: {} } as WireJournalState;
  }
}

export class GestureJournal {
  private entries: WireJournalEntry[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(options: { now: () => number }) {
    this.now = options.now;
  }

  /** Inscrit une entrée en tête ; au-delà de 20, les plus anciennes tombent. */
  record(entry: JournalEntryInput): void {
    this.entries = [
      {
        id: entry.id,
        kindLabel: entry.kindLabel,
        targetLabel: entry.targetLabel,
        state: wireState(entry.state),
        at: entry.at ?? this.now(),
      },
      ...this.entries,
    ].slice(0, JOURNAL_LIMIT);
    this.emit();
  }

  /** Règle l'état d'une entrée ; sans effet (ni trame) si elle n'est plus dans le journal. */
  settle(id: string, state: JournalState): void {
    const index = this.entries.findIndex(entry => entry.id === id);
    if (index < 0) return;
    this.entries = this.entries.map((entry, i) => (i === index ? { ...entry, state: wireState(state) } : entry));
    this.emit();
  }

  /** L'entrée d'un geste, ou `undefined` si elle est sortie de la fenêtre de 20. */
  find(id: string): WireJournalEntry | undefined {
    return this.entries.find(entry => entry.id === id);
  }

  /** Les entrées, la plus récente en tête (`RemoteJournalPayload.entries`). */
  list(): WireJournalEntry[] {
    return this.entries;
  }

  /** Abonne un auditeur appelé à chaque inscription ou règlement ; rend le désabonnement. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
