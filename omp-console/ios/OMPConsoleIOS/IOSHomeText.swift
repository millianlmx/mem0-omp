// Le vocabulaire PROPRE à l'Accueil de l'app iOS (S-3, périmètre borné) : les
// mots absents de la coque macOS — l'état déconnecté, « OMP absent sur le Mac »,
// l'action de connexion — vivent ICI, dans l'app, et n'entrent jamais dans le
// noyau partagé `ConsoleCore`.
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`) : la garde `design-ios/AC-5`
// n'autorise un littéral alphabétique hors de ces fichiers que s'il commence par
// `ios.` ou `-`. Les valeurs de FIL alphabétiques (états de document de l'API,
// kind d'une réponse, verdict d'un jalon) vivent aussi ici, jamais dans une vue.
//
// TOUTE table de symboles SF de l'Accueil vit ici : la vue ne porte aucune chaîne
// de symbole en dur.

import ConsoleCore

enum IOSHomeText {
    // --- état déconnecté (S-10) -----------------------------------------------

    static let disconnectedTitle = "Pas de connexion au Mac"
    static let disconnectedBody =
        "Connectez l'app au Mac pour voir ce qui vous attend, ce qui tourne et ce qui est livré."
    static let connect = "Se connecter"

    // --- liste racine ---------------------------------------------------------

    /// Le titre de navigation de la liste racine : grand titre sur iPhone, en
    /// ligne en haut de la barre latérale sur iPad, et libellé du bouton retour
    /// d'un écran poussé sur iPhone.
    static let rootTitle = "OMP Console"

    // --- rangée de la liste racine (lue par VoiceOver) -------------------------

    /// Le mot qui suit le nombre d'un badge visible dans le libellé d'une rangée.
    static let rowPending = "en attente"

    /// Le libellé d'accessibilité d'une rangée de section : le titre, suivi du
    /// badge QUAND il est visible (`badge > 0`). Même valeur que celle passée à
    /// `.badge(_:)`, donc le libellé annonce un badge si et seulement s'il se voit.
    static func sectionRowLabel(_ title: String, badge: Int) -> String {
        badge > 0 ? "\(title), \(badge) \(rowPending)" : title
    }

    // --- OMP absent sur le Mac (S-10, AC-16) ----------------------------------

    static let macMissingTitle = "OMP absent sur le Mac"
    static let macMissingBody =
        "Le Mac est joignable, mais OMP n'y est pas installé. Installez-le sur le Mac, puis rouvrez l'Accueil."

    // --- feuille Contrat (S-14) -----------------------------------------------

    static let contractNavigationTitle = "Contrat"
    static let contractLoading = "Chargement du contrat…"
    static let contractSectionEmpty = "Cette section est vide."

    /// Une section requise absente du contrat : le titre entre guillemets
    /// français, sans la syntaxe Markdown du texte partagé de macOS.
    static func contractSectionMissing(title: String) -> String {
        "La section « \(title) » est absente du contrat."
    }

    // --- échecs des gestes (S-9, S-13, S-14) ----------------------------------

    static let notConnected = "L'app n'est pas connectée au Mac."
    static let transportFailure = "Le Mac n'a pas répondu."
    static let decodingFailure = "La réponse du Mac est illisible."
    static let incompatibleProtocol = "La version d'API du Mac n'est pas la même que celle de l'app."

    // --- valeurs de fil de l'API (jamais dans une vue) ------------------------

    static let documentText = "text"
    static let documentMissing = "missing"
    /// Le nom du document de contrat servi par l'API (`RemoteDocument.name`).
    static let contractName = "contract.md"
    static let kindSelected = "selected"
    static let kindCustom = "custom"
    static let verdictSpecs = "specs"
    static let verdictReview = "review"

    // --- symboles SF de l'Accueil ---------------------------------------------

    /// La marque d'une option choisie dans la feuille « Répondre ».
    static let selectedSymbol = "checkmark"

    /// Le symbole d'une nature d'attente.
    static func natureSymbol(_ nature: HomeAttentionNature) -> String {
        switch nature {
        case .question: "questionmark.bubble.fill"
        case .milestoneSpecs: "doc.text.magnifyingglass"
        case .milestoneReview: "checkmark.seal.fill"
        }
    }

    // --- nom de feature (ios-finitions-titres-icones, S-7) --------------------

    /// Le nom d'une feature, prêt à se replier sur plusieurs lignes SANS jamais finir
    /// une ligne par un tiret. UAX #14 : la coupure est permise APRÈS U+002D (le
    /// trait d'union n'accepte pas de coupure avant lui), jamais après U+2011
    /// (classe GL, LB12), et toujours après U+200B (classe ZW, LB8). Chaque `-`
    /// devient donc `U+200B U+2011` : l'unique occasion de coupure tombe AVANT le
    /// tiret. Le glyphe de U+2011 est celui du tiret ordinaire ; VoiceOver lit le
    /// nom d'origine par `.accessibilityLabel`.
    static func featureName(_ name: String) -> String {
        name.replacingOccurrences(of: "-", with: "\u{200B}\u{2011}")
    }
}
