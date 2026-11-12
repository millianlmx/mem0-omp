// Preuves du déroulé unique de la sortie (mac-quitter-sans-confirmation, S-4 et
// S-5) : aucune alerte, les feuilles fermées puis la terminaison, et la réponse à
// l'Apple Event de quit (Dock, fermeture de session macOS).
//
// Le délégué réel est construit ; seules la fermeture des feuilles et la terminaison
// sont injectées — un test ne termine pas le process qui l'exécute.

import AppKit
import Testing
@testable import OMPConsole

/// Un délégué réel dont le Quitter est observé : chaque étape s'inscrit au journal,
/// dans l'ordre où elle arrive.
@MainActor
final class QuitHarness {
    let delegate = AppDelegate()
    var log: [String] = []

    init() {
        let quit = delegate.quit
        quit.closeAttachedSheets = { [unowned self] in log.append("feuilles") }
        quit.requestTermination = { [unowned self] in log.append("terminaison") }
    }

    var quit: QuitFlow { delegate.quit }
    var terminated: Bool { log.last == "terminaison" }
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
    @Test("mac-quitter-sans-confirmation/AC-8 : aucune alerte — feuilles fermées puis terminaison")
    func quitClosesSheetsThenTerminates() async {
        let harness = QuitHarness()

        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateCancel)
        #expect(harness.quit.phase == .quitting)
        #expect(await awaitMainTrue { harness.terminated })
        #expect(harness.log == ["feuilles", "terminaison"])
        #expect(harness.quit.phase == .terminating)
        #expect(harness.delegate.applicationShouldTerminate(NSApplication.shared) == .terminateNow)
    }

    @Test("mac-quitter-sans-confirmation/AC-5 : une demande pendant la sortie la rejoint sans la relancer")
    func reentrantRequestsJoinTheExit() async {
        let harness = QuitHarness()

        harness.quit.request()
        harness.quit.request()
        #expect(harness.quit.shouldTerminate() == .terminateCancel)
        #expect(await awaitMainTrue { harness.terminated })
        harness.quit.request()
        #expect(harness.log == ["feuilles", "terminaison"])
    }

    @Test("mac-quitter-sans-confirmation/AC-11 : l'Apple Event de quit (Dock, fermeture de session) quitte, sans erreur dans la réponse")
    func quitAppleEventAnswersWithoutError() async {
        let harness = QuitHarness()
        let reply = quitReply()

        harness.delegate.handleQuitAppleEvent(quitEvent(), withReplyEvent: reply)

        #expect(reply.paramDescriptor(forKeyword: AEKeyword(keyErrorNumber)) == nil)
        #expect(await awaitMainTrue { harness.terminated })
    }
}
