// Preuves du geste « envoyer un message dicté à la session OMP » (siri-dictee-session-omp,
// S-1 et S-2) : sa ligne de table, la porte qui l'applique, et le déroulé partagé
// d'une dictée. Les attentes sont écrites À LA MAIN.

import AppIntents
import ConsoleCore
import Testing

/// La ligne attendue, plateforme par plateforme.
private let promptRows: [(platform: VoicePlatform, needsConfirmation: Bool, needsUnlock: Bool, policy: IntentAuthenticationPolicy)] = [
    (.ios, false, true, .requiresLocalDeviceAuthentication),
    (.mac, false, false, .alwaysAllowed),
]

/// Les messages qui ne portent rien, fournis par l'intent.
private let emptyMessages: [String?] = [nil, "", "  \n"]
/// Les réponses dictées qui ne portent rien.
private let emptyAnswers: [String] = ["", "  \n"]

/// Le refus de l'utilisateur, tel qu'une fausse `confirm` le lève.
private struct Refused: Error {}
/// Un échec de dictée qui n'est pas une annulation.
private struct AskFailed: Error {}

/// Les appels reçus par les ports du déroulé.
@MainActor
private final class PromptCalls {
    var ready = 0
    var asks: [String] = []
    var delivered: [String] = []
    var confirm = 0
    var send = 0
}

/// Une sonde Mac du geste dont le littéral exige un déverrouillage que la table ne demande pas.
private struct PromptWithUnlockProbe: VoiceGestureIntent {
    static let title: LocalizedStringResource = "Sonde message avec déverrouillage"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .promptHostedSession
    func perform() async throws -> some IntentResult { .result() }
}

@Suite("VoiceSessionPromptTests")
@MainActor
struct VoiceSessionPromptTests {
    // --- S-1 : la ligne de table et la porte ------------------------------------

    @Test(
        "siri-dictee-session-omp/AC-9 (table) : la ligne du geste est calme, et la porte appelle confirm autant que la ligne l'exige et send une fois",
        arguments: promptRows.indices
    )
    func tableRowDrivesTheGate(index: Int) async throws {
        let row = promptRows[index]
        let rule = VoiceGesturePolicy.rule(for: .promptHostedSession, on: row.platform)
        #expect(rule.needsConfirmation == row.needsConfirmation)
        #expect(rule.needsUnlock == row.needsUnlock)
        #expect(VoiceGesturePolicy.authenticationPolicy(for: .promptHostedSession, on: row.platform) == row.policy)
        #expect(VoiceGestureText.confirmation(for: .promptHostedSession, target: "x") == nil)
        #expect(VoiceGesture.allCases.count == 12)

        // La branche que prescrit la ligne : confirmation acceptée si la ligne en exige une.
        let calls = PromptCalls()
        let outcome = try await VoiceGesturePolicy.apply(
            .promptHostedSession, target: "x", on: row.platform,
            confirm: { _ in calls.confirm += 1 },
            send: { calls.send += 1 }
        )
        #expect(outcome == .sent)
        #expect(calls.confirm == (rule.needsConfirmation ? 1 : 0))
        #expect(calls.send == 1)

        // La branche « refus » par la même porte : un refus n'émet rien si la ligne
        // demande une confirmation ; sinon la confirmation n'est jamais demandée.
        let refused = PromptCalls()
        let refusal = try await VoiceGesturePolicy.apply(
            .promptHostedSession, target: "x", on: row.platform,
            confirm: { _ in refused.confirm += 1; throw Refused() },
            send: { refused.send += 1 }
        )
        if rule.needsConfirmation {
            #expect(refusal == .cancelled(dialog: VoiceGestureText.cancelled))
            #expect(refused.confirm == 1)
            #expect(refused.send == 0)
        } else {
            #expect(refusal == .sent)
            #expect(refused.confirm == 0)
            #expect(refused.send == 1)
        }
    }

    @Test("siri-dictee-session-omp/AC-9 (table) : une sonde dont le littéral diverge de la table est mal configurée et n'émet rien")
    func misconfiguredProbeSendsNothing() async throws {
        let calls = PromptCalls()
        let outcome = try await PromptWithUnlockProbe().applyVoicePolicy(target: "x") { calls.send += 1 }
        #expect(outcome == .misconfigured(dialog: VoiceGestureText.misconfigured))
        #expect(calls.send == 0)
        // Le littéral inverse sur iPhone diverge lui aussi de la table.
        #expect(!VoiceGesturePolicy.admits(.alwaysAllowed, for: [.promptHostedSession], on: .ios))
        #expect(!VoiceGesturePolicy.admits(.requiresLocalDeviceAuthentication, for: [.promptHostedSession], on: .mac))
    }

    // --- S-2 : le déroulé d'une dictée ------------------------------------------

    @Test(
        "siri-dictee-session-omp/AC-10 (noyau) : sans message, Siri le demande une fois ; une réponse vide n'envoie rien",
        arguments: emptyMessages, emptyAnswers
    )
    func emptyDictationSendsNothing(message: String?, answer: String) async throws {
        let calls = PromptCalls()
        let phrase = try await VoiceSessionPrompt.run(
            message: message,
            ready: { calls.ready += 1; return nil },
            ask: { calls.asks.append($0); return answer },
            deliver: { calls.delivered.append($0); return .sent(.promptHostedSession, target: $0) }
        )
        #expect(calls.asks == ["Quel message ?"])
        #expect(VoiceSpeechText.dictationPrompt == "Quel message ?")
        #expect(calls.delivered.isEmpty)
        #expect(phrase == "Aucun message n’a été envoyé.")
        #expect(VoiceSpeechText.dictationEmpty == phrase)
    }

    @Test("siri-dictee-session-omp/AC-10 (noyau) : une dictée qui échoue sans annulation vaut une réponse vide")
    func failedDictationSendsNothing() async throws {
        let calls = PromptCalls()
        let phrase = try await VoiceSessionPrompt.run(
            message: "  ",
            ready: { nil },
            ask: { calls.asks.append($0); throw AskFailed() },
            deliver: { calls.delivered.append($0); return .sent(.promptHostedSession, target: $0) }
        )
        #expect(calls.asks == ["Quel message ?"])
        #expect(calls.delivered.isEmpty)
        #expect(phrase == "Aucun message n’a été envoyé.")
    }

    @Test("siri-dictee-session-omp/AC-10 (noyau) : la réponse dictée part trimée")
    func dictatedAnswerIsTrimmed() async throws {
        let calls = PromptCalls()
        let phrase = try await VoiceSessionPrompt.run(
            message: nil,
            ready: { nil },
            ask: { calls.asks.append($0); return "  bonjour " },
            deliver: { calls.delivered.append($0); return .sent(.promptHostedSession, target: $0) }
        )
        #expect(calls.asks == ["Quel message ?"])
        #expect(calls.delivered == ["bonjour"])
        #expect(phrase == "Reçu.")
    }

    @Test("siri-dictee-session-omp/AC-11 (noyau) : un message fourni part sans être redemandé, et Siri dit « Reçu. »")
    func providedMessageIsDeliveredOnce() async throws {
        let calls = PromptCalls()
        let phrase = try await VoiceSessionPrompt.run(
            message: " x ",
            ready: { nil },
            ask: { calls.asks.append($0); return "autre" },
            deliver: { calls.delivered.append($0); return .sent(.promptHostedSession, target: "x") }
        )
        #expect(phrase == "Reçu.")
        #expect(calls.asks.isEmpty)
        #expect(calls.delivered == ["x"])
    }

    @Test("siri-dictee-session-omp : un appareil qui ne peut pas envoyer dit son motif, sans rien demander ni envoyer")
    func readyIssueStopsEverything() async throws {
        let calls = PromptCalls()
        let phrase = try await VoiceSessionPrompt.run(
            message: nil,
            ready: { calls.ready += 1; return .macUnreachable },
            ask: { calls.asks.append($0); return "bonjour" },
            deliver: { calls.delivered.append($0); return .sent(.promptHostedSession, target: $0) }
        )
        #expect(phrase == VoiceIssue.macUnreachable.phrase)
        #expect(calls.ready == 1)
        #expect(calls.asks.isEmpty)
        #expect(calls.delivered.isEmpty)
    }

    @Test("siri-dictee-session-omp : une annulation pendant la dictée ou l'envoi se propage, et rien n'est envoyé")
    func cancellationPropagates() async throws {
        let calls = PromptCalls()
        await #expect(throws: CancellationError.self) {
            _ = try await VoiceSessionPrompt.run(
                message: nil,
                ready: { nil },
                ask: { calls.asks.append($0); throw CancellationError() },
                deliver: { calls.delivered.append($0); return .sent(.promptHostedSession, target: $0) }
            )
        }
        #expect(calls.asks.count == 1)
        #expect(calls.delivered.isEmpty)

        await #expect(throws: CancellationError.self) {
            _ = try await VoiceSessionPrompt.run(
                message: "bonjour",
                ready: { nil },
                ask: { calls.asks.append($0); return "" },
                deliver: { _ in throw CancellationError() }
            )
        }
        #expect(calls.asks.count == 1)
    }
}
