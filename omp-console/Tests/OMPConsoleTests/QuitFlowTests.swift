// Preuves du déroulé unique de la sortie (mac-quitter-sans-confirmation, S-4 et
// S-5) : au plus une alerte, Annuler sans effet de bord, accroches puis feuilles
// puis terminaison, et la réponse à l'Apple Event de quit (Dock, fermeture de
// session macOS).
//
// Le délégué réel est construit avec ses accroches PAR DÉFAUT (les statiques des
// modèles, remplacées ici par des enregistreurs) ; seuls l'instantané, l'alerte,
// la fermeture des feuilles et la terminaison sont injectés — un test ne montre
// aucune alerte et ne termine pas le process qui l'exécute.

import AppKit
import Testing
@testable import OMPConsole

/// Les sept accroches statiques du délégué, sauvegardées puis restaurées : un
/// test du Quitter ne laisse rien derrière lui.
@MainActor
struct SavedQuitStatics {
    private let session = AppDelegate.terminateSession
    private let project = AppDelegate.terminateProject
    private let terminal = AppDelegate.terminateTerminal
    private let remote = AppDelegate.terminateRemoteService
    private let sessionActivity = AppDelegate.sessionQuitActivity
    private let terminalActivity = AppDelegate.terminalQuitActivity
    private let projectActivity = AppDelegate.projectQuitActivity

    /// Sauvegarde, puis remet toutes les accroches à nil.
    init() {
        AppDelegate.terminateSession = nil
        AppDelegate.terminateProject = nil
        AppDelegate.terminateTerminal = nil
        AppDelegate.terminateRemoteService = nil
        AppDelegate.sessionQuitActivity = nil
        AppDelegate.terminalQuitActivity = nil
        AppDelegate.projectQuitActivity = nil
    }

    func restore() {
        AppDelegate.terminateSession = session
        AppDelegate.terminateProject = project
        AppDelegate.terminateTerminal = terminal
        AppDelegate.terminateRemoteService = remote
        AppDelegate.sessionQuitActivity = sessionActivity
        AppDelegate.terminalQuitActivity = terminalActivity
        AppDelegate.projectQuitActivity = projectActivity
    }
}

/// Un délégué réel dont le Quitter est observé : chaque étape s'inscrit au
/// journal, dans l'ordre où elle arrive.
@MainActor
final class QuitHarness {
    let delegate = AppDelegate()
    var log: [String] = []
    var prompts: [QuitPrompt] = []
    var choice: QuitFlow.Choice

    init(activities: [QuitActivity], choice: QuitFlow.Choice) {
        self.choice = choice
        let quit = delegate.quit
        quit.activities = { activities }
        quit.confirm = { [unowned self] prompt in
            prompts.append(prompt)
            log.append("alerte")
            return self.choice
        }
        quit.closeAttachedSheets = { [unowned self] in log.append("feuilles") }
        quit.requestTermination = { [unowned self] in log.append("terminaison") }
        AppDelegate.terminateSession = { [unowned self] in log.append("session") }
        AppDelegate.terminateProject = { [unowned self] in log.append("pilotage") }
        AppDelegate.terminateTerminal = { [unowned self] in log.append("terminal") }
        AppDelegate.terminateRemoteService = { [unowned self] in log.append("service") }
    }

    var quit: QuitFlow { delegate.quit }
    var terminated: Bool { log.last == "terminaison" }

    static let exitSequence = ["session", "pilotage", "terminal", "service", "feuilles", "terminaison"]
}

private func quitEvent() -> NSAppleEventDescriptor {
    NSAppleEventDescriptor(
        eventClass: AEEventClass(kCoreEventClass),
        eventID: AEEventID(kAEQuitApplication),
        targetDescriptor: nil,
        returnID: AEReturnID(kAutoGenerateReturnID),
        transactionID: AETransactionID(kAnyTransactionID)
    )
}

private func quitReply() -> NSAppleEventDescriptor {
    NSAppleEventDescriptor(
        eventClass: AEEventClass(kCoreEventClass),
        eventID: AEEventID(kAEAnswer),
        targetDescriptor: nil,
        returnID: AEReturnID(kAutoGenerateReturnID),
        transactionID: AETransactionID(kAnyTransactionID)
    )
}

@MainActor
@Suite(.serialized)
struct QuitFlowTests {
    @Test("mac-quitter-sans-confirmation/AC-1 : une session OMP ouverte fait poser l'alerte, l'app reste en marche tant qu'on n'a pas choisi")
    func sessionAsksBeforeQuitting() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: [.session(name: "mem0-omp")], choice: .cancel)

        #expect(harness.quit.request() == .cancelled)
        #expect(harness.prompts.count == 1)
        #expect(harness.prompts.first?.title == QuitText.title)
        #expect(harness.prompts.first?.message == "La session OMP de « mem0-omp » s’arrêtera.")
        // Rien d'autre : ni accroche, ni feuille fermée, ni terminaison.
        try? await Task.sleep(for: .milliseconds(100))
        #expect(harness.log == ["alerte"])
        #expect(harness.quit.phase == .idle)
    }

    @Test("mac-quitter-sans-confirmation/AC-4 : Quitter lance les accroches inchangées dans l'ordre, ferme les feuilles, puis termine")
    func quitRunsHooksThenTerminates() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: [.session(name: "mem0-omp")], choice: .quit)

        #expect(harness.quit.request() == .proceeding)
        #expect(harness.quit.phase == .quitting)
        // Pendant les accroches, AppKit est encore renvoyé : la terminaison n'est
        // pas due.
        #expect(harness.quit.shouldTerminate() == .terminateCancel)
        #expect(await awaitMainTrue { harness.terminated })
        #expect(harness.log == ["alerte"] + QuitHarness.exitSequence)
        #expect(harness.quit.phase == .terminating)
        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    }

    @Test("mac-quitter-sans-confirmation/AC-3 : Annuler laisse tout tourner, et le ⌘Q suivant redemande avec un instantané neuf")
    func cancelHasNoSideEffectAndAsksAgain() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        var snapshots = 0
        let harness = QuitHarness(activities: [], choice: .cancel)
        harness.quit.activities = {
            snapshots += 1
            return [.session(name: "mem0-omp"), .terminalCommand(name: "sleep"), .pilotage(name: "mon-projet"), .pipelines(count: 2)]
        }

        #expect(harness.quit.request() == .cancelled)
        // `applicationShouldTerminate` sur `.idle` (un autre appelant de
        // `NSApp.terminate`) redemande, et AppKit est renvoyé.
        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(snapshots == 2)
        #expect(harness.prompts.count == 2)
        try? await Task.sleep(for: .milliseconds(100))
        // Aucune accroche : session, pilotage, commande et service continuent.
        #expect(harness.log == ["alerte", "alerte"])
        #expect(harness.quit.phase == .idle)
    }

    @Test("mac-quitter-sans-confirmation/AC-5 : pipelines et session — une seule alerte qui cite les deux, aucune seconde après Quitter")
    func pipelinesAndSessionMakeOneAlert() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: [.session(name: "x"), .pipelines(count: 2)], choice: .quit)

        #expect(harness.quit.request() == .proceeding)
        #expect(harness.prompts.count == 1)
        #expect(harness.prompts.first?.message.components(separatedBy: "\n") == [
            "La session OMP de « x » s’arrêtera.",
            "2 pipelines en cours continuent dans OMP.",
        ])
        #expect(await awaitMainTrue { harness.terminated })
        // La redemande finale d'AppKit termine sans repasser par l'alerte.
        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
        #expect(harness.prompts.count == 1)
    }

    @Test(
        "mac-quitter-sans-confirmation/AC-8 : sans activité qui s'arrête, aucune alerte — accroches puis terminaison",
        arguments: [[QuitActivity](), [.pilotage(name: "p"), .pipelines(count: 3)]]
    )
    func noStoppingActivityQuitsWithoutAlert(activities: [QuitActivity]) async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: activities, choice: .cancel)

        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(await awaitMainTrue { harness.terminated })
        #expect(harness.prompts.isEmpty)
        #expect(harness.log == QuitHarness.exitSequence)
        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    }

    @Test("mac-quitter-sans-confirmation/AC-9 : une feuille ouverte sans activité — les feuilles sont fermées AVANT la terminaison redemandée, le bouton Quitter de la feuille passe par le même déroulé")
    func sheetsCloseBeforeTermination() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: [], choice: .cancel)

        // Le bouton « Quitter » de la feuille de préparation appelle `request()`.
        #expect(harness.quit.request() == .proceeding)
        #expect(await awaitMainTrue { harness.terminated })
        #expect(harness.prompts.isEmpty)
        #expect(harness.log.suffix(2) == ["feuilles", "terminaison"])
    }

    @Test("mac-quitter-sans-confirmation/AC-5 : une demande pendant l'alerte est refusée, une demande pendant la sortie la rejoint sans relancer les accroches")
    func reentrantRequestsNeverAskTwice() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: [.terminalCommand(name: "sleep")], choice: .quit)
        var nested: [QuitFlow.Decision] = []
        let confirm = harness.quit.confirm
        harness.quit.confirm = { [unowned harness] prompt in
            nested.append(harness.quit.request())
            #expect(harness.quit.shouldTerminate() == .terminateCancel)
            return confirm(prompt)
        }

        #expect(harness.quit.request() == .proceeding)
        #expect(nested == [.cancelled])
        // Pendant les accroches : la demande rejoint la sortie en cours.
        #expect(harness.quit.request() == .proceeding)
        #expect(await awaitMainTrue { harness.terminated })
        #expect(harness.quit.request() == .proceeding)
        #expect(harness.prompts.count == 1)
        #expect(harness.log == ["alerte"] + QuitHarness.exitSequence)
    }

    @Test("mac-quitter-sans-confirmation/AC-11 : Annuler sur l'Apple Event de quit (fermeture de session, Dock) répond userCanceledErr (-128)")
    func quitAppleEventCancelledAnswersUserCanceled() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: [.terminalCommand(name: "sleep")], choice: .cancel)
        let reply = quitReply()

        harness.delegate.handleQuitAppleEvent(quitEvent(), withReplyEvent: reply)

        #expect(harness.prompts.count == 1)
        #expect(reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber))?.int32Value == -128)
        try? await Task.sleep(for: .milliseconds(100))
        #expect(harness.log == ["alerte"])
        #expect(harness.quit.phase == .idle)
    }

    @Test("mac-quitter-sans-confirmation/AC-11 : Quitter, ou aucune activité, laisse la réponse à l'Apple Event sans erreur — la fermeture de session n'est plus interrompue")
    func quitAppleEventAcceptedAnswersWithoutError() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        for (activities, alerts) in [([QuitActivity.terminalCommand(name: "sleep")], 1), ([], 0)] {
            let harness = QuitHarness(activities: activities, choice: .quit)
            let reply = quitReply()

            harness.delegate.handleQuitAppleEvent(quitEvent(), withReplyEvent: reply)

            #expect(harness.prompts.count == alerts)
            #expect(reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)) == nil)
            #expect(await awaitMainTrue { harness.terminated })
        }
    }

    @Test("mac-quitter-sans-confirmation/AC-10 : menu de l'app (⌘Q), Dock et NSApp.terminate posent la même alerte")
    func everyExitPathAsksTheSameAlert() async {
        let saved = SavedQuitStatics()
        defer { saved.restore() }
        let harness = QuitHarness(activities: [.session(name: "mem0-omp")], choice: .cancel)

        // Menu « Quitter OMP Console » : `QuitCommands` appelle `request()`.
        #expect(harness.quit.request() == .cancelled)
        // Dock ▸ Quitter : l'Apple Event de quit.
        harness.delegate.handleQuitAppleEvent(quitEvent(), withReplyEvent: quitReply())
        // Tout autre appelant de `NSApp.terminate`.
        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)

        #expect(harness.prompts.count == 3)
        #expect(harness.prompts.allSatisfy { $0 == harness.prompts[0] })
        try? await Task.sleep(for: .milliseconds(100))
        #expect(harness.log == ["alerte", "alerte", "alerte"])
    }
}
