// La PALETTE de commandes des deux apps (⌘K) et sa recherche globale (⌘F) : sauter à
// une section, ouvrir une feature, lancer une feature, valider ou trancher ce qui
// attend, actualiser, relier le serveur — et, en recherche, les features (vivantes
// et historique) et la mémoire.
//
// La liste et son tri sont calculés ici, sans vue : `HarnessPalette.items` rend les
// entrées retenues par la saisie, la meilleure d'abord. L'exécution d'une commande
// (choisir une section, ouvrir une feuille) appartient à l'app (`ConsoleUI`).

import ConsoleCore
import Foundation

/// Ce que fait une entrée de la palette.
public enum HarnessPaletteCommand: Hashable, Sendable {
    /// Montrer une section.
    case section(ConsoleSection)
    /// Ouvrir une feature : son direct si elle en a un, sinon l'historique filtré sur elle.
    case run(String)
    /// Ouvrir la feuille « Nouvelle feature » (⌘N).
    case newFeature
    /// Aller à ce qui attend l'humain sur l'Accueil (specs, verdicts, questions).
    case inbox(HarnessHomeAnchor)
    /// Relire le serveur.
    case refresh
    /// Ouvrir la feuille du serveur.
    case server
    /// Chercher la saisie dans la mémoire.
    case searchMemory(String)
}

/// Une entrée : son libellé, son détail, son symbole et sa commande.
public struct HarnessPaletteItem: Identifiable, Hashable, Sendable {
    public var title: String
    public var subtitle: String?
    public var symbol: String
    public var command: HarnessPaletteCommand

    public var id: HarnessPaletteCommand { command }

    public init(title: String, subtitle: String? = nil, symbol: String, command: HarnessPaletteCommand) {
        self.title = title
        self.subtitle = subtitle
        self.symbol = symbol
        self.command = command
    }
}

public enum HarnessPalette {
    /// Au plus tant d'entrées montrées.
    public static let limit = 40

    /// Les entrées retenues par `query`, la meilleure d'abord. `search` (⌘F) ne garde
    /// que les features et la mémoire ; `sections` sont celles de l'app (l'iPhone n'a
    /// ni Terminal ni Fichiers) ; `memory` dit si l'app a une section Mémoire.
    public static func items(
        query: String, search: Bool, sections: [ConsoleSection], inbox: HarnessInbox?, history: [HarnessRun],
        canAct: Bool, memory: Bool
    ) -> [HarnessPaletteItem] {
        var candidates: [HarnessPaletteItem] = []
        if !search {
            candidates += sections.map {
                HarnessPaletteItem(title: $0.title, subtitle: PipelineServerText.paletteSection, symbol: $0.systemImage, command: .section($0))
            }
            if canAct {
                candidates.append(HarnessPaletteItem(title: PipelineServerText.newFeature, symbol: PipelineServerText.newFeatureSymbol, command: .newFeature))
            }
            if let inbox {
                if !inbox.batches.isEmpty {
                    candidates.append(HarnessPaletteItem(title: PipelineServerText.paletteToDecide(inbox.batches.count), symbol: PipelineServerText.questionSymbol, command: .inbox(.toDecide)))
                }
                if !inbox.specsAwaiting.isEmpty {
                    candidates.append(HarnessPaletteItem(title: PipelineServerText.paletteSpecs(inbox.specsAwaiting.count), symbol: PipelineServerText.validateSymbol, command: .inbox(.specs)))
                }
                if !inbox.verdictsAwaiting.isEmpty {
                    candidates.append(HarnessPaletteItem(title: PipelineServerText.paletteVerdicts(inbox.verdictsAwaiting.count), symbol: PipelineServerText.validateSymbol, command: .inbox(.verdicts)))
                }
            }
            candidates.append(HarnessPaletteItem(title: PipelineServerText.refresh, symbol: PipelineServerText.refreshSymbol, command: .refresh))
            candidates.append(HarnessPaletteItem(title: PipelineServerText.open, symbol: PipelineServerText.serverSymbol, command: .server))
        }
        var seen = Set<String>()
        let live = inbox.map { $0.batches.compactMap(\.run) + $0.awaiting + $0.runs } ?? []
        for run in live + history.sorted(by: .updated) where seen.insert(run.id).inserted {
            candidates.append(HarnessPaletteItem(title: run.title, subtitle: run.repo + " · " + run.statusLine, symbol: ConsoleSection.kanban.systemImage, command: .run(run.id)))
        }

        let words = words(of: query)
        var scored: [(item: HarnessPaletteItem, score: Int, order: Int)] = []
        for (order, item) in candidates.enumerated() {
            if let score = score(item, words: words) { scored.append((item, score, order)) }
        }
        var kept = scored
            .sorted { ($0.score, -$0.order) > ($1.score, -$1.order) }
            .prefix(limit)
            .map(\.item)
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if memory, !trimmed.isEmpty {
            let entry = HarnessPaletteItem(title: PipelineServerText.paletteMemory(trimmed), symbol: ConsoleSection.memory.systemImage, command: .searchMemory(trimmed))
            // En recherche, la mémoire vient en tête : c'est souvent elle qu'on cherche.
            if search { kept.insert(entry, at: 0) } else { kept.append(entry) }
        }
        return kept
    }

    static func words(of query: String) -> [String] {
        query.split(whereSeparator: \.isWhitespace).map { fold(String($0)) }
    }

    /// Le score d'une entrée : chaque mot doit figurer dans le titre ou le détail ; un
    /// début de titre compte plus qu'un milieu, le titre plus que le détail. `nil` : écartée.
    static func score(_ item: HarnessPaletteItem, words: [String]) -> Int? {
        guard !words.isEmpty else { return 0 }
        let title = fold(item.title)
        let detail = fold(item.subtitle ?? "")
        var total = 0
        for word in words {
            if title.hasPrefix(word) {
                total += 4
            } else if title.split(separator: " ").contains(where: { $0.hasPrefix(word) }) {
                total += 3
            } else if title.contains(word) {
                total += 2
            } else if detail.contains(word) {
                total += 1
            } else {
                return nil
            }
        }
        return total
    }

    static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
}
