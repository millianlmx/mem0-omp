// Harnais des tests d'alertes (BR-2) : une doublure de livreur enregistreuse et des
// fabriques d'évènements, sur le magasin réel de `StoreFixtures.swift`.
//
// Aucun mock du système de fichiers ni de UserNotifications : la doublure de livreur
// est un simple enregistreur, et la chaîne magasin → dérivation → décision est
// exercée sur de vrais fichiers (S-9, AC-10).

@testable import OMPConsole
import ConsoleCore
import Foundation

/// Un livreur ENREGISTREUR : ce que le modèle décide de livrer, et rien de plus. Il
/// n'appelle jamais UserNotifications (mesuré : un seul appel tue un processus de
/// test hors bundle, Doc-3).
final class RecorderAlertDeliverer: AlertDelivering, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [AlertMessage] = []
    private var recordedOutcomes: [AlertDeliveryOutcome] = []
    private var current: AlertAuthorization
    private var authorizationRequestCount = 0
    private var openingHandler: (@MainActor @Sendable (AlertOpening?) -> Void)?
    private var openingObservations = 0

    init(authorization: AlertAuthorization = .authorized) {
        current = authorization
    }

    /// `NSLock.lock()`/`unlock()` sont interdits dans un contexte `async` (Swift 6) :
    /// le verrou est donc pris dans une fonction SYNCHRONE, appelée par les façades.
    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    func authorization() async -> AlertAuthorization {
        withLock { current }
    }

    func requestAuthorization() async -> AlertAuthorization {
        withLock {
            authorizationRequestCount += 1
            return current
        }
    }

    func deliver(_ message: AlertMessage) async -> AlertDeliveryOutcome {
        withLock {
            recorded.append(message)
            let outcome = AlertDeliveryOutcome.delivered
            recordedOutcomes.append(outcome)
            return outcome
        }
    }

    func observeOpenings(_ handler: @escaping @MainActor @Sendable (AlertOpening?) -> Void) {
        withLock {
            openingObservations += 1
            openingHandler = handler
        }
    }

    /// Le clic sur une notification, tel que le délégué système le remet : le
    /// payload déjà décodé, livré sur le `MainActor`.
    @MainActor
    func simulateOpen(_ opening: AlertOpening?) {
        withLock { openingHandler }?(opening)
    }

    /// Le nombre d'enregistrements du traitement des clics.
    var openingObservationCount: Int {
        withLock { openingObservations }
    }

    var messages: [AlertMessage] {
        withLock { recorded }
    }

    var keys: [String] { messages.map(\.key) }

    var outcomes: [AlertDeliveryOutcome] {
        withLock { recordedOutcomes }
    }

    var authorizationRequests: Int {
        withLock { authorizationRequestCount }
    }
}

// --- accès au magasin réel ----------------------------------------------------

/// L'instantané complet d'une fixture : la même lecture que le modèle reçoit du flux.
func alertsSnapshot(_ fixture: StoreFixture) -> StoreSnapshot {
    StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
}

/// Les évènements dérivés d'une fixture, à l'instant de référence, avec l'ardoise
/// dérivée du même magasin (comme `AlertsModel.apply`).
func alertEvents(_ fixture: StoreFixture) -> [AlertEvent] {
    AlertDerivation.events(from: alertsSnapshot(fixture), board: kanbanBoard(fixture))
}

// --- fabriques d'objets utiles -------------------------------------------------

/// Une question `ask` EN VOL, au format réel.
func pendingAskObject(_ toolCallId: String = "call-1") -> [String: Any] {
    [
        "toolCallId": toolCallId,
        "id": "ask-1",
        "question": "Quel chemin ?",
        "options": [["label": "ici"], ["label": "ailleurs"]],
    ]
}

/// Publie un run au premier plan du magasin : vivant (pid courant), frais, une
/// question `ask` en vol ⇒ la clé `answer:<id>:<toolCallId>`.
func publishPendingAnswer(
    _ fixture: StoreFixture,
    id: String,
    label: String = "depot/attente",
    toolCallId: String = "call-1",
    updatedAt: Double = fixtureT0 - 500
) {
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: "/tmp/alerts/\(id)",
            label: label,
            state: "waiting",
            phaseStartedAt: fixtureT0 - 1_000,
            updatedAt: updatedAt,
            ownerPid: Double(getpid()),
            pendingAsk: pendingAskObject(toolCallId)
        )
    )
}

/// Publie un run SANS question, vivant et frais (colonne « en cours »).
func publishBusyRun(
    _ fixture: StoreFixture,
    id: String,
    label: String = "depot/en-cours",
    updatedAt: Double = fixtureT0 - 500
) {
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: "/tmp/alerts/\(id)",
            label: label,
            state: "running",
            phaseStartedAt: fixtureT0 - 900,
            updatedAt: updatedAt,
            ownerPid: Double(getpid())
        )
    )
}

/// Le chemin d'un registre sous le répertoire jetable de la fixture : la suite ne
/// touche JAMAIS le vrai `~/Library/Application Support`.
func fixtureLedgerPath(_ fixture: StoreFixture) -> String {
    joinPath(fixture.root, "alerts/\(AlertLedger.fileName)")
}

/// Un modèle réel sur le magasin réel d'une fixture, pour les tests de décision.
@MainActor
func fixtureAlertsModel(
    _ fixture: StoreFixture,
    deliverer: AlertDelivering,
    frontmost: Bool,
    ledgerPath: String? = nil
) -> AlertsModel {
    AlertsModel(
        hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }),
        ledgerPath: ledgerPath ?? fixtureLedgerPath(fixture),
        deliverer: deliverer,
        isWindowFrontmost: { frontmost },
        nowMs: { fixtureT0 }
    )
}
