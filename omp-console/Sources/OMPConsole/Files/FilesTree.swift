// L'arbre d'une cible : l'union des fichiers SUIVIS et NON SUIVIS que git connaît,
// chacun classé, et l'arbre de nœuds que la vue affiche (S-2).
//
// `build` est PURE (aucune E/S) : la seule chose qu'elle ne peut pas deviner est ce
// que le disque dit d'un chemin — d'où `disk:`, injecté par l'appelant (le modèle
// interroge `FileManager`, les tests répondent ce qu'ils veulent). C'est cette
// séparation qui rend testables l'ordre, le badge « supprimé » et le rejet d'un
// gitlink sans toucher au dépôt.

import Foundation

enum FilesEntryKind: Sendable, Equatable, Hashable {
    case tracked
    case untracked
    /// Suivi mais absent du disque : c'est une modification de la cible, elle doit
    /// se voir (badge « supprimé »), pas disparaître de l'arbre.
    case deleted
}

struct FilesEntry: Sendable, Equatable, Hashable {
    /// Chemin RELATIF à la racine de la cible.
    var path: String
    var kind: FilesEntryKind
}

/// Ce que le disque dit d'un chemin. Trois cas et non deux : « présent mais
/// répertoire » (gitlink de sous-module) n'est ni « supprimé », ni un fichier à
/// montrer — c'est ce que `exists: (String) -> Bool` ne savait pas dire.
enum FilesDiskState: Sendable, Equatable {
    case file
    case directory
    case absent
}

struct FilesNode: Sendable, Equatable, Identifiable {
    var name: String
    var path: String
    var isDirectory: Bool
    /// Vide pour un fichier.
    var children: [FilesNode]
    /// `nil` pour un répertoire.
    var entry: FilesEntry?

    var id: String { path }
}

struct FilesTree: Sendable, Equatable {
    /// Chemins relatifs, dans un ordre TOTAL (une même entrée rend toujours la même
    /// liste).
    var entries: [FilesEntry]

    static func build(tracked: [String], untracked: [String], disk: (String) -> FilesDiskState) -> FilesTree {
        var entries: [FilesEntry] = []
        var seen = Set<String>()

        for path in tracked where isRelativePath(path) {
            guard seen.insert(path).inserted else { continue }
            switch disk(path) {
            case .directory:
                // Gitlink de sous-module : ce n'est pas un fichier de la cible.
                continue
            case .file:
                entries.append(FilesEntry(path: path, kind: .tracked))
            case .absent:
                entries.append(FilesEntry(path: path, kind: .deleted))
            }
        }

        // `--others` sans `--directory` liste les fichiers d'un répertoire neuf un
        // par un ; un chemin qui n'est plus un fichier au moment de la lecture
        // (disparu, ou répertoire) n'a rien à montrer, mais n'est PAS marqué
        // supprimé : il n'est pas suivi.
        for path in untracked where isRelativePath(path) {
            guard seen.insert(path).inserted else { continue }
            guard disk(path) == .file else { continue }
            entries.append(FilesEntry(path: path, kind: .untracked))
        }

        entries.sort { filePathOrder($0.path, $1.path) }
        return FilesTree(entries: entries)
    }
}

extension FilesTree {
    /// L'arbre de la vue, matérialisé depuis les chemins : les répertoires existent
    /// par leurs fichiers, et aucune entrée n'est vide.
    var nodes: [FilesNode] { makeNodes(entries) }
}

/// L'ordre d'affichage : les répertoires d'abord, puis les fichiers ; dans chaque
/// groupe, comparaison insensible à la casse, égalités tranchées par comparaison
/// scalaire — deux noms qui ne diffèrent que par la casse restent donc dans un
/// ordre stable.
func nameOrder(_ left: String, _ right: String) -> Bool {
    let foldedLeft = left.lowercased()
    let foldedRight = right.lowercased()
    if foldedLeft != foldedRight { return foldedLeft < foldedRight }
    return left < right
}

/// L'ordre total des entrées : le chemin complet, avec la même règle qu'au niveau
/// d'un nœud.
func filePathOrder(_ left: String, _ right: String) -> Bool {
    nameOrder(left, right)
}

/// Les chemins transportés par `ls-files -z` : découpés sur l'octet NUL, fragments
/// vides ignorés. `-z` garantit qu'aucun chemin n'est échappé — un chemin à espaces,
/// accents ou retour à la ligne arrive donc tel quel.
func nulSeparated(_ text: String) -> [String] {
    text.split(separator: "\0", omittingEmptySubsequences: true).map(String.init)
}

/// Ce que le disque dit d'un chemin, pour `FilesTree.build`.
func filesDiskState(_ path: String, fileManager: FileManager = .default) -> FilesDiskState {
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory) else { return .absent }
    return isDirectory.boolValue ? .directory : .file
}

private func isRelativePath(_ path: String) -> Bool {
    !path.isEmpty && !path.hasPrefix("/")
}

private struct NodeBuilder {
    var name: String
    var path: String
    var isDirectory: Bool
    var entry: FilesEntry?
    var children: [String: NodeBuilder] = [:]

    func node() -> FilesNode {
        let kids = children.values.map { $0.node() }.sorted { left, right in
            if left.isDirectory != right.isDirectory { return left.isDirectory }
            return nameOrder(left.name, right.name)
        }
        return FilesNode(name: name, path: path, isDirectory: isDirectory, children: kids, entry: entry)
    }
}

private func makeNodes(_ entries: [FilesEntry]) -> [FilesNode] {
    var roots: [String: NodeBuilder] = [:]
    for entry in entries {
        let parts = entry.path.split(separator: "/").map(String.init)
        guard let head = parts.first else { continue }
        var builder = roots[head] ?? NodeBuilder(name: head, path: head, isDirectory: parts.count > 1, entry: nil)
        fill(parts.dropFirst(), prefix: head, entry: entry, into: &builder)
        roots[head] = builder
    }
    return roots.values.map { $0.node() }.sorted { left, right in
        if left.isDirectory != right.isDirectory { return left.isDirectory }
        return nameOrder(left.name, right.name)
    }
}

/// Pose `entry` sur le nœud désigné par `parts` (le reste du chemin), en créant les
/// répertoires intermédiaires au passage.
private func fill(_ parts: ArraySlice<String>, prefix: String, entry: FilesEntry, into builder: inout NodeBuilder) {
    guard let head = parts.first else {
        builder.entry = entry
        builder.isDirectory = false
        return
    }
    let path = "\(prefix)/\(head)"
    var child = builder.children[head] ?? NodeBuilder(name: head, path: path, isDirectory: true, entry: nil)
    fill(parts.dropFirst(), prefix: path, entry: entry, into: &child)
    builder.children[head] = child
    builder.isDirectory = true
}
