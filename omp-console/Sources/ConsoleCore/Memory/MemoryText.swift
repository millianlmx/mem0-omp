// Tous les textes de la section « Mémoire », en UN endroit.
//
// Un message à un seul endroit, c'est ce qui permet à un test de le figer sans
// rendre une vue, et à la vue de ne jamais composer une phrase : chaque état de la
// section a son texte, et il n'existe qu'ici.

import Foundation

public enum MemoryText {
    // Barre d'outils
    public static let searchPrompt = "Rechercher dans la mémoire"
    public static let summaryButton = "Sommaire"
    public static let summaryHelp = "Revenir au sommaire de la mémoire"
    public static let refresh = "Rafraîchir"
    public static let refreshHelp = "Recharger la mémoire du projet (⌘R)"

    // États
    public static let noProjectTitle = "Aucun projet ouvert"
    public static let noProjectDescription = "Choisissez un projet dans la section « Session OMP » (⌘4)."
    public static let unavailableTitle = "Mémoire indisponible"
    public static let unavailableDescription = "Le service de mémoire ne répond pas. Vérifiez qu'il est démarré, puis réessayez."
    public static let retry = "Réessayer"
    public static let loading = "Chargement de la mémoire du projet…"
    public static let emptySummaryTitle = "Aucun souvenir"
    public static let noResultTitle = "Aucun résultat"
    public static let noMatch = "La mémoire du projet ne contient aucun souvenir correspondant."
    public static let belowThreshold = "Aucun souvenir n'est assez proche de cette recherche."
    public static let searchUnsupportedTitle = "Recherche impossible"
    public static let noSemanticScore = "Ce service de mémoire ne sait pas classer les souvenirs par pertinence."
    public static let nothingSelected = "Sélectionnez un souvenir pour le lire."
    public static let emptyRow = "Souvenir vide."

    // Erreurs (S-6.4) : détail secondaire de l'indisponibilité, jamais un titre.
    public static let tokenRefused = "jeton refusé (401)"
    public static let unreadableResponse = "réponse illisible"

    // MARK: - État « pas la pile d'OMP Console » (S-2, S-4, S-5, BR-9)

    // Quelqu'un répond à l'adresse du service SANS porter le jeton d'installation
    // de l'app : la section Mémoire le NOMME au lieu de rendre un état disponible.
    public static let foreignTitle = "Ce n'est pas la pile d'OMP Console"
    public static let foreignDescription = "Cette adresse répond, mais elle est tenue par un autre service : la mémoire du projet n'est pas celle d'OMP Console tant que sa pile n'occupe pas le port."
    /// Le libellé du bouton de reprise (S-6), partagé avec la feuille de
    /// préparation (`SetupText.takeover`) : une seule action, un seul mot.
    public static let takeover = "Arrêter l'ancienne pile et reprendre"
    /// Le message d'erreur du client quand `/health` répond sans notre jeton (S-4) :
    /// il alimente le détail de l'état « indisponible ».
    public static let foreignService = "Ce service n'est pas la pile d'OMP Console : son jeton d'installation est absent ou différent."

    // MARK: - Prérequis système (S-6, all-in-one-app/AC-6)

    // oMLX est un prérequis SYSTÈME (embeddings de la recherche) : l'app ne
    // l'installe ni ne le configure, elle le NOMME quand il manque. Une phrase, un
    // état — le bandeau de la section n'en compose aucune.

    /// oMLX ne répond pas à la sonde : l'URL est celle RÉELLEMENT sondée
    /// (`StackConfig.omlxProbeURL`), pour que le diagnostic soit exploitable.
    public static func omlxUnreachable(url: String) -> String {
        "oMLX est injoignable (\(url)) — la mémoire a besoin de ses embeddings pour chercher."
    }

    /// oMLX répond 401/403 : le jeton configuré est refusé, la recherche ne peut pas
    /// obtenir ses embeddings (S-6).
    public static let omlxUnauthorized = "oMLX a refusé le jeton configuré (401) — vérifiez OMLX_API_TOKEN."

    /// L'adresse du service et la DERNIÈRE erreur (S-6.3), en détail secondaire de
    /// « Mémoire indisponible » : une ligne chacune, pour qu'aucune ne disparaisse.
    public static func unavailableDetail(address: String, error: String) -> String {
        error.isEmpty ? address : "\(address)\n\(error)"
    }

    /// « 1 souvenir », « 829 souvenirs » : un vrai pluriel.
    public static func summaryCount(_ n: Int) -> String {
        ConsoleFormat.count(n, "souvenir", "souvenirs")
    }

    public static func emptySummary(_ scope: String) -> String {
        "Aucun souvenir dans la mémoire du projet « \(scope) »."
    }

    /// Le rappel de la requête au-dessus d'une liste de résultats de recherche.
    public static func searchResults(_ query: String) -> String {
        "Résultats pour « \(query) »"
    }

    public static func unexpectedStatus(code: Int, detail: String) -> String {
        "réponse \(code) du service (\(detail))"
    }

    // MARK: - Mode graphe (S-1, S-2, S-5, S-6, S-7)

    // La bascule nomme le mode à ATTEINDRE : en liste elle dit « Graphe », en
    // graphe elle dit « Liste ».
    public static let graphButton = "Graphe"
    public static let graphHelp = "Afficher les souvenirs de tous les projets en graphe"
    public static let listButton = "Liste"
    public static let listHelp = "Revenir à la liste du projet courant"

    public static let graphLoading = "Chargement du graphe des souvenirs…"
    public static let emptyGraphDescription = "La mémoire du service ne contient aucun souvenir."
    public static let graphNoMatch = "Aucun souvenir du service ne correspond à cette recherche."

    public static let projectMenu = "Projet"
    public static let allProjects = "Tous les projets"
    public static let tagMenu = "Étiquette"
    public static let allTags = "Toutes les étiquettes"
    /// La portée d'une ligne sans `agent_id` : elle reste affichée, jamais perdue.
    public static let noProjectScope = "Sans projet"

    public static let zoomIn = "Agrandir"
    public static let zoomInHelp = "Agrandir (⌘+)"
    public static let zoomOut = "Réduire"
    public static let zoomOutHelp = "Réduire (⌘−)"
    public static let recenter = "Recentrer"
    public static let recenterHelp = "Recadrer le graphe sur l'écran (⌘0)"

    public static let createMemory = "Nouveau souvenir"
    public static let createMemoryHelp = "Écrire un souvenir dans un projet"

    /// Le libellé d'un nœud-étiquette, réutilisé par `tagList` (une seule formule
    /// pour `#étiquette`).
    public static func tagLabel(_ tag: String) -> String {
        "#\(tag)"
    }

    /// Le bandeau de compte du graphe : « 1 892 souvenirs · 17 projets · 2 liens
    /// manuels » — chaque segment absent est omis.
    public static func graphCount(memories: Int, projects: Int, links: Int) -> String {
        var segments = [ConsoleFormat.count(memories, "souvenir", "souvenirs")]
        if projects > 0 {
            segments.append(ConsoleFormat.count(projects, "projet", "projets"))
        }
        if links > 0 {
            segments.append(ConsoleFormat.count(links, "lien manuel", "liens manuels"))
        }
        return segments.joined(separator: separator)
    }

    /// La portée affichée d'une ligne : son `agent_id`, ou « Sans projet ».
    public static func scopeLabel(_ scope: String?) -> String {
        guard let scope, !scope.isEmpty else { return noProjectScope }
        return scope
    }

    // MARK: - Écriture depuis le graphe (S-8, S-9, S-10, S-11)

    public static let edit = "Modifier…"
    public static let editHelp = "Corriger le texte et les étiquettes de ce souvenir"
    public static let editTitle = "Modifier le souvenir"
    public static let delete = "Supprimer…"
    public static let deleteHelp = "Supprimer ce souvenir de la mémoire"
    public static let deleteConfirmTitle = "Supprimer ce souvenir ?"
    public static let deleteConfirmMessage = "Le souvenir disparaît de la mémoire du service ; ses liens manuels sont supprimés."
    public static let deleteConfirm = "Supprimer"
    public static let cancel = "Annuler"
    public static let save = "Enregistrer"

    public static let createTitle = "Nouveau souvenir"
    public static let textLabel = "Texte"
    public static let tagsLabel = "Étiquettes"
    public static let tagsPlaceholder = "séparées par des virgules"
    public static let textPlaceholder = "Écrire un souvenir…"
    public static let noKnownProject = "Aucun projet connu — la mémoire est vide."

    public static let manualLinks = "Liens manuels"
    public static let linkTo = "Relier à…"
    public static let linkTitle = "Relier à un souvenir"
    public static let linkFilter = "Filtrer par texte"
    public static let noCandidate = "Aucun souvenir à relier."
    public static let detach = "Détacher"
    public static let noManualLink = "Aucun lien manuel."
    public static let linkNotSaved = "Le lien n'a pas pu être enregistré sur le disque."
    public static let link = "Relier"

    // MARK: - Ligne de la liste et détail (omp-console-redesign S-18 R7)

    /// Le séparateur des segments de la ligne de contexte.
    public static let separator = " · "

    // Le détail : titre, ligne de contexte, texte rendu, puis les données
    // techniques repliées sous « Détails techniques ».
    public static let copy = "Copier"
    public static let copyHelp = "Copier le texte du souvenir"
    public static let technicalDetails = "Détails techniques"
    public static let identifierLabel = "Identifiant"
    public static let scopeLabel = "Portée"
    public static let scoreLabel = "Pertinence"

    /// La ligne de contexte d'un souvenir, dans la liste comme dans le détail :
    /// date relative à `nowMs` (`ConsoleFormat.relative`), puis étiquettes
    /// (`tagList`) — chaque segment ABSENT de l'entrée est omis, jamais remplacé.
    /// La portée, identique pour toute la liste, n'y figure pas : elle vit dans les
    /// détails techniques. UNE seule formule, partagée par les deux coques.
    public static func subtitle(updatedAt: String?, tags: [String], nowMs: Double) -> String {
        var segments: [String] = []
        if let ms = updatedAtMs(updatedAt) {
            segments.append(ConsoleFormat.relative(ms: ms, nowMs: nowMs))
        }
        if !tags.isEmpty {
            segments.append(tagList(tags))
        }
        return segments.joined(separator: separator)
    }

    /// Les étiquettes en mots-dièse, dans l'ordre du service.
    public static func tagList(_ tags: [String]) -> String {
        tags.map { "#\($0)" }.joined(separator: " ")
    }

    /// L'instant d'un `updated_at` du service (`2026-10-01T11:50:31.746110+00:00`,
    /// fraction et décalage facultatifs), en millisecondes ; `nil` s'il est absent
    /// ou illisible — la ligne perd alors sa date, jamais sa place.
    public static func updatedAtMs(_ raw: String?) -> Double? {
        guard let raw, let date = try? timestampStyle.parse(raw) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    // MARK: - Titre d'un souvenir (omp-console-redesign S-19 R2)

    /// La longueur maximale d'un titre, points de suspension compris.
    public static let titleLimit = 90

    /// Le TITRE court d'un souvenir pour la liste (S-19 R2) : le début de sa
    /// première ligne jusqu'au premier séparateur français « mot : » (blanc AVANT
    /// le deux-points — « 11:50 » ou « http:// » ne coupent pas), sinon jusqu'à la
    /// fin de la première phrase ; Markdown en ligne retiré (`**`, `` ` ``, `_`
    /// d'emphase, liens), tout chemin réduit à son dernier composant, blancs
    /// normalisés, borné à `titleLimit` caractères avec « … ». Vide seulement pour
    /// un texte vide ou blanc ; sinon, si la coupe ne laisse rien, le titre se
    /// replie sur le texte entier nettoyé, puis sur le texte brut.
    public static func title(_ text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let firstLine = trimmed.prefix { !$0.isNewline }
        for candidate in [titleHead(String(firstLine)), trimmed] {
            let cleaned = collapseBlanks(reducePaths(stripInlineMarkdown(stripBlockMarker(candidate))))
            if !cleaned.isEmpty { return bounded(cleaned) }
        }
        return bounded(collapseBlanks(trimmed))
    }

    /// Le début d'une ligne : jusqu'au premier « : » précédé d'un blanc, sinon
    /// jusqu'à la première fin de phrase (« . », « ! », « ? » suivis d'un blanc) ;
    /// le point final d'une phrase n'appartient pas au titre.
    private static func titleHead(_ line: String) -> String {
        let chars = Array(line)
        for i in chars.indices where chars[i] == ":" && i > 0 && chars[i - 1].isWhitespace {
            return String(chars[..<i])
        }
        for i in chars.indices where ".!?".contains(chars[i]) {
            guard i + 1 == chars.count || chars[i + 1].isWhitespace else { continue }
            return String(chars[..<(chars[i] == "." ? i : i + 1)])
        }
        return line
    }

    /// Le marqueur de bloc en tête de ligne (« # », « > », « - », « * », « + »).
    private static func stripBlockMarker(_ line: String) -> String {
        var rest = Substring(line.trimmingCharacters(in: .whitespaces))
        while let first = rest.first, "#>".contains(first) { rest = rest.dropFirst() }
        if let first = rest.first, "-*+".contains(first), rest.dropFirst().first == " " {
            rest = rest.dropFirst()
        }
        return rest.trimmingCharacters(in: .whitespaces)
    }

    /// Le Markdown en ligne : liens et images réduits à leur texte, `**`, `__`,
    /// `~~` et backticks retirés partout ; `*` et `_` retirés seulement en bord de
    /// mot (emphase), pour que `memory_type` garde son tiret bas.
    private static func stripInlineMarkdown(_ text: String) -> String {
        var out = text
        if let link = try? Regex(#"!?\[([^\]]*)\]\([^)]*\)"#) {
            out = out.replacing(link) { String($0.output[1].substring ?? "") }
        }
        for marker in ["**", "__", "~~", "`"] {
            out = out.replacingOccurrences(of: marker, with: "")
        }
        let chars = Array(out)
        var kept = ""
        for i in chars.indices {
            if "*_".contains(chars[i]) {
                let before = i > 0 ? chars[i - 1] : " "
                let after = i + 1 < chars.count ? chars[i + 1] : " "
                if !(isWordCharacter(before) && isWordCharacter(after)) { continue }
            }
            kept.append(chars[i])
        }
        return kept
    }

    /// Tout chemin réduit à son dernier composant : une suite de caractères de
    /// chemin contenant « / » est un chemin si elle commence par « / », « ~/ »,
    /// « ./ », « ../ », si elle compte au moins deux « / », ou si son dernier
    /// composant porte une extension (« Files/FilesView.swift »). Un « / » isolé
    /// (« omp-console / quitter ») et « lecture/écriture » restent ; une URL aussi.
    private static func reducePaths(_ text: String) -> String {
        var out = ""
        var run = ""
        var previous: Character?
        func flush() {
            out += reducedPath(run, afterColon: previous == ":")
            run = ""
        }
        for char in text {
            if isWordCharacter(char) || "/.~-+@".contains(char) {
                run.append(char)
            } else {
                flush()
                out.append(char)
                previous = char
            }
        }
        flush()
        return out
    }

    private static func reducedPath(_ run: String, afterColon: Bool) -> String {
        guard run.contains("/"), !afterColon else { return run }
        // Le point d'une fin de phrase n'appartient pas au chemin.
        let body = run.reversed().drop { $0 == "." }.reversed()
        let trailing = run.dropFirst(body.count)
        let components = String(body).split(separator: "/")
        guard let last = components.last else { return run }
        let slashes = body.filter { $0 == "/" }.count
        let rooted = ["/", "~/", "./", "../"].contains { String(body).hasPrefix($0) }
        let hasExtension = last.split(separator: ".", omittingEmptySubsequences: false).count > 1
            && last.split(separator: ".").last?.first?.isLetter == true
            && !last.hasPrefix(".")
        guard (rooted && body.count > 1) || slashes >= 2 || hasExtension else { return run }
        return String(last) + trailing
    }

    private static func isWordCharacter(_ char: Character) -> Bool {
        char.isLetter || char.isNumber || char == "_"
    }

    private static func collapseBlanks(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// Au plus `titleLimit` caractères : au-delà, la coupe se fait au dernier blanc
    /// s'il n'est pas trop tôt, et « … » marque la coupe.
    private static func bounded(_ text: String) -> String {
        guard text.count > titleLimit else { return text }
        var kept = text.prefix(titleLimit - 1)
        if let space = kept.lastIndex(of: " "), kept.distance(from: kept.startIndex, to: space) >= titleLimit * 2 / 3 {
            kept = kept[..<space]
        }
        return kept.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// `Date.ISO8601FormatStyle` est une `struct` `Sendable` (légale en `static let`
    /// sous Swift 6) et lit les formes avec et sans fraction de seconde.
    private static let timestampStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

    /// « 0,55 » : un seuil se lit en français, jamais « 0.55 ».
    public static func decimal(_ value: Double) -> String {
        String(format: "%.2f", value).replacingOccurrences(of: ".", with: ",")
    }
}
