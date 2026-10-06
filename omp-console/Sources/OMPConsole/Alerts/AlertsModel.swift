// Le modèle d'alertes (BR-3, S-7) : il s'abonne au flux global du magasin, publie
// l'état des compteurs et l'autorisation, et décide — une fois par évènement — de
// livrer ou non une notification.
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
    /// L'état des compteurs, tel que la bande (S-9) et l'item de barre (S-2) l'affichent.
    @Published private(set) var status: AlertsStatus = .loading
    /// L'état d'autorisation, relu au démarrage puis à chaque activation de l'app.
    @Published private(set) var authorization: AlertAuthorization = .unknown

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

    init(
        hub: StoreHub = StoreHub(),
        ledgerPath: String = AlertLedger.defaultPath(),
        deliverer: AlertDelivering = AlertDeliverer.live(),
        isWindowFrontmost: @escaping @MainActor () -> Bool = { NSApplication.shared.isActive },
        nowMs: @escaping @Sendable () -> Double = { StoreClock.live.nowMs() }
    ) {
        self.hub = hub
        self.makeHub = { StoreHub(stateDir: hub.stateDir, nowMs: hub.nowMs) }
        self.ledgerPath = ledgerPath
        self.ledger = AlertLedger(path: ledgerPath)
        self.deliverer = deliverer
        self.isWindowFrontmost = isWindowFrontmost
        self.nowMs = nowMs
    }

    /// Le flux de l'état publié : l'item de barre s'y abonne (S-2). C'est le SEUL
    /// producteur des chiffres — la barre ne calcule rien pour son compte.
    var statusPublisher: AnyPublisher<AlertsStatus, Never> {
        $status.eraseToAnyPublisher()
    }

    /// Charge le registre, s'abonne au flux, demande l'autorisation, relit le statut
    /// à chaque activation. Idempotent.
    func start() {
        guard task == nil else { return }
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
    }

    /// Annule l'abonnement, retire l'observateur et arrête le hub.
    func stop() {
        task?.cancel()
        task = nil
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

    /// Le cœur de la décision (S-7).
    private func apply(_ snapshot: StoreSnapshot, stateDir: String) async {
        status = AlertsStatus.from(boardState: KanbanBoardState.derive(
            snapshot: snapshot, nowMs: nowMs(), stateDir: stateDir
        ))
        let events = AlertDerivation.events(from: snapshot)
        let fresh = Set(events.filter { !ledger.contains($0.key) }.map(\.key))
        // (3) On enregistre TOUTES les clés dérivées ; l'écriture n'a lieu que si au
        // moins une est neuve — un registre inchangé ne se réécrit pas.
        if ledger.record(keys: events.map(\.key), nowMs: nowMs()) {
            ledger.save()
        }
        // (4) Une fenêtre au premier plan consomme l'évènement sans notifier.
        guard !isWindowFrontmost() else { return }
        for event in events where fresh.contains(event.key) {
            _ = await deliverer.deliver(AlertMessage(key: event.key, title: event.title, body: event.body))
        }
    }
}
