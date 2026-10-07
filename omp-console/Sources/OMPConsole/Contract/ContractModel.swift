// Le modèle de la feuille Contrat (S-4) : chaque ouverture RELIT le fichier à cet
// instant — aucun cache entre deux ouvertures, et le contenu d'une feuille ouverte
// est figé (hors périmètre : suivre les modifications en direct).
//
// Même mécanique que les autres feuilles de la fenêtre : la racine présente
// `sheet` par `.sheet(item:)`, et `close()` la referme.

import ConsoleCore
import Combine
import Foundation

/// La feuille Contrat affichée : le moment, le chemin lu et le contenu de CETTE
/// lecture. `id` = `<slug>.<moment>` : deux moments d'une même feature sont deux
/// feuilles distinctes.
struct ContractSheet: Identifiable, Equatable, Sendable {
    var slug: String
    var moment: ContractMoment
    var path: String
    var content: ContractContent

    var id: String {
        "\(slug).\(moment.rawValue)"
    }
}

@MainActor
final class ContractModel: ObservableObject {
    /// La feuille due, `nil` quand aucune. Une seule à la fois (HIG Sheets).
    @Published private(set) var sheet: ContractSheet?

    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
    }

    /// Ouvre la feuille d'une carte : la lecture a lieu ICI, à cet instant (S-4).
    /// Une carte sans moment (`nil`), sans slug ou sans worktree n'ouvre rien, ne
    /// lève rien, ne change aucun état.
    func open(_ card: KanbanCard) {
        guard let moment = ContractDocument.moment(for: card),
              let slug = card.action?.slug,
              let worktree = card.action?.worktree, !worktree.isEmpty
        else { return }
        let path = ContractDocument.path(worktree: worktree)
        sheet = ContractSheet(
            slug: slug,
            moment: moment,
            path: path,
            content: ContractDocument.read(path: path, moment: moment, fileManager: fileManager)
        )
    }

    /// Ferme la feuille : l'état revient à `nil`, comme la feuille « Répondre ».
    func close() {
        sheet = nil
    }
}
