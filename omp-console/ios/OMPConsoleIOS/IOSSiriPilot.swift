// La coque iOS du pilotage vocal des pipelines (siri-iphone-pilotage-pipelines,
// S-8) : le canal vers le Mac appairé, qui lit l'ardoise comme l'écran Pipelines,
// propose les dépôts de la feuille « Nouvelle feature » et livre chaque geste par
// UNE route existante de l'API distante, puis l'orchestration « appareil
// déverrouillé → client prêt → conversation ». La conversation, ses phrases et la
// politique de confirmation vivent dans `ConsoleCore` ; ce fichier ne cite pas la
// politique vocale (garde `gestes-vocaux-sans-politique-de-confirma/AC-9`) et
// n'écrit aucun mot (garde `design-ios/AC-5`) : les constantes de fil viennent de
// `IOSHomeText`.

import ConsoleClient
import ConsoleCore
import Foundation
import UIKit

/// Le canal de `VoicePilot.run` et `VoicePilot.launch` sur le client partagé.
@MainActor
struct IOSSiriPilotChannel: VoicePilotChannel {
    let client: ConsoleClientModel

    /// L'ardoise relue sur le Mac, dérivée comme celle de l'écran Pipelines.
    func cards() async throws -> [KanbanCard] {
        _ = try await client.store()
        return PipelinesModel.boardState(of: client, nowMs: Date().timeIntervalSince1970 * 1000)?.kanbanBoard?.cards ?? []
    }

    /// Les dépôts de la feuille « Nouvelle feature » (`NewFeatureSheetView.repos`).
    func launchRepos() async throws -> [String] {
        KanbanLaunchRepos.options(cards: try await cards(), projectRoot: nil)
    }

    /// UN appel client par livraison, donc UNE requête vers le Mac. Le lancement
    /// passe des modèles nuls, comme la feuille dont les deux sélecteurs restent
    /// sur le choix par défaut.
    func deliver(_ delivery: VoicePilotDelivery) async throws {
        switch delivery {
        case let .launch(repoRoot, title, need):
            _ = try await client.launch(
                repoRoot: repoRoot, title: title, description: need, modelReqSpecs: nil, modelImplReview: nil
            )
        case let .resume(cardId):
            _ = try await client.resume(cardId: cardId)
        case let .stop(cardId):
            _ = try await client.stop(cardId: cardId)
        case let .verdict(cardId, milestone):
            let verdict = milestone == .specs ? IOSHomeText.verdictSpecs : IOSHomeText.verdictReview
            _ = try await client.verdict(cardId: cardId, verdict: verdict)
        }
    }

    func issue(of error: Error) -> VoiceIssue {
        IOSSiriPending.issue(of: error)
    }
}

/// L'orchestration des intents de pilotage.
@MainActor
enum IOSSiriPilot {
    /// Un geste sur une feature existante : readiness partagée, puis la
    /// conversation ; une cause de connexion rend sa phrase sans rien envoyer.
    static func perform(
        _ gesture: VoicePilotGesture,
        client: ConsoleClientModel,
        conversation: some VoiceConversation,
        isProtectedDataAvailable: @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }
    ) async throws -> String {
        if let issue = await IOSSiriPending.readiness(client: client, isProtectedDataAvailable: isProtectedDataAvailable) {
            return issue.phrase
        }
        return try await VoicePilot.run(gesture, channel: IOSSiriPilotChannel(client: client), conversation: conversation)
    }

    /// Le lancement d'une feature : même ordre que `perform`.
    static func launch(
        client: ConsoleClientModel,
        conversation: some VoiceConversation,
        isProtectedDataAvailable: @MainActor () -> Bool = { UIApplication.shared.isProtectedDataAvailable }
    ) async throws -> String {
        if let issue = await IOSSiriPending.readiness(client: client, isProtectedDataAvailable: isProtectedDataAvailable) {
            return issue.phrase
        }
        return try await VoicePilot.launch(channel: IOSSiriPilotChannel(client: client), conversation: conversation)
    }
}
