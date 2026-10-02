// Les textes de la conversation (S-15 de omp-console-redesign) : ceux de la
// visionneuse d'un run et de la fenêtre « Session OMP », qui partagent le même fil.
//
// Fonctions PURES : le rendu Markdown d'un message (en ligne pour l'utilisateur
// et la réflexion, en blocs complets pour le texte de l'agent — S-19 R1), l'état
// du fil en un mot doublé d'un ton, le verbe et le symbole d'un appel d'outil.
// Les deux rendus Markdown sont MÉMOÏSÉS par texte (S-18 R8) : une ligne du fil
// est réévaluée à chaque passe de rendu, et l'analyse d'un long message à chaque
// passe faisait « laguer » le défilement d'une longue session.

import Foundation
import Synchronization

enum ConversationText {
    static let thinking = "Réflexion"
    static let compaction = "Contexte compacté"
    static let branchSummary = "Résumé de branche"
    static let withoutCall = "(sans appel)"
    static let waitingTitle = "Aucun échange pour l'instant"
    static let emptyTitle = "Session vide"
    static let rewritten = "Fichier réécrit — affichage reconstruit"

    /// Le cache du rendu Markdown : assez large pour une longue session affichée
    /// (une entrée par message, réflexion ou résumé RENDU), borné pour qu'une
    /// fenêtre ouverte des heures ne grandisse pas sans fin.
    static let markdownCache = BoundedMemo<AttributedString>(capacity: 2_048) { parseInlineMarkdown($0) }

    /// Le Markdown EN LIGNE d'un message (gras, italique, `code`, liens), blancs
    /// et retours à la ligne conservés ; un Markdown invalide rend le texte brut.
    /// Mémoïsé : un même texte n'est analysé qu'une fois tant qu'il reste en cache.
    static func attributed(_ text: String) -> AttributedString {
        markdownCache.value(for: text)
    }

    /// Le cache des BLOCS Markdown d'un message de l'agent (S-19 R1), borné comme
    /// `markdownCache` : une entrée par message rendu.
    static let blocksCache = BoundedMemo<[MarkdownBlock]>(capacity: 2_048) { MarkdownDocument.blocks($0) }

    /// Le texte d'un message de l'agent en blocs complets (titres, listes,
    /// citations, code, tableaux, séparateurs). Mémoïsé : un même texte n'est
    /// découpé qu'une fois tant qu'il reste en cache.
    static func blocks(_ text: String) -> [MarkdownBlock] {
        blocksCache.value(for: text)
    }

    /// L'analyse elle-même, sans cache.
    static func parseInlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    static func ignored(_ n: Int) -> String {
        ConsoleFormat.count(n, "entrée ignorée", "entrées ignorées")
    }

    static func unreadable(_ message: String) -> String {
        "Session illisible : \(message). Nouvelle tentative automatique."
    }

    /// L'état du fil : la lecture en erreur prime (les faits déjà lus restent
    /// affichés), puis l'attente d'un premier fait, puis le suivi du direct.
    /// `nil` quand le fil ne suit plus le direct : le bouton « Revenir au direct »
    /// dit seul cet état, un second mot ferait doublon (audit HIG 2026-10-01).
    static func status(state: SessionViewerState, following: Bool, isEmpty: Bool) -> ConsoleStatus? {
        if case .unreadable = state { return ConsoleStatus(text: "Erreur de lecture", tone: .danger) }
        if state == .waiting && isEmpty { return ConsoleStatus(text: "Démarrage", tone: .info) }
        if following { return ConsoleStatus(text: "En direct", tone: .success) }
        return nil
    }
}

/// Une mémoïsation BORNÉE par texte, sûre depuis n'importe quel fil.
///
/// Deux générations de `capacity / 2` entrées : une valeur lue dans l'ancienne est
/// promue dans la courante, et la courante pleine devient l'ancienne (l'ancienne
/// est oubliée). On garde donc toujours au plus `capacity` entrées, et ce qui sert
/// encore survit — un LRU approché en O(1), sans liste chaînée.
///
/// Le calcul se fait HORS du verrou : deux fils qui manquent la même clé calculent
/// chacun (la valeur est déterministe), mais aucun n'attend l'analyse de l'autre.
final class BoundedMemo<Value: Sendable>: Sendable {
    private struct Generations {
        var current: [String: Value] = [:]
        var previous: [String: Value] = [:]
    }

    let capacity: Int
    private let generationLimit: Int
    private let compute: @Sendable (String) -> Value
    private let state = Mutex(Generations())

    init(capacity: Int, compute: @escaping @Sendable (String) -> Value) {
        self.capacity = max(2, capacity)
        self.generationLimit = self.capacity / 2
        self.compute = compute
    }

    /// Le nombre d'entrées gardées ; jamais plus que `capacity`.
    var count: Int {
        state.withLock { $0.current.count + $0.previous.count }
    }

    func value(for key: String) -> Value {
        let cached: Value? = state.withLock { generations in
            if let value = generations.current[key] { return value }
            guard let value = generations.previous.removeValue(forKey: key) else { return nil }
            Self.insert(key, value, into: &generations, limit: generationLimit)
            return value
        }
        if let cached { return cached }
        let value = compute(key)
        state.withLock { Self.insert(key, value, into: &$0, limit: generationLimit) }
        return value
    }

    private static func insert(_ key: String, _ value: Value, into generations: inout Generations, limit: Int) {
        if generations.current[key] == nil, generations.current.count >= limit {
            generations.previous = generations.current
            generations.current = [:]
        }
        generations.current[key] = value
    }
}

/// Le verbe lisible et le symbole d'un appel d'outil ; un outil inconnu garde son
/// nom.
enum ToolVerb {
    private static let table: [String: (title: String, symbol: String)] = [
        "bash": ("Commande", "terminal"),
        "read": ("Lecture", "doc.text"),
        "edit": ("Modification", "pencil"),
        "write": ("Écriture", "square.and.pencil"),
        "grep": ("Recherche", "magnifyingglass"),
        "glob": ("Recherche de fichiers", "doc.text.magnifyingglass"),
        "ask": ("Question", "questionmark.bubble"),
        "task": ("Sous-agent", "person.2"),
        "hub": ("Coordination", "point.3.connected.trianglepath.dotted"),
        "eval": ("Exécution", "play.rectangle"),
        "yield": ("Résultat", "flag.checkered"),
        "todo": ("Tâches", "checklist"),
        "web_search": ("Recherche web", "globe"),
        "mem0_search": ("Recherche en mémoire", "brain"),
        "mem0_add": ("Mémorisation", "brain"),
        "mem0_update": ("Mémoire mise à jour", "brain"),
        "mem0_forget": ("Souvenir oublié", "brain"),
    ]

    static func title(_ name: String) -> String {
        table[name]?.title ?? name
    }

    static func symbol(_ name: String) -> String {
        table[name]?.symbol ?? "wrench.and.screwdriver"
    }
}
