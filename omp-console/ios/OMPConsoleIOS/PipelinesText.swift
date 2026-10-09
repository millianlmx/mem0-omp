// Le vocabulaire de l'écran Pipelines de la coque iOS : les quelques messages
// TRANSITOIRES et les identifiants d'accessibilité propres à l'app. Les mots
// DURABLES (état d'une carte, gestes, feuille « Nouvelle feature ») viennent de
// `ConsoleCore` (`KanbanText`, `NewFeatureText`) — l'app ne réinvente aucun
// libellé partagé (règle `coque-ios`/`design-ios`).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : la garde `design-ios/AC-5` autorise
// les littéraux alphabétiques ici, et seulement ici, dans l'app.

import ConsoleClient
import ConsoleCore

enum PipelinesText {
    /// L'état vide de l'app quand le Mac n'est pas joignable et qu'aucun
    /// instantané n'est jamais arrivé : on ne peut PAS affirmer que le magasin est
    /// vide (on ne l'a pas lu), donc on le dit.
    static let noSnapshot = "Aucune donnée reçue du Mac pour l'instant."

    /// Le compte d'une voie, en texte (l'interpolation vit ici, dans le fichier de
    /// vocabulaire, pas dans la vue).
    static func laneCount(_ count: Int) -> String { "\(count)" }

    /// La valeur d'accessibilité de l'en-tête d'une voie terminale : SwiftUI
    /// n'expose pas l'état replié/déplié d'un bouton, il passe par la valeur.
    static let laneFolded = "replié"
    static let laneUnfolded = "déplié"

    /// La fusion ne trouve aucune ligne de PR pour ce slug : la PR est ouverte,
    /// mais le Mac ne la suit pas.
    static let noPullRequestRow = "La PR est ouverte, mais le Mac ne la suit pas encore."

    /// L'app n'est pas connectée au Mac : aucun geste n'est émis.
    static let notConnected = "L'app n'est pas connectée au Mac."

    /// Le Mac n'a pas répondu.
    static let transportError = "Le Mac n'a pas répondu."

    /// Le message d'une erreur de geste : le texte du serveur tel quel, jamais
    /// recomposé ; un échec de transport n'invente pas de cause.
    static func gestureError(_ error: Error) -> String {
        guard let client = error as? ClientError else { return transportError }
        switch client {
        case .notConnected:
            return notConnected
        case .incompatibleProtocol(let local, let remote):
            return ConnectionText.incompatibleProtocol(local: local, remote: remote)
        case .api(let api):
            return api.message ?? transportError
        case .transport:
            return transportError
        case .decoding(let detail):
            return detail
        }
    }

    // MARK: - Identifiants de feuille

    static func cardSheetId(_ cardId: String) -> String { "pipelines.card.sheet.\(cardId)" }
    static let newFeatureSheetId = "pipelines.newFeature.sheet"
}

/// Les identifiants d'accessibilité de l'écran, chaînes pointées préfixées
/// `pipelines.` — la même convention que `ConnectionAccessibility`.
enum PipelinesAccessibility {
    static let screen = "pipelines.screen"
    static let newFeature = "pipelines.newFeature"
    static let banner = "pipelines.banner"
    static let emptyCard = "pipelines.empty"

    static func lane(_ id: String) -> String { "pipelines.lane.\(id)" }
    static func laneHeader(_ id: String) -> String { "pipelines.lane.\(id).header" }
    static func card(_ id: String) -> String { "pipelines.card.\(id)" }
    static func gesture(_ name: String, _ id: String) -> String { "pipelines.card.\(id).\(name)" }
    static func option(_ index: Int) -> String { "pipelines.option.\(index)" }

    static let sheet = "pipelines.card.sheet"
    static let sheetTitle = "pipelines.card.sheet.title"
    static let answerField = "pipelines.card.sheet.answer"
    static let answerSend = "pipelines.card.sheet.send"
    static let error = "pipelines.card.sheet.error"

    static let repoField = "pipelines.newFeature.repo"
    static let reqSpecsField = "pipelines.newFeature.modelReqSpecs"
    static let implReviewField = "pipelines.newFeature.modelImplReview"
    static let titleField = "pipelines.newFeature.title"
    static let needField = "pipelines.newFeature.need"
    static let launchButton = "pipelines.newFeature.launch"
    static let cancelButton = "pipelines.newFeature.cancel"
    static let modelRetry = "pipelines.newFeature.modelRetry"
}
