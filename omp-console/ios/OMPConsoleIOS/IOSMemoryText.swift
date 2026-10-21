// Le vocabulaire de l'écran Mémoire de l'app iOS : les quelques mots propres à
// cette coque, et ses identifiants d'accessibilité.
//
// Fichier de VOCABULAIRE (`*Text.swift`), comme `IOSText.swift` et
// `IOSConnectionStateText.swift` : la garde `design-ios/AC-5` n'autorise un littéral
// alphabétique que dans ces fichiers-là — toute vue de l'écran ne lit que des
// constantes d'ici ou du noyau partagé `ConsoleCore`.
//
// Les mots DURABLES (états, compte, résultats, troncature) viennent du noyau :
// l'app ne réinvente aucun libellé partagé. Ce qui reste ici, c'est ce qui est
// propre à l'iPhone : le choix du projet, la fiche, les recettes.

import ConsoleClient
import ConsoleCore

/// Les mots propres à l'écran Mémoire (BR-2) — le reste vient de `ConsoleCore`.
enum IOSMemoryText {
    /// L'état vide de l'app quand le serveur n'est pas joignable : on ne peut PAS
    /// affirmer que la mémoire est vide (on ne l'a pas lue), donc on le dit.
    static let noData = "Aucune donnée reçue du serveur pour l’instant."

    /// Aucun projet : la mémoire du serveur n'a encore aucun souvenir.
    static let noProjectDetail = "La mémoire du serveur n’a encore aucun souvenir."

    /// Le menu du projet lu (les portées de la mémoire, la plus récente en tête).
    static let projectMenu = "Choisir le projet"
    static let projectSymbol = "folder"

    /// Le pied de liste pendant la lecture de la page suivante (défilement continu).
    static let loadingMore = "Chargement des souvenirs suivants…"

    /// Le titre de la barre de la fiche d'un souvenir (feuilles-ios-presentation-et-depots, S-6).
    static let detailTitle = "Souvenir"
    /// Le bouton qui ferme la fiche.
    static let close = "Fermer"

    // MARK: - Le mode graphe (BR-4, BR-5, BR-6)

    /// Le graphe partiel : des lignes ont été retirées à l'une des deux bornes.
    static let graphPartial = "Graphe partiel : tous les souvenirs n’ont pas été servis."

    /// La route graphe est absente du serveur mémoire : la cause et le remède, sans
    /// adresse, sans JSON ni code HTTP.
    static let graphServiceOutdated =
        "Graphe indisponible : serveur mémoire trop ancien.\nMettez à jour le serveur, puis réessayez."

    /// Le titre du bloc de liens de la fiche.
    static let links = "Liens"

    /// Les natures d'un lien, en mots de l'app (le noyau n'en nomme aucune). Une
    /// proximité se dit par `proximityLabel(_:)`, jamais par son score.
    static let linkTag = "Étiquette"
    static let linkManual = "Manuel"

    /// Une proximité sémantique en clair, sans chiffre : ≥ 0,90 « Très proche »,
    /// ≥ 0,80 « Proche », sinon (dont un score absent, 0, ou NaN) « Assez proche ».
    static func proximityLabel(_ score: Double) -> String {
        if score >= 0.90 { return "Très proche" }
        if score >= 0.80 { return "Proche" }
        return "Assez proche"
    }

    /// Le libellé d'une ligne de lien : sa nature en clair, puis l'autre extrémité.
    static func linkLine(kind: MemoryGraphLinkKind, other: String, score: Double?) -> String {
        let name: String
        switch kind {
        case .semantic: name = proximityLabel(score ?? 0)
        case .tag: name = linkTag
        case .manual: name = linkManual
        }
        return name + " · " + other
    }

    // MARK: - Le graphe parcouru par VoiceOver (ios-statistiques-et-graphe-accessibles, S-5)

    /// Le titre d'un souvenir dont le texte est vide.
    static let untitledMemory = "Souvenir sans titre"

    /// L'élément d'un souvenir : son titre, puis son nombre de liens affichés.
    static func graphMemoryLabel(title: String, links: Int) -> String {
        guard links > 0 else { return title + ", aucun lien" }
        return title + ", " + ConsoleFormat.count(links, "lien", "liens")
    }

    /// L'élément d'un nœud-étiquette : `#étiquette`, sa nature, puis le nombre de
    /// souvenirs affichés qui la portent.
    static func graphTagLabel(tag: String, memories: Int) -> String {
        MemoryText.tagLabel(tag) + ", étiquette, " + ConsoleFormat.count(memories, "souvenir", "souvenirs")
    }

    /// « Affiche », jamais « Ouvre » : en tête de phrase, la garde anti-tutoiement
    /// lit « Ouvre » comme un impératif tutoyé (décision du 2026-10-11).
    static let graphMemoryHint = "Affiche la fiche du souvenir."
    static let graphTagHint = "Affiche seulement les souvenirs de cette étiquette."
    static let graphShowAllHint = "Revient au graphe entier."

    /// Le libellé du contenu donné à la demande (rotor « Plus de contenu ») : les
    /// titres des extrémités liées à un souvenir.
    static let graphLinkedTitles = "Liés à"

    // MARK: - La recette `-memoire.recipe` (BR-7)

    /// Le drapeau du crochet de recette du mode graphe.
    static let graphRecipeFlag = "-memoire.recipe"
    static let graphRecipePlate = "graphe"
    static let graphRecipeZoom = "zoom"
    static let graphRecipeSheet = "fiche"
    /// La recette `liste` : la fiche du souvenir de la fixture ouverte depuis la LISTE
    /// (feuilles-ios-presentation-et-depots), le graphe restant masqué.
    static let graphRecipeList = "liste"

    /// Le souvenir de la fixture dont les recettes `fiche` et `liste` ouvrent la feuille.
    static let graphRecipeMemory = "m1"

    /// Le signal de PRÊT, écrit sur la sortie d'erreur quand l'état forcé de la recette
    /// est atteint. `scripts/recette/ios-shots.sh` le lit (miroir littéral dans le script) au lieu
    /// d'attendre un délai fixe.
    static let graphRecipeReady = "memoire-recipe-ready"

    /// La recette `clavier` (ipad-clavier-et-largeur-de-lecture, S-8) : la Mémoire en
    /// mode liste sur la fixture partagée, sans réseau ni fiche ouverte.
    static let keyboardRecipe = "clavier"

    /// Le signal de LECTURE de la recette `clavier`, écrit sur la sortie d'erreur à
    /// chaque lecture du sommaire : une recette compte ⌘R par lui.
    static let keyboardRecipeRead = "memoire-recipe-read"

    /// Les recettes de PANNE (ios-redaction-vouvoiement, S-2) : `injoignable` montre la
    /// liste face à un serveur injoignable, `service-ancien` le graphe face à un service
    /// mémoire trop ancien. Les deux modèles lisent `IOSMemoryFailureReader`.
    static let failureRecipeUnreachable = "injoignable"
    static let failureRecipeOutdated = "service-ancien"

    // MARK: - « Sommaire » et « Liste » : deux icônes distinctes

    /// Les symboles de la barre d'outils : « Sommaire » et « Liste » ne partagent
    /// plus la même icône. « Graphe » garde son symbole dans la vue.
    static let summarySymbol = "rectangle.stack"
    static let listSymbol = "list.bullet"
}

/// Les identifiants d'accessibilité de l'écran, chaînes pointées préfixées
/// `ios.memoire.` — la même convention que `ProjectAccessibility`.
enum IOSMemoryAccessibility {
    static let screen = "ios.memoire.screen"
    static let banner = "ios.memoire.banner"
    static let retry = "ios.memoire.retry"
    static let summary = "ios.memoire.summary"
    static let count = "ios.memoire.count"
    static let results = "ios.memoire.results"
    /// Le pied de liste : chargement de la page suivante, ou son échec.
    static let more = "ios.memoire.more"
    static let moreRetry = "ios.memoire.more.retry"
    static let detail = "ios.memoire.detail"
    static let close = "ios.memoire.close"
    static let project = "ios.memoire.projet"

    static func projectOption(_ scope: String) -> String { "ios.memoire.projet.\(scope)" }

    static func row(_ id: String) -> String { "ios.memoire.row.\(id)" }

    // MARK: - Le mode graphe (BR-4, BR-5, BR-6)

    static let graphToggle = "ios.memoire.graphe.bascule"
    static let graphCanvas = "ios.memoire.graphe.canevas"
    static let graphCount = "ios.memoire.graphe.compte"
    static let graphZoomIn = "ios.memoire.graphe.zoomIn"
    static let graphZoomOut = "ios.memoire.graphe.zoomOut"
    static let graphRecenter = "ios.memoire.graphe.recenter"
    static let graphTagMenu = "ios.memoire.graphe.etiquette"
    static let graphPartial = "ios.memoire.graphe.partiel"

    static func graphTagOption(_ tag: String) -> String { "ios.memoire.graphe.etiquette.\(tag)" }

    // MARK: - Les éléments VoiceOver du canevas (ios-statistiques-et-graphe-accessibles, S-5)

    /// Le retour à la vue entière, premier élément quand un filtre est posé.
    static let graphShowAll = "ios.memoire.graphe.tout"

    static func graphMemory(_ id: String) -> String { "ios.memoire.graphe.souvenir.\(id)" }
}
