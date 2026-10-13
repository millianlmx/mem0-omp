// La coque iOS de la conversation des attentes (siri-iphone-questions-en-attente,
// S-6) : le canal vers le Mac appairé, qui lit la liste des attentes et livre
// chaque réponse par UNE route existante de l'API distante, et l'orchestration
// « appareil déverrouillé → client prêt → conversation ». La conversation, ses
// phrases et la politique de confirmation vivent dans `ConsoleCore` ; ce fichier
// ne cite pas la politique vocale (garde `gestes-vocaux-sans-politique-de-confirma/AC-9`)
// et n'écrit aucun mot (garde `design-ios/AC-5`) : les constantes de fil viennent
// de `IOSHomeText` et de `ProjectDialogKind`.

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
    /// livraison (409/404, `IOSAnswerFlow.isStale`), une cause sinon.
    func issue(of error: Error, delivery: VoiceDelivery?) -> VoiceIssue? {
        if delivery != nil, IOSAnswerFlow.isStale(error) { return nil }
        guard let cause = (error as? PendingRequestsUnavailable)?.cause ?? (error as? ClientError) else {
            return .macRefused(motive: "")
        }
        switch cause {
        case .notConnected, .transport:
            return .macUnreachable
        case let .incompatibleProtocol(local, remote):
            return .incompatibleVersion(local: local, remote: remote)
        case .api(.incompatibleProtocol):
            return .incompatibleVersion(local: ConsoleAPI.protocolVersion, remote: nil)
        case .api(.unauthorized):
            return .notPaired
        case .api(.badRequest):
            if case .cardOption = delivery { return .invalidOption }
            return .macRefused(motive: cause.apiMessage)
        case .api:
            return .macRefused(motive: cause.apiMessage)
        case .decoding, .unexpectedStatus:
            return .macRefused(motive: "")
        }
    }
}

private extension ClientError {
    /// Le motif lisible d'un refus de l'API, vide s'il n'en porte pas.
    var apiMessage: String {
        guard case let .api(error) = self else { return "" }
        return error.message ?? ""
    }
}

/// L'orchestration de l'intent « demandes en attente ».
@MainActor
enum IOSSiriPending {
    /// La conversation des attentes sur le client partagé.
    static func walk(client: ConsoleClientModel, conversation: some VoiceConversation) async throws -> String {
        try await VoicePendingWalk.run(channel: IOSSiriPendingChannel(client: client), conversation: conversation)
    }

    /// Appareil verrouillé → phrase `deviceLocked` sans toucher au client (le
    /// jeton, au trousseau en `WhenUnlocked`, serait lu comme absent). Sinon,
    /// attente bornée « prêt à émettre », puis la conversation ; une cause de
    /// connexion rend sa phrase sans rien envoyer.
    static func answer(
        client: ConsoleClientModel,
        conversation: some VoiceConversation,
        isProtectedDataAvailable: @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }
    ) async throws -> String {
        guard isProtectedDataAvailable() else { return VoiceIssue.deviceLocked.phrase }
        let issue: VoiceIssue
        switch await client.waitUntilReady() {
        case .ready:
            return try await walk(client: client, conversation: conversation)
        case .notPaired, .pairingRefused:
            issue = .notPaired
        case .macUnreachable:
            issue = .macUnreachable
        case let .incompatibleVersion(local, remote):
            issue = .incompatibleVersion(local: local, remote: remote)
        }
        return issue.phrase
    }
}
