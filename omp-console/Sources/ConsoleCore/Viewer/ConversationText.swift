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

public enum ConversationText {
    public static let thinking = "Réflexion"
    public static let compaction = "Contexte compacté"
    public static let branchSummary = "Résumé de branche"
    public static let withoutCall = "(sans appel)"
    public static let waitingTitle = "Aucun échange pour l'instant"
    public static let emptyTitle = "Session vide"
    public static let rewritten = "Fichier réécrit — affichage reconstruit"

    /// Le cache du rendu Markdown : assez large pour une longue session affichée
    /// (une entrée par message, réflexion ou résumé RENDU), borné pour qu'une
    /// fenêtre ouverte des heures ne grandisse pas sans fin.
    public static let markdownCache = BoundedMemo<AttributedString>(capacity: 2_048) { parseInlineMarkdown($0) }

    /// Le Markdown EN LIGNE d'un message (gras, italique, `code`, liens), blancs
    /// et retours à la ligne conservés ; un Markdown invalide rend le texte brut.
    /// Mémoïsé : un même texte n'est analysé qu'une fois tant qu'il reste en cache.
    public static func attributed(_ text: String) -> AttributedString {
        markdownCache.value(for: text)
    }

    /// L'analyse elle-même, sans cache.
    public static func parseInlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    public static func ignored(_ n: Int) -> String {
        ConsoleFormat.count(n, "entrée ignorée", "entrées ignorées")
    }

    public static func unreadable(_ message: String) -> String {
        "Session illisible : \(message). Nouvelle tentative automatique."
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
public final class BoundedMemo<Value: Sendable>: Sendable {
    private struct Generations {
        public var current: [String: Value] = [:]
        public var previous: [String: Value] = [:]
    }

    public let capacity: Int
    private let generationLimit: Int
    private let compute: @Sendable (String) -> Value
    private let state = Mutex(Generations())

    public init(capacity: Int, compute: @escaping @Sendable (String) -> Value) {
        self.capacity = max(2, capacity)
        self.generationLimit = self.capacity / 2
        self.compute = compute
    }

    /// Le nombre d'entrées gardées ; jamais plus que `capacity`.
    public var count: Int {
        state.withLock { $0.current.count + $0.previous.count }
    }

    public func value(for key: String) -> Value {
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
public enum ToolVerb {
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

    public static func title(_ name: String) -> String {
        table[name]?.title ?? name
    }

    public static func symbol(_ name: String) -> String {
        table[name]?.symbol ?? "wrench.and.screwdriver"
    }
}
