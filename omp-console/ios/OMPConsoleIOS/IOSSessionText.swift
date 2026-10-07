// Le vocabulaire PROPRE aux sessions de l'app iOS (S-1..S-10) : les mots qui
// n'existent pas dans la coque macOS, les identifiants d'accessibilité, et les
// valeurs du crochet de recette `-sessions.recipe`.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise un littéral alphabétique que dans ces fichiers-là — donc TOUT mot
// de cette feature et TOUT identifiant d'accessibilité (préfixe `ios.`) vivent
// ici, jamais dans une vue. Les mots DURABLES que les deux coques affichent
// (`ConversationText`, `SessionDiffText`, `SessionSelectorText`, `ToolVerb`,
// `PhaseText`, `ConsoleFormat`) ne sont PAS recopiés : ils viennent du noyau.
//
// Le reste du vocabulaire de la feature (`ToolVerb.title(_:)`,
// `ConversationText.thinking/live/backToLive/…`, `SessionDiffText.toneLabel(_:)`)
// est partagé : l'app le lit, elle ne le réinvente pas.

import ConsoleCore

enum IOSSessionText {
    // MARK: - L'écran de la liste (S-1)

    /// L'app n'est pas connectée au Mac et n'a jamais reçu d'instantané : on ne
    /// peut PAS affirmer que le magasin est vide.
    static let noConnection = "Pas de connexion au Mac"
    /// Connectée, l'instantané du magasin n'est pas encore arrivé.
    static let loading = "Chargement des sessions…"
    /// Le choix « aucun projet » du filtre (S-2).
    static let allProjects = "Tous les projets"

    // MARK: - Le fil (S-3, S-6)

    /// Le titre de la section des arguments d'un appel d'outil.
    static let arguments = "Arguments"
    /// Le titre de la section du résultat d'un appel d'outil.
    static let result = "Résultat"
    /// L'étiquette d'une question `ask` (S-7).
    static let question = "Question"

    /// Le libellé d'accessibilité d'une ligne de la liste : le titre de la
    /// feature et l'état de son run (S-1).
    static func rowLabel(_ title: String, _ status: String) -> String { "\(title) — \(status)" }

    /// Le titre d'un appel d'outil : le verbe, puis sa cible quand elle existe.
    static func toolTitle(_ verb: String, _ target: String) -> String {
        target.isEmpty ? verb : "\(verb) · \(target)"
    }

    /// Le titre d'un résultat SANS appel : le verbe, puis la mention partagée
    /// `ConversationText.withoutCall`.
    static func resultTitle(_ verb: String) -> String { "\(verb) \(ConversationText.withoutCall)" }

    /// Le nom d'un outil que son résultat ne nomme pas.
    static let unknownTool = "outil"

    /// Le chemin d'un fichier de session, depuis son dossier et son identifiant.
    static func sessionFile(_ directory: String, _ id: String) -> String { "\(directory)/\(id).jsonl" }

    /// Le statut d'un appel d'outil, dit pour l'accessibilité (le symbole ne
    /// porte pas le sens seul).
    static func toolStatusLabel(_ result: ToolResultRow?) -> String {
        guard let result else { return statusPending }
        return result.isError ? statusError : statusDone
    }

    private static let statusPending = "en cours"
    private static let statusError = "erreur"
    private static let statusDone = "terminé"

    /// La clé de pli de la RÉFLEXION d'une ligne, distincte de celle de la ligne :
    /// replier la réflexion ne touche pas la ligne du message (S-6).
    static func thinkingKey(_ rowId: String) -> String { "\(rowId).thinking" }

    // MARK: - Symboles SF (jamais en dur dans une vue)

    static func chevron(_ open: Bool) -> String { open ? "chevron.down" : "chevron.right" }
    static let waitingSymbol = "hourglass"
    static let emptySymbol = "bubble.left"
    static let errorSymbol = "xmark.circle.fill"
    static let doneSymbol = "checkmark.circle.fill"

    // MARK: - La recette `-sessions.recipe` (BR-7)

    /// Le drapeau de lancement.
    static let recipeFlag = "-sessions.recipe"
    /// Les valeurs reconnues, dans l'ordre du contrat.
    static let recipeListe = "liste"
    static let recipeVide = "vide"
    static let recipeVisionneuse = "visionneuse"
    static let recipeIllisible = "illisible"
    static let recipeEnDirect = "en-direct"
    /// Le motif « fichier illisible » de la recette : le même que celui que la
    /// suite macOS épingle sur un fichier aux droits retirés.
    static let unreadableReason = "ouverture en lecture refusée"
}

/// Les identifiants d'accessibilité de la feature (chaînes pointées préfixées
/// `ios.`), dans le même fichier de vocabulaire : le test les éprouve sans
/// rendre de SwiftUI, et aucune vue n'écrit d'identifiant en dur.
enum IOSSessionsAccessibility {
    // --- L'écran de la liste (S-1, S-2) ---------------------------------------

    static let screen = "ios.sessions.screen"
    static let filter = "ios.sessions.filter"
    static let list = "ios.sessions.list"
    static let loading = "ios.sessions.loading"
    static let empty = "ios.sessions.empty"
    static let noConnection = "ios.sessions.noConnection"

    static func day(_ id: String) -> String { "ios.sessions.day.\(id)" }
    static func row(_ id: String) -> String { "ios.sessions.row.\(id)" }

    // --- La visionneuse et le fil (S-3..S-9) ----------------------------------

    static let viewer = "ios.session.viewer"
    static let close = "ios.session.close"
    static let thread = "ios.session.thread"
    static let threadEnd = "ios.session.thread.end"
    static let threadStatus = "ios.session.thread.status"
    static let placeholder = "ios.session.placeholder"
    static let unreadable = "ios.session.unreadable"
    static let errorBanner = "ios.session.error"
    static let notes = "ios.session.notes"
    static let backToLive = "ios.session.backToLive"

    static func user(_ rowId: String) -> String { "ios.session.user.\(rowId)" }
    static func assistant(_ rowId: String) -> String { "ios.session.assistant.\(rowId)" }
    static func thinking(_ rowId: String) -> String { "ios.session.thinking.\(rowId)" }
    static func toolCall(_ rowId: String) -> String { "ios.session.toolcall.\(rowId)" }
    static func toolCallBody(_ rowId: String) -> String { "ios.session.toolcall.\(rowId).body" }
    static func toolResult(_ rowId: String) -> String { "ios.session.toolresult.\(rowId)" }
    static func marker(_ rowId: String) -> String { "ios.session.marker.\(rowId)" }
    static func markerBody(_ rowId: String) -> String { "ios.session.marker.\(rowId).body" }
    static func diff(_ rowId: String, _ index: Int) -> String { "ios.session.diff.\(rowId).\(index)" }

    /// Les identifiants du bloc `ask` (S-7), tels que S-7 les nomme.
    static func ask(_ rowId: String) -> String { "ios.session.ask.\(rowId)" }
    static func askQuestion(_ rowId: String, _ index: Int) -> String { "ios.session.ask.\(rowId).question.\(index)" }
    static func askOption(_ rowId: String, _ question: Int, _ option: Int) -> String {
        "ios.session.ask.\(rowId).option.\(question).\(option)"
    }
}
