/// Le vocabulaire d’Atlassian (Jira, Confluence) : la page du Poste (connexion du serveur,
/// plan du jour, savoir de la boîte) et les commentaires Jira proposés par l’agent dans
/// « À traiter ». Les noms propres (Atlassian, Jira, Confluence) restent tels quels.
public enum AtlassianText {
    public static let title = L10n.text("Atlassian")
    public static let pageSymbol = "link"

    // MARK: - Connexion

    public static let connectionTitle = L10n.text("Connexion")
    public static let connectionSymbol = "person.badge.key"
    public static let connected = L10n.text("Branché")
    public static let disconnected = L10n.text("Non branché")
    public static let state = L10n.text("État")
    public static let site = L10n.text("Site")
    public static let account = L10n.text("Compte")
    public static let connectedAt = L10n.text("Branché le")
    public static let expiresAt = L10n.text("Accès valable jusqu’au")
    public static func lastError(_ error: String) -> String { L10n.format("Dernière erreur : %@", error) }
    public static let connect = L10n.text("Connecter")
    public static let connectSymbol = "arrow.up.forward.app"
    public static let connectHint = L10n.text("Le lien s’ouvre dans le navigateur : choisissez le site de la boîte puis acceptez.")
    public static func pending(_ date: String) -> String { L10n.format("Lien en attente jusqu’au %@", date) }
    public static let callbackField = L10n.text("Adresse de retour")
    public static let callbackHint = L10n.text("Après l’accord, le navigateur ouvre une page introuvable : copiez son adresse ici.")
    public static let submit = L10n.text("Valider")
    public static let disconnect = L10n.text("Débrancher")
    public static let disconnectSymbol = "bolt.horizontal.circle"

    // MARK: - Plan du jour

    public static let planTitle = L10n.text("Plan du jour")
    public static let planSymbol = "calendar"
    public static let planEmpty = L10n.text("Pas encore de plan.")
    public static func planMade(_ date: String) -> String { L10n.format("Établi le %@", date) }
    public static func planHour(_ hour: Int) -> String { L10n.format("Plan automatique à %lld h", hour) }
    public static let planManual = L10n.text("Pas de plan automatique.")
    public static func next(_ action: String) -> String { L10n.format("Prochaine action : %@", action) }
    public static let openLink = L10n.text("Ouvrir")
    public static let openLinkSymbol = "arrow.up.right.square"
    public static let launch = L10n.text("Lancer une feature")
    public static let launchSymbol = "play.fill"
    public static let launched = L10n.text("Feature lancée.")
    public static let replan = L10n.text("Refaire le plan")
    public static let replanSymbol = "arrow.clockwise"
    public static let queued = L10n.text("Demandé : le poste s’en charge à son prochain tour.")

    // MARK: - Savoir de la boîte

    public static let knowledgeTitle = L10n.text("Savoir de la boîte")
    public static let knowledgeSymbol = "books.vertical"
    public static func knowledgeLast(_ date: String) -> String { L10n.format("Dernière passe le %@", date) }
    public static let knowledgeNever = L10n.text("Aucune passe pour l’instant.")
    public static let knowledgeRun = L10n.text("Lancer une passe")
    public static let knowledgeRunSymbol = "sparkles"
}
