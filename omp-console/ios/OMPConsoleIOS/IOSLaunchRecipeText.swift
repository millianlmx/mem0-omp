// Les mots des crochets de RECETTE de l'écran Projet et de ses feuilles
// (feuilles-ios-presentation-et-depots, S-7 ; ios-listes-groupees-natives, S-6) :
// `-projet.recipe <lancement|dialogue|saisie|plan>` sur l'écran Projet et
// `-sessionomp.recipe lancement` sur l'écran Session OMP. Des crochets de capture,
// pas des fonctionnalités ; `scripts/ios-feuilles-recette.sh` les emploie.

import Foundation

enum IOSLaunchRecipeText {
    /// Le drapeau de la recette de l'écran Projet.
    static let projectFlag = "-projet.recipe"
    /// Le drapeau de la recette de l'écran Session OMP.
    static let sessionOmpFlag = "-sessionomp.recipe"

    /// La feuille de lancement ouverte d'elle-même sur les dépôts de la fixture.
    static let launch = "lancement"
    /// La feuille « OMP vous demande » ouverte sur le dialogue de la fixture.
    static let dialog = "dialogue"
    /// La feuille « OMP vous demande » ouverte sur le dialogue de saisie libre de la fixture.
    static let editorDialog = "saisie"
    /// L'écran Projet vif sur le plan de six étapes de la fixture, plus haut qu'un écran.
    static let projectPlan = "plan"

    // MARK: - La fixture de `-projet.recipe plan`

    /// Le dépôt conduit : la clé vaut la racine, comme pour les dépôts de lancement.
    static let planRepoKey = "/Users/recette/depots/plan-recette"
    static let planRepoRoot = planRepoKey
    /// La clé de relais, absolue comme le dépôt l'exige.
    static let planRelayKey = "/Users/recette/.omp/relais/plan-recette"
    /// Le nom de la conduite, affiché dans l'en-tête de l'écran.
    static let planName = "plan-recette"
    static let planPurpose = "Recette de l’écran Projet sur un plan plus haut qu’un écran."
    static let planFunction = "Mesurer le défilement du plan."

    /// Le nom d'une étape du plan, numérotée à partir de 1.
    static func planSegmentName(_ segment: Int) -> String {
        "Étape \(segment + 1)"
    }

    /// Le slug d'une feature, numérotée à partir de 1 dans son étape.
    static func planSlug(segment: Int, feature: Int) -> String {
        "etape-\(segment + 1)-feature-\(feature + 1)"
    }

    /// L'intention d'une feature.
    static func planIntention(segment: Int, feature: Int) -> String {
        "Intention de la feature \(feature + 1) de l’étape \(segment + 1)."
    }

    /// L'adresse de la PR numéro `number`, composée sans littéral d'URL complet.
    static func planPRURL(_ number: Int) -> String {
        var components = URLComponents()
        components.scheme = "https"
        components.host = "example.com"
        components.path = "/pr/\(number)"
        return components.string ?? ""
    }

    /// Le dialogue de la fixture, dans la forme EXACTE du fil (`RpcDialogRequest`) :
    /// un choix entre deux branches, sans description, ni indication, ni texte prérempli.
    static let dialogJSON = """
        {"id":"recette-dialogue","method":"select","title":"Quelle base pour la feature ?",\
        "message":"OMP prépare la feature export-csv.","options":["main","feat/memoire-ios"],\
        "optionDescriptions":[null,null],"placeholder":null,"prefill":null,"promptStyle":false}
        """

    /// Le dialogue de saisie libre de la fixture, dans la forme EXACTE du fil
    /// (`RpcDialogRequest`) : un éditeur sans option, ni indication, ni texte prérempli.
    static let editorDialogJSON = """
        {"id":"recette-saisie","method":"editor","title":"Que doit dire la note de version ?",\
        "message":"OMP prépare la feature export-csv.","options":[],"optionDescriptions":[],\
        "placeholder":null,"prefill":null,"promptStyle":false}
        """
}
