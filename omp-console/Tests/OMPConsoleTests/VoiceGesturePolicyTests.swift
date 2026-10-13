// Preuves de la politique vocale (gestes-vocaux-sans-politique-de-confirma) : la
// table geste × plateforme, ses textes, la porte d'application et l'adaptateur
// App Intents. Les listes de gestes sont écrites À LA MAIN : dérivées du code de
// production, elles prouveraient la table par elle-même.

import AppIntents
import ConsoleCore
import Testing

private let riskyGestures: [VoiceGesture] = [.stopFeature, .validateSpecs, .acceptReview, .launchPipeline]
private let calmGestures: [VoiceGesture] = [
    .answerOption, .answerText, .answerProjectDialog, .answerHostedDialog,
    .answerAuditEscalation, .resume, .consult,
]

/// Le refus de l'utilisateur, tel qu'une fausse `confirm` le lève.
private struct Refused: Error {}
/// L'échec d'émission, tel qu'une fausse `send` le lève.
private struct SendFailed: Error, Equatable {}

/// Un compteur d'appels et le dernier texte reçu par une fausse `confirm`.
@MainActor
private final class Calls {
    var confirm = 0
    var send = 0
    var prompts: [String] = []
}

/// Un geste à risque dont le littéral ne demande pas le déverrouillage exigé par la table.
private struct StopWithoutUnlockProbe: VoiceGestureIntent {
    static let title: LocalizedStringResource = "Sonde arrêt sans déverrouillage"
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGesture: VoiceGesture = .stopFeature
    func perform() async throws -> some IntentResult { .result() }
}

/// Une consultation Mac dont le littéral exige un déverrouillage que la table ne demande pas.
private struct ConsultWithUnlockProbe: VoiceGestureIntent {
    static let title: LocalizedStringResource = "Sonde consultation avec déverrouillage"
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .consult
    func perform() async throws -> some IntentResult { .result() }
}

/// Une consultation Mac conforme à la table.
private struct ConsultProbe: VoiceGestureIntent {
    static let title: LocalizedStringResource = "Sonde consultation"
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGesture: VoiceGesture = .consult
    func perform() async throws -> some IntentResult { .result() }
}

@Suite("VoiceGesturePolicyTests")
@MainActor
struct VoiceGesturePolicyTests {
    // --- la table -------------------------------------------------------------

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-1 : les quatre gestes à risque exigent une confirmation, sur iPhone et sur Mac",
        arguments: riskyGestures, VoicePlatform.allCases
    )
    func riskyGestureNeedsConfirmation(gesture: VoiceGesture, platform: VoicePlatform) {
        #expect(VoiceGesturePolicy.rule(for: gesture, on: platform).needsConfirmation == true)
        #expect(VoiceGestureText.confirmation(for: gesture, target: "login-oauth") != nil)
    }

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-2 : aucun autre geste n'exige de confirmation, sur iPhone et sur Mac",
        arguments: calmGestures, VoicePlatform.allCases
    )
    func calmGestureNeedsNoConfirmation(gesture: VoiceGesture, platform: VoicePlatform) {
        #expect(VoiceGesturePolicy.rule(for: gesture, on: platform).needsConfirmation == false)
    }

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-3 : sur iPhone, tout geste exige le déverrouillage, consultations comprises",
        arguments: VoiceGesture.allCases
    )
    func everyIOSGestureNeedsUnlock(gesture: VoiceGesture) {
        #expect(VoiceGesturePolicy.rule(for: gesture, on: .ios).needsUnlock == true)
        #expect(VoiceGesturePolicy.authenticationPolicy(for: gesture, on: .ios) == .requiresLocalDeviceAuthentication)
    }

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-4 : sur Mac, seuls les quatre gestes à risque exigent le déverrouillage",
        arguments: VoiceGesture.allCases
    )
    func onlyRiskyMacGesturesNeedUnlock(gesture: VoiceGesture) {
        let risky = riskyGestures.contains(gesture)
        #expect(VoiceGesturePolicy.rule(for: gesture, on: .mac).needsUnlock == risky)
        #expect(
            VoiceGesturePolicy.authenticationPolicy(for: gesture, on: .mac)
                == (risky ? .requiresLocalDeviceAuthentication : .alwaysAllowed)
        )
    }

    @Test("gestes-vocaux-sans-politique-de-confirma/AC-4 : un intent Mac dont le littéral diverge de la table n'émet rien et se dit mal configuré")
    func macIntentWithDivergentPolicyIsMisconfigured() async throws {
        #expect(VoicePlatform.current == .mac)
        let calls = Calls()

        let stop = try await StopWithoutUnlockProbe().applyVoicePolicy(target: "login-oauth") { calls.send += 1 }
        #expect(stop == .misconfigured(dialog: VoiceGestureText.misconfigured))

        let consult = try await ConsultWithUnlockProbe().applyVoicePolicy(target: "") { calls.send += 1 }
        #expect(consult == .misconfigured(dialog: VoiceGestureText.misconfigured))

        #expect(calls.send == 0)
    }

    // --- la porte d'application -------------------------------------------------

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-5 : la confirmation d'arrêt énonce l'action et la feature nommée",
        arguments: VoicePlatform.allCases
    )
    func stopConfirmationNamesTheFeature(platform: VoicePlatform) async throws {
        let expected = "Arrêter la feature login-oauth\u{00A0}?"
        for target in ["login-oauth", "  login-oauth \n"] {
            let calls = Calls()
            let outcome = try await VoiceGesturePolicy.apply(
                .stopFeature, target: target, on: platform,
                confirm: { prompt in calls.confirm += 1; calls.prompts.append(prompt) },
                send: { calls.send += 1 }
            )
            #expect(outcome == .sent)
            #expect(calls.prompts == [expected])
            #expect(calls.prompts.first?.contains("login-oauth") == true)
        }
    }

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-6 : un refus, une absence de réponse ou une cible sans nom n'émettent rien et annoncent l'annulation",
        arguments: riskyGestures, VoicePlatform.allCases
    )
    func refusedOrUnansweredConfirmationSendsNothing(gesture: VoiceGesture, platform: VoicePlatform) async throws {
        let cancelled = VoiceGestureOutcome.cancelled(dialog: VoiceGestureText.cancelled)
        let failures: [any Error] = [Refused(), CancellationError()]
        for failure in failures {
            let calls = Calls()
            let outcome = try await VoiceGesturePolicy.apply(
                gesture, target: "login-oauth", on: platform,
                confirm: { _ in calls.confirm += 1; throw failure },
                send: { calls.send += 1 }
            )
            #expect(outcome == cancelled)
            #expect(calls.confirm == 1)
            #expect(calls.send == 0)
        }

        let calls = Calls()
        let blank = try await VoiceGesturePolicy.apply(
            gesture, target: "   ", on: platform,
            confirm: { _ in calls.confirm += 1 },
            send: { calls.send += 1 }
        )
        #expect(blank == cancelled)
        #expect(calls.confirm == 0)
        #expect(calls.send == 0)
    }

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-7 : une confirmation acceptée émet exactement une requête, dont l'échec se propage",
        arguments: riskyGestures, VoicePlatform.allCases
    )
    func confirmedGestureSendsExactlyOnce(gesture: VoiceGesture, platform: VoicePlatform) async throws {
        let calls = Calls()
        let outcome = try await VoiceGesturePolicy.apply(
            gesture, target: "login-oauth", on: platform,
            confirm: { _ in calls.confirm += 1 },
            send: { calls.send += 1 }
        )
        #expect(outcome == .sent)
        #expect(calls.confirm == 1)
        #expect(calls.send == 1)

        let failing = Calls()
        await #expect(throws: SendFailed()) {
            _ = try await VoiceGesturePolicy.apply(
                gesture, target: "login-oauth", on: platform,
                confirm: { _ in failing.confirm += 1 },
                send: { failing.send += 1; throw SendFailed() }
            )
        }
        #expect(failing.confirm == 1)
        #expect(failing.send == 1)
    }

    @Test(
        "gestes-vocaux-sans-politique-de-confirma/AC-8 : un geste sans confirmation émet sa requête sans rien demander, même sans cible",
        arguments: calmGestures, VoicePlatform.allCases
    )
    func calmGestureSendsWithoutConfirmation(gesture: VoiceGesture, platform: VoicePlatform) async throws {
        let calls = Calls()
        let outcome = try await VoiceGesturePolicy.apply(
            gesture, target: "", on: platform,
            confirm: { _ in calls.confirm += 1 },
            send: { calls.send += 1 }
        )
        #expect(outcome == .sent)
        #expect(calls.confirm == 0)
        #expect(calls.send == 1)
    }

    @Test("gestes-vocaux-sans-politique-de-confirma/AC-8 : un intent de consultation conforme émet sa requête par l'adaptateur, sans confirmation")
    func conformingConsultIntentSends() async throws {
        let calls = Calls()
        let outcome = try await ConsultProbe().applyVoicePolicy(target: "") { calls.send += 1 }
        #expect(outcome == .sent)
        #expect(calls.send == 1)
    }

    // --- aucun geste non classé ----------------------------------------------------

    @Test("gestes-vocaux-sans-politique-de-confirma/AC-10 : tout geste vocal est classé à risque ou calme")
    func everyGestureIsClassified() {
        let classified = Set(riskyGestures).union(calmGestures)
        for gesture in VoiceGesture.allCases where !classified.contains(gesture) {
            Issue.record("geste vocal non classé : \(gesture.rawValue)")
        }
    }

    @Test("gestes-vocaux-sans-politique-de-confirma/AC-11 : chaque couple geste × plateforme est prouvé une fois pour la confirmation et une fois pour le déverrouillage")
    func everyRuleIsProvedOnce() {
        #expect(Set(riskyGestures).isDisjoint(with: calmGestures))
        #expect(Set(riskyGestures).union(calmGestures) == Set(VoiceGesture.allCases))
        #expect(riskyGestures.count + calmGestures.count == VoiceGesture.allCases.count)
        #expect(VoicePlatform.allCases == [.ios, .mac])
    }
}
