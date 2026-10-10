// Les mots des crochets de RECETTE des feuilles de lancement (feuilles-ios-presentation-et-depots,
// S-7) : `-projet.recipe <lancement|dialogue>` sur l'écran Projet et
// `-sessionomp.recipe lancement` sur l'écran Session OMP. Des crochets de capture,
// pas des fonctionnalités ; `scripts/ios-feuilles-recette.sh` les emploie.

enum IOSLaunchRecipeText {
    /// Le drapeau de la recette de l'écran Projet.
    static let projectFlag = "-projet.recipe"
    /// Le drapeau de la recette de l'écran Session OMP.
    static let sessionOmpFlag = "-sessionomp.recipe"

    /// La feuille de lancement ouverte d'elle-même sur les dépôts de la fixture.
    static let launch = "lancement"
    /// La feuille « OMP vous demande » ouverte sur le dialogue de la fixture.
    static let dialog = "dialogue"

    /// Le dialogue de la fixture, dans la forme EXACTE du fil (`RpcDialogRequest`) :
    /// un choix entre deux branches, sans description, ni indication, ni texte prérempli.
    static let dialogJSON = """
        {"id":"recette-dialogue","method":"select","title":"Quelle base pour la feature ?",\
        "message":"OMP prépare la feature export-csv.","options":["main","feat/memoire-ios"],\
        "optionDescriptions":[null,null],"placeholder":null,"prefill":null,"promptStyle":false}
        """
}
