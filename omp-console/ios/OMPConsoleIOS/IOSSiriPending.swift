// La coque iOS des intents Siri qui parlent au Mac appairé : le canal de la
// conversation des attentes (siri-iphone-questions-en-attente, S-6), qui lit la
// liste des attentes et livre chaque réponse par UNE route existante de l'API
// distante, la dictée vers la session OMP (siri-dictee-session-omp, S-5), et ce
// qu'ils partagent : « appareil déverrouillé → client prêt » et la traduction
// d'un échec du client en issue. Les déroulés, leurs phrases et la politique de
// confirmation vivent dans `ConsoleCore` ; ce fichier ne cite pas la politique
// vocale (garde `gestes-vocaux-sans-politique-de-confirma/AC-9`) et n'écrit aucun
// mot (garde `design-ios/AC-5`) : les constantes de fil viennent de `IOSHomeText`
// et de `ProjectDialogKind`.

import ConsoleClient
import ConsoleCore
import UIKit

/// Le canal de `VoicePendingWalk.run` sur le client partagé.
@MainActor
struct IOSSiriPendingChannel: VoicePendingChannel {
    let client: ConsoleClientModel

    func pending() async throws -> [PendingRequest] {
        try await client.pendingRequests()
    }

    /// UN appel client par livraison, donc UNE requête vers le Mac.
    func deliver(_ delivery: VoiceDelivery) async throws {
        switch delivery {
        case let .cardOption(cardId, toolCallId, label):
            _ = try await client.answer(cardId: cardId, kind: IOSHomeText.kindSelected, label: label, text: nil, toolCallId: toolCallId)
        case let .cardCustom(cardId, toolCallId, text):
            _ = try await client.answer(cardId: cardId, kind: IOSHomeText.kindCustom, label: nil, text: text, toolCallId: toolCallId)
        case let .cardReply(cardId, text):
            _ = try await client.reply(cardId: cardId, text: text)
        case let .cardVerdict(cardId, milestone):
            let verdict = milestone == .specs ? IOSHomeText.verdictSpecs : IOSHomeText.verdictReview
            _ = try await client.verdict(cardId: cardId, verdict: verdict)
        case let .conduiteValue(dialogId, value):
            _ = try await client.answerProjectDialog(id: dialogId, kind: ProjectDialogKind.value, value: value, confirmed: nil)
        case let .conduiteConfirmed(dialogId, confirmed):
            _ = try await client.answerProjectDialog(id: dialogId, kind: ProjectDialogKind.confirmed, value: nil, confirmed: confirmed)
        case let .sessionValue(dialogId, value):
            _ = try await client.answerHostedDialog(id: dialogId, kind: ProjectDialogKind.value, value: value, confirmed: nil)
        case let .sessionConfirmed(dialogId, confirmed):
            _ = try await client.answerHostedDialog(id: dialogId, kind: ProjectDialogKind.confirmed, value: nil, confirmed: confirmed)
        case let .auditAnswer(auditId, slug, key, answer):
            _ = try await client.answerAuditEscalation(id: auditId, slug: slug, key: key, answer: answer, decision: nil)
        case let .auditDecision(auditId, slug, key, decision):
            _ = try await client.answerAuditEscalation(id: auditId, slug: slug, key: key, answer: nil, decision: decision)
        }
    }

    /// L'issue d'un échec : `nil` pour le refus « question périmée » d'une
    /// livraison (409/404, `IOSAnswerFlow.isStale`), « option invalide » pour un
    /// 400 sur une option de carte, sinon la traduction commune.
    func issue(of error: Error, delivery: VoiceDelivery?) -> VoiceIssue? {
        if delivery != nil, IOSAnswerFlow.isStale(error) { return nil }
        let cause: Error = (error as? PendingRequestsUnavailable)?.cause ?? error
        if case .api(.badRequest) = cause as? ClientError, case .cardOption = delivery { return .invalidOption }
        return IOSSiriPending.issue(of: cause)
    }
}

/// L'orchestration des intents Siri qui parlent au Mac appairé.
@MainActor
enum IOSSiriPending {
    /// Appareil verrouillé → `deviceLocked` sans toucher au client (le jeton, au
    /// trousseau en `WhenUnlocked`, serait lu comme absent). Sinon, attente bornée
    /// « prêt à émettre » : `nil` si le client est prêt, la cause de connexion sinon.
    static func readiness(
        client: ConsoleClientModel,
        isProtectedDataAvailable: @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }
    ) async -> VoiceIssue? {
        guard isProtectedDataAvailable() else { return .deviceLocked }
        switch await client.waitUntilReady() {
        case .ready:
            return nil
        case .notPaired, .pairingRefused:
            return .notPaired
        case .macUnreachable:
            return .macUnreachable
        case let .incompatibleVersion(local, remote):
            return .incompatibleVersion(local: local, remote: remote)
        }
    }

    /// L'issue d'un échec du client, indépendante de ce qui était livré.
    static func issue(of error: Error) -> VoiceIssue {
        guard let cause = error as? ClientError else { return .macRefused(motive: "") }
        switch cause {
        case .notConnected, .transport:
            return .macUnreachable
        case let .incompatibleProtocol(local, remote):
            return .incompatibleVersion(local: local, remote: remote)
        case .api(.incompatibleProtocol):
            return .incompatibleVersion(local: ConsoleAPI.protocolVersion, remote: nil)
        case .api(.unauthorized):
            return .notPaired
        case let .api(error):
            return .macRefused(motive: error.message ?? "")
        case .decoding, .unexpectedStatus:
            return .macRefused(motive: "")
        }
    }
    /// La conversation des attentes sur le client partagé.
    static func walk(client: ConsoleClientModel, conversation: some VoiceConversation) async throws -> String {
        try await VoicePendingWalk.run(channel: IOSSiriPendingChannel(client: client), conversation: conversation)
    }

    /// L'appareil et le client d'abord (`readiness`), puis la conversation ; une
    /// cause de connexion rend sa phrase sans rien envoyer.
    static func answer(
        client: ConsoleClientModel,
        conversation: some VoiceConversation,
        isProtectedDataAvailable: @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }
    ) async throws -> String {
        if let issue = await readiness(client: client, isProtectedDataAvailable: isProtectedDataAvailable) {
            return issue.phrase
        }
        return try await walk(client: client, conversation: conversation)
    }

    /// La dictée vers la session OMP hébergée (`VoiceSessionPrompt`) : l'appareil
    /// et le client d'abord, puis le message demandé au besoin, puis UN envoi par
    /// `client.prompt`. `deliver` reçoit le message trimé et cet envoi, et rend
    /// son issue ; une annulation est relancée, tout autre échec est traduit par
    /// `issue(of:)`.
    static func dictate(
        client: ConsoleClientModel,
        message: String?,
        ask: @MainActor (String) async throws -> String,
        deliver: @MainActor (String, @MainActor () async throws -> Void) async throws -> VoiceIssue,
        isProtectedDataAvailable: @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }
    ) async throws -> String {
        try await VoiceSessionPrompt.run(
            message: message,
            ready: { await readiness(client: client, isProtectedDataAvailable: isProtectedDataAvailable) },
            ask: ask,
            deliver: { text in
                do {
                    return try await deliver(text) { _ = try await client.prompt(message: text) }
                } catch let cancellation as CancellationError {
                    throw cancellation
                } catch {
                    return issue(of: error)
                }
            }
        )
    }
}
