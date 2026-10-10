// Le modèle d'alertes (BR-3, S-7) : il s'abonne au flux global du magasin, publie
// les comptes de l'Accueil que l'item de barre recopie (« À vous », « En cours »)
// et l'autorisation, et décide — une fois par évènement — de livrer ou non une
// notification.
//
// Décision, à CHAQUE instantané, dans cet ordre (S-7) :
//   1. dériver TOUS les évènements du magasin (AlertEvents) ;
//   2. marquer « neufs » ceux dont la clé est absente du registre ;
//   3. enregistrer TOUTES les clés dérivées et persister si une clé est neuve ;
//   4. si la fenêtre n'est PAS au premier plan, livrer les neufs, un par un.
// L'enregistrement PRÉCÈDE la livraison : une notification en double est pire qu'une
// notification perdue. Il a lieu même fenêtre au premier plan (AC-6 n'émet rien, mais
// AC-5 ne doit pas renotifier après relance).
//
// Patron du dépôt (`KanbanModel.swift`) : un abonnement UNIQUE et de longue durée
// (`for await` sur `hub.snapshots()`), jamais une scrutation ; `start()` idempotent,
// `stop()` arrête le hub et en construit un neuf au `start()` suivant.

import AppKit
import Combine
import ConsoleCore
import Foundation

@MainActor
final class AlertsModel: ObservableObject {
    /// Les comptes « À vous » / « En cours » de l'Accueil, tels que l'item de barre
    /// de menus les affiche (S-6, S-7 de accueil-en-cours-melange-pause-et-compte).
    @Published private(set) var status: AlertsStatus = .loading
    /// L'état d'autorisation, relu au démarrage puis à chaque activation de l'app.
    @Published private(set) var authorization: AlertAuthorization = .unknown
    /// Le clic d'une notification (notifications-mac-lien-profond S-3) : posé par
    /// `AppDelegate`, il remet la destination décodée au routeur de la fenêtre.
    var onOpen: (@MainActor (AlertOpening?) -> Void)?

    /// Comment ouvrir un abonnement NEUF : un `StoreHub` arrêté ne se rouvre pas.
    private let makeHub: () -> StoreHub
    private var hub: StoreHub
    private var task: Task<Void, Never>?
    private var hubStopped = false
    private let ledgerPath: String
    private var ledger: AlertLedger
    private let deliverer: AlertDelivering
    private let isWindowFrontmost: @MainActor () -> Bool
    private let nowMs: @Sendable () -> Double
    private var activationObserver: NSObjectProtocol?
    private var openingsObserved = false
    /// Le superviseur d'ownership (S-5) : optionnel, une seule surface le démarre.
    private let ownership: StackOwnershipModel?
    private var ownershipTask: Task<Void, Never>?
    /// L'ardoise du crochet de recette `-home.recipe` (`HomeRecipe`) : `start()`
    /// en pose le statut et s'arrête là — aucun hub, aucun superviseur, aucune
    /// notification.
    private let recipeBoard: KanbanBoardState?

    init(
        hub: StoreHub = StoreHub(),
        ledgerPath: String = AlertLedger.defaultPath(),
        deliverer: AlertDelivering = AlertDeliverer.live(),
        isWindowFrontmost: @escaping @MainActor () -> Bool = { NSApplication.shared.isActive },
        nowMs: @escaping @Sendable () -> Double = { StoreClock.live.nowMs() },
        ownership: StackOwnershipModel? = nil,
        recipeBoard: KanbanBoardState? = nil
    ) {
        self.hub = hub
        self.makeHub = { StoreHub(stateDir: hub.stateDir, nowMs: hub.nowMs) }
        self.ledgerPath = ledgerPath
        self.ledger = AlertLedger(path: ledgerPath)
        self.deliverer = deliverer
        self.isWindowFrontmost = isWindowFrontmost
        self.nowMs = nowMs
        self.ownership = ownership
        self.recipeBoard = recipeBoard
    }

    /// Le flux de l'état publié : l'item de barre s'y abonne (S-2). C'est le SEUL
    /// producteur des chiffres — la barre ne calcule rien pour son compte.
    var statusPublisher: AnyPublisher<AlertsStatus, Never> {
        $status.eraseToAnyPublisher()
    }

    /// Charge le registre, s'abonne au flux, demande l'autorisation, relit le statut
    /// à chaque activation, et confie les clics au livreur (une seule fois, même
    /// après `stop()`). Idempotent. Sous une recette, pose seulement le statut
    /// de son ardoise.
    func start() {
        if let recipeBoard {
            status = AlertsStatus.from(boardState: recipeBoard)
            return
        }
        guard task == nil else { return }
        if !openingsObserved {
            openingsObserved = true
            deliverer.observeOpenings { [weak self] in self?.onOpen?($0) }
        }
        if hubStopped {
            hub = makeHub()
            hubStopped = false
        }
        // Le registre est relu au DÉMARRAGE (S-7) : la version persistée fait foi.
        ledger = AlertLedger(path: ledgerPath)
        Task { [weak self] in await self?.refreshAuthorization(request: true) }
        activationObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // Relecture SANS nouvelle demande (S-8) : c'est le retour de Réglages.
            Task { @MainActor in await self?.refreshAuthorization(request: false) }
        }
        let hub = self.hub
        let stateDir = hub.stateDir
        task = Task { [weak self] in
            for await snapshot in hub.snapshots() {
                guard let self else { return }
                await self.apply(snapshot, stateDir: stateDir)
            }
        }
        // Le superviseur d'ownership (S-5) : un abonnement UNIQUE et de longue
        // durée, comme `hub.snapshots()`. `ownership.start()` démarre la scrutation.
        if let ownership {
            let events = ownership.events
            ownershipTask = Task { [weak self] in
                for await event in events {
                    guard let self else { return }
                    await self.ingest(event)
                }
            }
            ownership.start()
        }
    }

    /// Annule les abonnements, retire l'observateur et arrête le hub et le superviseur.
    func stop() {
        task?.cancel()
        task = nil
        ownershipTask?.cancel()
        ownershipTask = nil
        ownership?.stop()
        if let observer = activationObserver {
            NotificationCenter.default.removeObserver(observer)
            activationObserver = nil
        }
        hub.stop()
        hubStopped = true
    }

    private func refreshAuthorization(request: Bool) async {
        authorization = request ? await deliverer.requestAuthorization() : await deliverer.authorization()
    }

    /// Le cœur de la décision (S-7) : l'instantané publie les comptes, puis
    /// chaque évènement dérivé passe par `ingest`.
    private func apply(_ snapshot: StoreSnapshot, stateDir: String) async {
        // L'ardoise du MÊME instantané sert aux comptes et aux évènements (carte
        // concernée, nom affiché par l'Accueil). Aucun fait de PR : les comptes ne
        // lisent que « À vous » et « En cours », que l'état GitHub ne range jamais
        // (il ne range que les livraisons).
        let boardState = KanbanBoardState.derive(
            snapshot: snapshot, nowMs: nowMs(), stateDir: stateDir, isAlive: .processLocal, prFacts: [:]
        )
        status = AlertsStatus.from(boardState: boardState)
        for event in AlertDerivation.events(from: snapshot, board: boardState.kanbanBoard) {
            await ingest(event)
        }
    }

    /// La décision pour UN évènement (S-7, S-5) : « la clé est enregistrée AVANT la
    /// livraison, et la livraison n'a lieu que si la fenêtre n'est pas au premier
    /// plan ». C'est le même corps que celui qu'`apply` portait, extrait pour que le
    /// flux d'ownership (S-5) le réutilise tel quel.
    func ingest(_ event: AlertEvent) async {
        let isFresh = !ledger.contains(event.key)
        // On enregistre la clé même fenêtre au premier plan ; l'écriture n'a lieu
        // que si la clé est neuve — un registre inchangé ne se réécrit pas.
        if ledger.record(keys: [event.key], nowMs: nowMs()) {
            ledger.save()
        }
        // Une fenêtre au premier plan consomme l'évènement sans notifier.
        guard !isWindowFrontmost() else { return }
        guard isFresh else { return }
        _ = await deliverer.deliver(AlertMessage(key: event.key, title: event.title, body: event.body))
    }
}
