// Tous les textes de la section « Mémoire », en UN endroit.
//
// Un message à un seul endroit, c'est ce qui permet à un test de le figer sans
// rendre une vue, et à la vue de ne jamais composer une phrase : chaque état de la
// section a son texte, et il n'existe qu'ici.

import Foundation

enum MemoryText {
    // Barre d'outils
    static let searchPrompt = "Rechercher dans la mémoire"
    static let summaryButton = "Sommaire"
    static let summaryHelp = "Revenir au sommaire de la mémoire"
    static let refresh = "Rafraîchir"
    static let refreshHelp = "Recharger la mémoire du projet (⌘R)"

    // États
    static let noProjectTitle = "Aucun projet ouvert"
    static let noProjectDescription = "Choisissez un projet dans la section « Session OMP » (⌘4)."
    static let unavailableTitle = "Mémoire indisponible"
    static let unavailableDescription = "Le service de mémoire ne répond pas. Vérifiez qu'il est démarré, puis réessayez."
    static let retry = "Réessayer"
    static let loading = "Chargement de la mémoire du projet…"
    static let emptySummaryTitle = "Aucun souvenir"
    static let noResultTitle = "Aucun résultat"
    static let noMatch = "La mémoire du projet ne contient aucun souvenir correspondant."
    static let belowThreshold = "Aucun souvenir n'est assez proche de cette recherche."
    static let searchUnsupportedTitle = "Recherche impossible"
    static let noSemanticScore = "Ce service de mémoire ne sait pas classer les souvenirs par pertinence."
    static let nothingSelected = "Sélectionnez un souvenir pour le lire."
    static let emptyRow = "Souvenir vide."

    // Erreurs (S-6.4) : détail secondaire de l'indisponibilité, jamais un titre.
    static let tokenRefused = "jeton refusé (401)"
    static let unreadableResponse = "réponse illisible"

    /// L'adresse du service et la DERNIÈRE erreur (S-6.3), en détail secondaire de
    /// « Mémoire indisponible » : une ligne chacune, pour qu'aucune ne disparaisse.
    static func unavailableDetail(address: String, error: String) -> String {
        error.isEmpty ? address : "\(address)\n\(error)"
    }

    /// « 1 souvenir », « 829 souvenirs » : un vrai pluriel.
    static func summaryCount(_ n: Int) -> String {
        ConsoleFormat.count(n, "souvenir", "souvenirs")
    }

    static func emptySummary(_ scope: String) -> String {
        "Aucun souvenir dans la mémoire du projet « \(scope) »."
    }

    /// Le rappel de la requête au-dessus d'une liste de résultats de recherche.
    static func searchResults(_ query: String) -> String {
        "Résultats pour « \(query) »"
    }

    static func unexpectedStatus(code: Int, detail: String) -> String {
        "réponse \(code) du service (\(detail))"
    }

    // MARK: - Ligne de la liste et détail (omp-console-redesign S-18 R7)

    /// Le séparateur des segments de la ligne de contexte.
    static let separator = " · "

    // Le détail : titre, ligne de contexte, texte rendu, puis les données
    // techniques repliées sous « Détails techniques ».
    static let copy = "Copier"
    static let copyHelp = "Copier le texte du souvenir"
    static let technicalDetails = "Détails techniques"
    static let identifierLabel = "Identifiant"
    static let scopeLabel = "Portée"
    static let scoreLabel = "Pertinence"

    /// Les étiquettes en mots-dièse, dans l'ordre du service.
    static func tagList(_ tags: [String]) -> String {
        tags.map { "#\($0)" }.joined(separator: " ")
    }

    /// L'instant d'un `updated_at` du service (`2026-10-01T11:50:31.746110+00:00`,
    /// fraction et décalage facultatifs), en millisecondes ; `nil` s'il est absent
    /// ou illisible — la ligne perd alors sa date, jamais sa place.
    static func updatedAtMs(_ raw: String?) -> Double? {
        guard let raw, let date = try? timestampStyle.parse(raw) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    /// La ligne de contexte d'un souvenir, dans la liste comme dans le détail :
    /// date relative à `nowMs`, puis étiquettes — chaque segment absent de l'entrée
    /// est omis, jamais remplacé. La portée, identique pour toute la liste, n'y
    /// figure pas (elle vit dans les détails techniques).
    static func subtitle(row: MemoryRow, nowMs: Double) -> String {
        var segments: [String] = []
        if let ms = updatedAtMs(row.updatedAt) {
            segments.append(ConsoleFormat.relative(ms: ms, nowMs: nowMs))
        }
        if !row.tags.isEmpty {
            segments.append(tagList(row.tags))
        }
        return segments.joined(separator: separator)
    }

    // MARK: - Titre d'un souvenir (omp-console-redesign S-19 R2)

    /// La longueur maximale d'un titre, points de suspension compris.
    static let titleLimit = 90

    /// Le TITRE court d'un souvenir pour la liste (S-19 R2) : le début de sa
    /// première ligne jusqu'au premier séparateur français « mot : » (blanc AVANT
    /// le deux-points — « 11:50 » ou « http:// » ne coupent pas), sinon jusqu'à la
    /// fin de la première phrase ; Markdown en ligne retiré (`**`, `` ` ``, `_`
    /// d'emphase, liens), tout chemin réduit à son dernier composant, blancs
    /// normalisés, borné à `titleLimit` caractères avec « … ». Vide seulement pour
    /// un texte vide ou blanc ; sinon, si la coupe ne laisse rien, le titre se
    /// replie sur le texte entier nettoyé, puis sur le texte brut.
    static func title(_ text: String) -> String {
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
    static func decimal(_ value: Double) -> String {
        String(format: "%.2f", value).replacingOccurrences(of: ".", with: ",")
    }
}
