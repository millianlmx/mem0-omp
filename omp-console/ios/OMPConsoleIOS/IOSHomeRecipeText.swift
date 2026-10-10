// La fixture de la recette `-home.recipe contractLong` (feature
// contrat-ios-markdown-brut, S-4) : un nom de feature plus large qu'un iPhone et
// un contrat LONG, riche en Markdown (sous-titres, listes, liste numérotée, code
// en ligne, bloc de code), pour prouver le rendu de la feuille Contrat sans réseau
// ni appairage.
//
// Ce n'est pas une fonctionnalité : `IOSHomeRecipe.contractLong` réécrit le seul
// identifiant de la carte de la recette `contract` et sert ce texte comme charge
// utile. Le fichier est un `*Text.swift` : ses littéraux sont autorisés par la
// garde de vocabulaire de l'app.
//
// `scripts/ios-contrat-recette.sh` sonde QUATRE chaînes de ce fichier, recopiées
// en dur dans le script : `longSlug`, le sous-titre « S-1 — Rendu des sections
// par blocs », l'élément de liste « Chaque bloc du corps est un élément
// d'accessibilité distinct. » et le paragraphe qui cite
// `IOSHomeContent.contractBlocks(_:)`. Les changer ici impose de les changer là.
//
// Contraintes du texte (S-4) : paragraphes et éléments de liste de 400 caractères
// au plus ; ni astérisque ni tiret bas hors du code ; aucun accent grave ni double
// dièse dans le code ; aucune ligne de code qui commence par un tiret suivi d'une
// espace.

enum IOSHomeRecipeText {
    /// Le nom de la feature de la recette : 56 caractères, plus large que l'écran
    /// d'un iPhone en titre.
    static let longSlug = "chaines-ui-mac-et-ios-alignees-sur-les-conventions-apple"

    /// Le contrat de la recette : `Besoins` et `Critères d'acceptation` courtes,
    /// puis `Spécifications` (plus de 6 000 caractères) et `Lots` (plus de 1 500).
    static let longContract = """
        # Contrat de recette (contractLong)

        ## Besoins
        B-1 : Lire chaque section du contrat comme un document mis en forme, sur iPhone comme sur iPad.
        B-2 : Voir un seul titre par section et le nom complet de la feature, même quand il est long.

        ## Critères d'acceptation
        AC-1 (B-1) : Given un contrat long, When la feuille s'ouvre, Then les titres, les listes et le code en ligne sont mis en forme.
        AC-2 (B-2) : Given une feature au nom long, When la feuille s'ouvre, Then le nom se lit en entier dans la feuille.

        ## Spécifications

        ### S-1 — Rendu des sections par blocs
        La feuille Contrat de l'app iOS montre les sections que le jalon demande de valider. Chaque section arrive du Mac sous forme de texte Markdown, découpée par les fonctions partagées du socle, avec les mêmes bornes que sur macOS. Sur iPhone et sur iPad, ce texte doit se lire comme un document, et non comme une source.

        La fonction `IOSHomeContent.contractBlocks(_:)` retire la ligne de titre de la section.

        Le reste du texte passe ensuite par le parseur partagé `MarkdownDocument.blocks(_:)`, qui rend une liste ordonnée de blocs : paragraphes, titres de niveau trois, listes à puces, listes numérotées, citations et blocs de code. La vue `IOSMarkdownView` les affiche tels quels, comme elle le fait déjà pour les documents du projet et pour les réponses.

        - Chaque bloc du corps est un élément d'accessibilité distinct.
        - Un paragraphe long passe à la ligne autant que nécessaire, sans borne de lignes ni points de suspension.
        - Une liste à puces montre des puces dessinées par la vue, jamais le tiret de la source.
          - Un élément imbriqué garde son retrait sous l'élément qui le porte.
        - Le code en ligne, comme `ContractDocument.section(in:title:)`, paraît en chasse fixe et sans accents graves.
        - Les sous-titres de niveau trois restent des titres, plus discrets que l'en-tête de la section.

        Le découpage est calculé une seule fois, au moment où le contenu arrive, et non à chaque nouvelle évaluation de la vue. Un contrat de plusieurs milliers de lignes reste fluide : la feuille garde un seul défilement vertical, et chaque bloc n'occupe que la hauteur de son propre texte.

        Le parseur peut échouer sur une source malformée. Dans ce cas, il rend un seul paragraphe brut ; la ligne de titre ayant déjà été retirée avant l'analyse, le titre de la section n'apparaît jamais deux fois, même dans ce cas de repli.

        ### S-2 — Messages d'état sans syntaxe brute
        Une section peut manquer au contrat, ou ne contenir que des lignes vides. La feuille le dit alors avec une phrase ordinaire, sans reprendre la syntaxe de la source. Le nom de la section est cité entre guillemets français, et le message reste discret, en couleur secondaire.

        1. Une section absente affiche une phrase qui nomme la section entre guillemets.
        2. Une section vide affiche une phrase courte qui dit qu'elle est vide.
        3. Un fichier de contrat absent cite son chemin en chasse fixe, comme `.omp/pipeline/contract.md`.
        4. Un échec réseau garde son bandeau rouge et son texte habituel.

        Le chargement garde son indicateur d'activité et sa phrase d'attente. Aucun de ces messages ne montre de dièse, de tiret de liste ni d'accent grave : ce sont des phrases destinées à une personne, pas des fragments de source recopiés tels quels.

        > Une citation du contrat reste une citation : elle est rendue en retrait, avec la barre verticale de la vue, et son texte passe à la ligne comme un paragraphe.

        Les messages vivent dans le vocabulaire de l'app iOS, à côté des autres mots de l'Accueil. Les identifiants d'accessibilité restent stables, pour que les recettes automatiques retrouvent la feuille, son corps et son bouton de fermeture sans dépendre du texte affiché.

        ### S-3 — Titre de barre et nom de la feature
        La barre de navigation de la feuille porte un titre court, en mode en ligne, à la hauteur standard d'une barre. Le nom de la feature, souvent long et fait de mots reliés par des tirets, ne tient pas dans cette barre : il passe en tête du panneau, en grand, et peut occuper plusieurs lignes.

        - Le nom complet de la feature est le premier élément du panneau, au-dessus du sous-titre.
        - Il passe à la ligne aux tirets, puis au caractère si un seul mot dépasse la largeur.
        - Il est annoncé comme un en-tête par VoiceOver et figure dans le rotor des en-têtes.
        - Il reste affiché dans tous les états de la feuille, chargement et échec compris.
        - Il ne porte jamais de points de suspension, à toute taille de texte.

        La hiérarchie typographique va du plus grand au plus petit : le nom de la feature, puis l'en-tête de chaque section, puis les sous-titres de niveau trois du corps. Les tailles suivent le texte dynamique du système, sans aucune taille fixe, et les couleurs suivent les modes clair et sombre.

        Le bouton de fermeture garde sa place dans la barre, comme action de confirmation. Il répond au doigt, au pointeur sur iPad et au clavier matériel ; le balayage vers le bas ferme aussi la feuille, comme toute feuille du système.

        ### S-4 — Exemple de découpage
        L'exemple ci-dessous montre la forme du découpage. Il ne fait que rappeler l'idée : la ligne de titre est retirée en texte, avant le parseur, puis le reste est confié au socle partagé.

        ```swift
        static func contractBlocks(_ section: ContractSection) -> [MarkdownBlock]? {
            guard let text = section.text else { return nil }
            guard let newline = text.firstIndex(of: "\\n") else { return [] }
            let rest = String(text[text.index(after: newline)...])
            if rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return []
            }
            return MarkdownDocument.blocks(rest)
        }
        ```

        Ce bloc de code est rendu sur un fond discret, en chasse fixe, et défile horizontalement si une ligne dépasse la largeur de l'écran. Ses lignes ne sont jamais coupées, pour que le code reste lisible tel qu'il a été écrit.

        Une section qui cite la chaîne de son propre titre au milieu d'un paragraphe ne crée pas de nouvelle section : seule une ligne entière qui commence par le marqueur de section en ouvre une. Quand une section figure deux fois dans le contrat, c'est la dernière qui est montrée.

        Le rendu ne modifie jamais le fichier du contrat. La feuille lit le texte que le Mac lui transmet à l'ouverture, le découpe en mémoire et l'affiche ; fermer puis rouvrir la feuille relit le contrat, si bien qu'une section réécrite entre-temps par un maillon de la pipeline apparaît telle qu'elle est devenue.

        L'app Mac garde son propre rendu, inchangé : elle montre la ligne de titre comme un titre du document, sous l'en-tête de sa feuille. Les deux coques partagent le découpage en sections et le parseur, mais chacune choisit comment présenter le corps qu'elle reçoit.

        ## Lots

        ### BR-1 — Fixture et recette de preuve
        Le premier lot prépare les preuves sans toucher au rendu : une fixture longue, une recette de lancement et un script de relevé.

        - La recette `contractLong` ouvre la feuille Contrat sur la carte de la fixture, sans réseau.
        - Le nom de la feature est remplacé par un nom long, plus large que l'écran d'un iPhone.
        - Le script `scripts/ios-contrat-recette.sh` crée ses propres simulateurs et n'en partage aucun.
        - Chaque page de la feuille est capturée, avec l'arbre d'accessibilité qui l'accompagne.
        - Le rapport écrit une ligne par critère, pour chaque appareil, dans `rapport.txt`.

        ### BR-2 — Rendu de la feuille
        Le deuxième lot change le rendu de la feuille Contrat de l'app iOS, et seulement elle.

        - Le corps de chaque section passe par `IOSMarkdownView`, bloc par bloc.
        - La ligne de titre est retirée par `IOSHomeContent.contractBlocks(_:)` avant le parseur.
        - La barre prend le titre court `Contrat`, en mode en ligne.
        - Le nom complet de la feature s'affiche en tête du panneau, sans borne de lignes.

        ### BR-3 — Tests et recette finale
        Le troisième lot écrit les tests qui portent les critères, relance le script en mode `apres`, et vérifie que la compilation macOS reste verte avec les seuls outils en ligne de commande.

        - Les tests Swift lisent la fixture et vérifient le découpage en blocs.
        - La garde Node plante une faute dans une copie jetable du dépôt.
        - Les captures avant et après sont citées dans la revue.
        - La compilation macOS et les tests partagés du contrat restent verts, sans aucun fichier du socle modifié.
        """
}
