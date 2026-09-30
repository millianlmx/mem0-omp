// L'identité de PORTÉE mem0 du projet ouvert (S-4) : le même algorithme que
// `projectId` du plugin mémoire, pour que l'app voie exactement les souvenirs
// qu'une session voit (AC-1, AC-4, AC-5).
//
// Miroir assumé de `omp-mem0-memory/state.ts` :
//  - `MANIFESTS` (state.ts:13-18) — la table des manifestes et leurs extracteurs ;
//  - `projectId` (state.ts:73-89) — override `MEM0_PROJECT_ID`, racine PRINCIPALE,
//    manifestes dans l'ordre, premier `*.xcodeproj`, puis `basename`.
//
// La racine principale n'est PAS recalculée ici : `TargetCatalog.primaryRoot`
// (Files/FilesTarget.swift) est l'unique formule, celle qui résout le `.git`
// FICHIER d'un worktree lié vers le dépôt principal — un worktree de feature ne
// doit jamais ouvrir une seconde portée, sans quoi les souvenirs écrits depuis le
// dépôt seraient introuvables depuis la feature.

import Foundation

enum MemoryScope {
    /// La table des manifestes, dans l'ordre de `state.ts:13-18` : le premier qui
    /// porte un nom non vide gagne.
    static let manifestNames = ["package.json", "pyproject.toml", "Cargo.toml", "Package.swift"]

    /// La portée du projet, ou `nil` quand elle n'est pas calculable (aucun projet
    /// ouvert, dépôt git introuvable, `rev-parse` en échec) — S-4 en fait l'état
    /// « Aucun projet ouvert », sans aucun appel réseau.
    static func scope(
        projectRoot: String,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        git: GitCLI
    ) async -> String? {
        // `||` du plugin : une variable posée mais VIDE est traitée comme absente.
        if let override = environment["MEM0_PROJECT_ID"], !override.isEmpty {
            return override
        }
        guard let primary = try? await TargetCatalog.primaryRoot(git: git, projectRoot: projectRoot) else {
            return nil
        }
        if let named = manifestName(in: primary) {
            return named
        }
        if let xcode = firstXcodeProject(in: primary) {
            return xcode
        }
        return (primary as NSString).lastPathComponent
    }

    // MARK: - Manifestes

    /// `FileManager.default` est employé directement : le type n'est pas `Sendable`
    /// ici, et le traverser d'un acteur à l'autre serait une course inutile.
    private static func manifestName(in directory: String) -> String? {
        let fileManager = FileManager.default
        for name in manifestNames {
            guard let data = fileManager.contents(atPath: joinPath(directory, name)) else { continue }
            let text = String(decoding: data, as: UTF8.self)
            let extracted: String?
            switch name {
            case "package.json":
                extracted = packageName(text)
            case "Package.swift":
                extracted = firstMatch(#"\bname:\s*"([^"]+)""#, in: text)
            default:
                // pyproject.toml et Cargo.toml partagent le même motif (state.ts:15-16).
                extracted = firstMatch(#"^\s*name\s*=\s*"([^"]+)""#, in: text)
            }
            // `if (name)` du plugin : un nom vide ne gagne pas.
            if let extracted, !extracted.isEmpty { return extracted }
        }
        return nil
    }

    private static func packageName(_ text: String) -> String? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let name = object["name"] as? String
        else { return nil }
        return name
    }

    private static func firstMatch(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let captured = Range(match.range(at: 1), in: text)
        else { return nil }
        return String(text[captured])
    }

    /// Le premier `*.xcodeproj` du répertoire, par ordre alphabétique (le `readdir`
    /// du plugin n'impose aucun ordre : on fixe le nôtre pour que la portée soit
    /// déterministe), sans son extension.
    private static func firstXcodeProject(in directory: String) -> String? {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: directory) else { return nil }
        guard let first = entries.filter({ $0.hasSuffix(".xcodeproj") }).sorted().first else { return nil }
        let name = (first as NSString).deletingPathExtension
        return name.isEmpty ? nil : name
    }
}
