// Le vocabulaire de l'écran « Projet » de l'app iOS (BR-4, BR-5) : les mots
// propres à cette coque, et les identifiants d'accessibilité de l'écran.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`), comme `IOSText.swift` et
// `ConnectionText.swift` : la garde `design-ios/AC-5` n'autorise un littéral
// alphabétique que dans ces fichiers-là — toute vue de l'écran ne lit que des
// constantes d'ici ou du noyau partagé `ConsoleCore`.
//
// Patron `ConnectionAccessibility` : les identifiants sont réunis dans un second
// enum, chaînes pointées préfixées `ios.projet.`. Un identifiant composé depuis un
// indice ou un slug reste toléré par la garde parce qu'il commence par `ios.`.

import ConsoleClient

/// Les mots propres à l'écran Projet (BR-4) — le reste vient de `ConsoleCore`.
enum ProjectText {
    /// Le contrôle explicite de relecture des statuts de PR (S-3), symbole SF
    /// `arrow.clockwise`.
    static let refresh = "Relire les statuts"
    /// La marque du choix courant dans le dialogue « OMP vous demande ».
    static let selectedMark = "✓"

    /// Le message d'un échec de route : le message servi par l'API quand il existe,
    /// sinon le mot de `ConnectionText` pour l'état courant (S-7).
    static func failure(_ error: Error, state: ClientState) -> String {
        if let clientError = error as? ClientError, case .api(let api) = clientError, let message = api.message {
            return message
        }
        return ConnectionText.state(state)
    }
}

/// Le vocabulaire du champ `state` de la conduite (`RemoteConduiteStatePayload`) :
/// les valeurs de fil sont des littéraux alphabétiques, donc elles vivent ici.
enum ProjectConduiteState: String {
    case none
    case starting
    case live
    case closing
    case closed

    /// Un geste de démarrage concurrent doit être refusé (S-10).
    var isLive: Bool { self == .live || self == .starting || self == .closing }
}

/// Le vocabulaire du champ `state` d'un document servi (`RemoteDocument`).
enum ProjectDocumentWire {
    static let text = "text"
    static let missing = "missing"
}

/// Les valeurs de `kind` du corps `RemoteDialogAnswerRequest` (S-4/S-5). Elles
/// vivent ici parce que ce sont des littéraux alphabétiques : la garde
/// `design-ios/AC-5` les refuserait dans `IOSDialogGating.swift`.
enum ProjectDialogKind {
    static let value = "value"
    static let confirmed = "confirmed"
    static let cancelled = "cancelled"
}

/// Les identifiants d'accessibilité de l'écran (chaînes pointées de BR-4/BR-5).
enum ProjectAccessibility {
    static let screen = "ios.projet"
    static let header = "ios.projet.header"
    static let banner = "ios.projet.banner"
    static let emptyCard = "ios.projet.empty"
    static let picker = "ios.projet.picker"
    static let plan = "ios.projet.plan"
    static let document = "ios.projet.document"
    static let prPane = "ios.projet.pr"
    static let refresh = "ios.projet.refresh"
    static let start = "ios.projet.start"
    static let stop = "ios.projet.stop"
    static let launchSheet = "ios.projet.launch"
    static let launchList = "ios.projet.launch.repositories"
    static let launchName = "ios.projet.launch.name"
    static let launchCommit = "ios.projet.launch.commit"
    static let launchCancel = "ios.projet.launch.cancel"
    static let launchError = "ios.projet.launch.error"
    static let dialogSheet = "ios.projet.dialog"
    static let dialogQuestion = "ios.projet.dialog.question"
    static let dialogCounter = "ios.projet.dialog.counter"
    static let dialogBody = "ios.projet.dialog.body"
    static let dialogInput = "ios.projet.dialog.input"
    static let dialogAnswer = "ios.projet.dialog.answer"
    static let dialogCancel = "ios.projet.dialog.cancel"
    static let dialogConfirm = "ios.projet.dialog.confirm"
    static let dialogDecline = "ios.projet.dialog.decline"
    static let dialogError = "ios.projet.dialog.error"

    static func segment(_ index: Int) -> String { "ios.projet.segment.\(index)" }
    static func feature(_ slug: String) -> String { "ios.projet.feature.\(slug)" }
    static func removedFeature(_ slug: String) -> String { "ios.projet.removed.\(slug)" }
    static func prRow(_ index: Int) -> String { "ios.projet.pr.\(index)" }
    static func check(_ name: String) -> String { "ios.projet.check.\(name)" }
    static func option(_ index: Int) -> String { "ios.projet.dialog.option.\(index)" }
    static func launchRepo(_ repoKey: String) -> String { "ios.projet.launch.repo.\(repoKey)" }
}
