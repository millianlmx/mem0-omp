// Le découpage d'un corps de fait en texte et blocs de diff unifié, et la
// classification ligne à ligne d'un diff (S-1 de la feature
// `visionneuse-de-session`).
//
// Deux formats RÉELS doivent tomber juste (Documentation §6) :
//   — le diff d'édition d'OMP (`message.details.diff`, outils `edit`/`write`/
//     `apply_patch`) n'est PAS un diff unifié : `<marqueur><numéro>|<texte>`,
//     marqueur ∈ {' ', '-', '+'}. Toute la classification se fait donc sur le
//     PREMIER caractère, sans cas particulier ;
//   — un diff unifié reçu d'un outil quelconque est DÉTECTÉ dans le texte, puis
//     découpé en blocs ; le reste est du texte verbatim.
//
// `DiffLine.text` est la ligne d'ORIGINE, marqueur compris : la teinte colore, le
// marqueur reste lisible — la distinction ne repose donc pas sur la seule couleur
// (accessibilité).
//
// Aucune E/S, aucun état : que des fonctions pures.

import Foundation

/// La teinte d'une ligne de diff.
enum DiffTone: String, Equatable, Sendable {
    case added
    case removed
    case context
    case section
}

/// Une ligne de diff : ce qu'elle dit (`text`) et comment elle se peint (`tone`).
struct DiffLine: Equatable, Sendable {
    var tone: DiffTone
    var text: String
}

/// Un morceau de corps : du texte brut, ou un bloc de diff détecté.
enum BodySegment: Equatable, Sendable {
    case text(String)
    case diff([DiffLine])
}

// MARK: - Classification

/// Les en-têtes d'un diff unifié. Testés AVANT les caractères `+`/`-`/espace :
/// sans cela `+++ b/f` serait une addition et `--- a/f` une suppression.
private let diffSectionPrefixes = [
    "diff --git ", "index ", "new file mode ", "deleted file mode ",
    "similarity index ", "rename from ", "rename to ", "--- ", "+++ ", "@@",
]

/// Classe CHAQUE ligne d'un diff. L'ordre de décision est strict : le premier
/// motif qui matche gagne.
func diffLines(in diff: String) -> [DiffLine] {
    guard !diff.isEmpty else { return [] }
    return lines(of: diff).map { DiffLine(tone: tone(of: $0), text: $0) }
}

private func tone(of line: String) -> DiffTone {
    for prefix in diffSectionPrefixes where line.hasPrefix(prefix) { return .section }
    switch line.first {
    case "+": return .added
    case "-": return .removed
    default:
        // L'espace du contexte, et tout caractère non reconnu : une ligne
        // inconnue est du contexte, jamais une erreur.
        return .context
    }
}

// MARK: - Détection des blocs

/// Un bloc de diff unifié commence par `@@`, par `diff --git `, ou par `--- `
/// IMMÉDIATEMENT suivi de `+++ `.
private func startsDiffBlock(_ pieces: [String], _ index: Int) -> Bool {
    let line = pieces[index]
    if line.hasPrefix("@@") || line.hasPrefix("diff --git ") { return true }
    return line.hasPrefix("--- ") && index + 1 < pieces.count && pieces[index + 1].hasPrefix("+++ ")
}

/// Les têtes de ligne qui PROLONGENT un bloc : `\ ` est le marqueur
/// « \ No newline at end of file ».
private let diffBlockPrefixes = [
    "diff --git ", "index ", "new file mode ", "deleted file mode ",
    "similarity index ", "rename from ", "rename to ", "@@", "\\ ", " ", "+", "-",
]

private func continuesDiffBlock(_ line: String) -> Bool {
    for prefix in diffBlockPrefixes where line.hasPrefix(prefix) { return true }
    return false
}

/// Un bloc n'est RETENU que s'il porte au moins une addition ou une suppression
/// réelle : les seules têtes (`--- `, `+++ `) ne comptent pas.
private func containsChange(_ lines: ArraySlice<String>) -> Bool {
    lines.contains { line in
        guard let first = line.first, first == "+" || first == "-" else { return false }
        return !line.hasPrefix("--- ") && !line.hasPrefix("+++ ")
    }
}

/// La fin EXCLUSIVE du bloc maximal qui commence à `index`, ou `nil` s'il n'y a
/// pas là de bloc RETENU. Une ligne vide termine le bloc (un diff unifié n'en
/// porte pas).
private func diffBlockEnd(from index: Int, in pieces: [String]) -> Int? {
    guard startsDiffBlock(pieces, index) else { return nil }
    var end = index + 1
    while end < pieces.count, !pieces[end].isEmpty, continuesDiffBlock(pieces[end]) { end += 1 }
    return containsChange(pieces[index..<end]) ? end : nil
}

// MARK: - Découpage d'un corps

/// Découpe un texte QUELCONQUE en alternance de texte brut et de blocs de diff
/// unifié détectés. Les blocs sont maximaux et disjoints ; un texte sans aucun
/// bloc rend un unique `.text` VERBATIM.
func bodySegments(in text: String) -> [BodySegment] {
    guard !text.isEmpty else { return [] }
    let pieces = splitLines(text)
    var segments: [BodySegment] = []
    var textStart = 0
    var index = 0

    while index < pieces.count {
        guard let end = diffBlockEnd(from: index, in: pieces) else {
            index += 1
            continue
        }
        if index > textStart { segments.append(.text(textRange(textStart, index, in: pieces))) }
        segments.append(.diff(diffLines(in: pieces[index..<end].joined(separator: "\n"))))
        textStart = end
        index = end
    }
    if textStart < pieces.count { segments.append(.text(textRange(textStart, pieces.count, in: pieces))) }
    return segments
}

/// Les lignes d'un texte, découpées sur `\n` — le terminateur n'appartient pas au
/// contenu d'une ligne, la dernière ligne d'un texte qui finit par `\n` est donc
/// une ligne VIDE (elle termine un bloc de diff).
private func splitLines(_ text: String) -> [String] {
    text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
}

/// Les lignes d'un diff : le terminateur final n'est pas une ligne, il n'est donc
/// pas rendu comme une ligne de contexte vide.
private func lines(of diff: String) -> [String] {
    var pieces = splitLines(diff)
    if pieces.count > 1, pieces[pieces.count - 1].isEmpty { pieces.removeLast() }
    return pieces
}

/// Reconstruit le texte des lignes `[from, to)` AVEC les terminateurs d'origine —
/// la seule façon d'être verbatim. La dernière ligne d'un texte ne porte pas de
/// terminateur (le découpage sur `\n` l'a consommé), toutes les autres si.
private func textRange(_ from: Int, _ to: Int, in pieces: [String]) -> String {
    var joined = pieces[from..<to].joined(separator: "\n")
    if to - 1 < pieces.count - 1 { joined += "\n" }
    return joined
}
