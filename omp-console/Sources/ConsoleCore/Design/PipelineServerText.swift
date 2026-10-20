// Le vocabulaire du SERVEUR DE PIPELINES (omp-harness, sur le VPS), partagé par la
// coque Mac et l'app iOS : titres, états, gestes et messages d'échec. Les écrans
// n'écrivent aucune phrase eux-mêmes (règles `design-ios`, `typographie-et-glossaire-francais`).
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?, « » avec espaces insécables) et glossaire GLOSSAIRE.md.

public enum PipelineServerText {
    public static let title = "Serveur de pipelines"
    public static let open = "Serveur"
    public static let close = "Fermer"
    public static let refresh = "Actualiser"

    // MARK: - Configuration

    public static let setupTitle = "Relier le serveur"
    public static let setupExplanation =
        "Le serveur conduit les features de bout en bout sur le VPS. Saisissez l’adresse publiée par Tailscale et le jeton d’accès créé à son installation."
    public static let addressLabel = "Adresse du serveur"
    public static let addressPrompt = "vps.exemple.ts.net"
    public static let tokenLabel = "Jeton d’accès"
    public static let save = "Relier"
    public static let forget = "Oublier ce serveur"
    public static let forgetConfirm = "Oublier ce serveur ?"
    public static let forgetMessage = "L’adresse et le jeton d’accès sont effacés de cet appareil. Le serveur, lui, continue."
    /// Les symboles SF de l'état du flux et du choix d'une option.
    public static let liveSymbol = "dot.radiowaves.left.and.right"
    public static let offlineSymbol = "wifi.slash"
    public static let chosenSymbol = "checkmark.circle.fill"
    public static let optionSymbol = "circle"
    public static let live = "Mises à jour en direct"
    public static let offline = "Hors ligne : dernière boîte reçue"

    // MARK: - Sections

    public static let toDecide = "À trancher"
    public static let toDecideHint = "Des décisions irréversibles que les agents n’ont pas prises. La feature reprend quand toutes ont leur réponse."
    public static let toValidate = "À valider"
    public static let toValidateHint = "Revue terminée : le serveur attend votre accord pour fusionner."
    public static let toReview = "Décisions prises seules"
    public static let toReviewHint = "Chaque choix est un point de reprise. Le renverser fait reprendre la feature à cet endroit."
    public static let inProgress = "Features en cours"
    public static let nothingPending = "Rien n’attend votre décision."
    public static let nothingInProgress = "Aucune feature en cours."

    // MARK: - Gestes

    public static let answer = "Répondre"
    public static let answerPlaceholder = "Votre réponse"
    public static let approve = "Valider et fusionner"
    public static let refuse = "Refuser"
    public static let accept = "Accepter"
    public static let reverse = "Renverser…"
    public static let reverseTitle = "Renverser la décision"
    public static let reverseOption = "Choix retenu"
    public static let reasonLabel = "Raison"
    public static let reasonHint = "La raison rejoint la mémoire du projet : les agents ne rouvriront plus la question."
    public static let refuseTitle = "Refuser le verdict"
    public static let send = "Envoyer"
    public static let cancel = "Annuler"
    public static let stopFeature = "Arrêter la feature"
    public static let stopConfirm = "Arrêter cette feature ?"
    public static let stopMessage = "Le travail en cours s’arrête. La branche reste, pour inspection."

    // MARK: - Lignes

    /// « n° 3 · Séparateur CSV → virgule »
    public static func decisionLine(seq: Int, question: String, chosen: String) -> String {
        "n° \(seq) · \(question) → \(chosen)"
    }

    /// Le motif donné par l'agent.
    public static func rationale(_ text: String) -> String { "Motif : \(text)" }

    /// La proposition de l'agent, pour une escalade.
    public static func proposal(_ text: String) -> String { "Proposé par l’agent : \(text)" }

    public static func modules(_ list: [String]) -> String { "Modules : \(list.joined(separator: ", "))" }

    public static func fixes(_ count: Int) -> String { count == 1 ? "1 correction" : "\(count) corrections" }

    public static func pending(_ count: Int) -> String {
        count == 0 ? nothingPending : (count == 1 ? "1 décision attend" : "\(count) décisions attendent")
    }

    // MARK: - États

    public static func state(_ raw: String) -> String {
        switch raw {
        case "queued": "En file"
        case "running": "En cours"
        case "escalated": "Escaladée"
        case "awaiting_human": "À valider"
        case "merging": "Fusion en cours"
        case "merged": "Fusionnée"
        case "failed": "En échec"
        case "cancelled": "Arrêtée"
        default: "État inconnu"
        }
    }

    /// Les étapes, sous leur nom de commande (la correspondance avec les valeurs du
    /// serveur vit dans ConsoleClient, `HarnessRun.stepLabel`).
    public static let stepReq = "/req"
    public static let stepSpecs = "/specs"
    public static let stepImpl = "/impl"
    public static let stepReview = "/review"
    public static let stepFix = "Correction"

    public static func category(_ raw: String) -> String {
        switch raw {
        case "schema": "Schéma de données"
        case "public_api": "Protocole public"
        case "deletion": "Suppression"
        default: "Décision"
        }
    }

    public static func risk(_ raw: String) -> String {
        switch raw {
        case "low": "Risque faible"
        case "medium": "Risque moyen"
        case "high": "Risque élevé"
        default: "Risque inconnu"
        }
    }

    public static let weakVerdict = "Verdict faible : lisez les différences, pas seulement le verdict."
    public static let blockers = "Bloquants"
    public static let risks = "Risques"
    public static let unverified = "Non vérifié"

    // MARK: - Échecs (cause, puis remède)

    public static let invalidAddress = "Cette adresse n’est pas valide. Saisissez le nom du serveur publié par Tailscale."
    public static let unauthorized = "Le serveur refuse ce jeton d’accès. Copiez-le de nouveau depuis le serveur."
    public static let unreachable = "Le serveur de pipelines ne répond pas. Vérifiez qu’il tourne et que Tailscale est connecté."
    public static let timedOut = "Le serveur de pipelines met trop de temps à répondre. Réessayez dans un instant."
    public static let unreadable = "La réponse du serveur est illisible pour cette version de l’app. Mettez l’app à jour."

    /// Un geste refusé par le serveur, avec son motif quand il en donne un.
    public static func rejected(_ motive: String) -> String {
        motive.isEmpty ? "Le serveur a refusé ce geste." : "Le serveur a refusé ce geste : \(motive)"
    }
}
