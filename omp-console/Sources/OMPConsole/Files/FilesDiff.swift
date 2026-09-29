// Le diff unifié, découpé en lignes typées et colorables (S-9).
//
// `parse` est PURE : elle ne lit rien, elle classe. Le texte de chaque ligne est
// celui de git AU CARACTÈRE PRÈS (aucun rognage, aucun réindentage) — ce qui garde
// vrai le fait que le rendu est exactement ce que `git diff` a écrit, et rend la
// comparaison hunk à hunk d'AC-3 testable.

import AppKit
import Foundation

enum FilesDiffLineKind: Sendable, Equatable {
    /// `diff --git`, `index`, `new file mode`, `---`, `+++`…
    case header
    /// La ligne `@@ … @@` qui ouvre un hunk.
    case hunk
    case context
    case addition
    case removal
    /// `\ No newline at end of file`, « Binary files … differ ».
    case note
}

struct FilesDiffLine: Sendable, Equatable {
    var kind: FilesDiffLineKind
    var text: String
}

struct FilesDiff: Sendable, Equatable {
    /// `diff --git`, `index`, `new file mode`, `---`, `+++` (et les notes).
    var header: [FilesDiffLine]
    /// Un tableau par hunk, DANS L'ORDRE de git.
    var hunks: [[FilesDiffLine]]
    var isEmpty: Bool

    /// Toutes les lignes, dans l'ordre : c'est la seule façon dont la vue rend un
    /// diff — une colonne, un hunk après l'autre.
    var lines: [FilesDiffLine] {
        header + hunks.flatMap { $0 }
    }

    static func parse(_ output: String) -> FilesDiff {
        let raw = output
            .split(separator: "\n", omittingEmptySubsequences: true)
            .map(String.init)

        var header: [FilesDiffLine] = []
        var hunks: [[FilesDiffLine]] = []
        var current: [FilesDiffLine]?

        for line in raw {
            if line.hasPrefix("@@") {
                if let current { hunks.append(current) }
                current = [FilesDiffLine(kind: .hunk, text: line)]
                continue
            }
            guard current != nil else {
                // Avant le premier hunk : l'en-tête du fichier. `Binary files` et
                // `\ No newline` sont des NOTES — style secondaire, jamais une
                // couleur d'ajout ou de retrait.
                let kind: FilesDiffLineKind = line.hasPrefix("Binary files ") || line.hasPrefix("\\")
                    ? .note
                    : .header
                header.append(FilesDiffLine(kind: kind, text: line))
                continue
            }
            let kind: FilesDiffLineKind
            if line.hasPrefix("-") {
                kind = .removal
            } else if line.hasPrefix("+") {
                kind = .addition
            } else if line.hasPrefix("\\") {
                kind = .note
            } else {
                kind = .context
            }
            current?.append(FilesDiffLine(kind: kind, text: line))
        }
        if let current { hunks.append(current) }

        return FilesDiff(header: header, hunks: hunks, isEmpty: raw.isEmpty)
    }

    /// Vrai quand git n'a écrit AUCUNE ligne de contenu : le fichier ajouté est vide.
    /// Un fichier binaire, lui, porte une note — il ne doit pas être annoncé vide.
    var hasNoContent: Bool {
        hunks.isEmpty && !header.contains { $0.kind == .note }
    }
}

extension FilesDiffLine {
    /// La couleur exigée par S-9 : le rouge d'un retrait, le vert d'un ajout, rien
    /// pour les autres lignes. Elle vit ici, avec le découpage, parce qu'un test doit
    /// pouvoir la figer sans rendre une vue.
    var tint: NSColor? {
        switch kind {
        case .removal: .systemRed
        case .addition: .systemGreen
        case .header, .hunk, .context, .note: nil
        }
    }

    /// Le style secondaire : l'en-tête de fichier, la ligne `@@` et les notes — sans
    /// couleur d'ajout ni de retrait.
    var isSecondary: Bool {
        switch kind {
        case .header, .hunk, .note: true
        case .context, .addition, .removal: false
        }
    }
}
