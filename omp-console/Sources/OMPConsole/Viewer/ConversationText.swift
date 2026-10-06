// Ce que la coque garde des textes de la conversation : le rendu en BLOCS
// Markdown (qui dépend de `MarkdownDocument`, une vue/analyse de la coque) et
// l'état du fil (qui dépend de `SessionViewerState`). Le reste — dont le rendu en
// ligne et la mémoïsation bornée — vit dans `ConsoleCore/Viewer/ConversationText.swift`.

import ConsoleCore

extension ConversationText {
    /// Le texte d'un message de l'agent en blocs complets (titres, listes,
    /// citations, code, tableaux, séparateurs). Mémoïsé : un même texte n'est
    /// découpé qu'une fois tant qu'il reste en cache.
    static func blocks(_ text: String) -> [MarkdownBlock] {
        blocksCache.value(for: text)
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

    /// Le cache des BLOCS Markdown d'un message de l'agent (S-19 R1), borné comme
    /// `markdownCache` : une entrée par message rendu.
    ///
    /// Accesseur CALCULÉ : une extension ne peut pas porter de propriété stockée
    /// (D4). L'instance reste UNIQUE — `Support.blocksCache` est le seul stockage,
    /// donc `blocks(_:)` et les tests qui lisent `ConversationText.blocksCache`
    /// voient le même cache.
    static var blocksCache: BoundedMemo<[MarkdownBlock]> { Support.blocksCache }

    private enum Support {
        static let blocksCache = BoundedMemo<[MarkdownBlock]>(capacity: 2_048) { MarkdownDocument.blocks($0) }
    }
}
