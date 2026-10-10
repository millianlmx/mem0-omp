// Les gestes de carte de l'Accueil iOS (feature accueil-iphone-rangees-ecrasees-et-geste,
// S-3, S-4, S-5) : « Valider les specs », « Accepter la revue » et « Reprendre ».
//
// Le modèle porte trois faits, et rien d'autre :
// - les clés en vol : un geste envoyé reste désactivé jusqu'à la réponse du Mac,
//   et un second toucher pendant ce temps n'envoie rien ;
// - les échecs, un message par clé, affiché sur la carte du geste ;
// - la carte dont la confirmation de « Valider les specs » est ouverte (seul geste
//   confirmé, il lance l'implémentation sur le Mac).
// Aucun état de succès : la carte suit l'ardoise transportée par le client.
//
// L'envoi est une closure injectée, comme `IOSStatsModel.Load` : les tests ne
// construisent jamais de client, la production passe `live(_:)`.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// Un geste de carte de l'Accueil.
enum IOSHomeGesture: Hashable, Sendable {
    case validateSpecs
    case acceptReview
    case resume
}

/// Un geste sur une carte : deux cartes ont des clés indépendantes.
struct IOSHomeGestureKey: Hashable, Sendable {
    let cardId: String
    let gesture: IOSHomeGesture
}

@MainActor
final class IOSHomeGestureModel: ObservableObject {
    /// L'envoi d'un geste au Mac ; il lève l'erreur du client en cas d'échec.
    typealias Send = @MainActor (IOSHomeGestureKey) async throws -> Void

    @Published private(set) var inFlight: Set<IOSHomeGestureKey> = []
    @Published private(set) var failures: [IOSHomeGestureKey: String] = [:]
    /// L'identifiant de la carte dont la confirmation des specs est ouverte.
    @Published private(set) var specsConfirmation: String?

    /// Un toucher sur un bouton de geste : rien si la clé est en vol ; la
    /// confirmation pour « Valider les specs » ; l'envoi sinon.
    func tap(_ key: IOSHomeGestureKey, send: @escaping Send) {
        guard !inFlight.contains(key) else { return }
        if key.gesture == .validateSpecs {
            specsConfirmation = key.cardId
            return
        }
        start(key, send: send)
    }

    /// « Valider » dans la confirmation : l'id de carte arrive par capture, jamais
    /// lu dans `specsConfirmation`, que le système peut avoir déjà effacé.
    func confirmSpecs(cardId: String, send: @escaping Send) {
        specsConfirmation = nil
        start(IOSHomeGestureKey(cardId: cardId, gesture: .validateSpecs), send: send)
    }

    /// La confirmation est fermée sans valider : rien ne part.
    func cancelSpecs() {
        specsConfirmation = nil
    }

    /// Ne garde que les échecs et la confirmation des gestes encore offerts par le
    /// tableau de bord (`IOSHomeContent.offeredGestures`).
    func retain(_ offered: Set<IOSHomeGestureKey>) {
        let kept = failures.filter { offered.contains($0.key) }
        if kept.count != failures.count { failures = kept }
        if let cardId = specsConfirmation,
           !offered.contains(IOSHomeGestureKey(cardId: cardId, gesture: .validateSpecs)) {
            specsConfirmation = nil
        }
    }

    /// L'envoi d'une clé : la clé passe en vol AVANT tout `await`, donc un second
    /// toucher dans le même tour de boucle la voit déjà ; elle en sort à la
    /// réponse, succès comme échec.
    private func start(_ key: IOSHomeGestureKey, send: @escaping Send) {
        guard !inFlight.contains(key) else { return }
        inFlight.insert(key)
        failures[key] = nil
        Task { @MainActor in
            do {
                try await send(key)
            } catch {
                if let message = IOSHomeContent.gestureFailure(key.gesture, error: error) {
                    failures[key] = message
                }
            }
            inFlight.remove(key)
        }
    }

    /// L'envoi de production : les routes de verdict et de reprise du client
    /// partagé. L'accusé `202` est ignoré : la carte change par l'ardoise.
    static func live(_ client: ConsoleClientModel) -> Send {
        { key in
            switch key.gesture {
            case .validateSpecs:
                _ = try await client.verdict(cardId: key.cardId, verdict: IOSHomeText.verdictSpecs)
            case .acceptReview:
                _ = try await client.verdict(cardId: key.cardId, verdict: IOSHomeText.verdictReview)
            case .resume:
                _ = try await client.resume(cardId: key.cardId)
            }
        }
    }
}
