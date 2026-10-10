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
import ConsoleCore
import Foundation

@MainActor
final class KanbanModel: ObservableObject {
    /// L'état publié de la section : `loading` jusqu'au premier instantané.
    @Published private(set) var state: KanbanBoardState = .loading

    /// L'identifiant de la carte sélectionnée — jamais un ensemble (S-5).
    @Published var selectedCardID: String?

    // État de vue de la section (S-14 de omp-console-redesign, `@State` interdit
    // sous CLT) : la feuille de détail de la carte sélectionnée, la confirmation
    // d'arrêt demandée depuis le menu contextuel d'une carte, la bulle des
    // problèmes et les plis « Détails techniques » (feuille, bulle).
    @Published var detailShown = false
    @Published var stopRequest: KanbanCard?
    /// La carte dont la feuille « Modèles » est ouverte (menu contextuel de
    /// carte, inspecteur).
    @Published var modelsSheetCard: KanbanCard?
    @Published var diagnosticShown = false
    @Published var technicalExpanded = false
    @Published var diagnosticTechnicalExpanded = false

    /// Le registre des faits de PR (S-5) : l'ardoise est dérivée avec ses faits,
    /// le flux distant les sert à iOS.
    let prStates: PullRequestStateBook
    /// Relais de `prStates.refreshing` : vrai pendant une relecture des PR.
    @Published private(set) var prRefreshing = false

    /// La demande de feuille Contrat posée depuis la feuille de DÉTAIL (S-6) : la
    /// fenêtre ne présente jamais deux feuilles à la fois, donc le détail se ferme
    /// d'abord et la feuille Contrat n'est ouverte qu'à sa fermeture effective
    /// (`onDismiss` de `KanbanView`, qui consomme la demande).
    private(set) var pendingContract: KanbanCard?

    /// Comment ouvrir un abonnement NEUF : un `StoreHub` arrêté ne se rouvre pas
    /// (`stopped` est définitif), donc `start()` après `stop()` construit un hub
    /// neuf sur le MÊME magasin.
    private let makeHub: () -> StoreHub
    private var hub: StoreHub
    private var task: Task<Void, Never>?
    private var hubStopped = false
    /// L'ardoise du crochet de recette `-home.recipe` (`HomeRecipe`) : posée
    /// telle quelle par `start()`, sans abonnement au magasin.
    private let recipeBoard: KanbanBoardState?
    /// Le dernier instantané lu : re-dérivé quand les faits de PR changent.
    private var lastSnapshot: StoreSnapshot?
    private var cancellables: Set<AnyCancellable> = []

    /// `prStates` nil : le registre de production, lecteur `gh` résolu dans
    /// `environment` (`OMP_CONSOLE_GH_BINARY` compris) ; `gh` introuvable donne un
    /// registre SANS lecteur — aucun fait, toutes les PR restent « PR créée ».
    /// `recipeBoard` nil (défaut) : comportement de production.
    init(
        hub: StoreHub = StoreHub(),
        prStates: PullRequestStateBook? = nil,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        recipeBoard: KanbanBoardState? = nil
    ) {
        self.hub = hub
        self.makeHub = { StoreHub(stateDir: hub.stateDir, nowMs: hub.nowMs) }
        self.recipeBoard = recipeBoard
        self.prStates = prStates ?? Self.ghBook(environment: environment)
        // `@Published` émet AVANT l'affectation : la valeur neuve vient du
        // paramètre, jamais d'une relecture de la propriété.
        self.prStates.$facts
            .dropFirst()
            .sink { [weak self] facts in self?.rederive(facts: facts) }
            .store(in: &cancellables)
        self.prStates.$refreshing
            .sink { [weak self] refreshing in self?.prRefreshing = refreshing }
            .store(in: &cancellables)
    }

    /// Le registre de production (aussi celui du banc de recette BR-4).
    static func ghBook(environment: [String: String]) -> PullRequestStateBook {
        switch GhBinary.resolve(environment: environment) {
        case let .success(binary):
            return PullRequestStateBook(reader: GhPullRequestStateReader(cli: GhCLI(binary: binary, timeout: 20)))
        case .failure:
            return PullRequestStateBook(reader: nil)
        }
    }

    /// Rafraîchissement manuel (⌘R, route distante) : relance la lecture des PR
    /// sans l'attendre ; sans effet pendant une relecture.
    func refreshPullRequestStates() {
        prStates.refresh()
    }

    /// La charge servie à iOS : les faits triés par URL et l'état de relecture.
    func pullRequestStatesPayload() -> RemotePullRequestStatesPayload {
        RemotePullRequestStatesPayload(
            facts: prStates.facts.values.sorted { $0.url < $1.url },
            refreshing: prStates.refreshing
        )
    }

    /// « Les faits de PR ont changé » pour le flux distant : chaque fait publié ET
    /// chaque bascule de relecture, jamais la valeur initiale.
    func pullRequestStatesChanges() -> AnyPublisher<Void, Never> {
        prStates.$facts.dropFirst().voidChanges()
            .merge(with: prStates.$refreshing.dropFirst().voidChanges())
            .eraseToAnyPublisher()
    }

    /// S'abonne au flux global en UNE tâche de longue durée. Idempotent. Sous une
    /// recette, pose son ardoise et s'arrête là : aucun abonnement.
    func start() {
        if let recipeBoard {
            state = recipeBoard
            return
        }
        guard task == nil else { return }
        if hubStopped {
            hub = makeHub()
            hubStopped = false
        }
        let hub = self.hub
        task = Task { [weak self] in
            for await snapshot in hub.snapshots() {
                guard let self else { return }
                self.apply(snapshot)
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

    /// Sélectionne une carte et ouvre sa feuille de détail (double clic, ↩, menu
    /// contextuel).
    func openDetail(_ id: String) {
        select(id)
        detailShown = true
    }

    /// « Lire le contrat » depuis la feuille de détail : pose la demande PUIS
    /// ferme le détail. La feuille Contrat n'est demandée qu'à la fermeture
    /// effective du détail (`onDismiss`), jamais en même temps que lui.
    func requestContract(_ card: KanbanCard) {
        pendingContract = card
        detailShown = false
    }

    /// Rend la demande en attente et l'EFFACE : une demande ne se consomme
    /// qu'une fois.
    func consumePendingContract() -> KanbanCard? {
        defer { pendingContract = nil }
        return pendingContract
    }

    /// La carte sélectionnée, quand elle existe encore.
    var selectedCard: KanbanCard? {
        guard let id = selectedCardID else { return nil }
        return state.card(id)
    }

    /// Un pas de clavier, dans l'ordre de l'ÉCRAN : les voies de gauche à droite
    /// (`KanbanBoard.lanes`) pour `nextColumn`/`previousColumn`, les cartes de
    /// haut en bas puis d'une voie à la suivante pour `next`/`previous`. Sans
    /// sélection, `next`/`nextColumn` prennent la première carte et
    /// `previous`/`previousColumn` la dernière. Un déplacement qui sort de
    /// l'ardoise ne change rien.
    func move(by step: KanbanStep) {
        guard let board = state.kanbanBoard, !board.cards.isEmpty else { return }
        let lanes = board.lanes.filter { !$0.cards.isEmpty }
        let cards = lanes.flatMap(\.cards)
        guard let current = selectedCardID, let index = cards.firstIndex(where: { $0.id == current }) else {
            selectedCardID = (step == .next || step == .nextColumn) ? cards.first?.id : cards.last?.id
            return
        }
        switch step {
        case .next:
            selectedCardID = cards[min(index + 1, cards.count - 1)].id
        case .previous:
            selectedCardID = cards[max(index - 1, 0)].id
        case .nextColumn, .previousColumn:
            guard let laneIndex = lanes.firstIndex(where: { $0.cards.contains { $0.id == current } }) else { return }
            let target = step == .nextColumn ? laneIndex + 1 : laneIndex - 1
            if lanes.indices.contains(target) {
                selectedCardID = lanes[target].cards.first?.id
            }
        }
    }

    /// Reconstruit l'ardoise pour un instantané neuf, et purge une sélection dont
    /// la carte a disparu du magasin (pas de détail fantôme : la feuille se ferme,
    /// une confirmation d'arrêt en suspens aussi). Les URLs de PR du magasin sont
    /// passées au registre : une URL jamais tentée est lue (S-5).
    private func apply(_ snapshot: StoreSnapshot) {
        lastSnapshot = snapshot
        prStates.observe(urls: PullRequestFacts.urls(in: snapshot))
        derive(snapshot, facts: prStates.facts)
    }

    private func rederive(facts: [String: PullRequestFact]) {
        guard let snapshot = lastSnapshot else { return }
        derive(snapshot, facts: facts)
    }

    private func derive(_ snapshot: StoreSnapshot, facts: [String: PullRequestFact]) {
        // L'horloge du HUB, pas l'horloge murale : la borne des livraisons closes
        // (`KanbanBoard.deliveredWindowMs`) se mesure dans le temps du magasin lu,
        // celui qu'un test fixe.
        let next = KanbanBoardState.derive(
            snapshot: snapshot,
            nowMs: hub.nowMs(),
            stateDir: hub.stateDir,
            isAlive: .processLocal,
            prFacts: facts
        )
        state = next
        if let selected = selectedCardID, next.card(selected) == nil {
            selectedCardID = nil
            detailShown = false
        }
        if let request = stopRequest, next.card(request.id) == nil {
            stopRequest = nil
        }
        if let sheet = modelsSheetCard, next.card(sheet.id) == nil {
            modelsSheetCard = nil
        }
    }
}
