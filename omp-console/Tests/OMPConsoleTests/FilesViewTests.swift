// Ce que la section « Fichiers » MONTRE, figé sans rendre de vue (BR-2) : la couleur
// d'un retrait et d'un ajout, la colonne unique du diff, et les textes de chaque état.
//
// SwiftUI ne s'inspecte pas depuis la suite (aucune bibliothèque d'inspection n'est
// disponible) : tout ce qui décide de ce qui s'affiche vit donc dans des fonctions
// pures que ce fichier confronte, plutôt que dans le corps d'une `View`. Le contrat
// de section, lui, est vérifié par `ConsoleViewTests`.

import AppKit
import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test("visionneuse-de-fichiers-et-diffs/AC-12 : retraits en rouge, ajouts en vert, en-tête et hunk en style secondaire")
func diffLinesCarryTheirColour() {
    let diff = FilesDiff.parse(
        """
        diff --git a/tracked.txt b/tracked.txt
        index 7898192..422c2b7 100644
        --- a/tracked.txt
        +++ b/tracked.txt
        @@ -1 +1,2 @@
         a
        +b
        -old
        \\ No newline at end of file
        """
    )
    let lines = diff.lines
    #expect(lines.map(\.kind) == [.header, .header, .header, .header, .hunk, .context, .addition, .removal, .note])

    // La RÈGLE de S-9, telle quelle : rouge pour un retrait, vert pour un ajout, rien
    // pour les autres lignes.
    #expect(lines[7].tint == NSColor.systemRed)
    #expect(lines[6].tint == NSColor.systemGreen)
    #expect(lines[5].tint == nil)
    #expect(lines[0].tint == nil)
    #expect(lines[4].tint == nil)
    #expect(lines[8].tint == nil)

    // Le style secondaire : l'en-tête, la ligne `@@` et les notes — jamais une
    // couleur d'ajout ou de retrait.
    #expect(lines[0].isSecondary)
    #expect(lines[4].isSecondary)
    #expect(lines[8].isSecondary)
    #expect(!lines[5].isSecondary)
    #expect(!lines[6].isSecondary)
    #expect(!lines[7].isSecondary)

    // La distinction ne repose pas sur la couleur seule : le signe de tête est là.
    #expect(lines[7].text.hasPrefix("-"))
    #expect(lines[6].text.hasPrefix("+"))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-12 : la colonne unique suit l'ordre de git — l'en-tête, puis chaque hunk dans l'ordre")
func diffIsASingleOrderedColumn() {
    let diff = FilesDiff.parse(
        """
        diff --git a/a.txt b/a.txt
        --- a/a.txt
        +++ b/a.txt
        @@ -1 +1 @@
        -one
        +two
        @@ -9 +9 @@
        -nine
        +ten
        """
    )
    #expect(diff.hunks.count == 2)
    #expect(diff.lines.map(\.text) == [
        "diff --git a/a.txt b/a.txt",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1 +1 @@",
        "-one",
        "+two",
        "@@ -9 +9 @@",
        "-nine",
        "+ten",
    ])
    // Aucun tri, aucun regroupement : la vue rend `lines` tel quel, une ligne par rang.
    #expect(diff.lines.count == diff.header.count + diff.hunks.reduce(0) { $0 + $1.count })
}

@Test("visionneuse-de-fichiers-et-diffs/AC-9 : un document dédié absent dit SON absence, un fichier de l'arbre dit la sienne")
func dedicatedAbsenceHasItsOwnText() {
    #expect(FilesContent.missing.message(dedicated: FilesModel.contractRelativePath) == FilesText.noContract)
    #expect(FilesContent.missing.message(dedicated: FilesModel.projectDocumentRelativePath) == FilesText.noProjectDocument)
    #expect(FilesContent.missing.message(dedicated: nil) == FilesText.missingFile)
    #expect(FilesText.noContract == "Aucun contrat .omp/pipeline/contract.md dans cette cible.")
    #expect(FilesText.noProjectDocument == "Aucun PROJECT.md dans cette cible.")
    // Jamais un contenu vide muet : le contenu rendu est bien du texte, pas un message.
    #expect(FilesContent.text("").message(dedicated: nil) == FilesText.emptyFile)
    #expect(FilesContent.text("# contrat\n").message(dedicated: FilesModel.contractRelativePath) == nil)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-7 : un binaire et une lecture refusée ont chacun leur texte")
func binaryAndUnreadableTexts() {
    #expect(FilesContent.binary(bytes: 2048).message(dedicated: nil) == "Fichier binaire (2048 octets) — affichage indisponible.")
    #expect(FilesContent.unreadable("Permission denied").message(dedicated: nil) == "Lecture impossible : Permission denied.")
}

@Test("visionneuse-de-fichiers-et-diffs/AC-3 : les textes de la section qui dépendent d'une valeur la montrent")
func valueDependentTexts() {
    #expect(FilesText.baseUnavailable(reason: "pas de base de fusion avec main").contains("pas de base de fusion avec main"))
    #expect(FilesText.loading("/tmp/cible").contains("/tmp/cible"))
    #expect(FilesError.watchFailed(path: "/tmp/cible").userMessage.contains("/tmp/cible"))
    #expect(FilesError.targetGone(path: "/tmp/cible").userMessage.contains("/tmp/cible"))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-1 : seul un fichier qui diffère du dépôt porte un badge, chacun le sien")
func entryKindsHaveTheirBadge() {
    #expect(FilesText.badge(for: .tracked) == nil)
    let untracked = FilesText.badge(for: .untracked)
    let deleted = FilesText.badge(for: .deleted)
    #expect(untracked != nil)
    #expect(deleted != nil)
    #expect(untracked != deleted)
}

@Test("omp-console-redesign/C8 : la comparaison se dit seulement quand une base est calculable, et distingue HEAD du départ de branche")
func comparisonOnlyForAComputableBase() {
    #expect(FilesText.comparison(.unavailable("pas de base")) == nil)
    let head = FilesText.comparison(.head)
    let branchStart = FilesText.comparison(.commit("0123456789abcdef0123456789abcdef01234567"))
    #expect(head != nil)
    #expect(branchStart != nil)
    #expect(head != branchStart)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-9 : un diff sans ligne de contenu (fichier ajouté vide) est distingué d'un binaire")
func emptyAdditionIsNotABinary() {
    // Fichier non suivi de 0 octet : git n'écrit que l'en-tête.
    let empty = FilesDiff.parse(
        """
        diff --git a/vide.txt b/vide.txt
        new file mode 100644
        index 0000000..e69de29
        """
    )
    #expect(!empty.isEmpty)
    #expect(empty.hunks.isEmpty)
    #expect(empty.hasNoContent)

    let binary = FilesDiff.parse(
        """
        diff --git a/logo.png b/logo.png
        index 1111111..2222222 100644
        Binary files a/logo.png and b/logo.png differ
        """
    )
    #expect(binary.hunks.isEmpty)
    #expect(!binary.hasNoContent)
}
