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
    /// La fiche d'une carte qui n'est pas (ou plus) dans l'instantané reçu du
    /// Mac : on ne peut rien affirmer d'elle, donc on le dit. L'écran, lui, dit
    /// l'état de connexion par `IOSConnectionStateView`.
    static let sheetNoCard = "Aucune donnée reçue du Mac pour l'instant."

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

    /// Le chevron du sélecteur de dépôt (un menu : il se déroule, il ne navigue pas).
    static let repoMenuSymbol = "chevron.up.chevron.down"

    // MARK: - Recette `-pipelines.recipe` (crochet de capture, pas une fonctionnalité)

    /// Le drapeau partagé par les deux recettes de l'écran : la feuille « Nouvelle
    /// feature » (`vide`, `choisi`, `rempli`) et la fiche d'une carte (`fiche`,
    /// `actions`, `arret`). Chaque recette ignore les valeurs de l'autre.
    static let recipeFlag = "-pipelines.recipe"

    // La feuille « Nouvelle feature » (ios-nouvelle-feature-formulaire).

    /// Les dépôts forcés par la recette (triés) : deux homonymes et un nom unique.
    static let recipeRepos = [
        "/Users/demo/Archives/mem0-omp",
        "/Users/demo/Projets/mem0-omp",
        "/Users/demo/Projets/site-vitrine",
    ]
    /// La racine choisie par les recettes `choisi` et `rempli` (un des `recipeRepos`).
    static let recipeChosenRepo = "/Users/demo/Projets/mem0-omp"
    static let recipeFeatureTitle = "export-csv"
    static let recipeShortNeed = "Exporter les souvenirs du projet au format CSV."
    /// Douze lignes « Ligne <n> du besoin. » : plus que les huit que la zone montre.
    static let recipeLongNeed = (1...12).map { "Ligne \($0) du besoin." }.joined(separator: "\n")

    // La fiche d'une carte (ios-fiche-carte-pipelines).

    static let recipeFiche = "fiche"
    static let recipeActions = "actions"
    static let recipeArret = "arret"

    /// Le signal de PRÊT, écrit sur la sortie d'erreur quand l'état forcé est atteint.
    /// `scripts/ios-shots.sh` et `scripts/ios-fiche-carte-recette.sh` le lisent (miroir
    /// littéral dans les scripts) au lieu d'attendre un délai fixe.
    static let recipeReady = "pipelines-recipe-ready"

    /// L'ancre de défilement de la liste des gestes (états `actions` et `arret`).
    static let recipeActionsAnchor = "pipelines.card.sheet.actions"

    /// Le titre de la carte de fixture : 77 caractères, donc plus d'une ligne sur iPhone.
    static let recipeTitle = "Corriger la fiche d'une carte Pipelines : titre complet sur plusieurs lignes"

    /// Les deux modèles de la carte de fixture : l'un connu du catalogue de recette
    /// (nom lisible attendu), l'autre inconnu (sélecteur brut attendu).
    static let recipeModelKnown = "anthropic/claude-opus-5-5"
    static let recipeModelUnknown = "lm-studio/qwen3-coder-30b"
    static let recipeModelKnownName = "Claude Opus 5.5"
}

/// Les identifiants d'accessibilité de l'écran, chaînes pointées préfixées
/// `pipelines.` — la même convention que `ConnectionAccessibility`.
enum PipelinesAccessibility {
    static let screen = "pipelines.screen"
    static let newFeature = "pipelines.newFeature"
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

    // Un identifiant PAR élément de la fiche : un identifiant posé sur un
    // conteneur sans `.contain` est porté par tous ses descendants.
    static let sheetInfo = "pipelines.card.sheet.info"
    static let sheetRepo = "pipelines.card.sheet.repo"
    static let sheetPhase = "pipelines.card.sheet.phase"
    static let sheetDuration = "pipelines.card.sheet.duration"
    static let sheetModelReqSpecs = "pipelines.card.sheet.model.reqSpecs"
    static let sheetModelImplReview = "pipelines.card.sheet.model.implReview"
    static let sheetPR = "pipelines.card.sheet.pr"
    static let sheetMotif = "pipelines.card.sheet.motif"
    static let sheetEmpty = "pipelines.card.sheet.empty"
    static let sheetQuestionTitle = "pipelines.card.sheet.question.title"
    static let sheetQuestion = "pipelines.card.sheet.question"
    static let sheetPrompt = "pipelines.card.sheet.prompt"
    static let sheetClose = "pipelines.card.sheet.close"

    static let repoField = "pipelines.newFeature.repo"
    static let reqSpecsField = "pipelines.newFeature.modelReqSpecs"
    static let implReviewField = "pipelines.newFeature.modelImplReview"
    static let titleField = "pipelines.newFeature.title"
    static let needField = "pipelines.newFeature.need"
    static let launchButton = "pipelines.newFeature.launch"
    static let cancelButton = "pipelines.newFeature.cancel"
    static let modelRetry = "pipelines.newFeature.modelRetry"
}
