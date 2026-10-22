// Le sélecteur de projet des états vides de Mémoire, Fichiers et Terminal (S-2,
// S-3 de mac-etats-vides-sans-issue) : il offre les projets déjà choisis et le
// panneau d'ouverture, et il écrit le choix dans la préférence partagée
// (`ProjectRoot.defaultsKey`) — l'unique écrivain du projet choisi de l'app.
//
// Invariant : le modèle n'a AUCUNE référence à `ConsoleModel`. Il ne peut donc
// ni lire ni changer la section affichée : choisir un projet remplit l'écran
// courant, sans navigation.
//
// Le contenu d'un `Menu` SwiftUI est construit au rendu, pas à l'ouverture : la
// liste vit dans `entries` (publié), rafraîchie à l'apparition de l'action.

import AppKit
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

    /// Les projets déjà choisis, du plus récent au plus ancien.
    static let recentKey = "projects.recent"
    static let recentLimit = 8

    @Published private(set) var entries: [Entry] = []

    private let defaults: UserDefaults
    private let fileManager: FileManager

    init(defaults: UserDefaults = .standard, fileManager: FileManager = .default) {
        self.defaults = defaults
        self.fileManager = fileManager
    }

    /// Les projets connus encore présents : racines git déjà choisies.
    var knownRoots: [String] {
        (defaults.stringArray(forKey: Self.recentKey) ?? []).filter { root in
            fileManager.fileExists(atPath: (root as NSString).appendingPathComponent(".git"))
        }
    }

    /// Relit les projets connus. Appelé à l'apparition de l'action, avant toute
    /// ouverture du menu, et après une entrée disparue.
    func refresh() {
        entries = Self.entries(for: knownRoots)
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
        select(projectRoot: URL(fileURLWithPath: entry.id, isDirectory: true))
        return true
    }

    /// Le panneau d'ouverture : `false` quand il est annulé (rien n'est écrit).
    @discardableResult
    func chooseFolder() -> Bool {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = ProjectChooserText.panelPrompt
        panel.message = ProjectChooserText.panelMessage
        guard panel.runModal() == .OK, let url = panel.url else { return false }
        select(projectRoot: url)
        return true
    }

    /// Écrit le projet choisi, et le place en tête des projets connus.
    func select(projectRoot url: URL) {
        let path = url.standardizedFileURL.path
        defaults.set(path, forKey: ProjectRoot.defaultsKey)
        var recent = (defaults.stringArray(forKey: Self.recentKey) ?? []).filter { $0 != path }
        recent.insert(path, at: 0)
        defaults.set(Array(recent.prefix(Self.recentLimit)), forKey: Self.recentKey)
        refresh()
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
