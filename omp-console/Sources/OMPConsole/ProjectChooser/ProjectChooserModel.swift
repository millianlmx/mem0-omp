// Le sélecteur de projet des états vides de Mémoire, Fichiers et Terminal (S-2,
// S-3 de mac-etats-vides-sans-issue) : il offre les projets connus de la coque
// et le panneau de Session OMP, et il écrit le choix par
// `SessionConsoleModel.select(projectRoot:)` — l'unique écrivain du projet choisi
// de l'app, donc le même effet qu'un choix fait dans Session OMP.
//
// Invariant : le modèle n'a AUCUNE référence à `ConsoleModel`. Il ne peut donc
// ni lire ni changer la section affichée : choisir un projet remplit l'écran
// courant, sans navigation.
//
// Le contenu d'un `Menu` SwiftUI est construit au rendu, pas à l'ouverture : la
// liste vit dans `entries` (publié), rafraîchie à l'apparition de l'action.

import Combine
import Foundation

@MainActor
final class ProjectChooserModel: ObservableObject {
    /// Un projet connu, tel que le menu le montre : la racine absolue est
    /// l'identité, le libellé ne montre jamais de chemin complet.
    struct Entry: Identifiable, Equatable {
        let id: String
        let label: String
    }

    @Published private(set) var entries: [Entry] = []

    private let session: SessionConsoleModel
    private let knownRoots: @MainActor () -> [String]
    private let fileManager: FileManager

    init(
        session: SessionConsoleModel,
        knownRoots: @escaping @MainActor () -> [String],
        fileManager: FileManager = .default
    ) {
        self.session = session
        self.knownRoots = knownRoots
        self.fileManager = fileManager
    }

    /// Relit les projets connus. Appelé à l'apparition de l'action, avant toute
    /// ouverture du menu, et après une entrée disparue.
    func refresh() {
        entries = Self.entries(for: knownRoots())
    }

    /// Choisit un projet connu. Un dossier disparu depuis le dernier
    /// rafraîchissement n'est pas écrit : la liste est relue (l'entrée sort du
    /// menu) et l'état vide reste affiché, sans message.
    @discardableResult
    func choose(_ entry: Entry) -> Bool {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: entry.id, isDirectory: &isDirectory), isDirectory.boolValue else {
            refresh()
            return false
        }
        session.select(projectRoot: URL(fileURLWithPath: entry.id, isDirectory: true))
        return true
    }

    /// Le panneau de Session OMP, tel quel : `false` quand il est annulé.
    @discardableResult
    func chooseFolder() -> Bool {
        session.chooseProject()
    }

    /// Les entrées du menu, dans l'ordre reçu. Le libellé est le nom du dossier ;
    /// quand plusieurs racines partagent ce nom, CHACUNE est libellée
    /// « <nom> — <dossier parent> » pour rester distinguable. Pur, donc hors de
    /// l'acteur principal.
    nonisolated static func entries(for roots: [String]) -> [Entry] {
        let names = roots.map { ($0 as NSString).lastPathComponent }
        var counts: [String: Int] = [:]
        for name in names {
            counts[name, default: 0] += 1
        }
        return zip(roots, names).map { root, name in
            guard counts[name, default: 0] > 1 else {
                return Entry(id: root, label: name)
            }
            let parent = ((root as NSString).deletingLastPathComponent as NSString).lastPathComponent
            return Entry(id: root, label: "\(name) — \(parent)")
        }
    }
}
