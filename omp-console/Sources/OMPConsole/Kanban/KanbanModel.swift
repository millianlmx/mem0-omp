// Le modèle du tableau (BR-5) : il s'abonne au flux global du magasin, publie
// l'état de la section et porte le SEUL état de sélection (S-5, S-7).
//
// Deux invariants de forme :
//   - l'abonnement est UNE tâche de longue durée `for await` (patron `StoreHub`),
//     jamais une suite d'appels à échéance sur le même flux — annuler la tâche
//     termine le flux pour de bon, un abonné perdu ne se récupère pas ;
//   - `KanbanModel` ne connaît AUCUN `ConsoleModel` : sélectionner une carte ne
//     touche que le tableau, jamais la section courante de la fenêtre (S-6).
//
// La durée affichée ne vient PAS du flux : elle est recalculée au rendu depuis
// `TimelineView` (Doc-1), donc une carte ouverte avance sans que le magasin change.

import Combine
import Foundation

@MainActor
final class KanbanModel: ObservableObject {
    /// L'état publié de la section : `loading` jusqu'au premier instantané.
    @Published private(set) var state: KanbanBoardState = .loading

    /// L'identifiant de la carte sélectionnée — jamais un ensemble (S-5).
    @Published var selectedCardID: String?

    /// Comment ouvrir un abonnement NEUF : un `StoreHub` arrêté ne se rouvre pas
    /// (`stopped` est définitif), donc `start()` après `stop()` construit un hub
    /// neuf sur le MÊME magasin.
    private let makeHub: () -> StoreHub
    private var hub: StoreHub
    private var task: Task<Void, Never>?
    private var hubStopped = false

    init(hub: StoreHub = StoreHub()) {
        self.hub = hub
        self.makeHub = { StoreHub(stateDir: hub.stateDir, nowMs: hub.nowMs) }
    }

    /// S'abonne au flux global en UNE tâche de longue durée. Idempotent.
    func start() {
        guard task == nil else { return }
        if hubStopped {
            hub = makeHub()
            hubStopped = false
        }
        let hub = self.hub
        let stateDir = hub.stateDir
        task = Task { [weak self] in
            for await snapshot in hub.snapshots() {
                guard let self else { return }
                self.apply(snapshot, stateDir: stateDir)
            }
        }
    }

    /// Annule l'abonnement et arrête le hub : aucune scrutation ne prend le relais.
    func stop() {
        task?.cancel()
        task = nil
        hub.stop()
        hubStopped = true
    }

    /// Sélectionne une carte : SEUL point de mutation de la sélection (idempotent).
    func select(_ id: String) {
        selectedCardID = id
    }

    /// La carte sélectionnée, quand elle existe encore.
    var selectedCard: KanbanCard? {
        guard let id = selectedCardID else { return nil }
        return state.card(id)
    }

    /// Les lignes du panneau de détail (S-5) : vides quand rien n'est sélectionné.
    func detailLines(nowMs: Double) -> [String] {
        guard let card = selectedCard else { return [] }
        return KanbanDetail.lines(for: card, nowMs: nowMs)
    }

    /// Un pas de clavier, dans l'ordre TOTAL des cartes (S-5) : les colonnes dans
    /// l'ordre de S-1 pour `nextColumn`/`previousColumn`, les cartes dans l'ordre
    /// de leur source pour `next`/`previous`. Sans sélection, `next`/`nextColumn`
    /// prennent la première carte et `previous`/`previousColumn` la dernière. Un
    /// déplacement qui sort de l'ardoise ne change rien.
    func move(by step: KanbanStep) {
        guard let board = state.kanbanBoard, !board.cards.isEmpty else { return }
        let cards = board.cards
        guard let current = selectedCardID, let index = cards.firstIndex(where: { $0.id == current }) else {
            selectedCardID = (step == .next || step == .nextColumn) ? cards.first?.id : cards.last?.id
            return
        }
        switch step {
        case .next:
            selectedCardID = cards[min(index + 1, cards.count - 1)].id
        case .previous:
            selectedCardID = cards[max(index - 1, 0)].id
        case .nextColumn:
            if let card = neighbouringColumn(of: cards[index], in: cards, forward: true) {
                selectedCardID = card.id
            }
        case .previousColumn:
            if let card = neighbouringColumn(of: cards[index], in: cards, forward: false) {
                selectedCardID = card.id
            }
        }
    }

    /// La première carte de la colonne suivante (ou précédente) NON VIDE, dans
    /// l'ordre des colonnes de S-1 — `nil` s'il n'y en a aucune.
    private func neighbouringColumn(of card: KanbanCard, in cards: [KanbanCard], forward: Bool) -> KanbanCard? {
        let columns = KanbanColumn.allCases
        guard let start = columns.firstIndex(of: card.column) else { return nil }
        let candidates = forward ? Array(columns[(start + 1)...]) : Array(columns[..<start].reversed())
        for column in candidates {
            if let first = cards.first(where: { $0.column == column }) { return first }
        }
        return nil
    }

    /// Reconstruit l'ardoise pour un instantané neuf, et purge une sélection dont
    /// la carte a disparu du magasin (pas de détail fantôme).
    private func apply(_ snapshot: StoreSnapshot, stateDir: String) {
        let next = KanbanBoardState.derive(
            snapshot: snapshot,
            nowMs: StoreClock.live.nowMs(),
            stateDir: stateDir
        )
        state = next
        if let selected = selectedCardID, next.card(selected) == nil {
            selectedCardID = nil
        }
    }
}
