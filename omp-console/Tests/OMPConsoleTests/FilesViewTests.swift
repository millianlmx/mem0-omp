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
    #expect(FilesText.noContract == "Aucun contrat dans ce dossier.")
    #expect(FilesText.noProjectDocument == "Aucun PROJECT.md dans ce dossier.")
    // Jamais un contenu vide muet : le contenu rendu est bien du texte, pas un message.
    #expect(FilesContent.text("").message(dedicated: nil) == FilesText.emptyFile)
    #expect(FilesContent.text("# contrat\n").message(dedicated: FilesModel.contractRelativePath) == nil)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-7 : un binaire et une lecture refusée ont chacun leur texte")
func binaryAndUnreadableTexts() {
    #expect(FilesContent.binary(bytes: 2048).message(dedicated: nil) == "Ce fichier n’est pas du texte : il ne peut pas être affiché.")
    // La raison brute ne s'affiche plus : elle part dans le diagnostic de la vue.
    #expect(FilesContent.unreadable("Permission denied").message(dedicated: nil) == FilesText.unreadable)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-3 : les textes de la section qui dépendent d'une valeur la montrent")
func valueDependentTexts() {
    #expect(FilesText.loading("/tmp/cible").contains("/tmp/cible"))
    // Le chemin d'une erreur de veille ou d'une cible disparue vit dans le diagnostic.
    #expect(FilesError.watchFailed(path: "/tmp/cible").diagnostic.contains("/tmp/cible"))
    #expect(FilesError.targetGone(path: "/tmp/cible").diagnostic.contains("/tmp/cible"))
}

// MARK: - jargon-technique-expose-mac-et-ios (S-8, S-10)

private let everyFilesError: [FilesError] = [
    .gitNotFound(searched: ["/usr/bin/git", "/opt/homebrew/bin/git"], override: nil, path: "/tmp/projet"),
    .gitNotFound(searched: ["/nowhere/git"], override: "/nowhere/git", path: "/tmp/projet"),
    .notARepository(path: "/tmp/projet"),
    .commandFailed(command: "ls-files", code: 128, detail: "fatal: bad object 1234567"),
    .commandTimedOut(command: "diff", seconds: 30),
    .gitCommandRefused(command: "push"),
    .targetGone(path: "/tmp/projet/feat"),
    .watchFailed(path: "/tmp/projet/feat"),
]

@Test("jargon-technique-expose-mac-et-ios/AC-6 : les phrases de Fichiers ne citent ni git, ni chemin, ni code, ni nombre")
func filesPhrasesHaveNoJargon() {
    let phrases = everyFilesError.map(\.userMessage)
        + [FilesText.readFailed, FilesText.unreadable, FilesText.baseUnavailable]
    for phrase in phrases {
        #expect(!phrase.lowercased().contains("git"), "\(phrase)")
        #expect(!phrase.contains("/"), "\(phrase)")
        #expect(!phrase.lowercased().contains("code"), "\(phrase)")
        let hasNumber = phrase.contains { $0.isNumber }
        #expect(!hasNumber, "\(phrase)")
    }
    #expect(FilesError.gitNotFound(searched: [], override: nil, path: "/p").userMessage == FilesText.gitNotFound)
    #expect(FilesText.gitNotFound == "Les outils de développement d’Apple sont introuvables : les fichiers ne peuvent pas être lus. Installez-les, puis rafraîchissez.")
    #expect(FilesText.notARepository == "Ce dossier n’est pas un projet suivi : ses fichiers ne peuvent pas être comparés. Choisissez un autre dossier dans la section « Session OMP ».")
    #expect(FilesText.commandFailed == "La lecture du projet a échoué : les fichiers ne peuvent pas être affichés. Rafraîchissez ; si l’échec revient, copiez le diagnostic.")
    #expect(FilesText.commandTimedOut == "La lecture du projet a pris trop de temps et a été abandonnée. Rafraîchissez pour réessayer.")
    #expect(FilesText.gitCommandRefused == "Une lecture non autorisée a été bloquée : rien n’a été modifié. Copiez le diagnostic pour le signaler.")
    #expect(FilesText.targetGone == "Ce dossier n’existe plus : choisissez-en un autre dans le menu « Dossier ».")
    #expect(FilesText.watchFailed == "Le suivi des modifications s’est arrêté : l’affichage ne se met plus à jour tout seul. Rafraîchissez pour le relancer.")
    #expect(FilesText.readFailed == "La lecture a échoué : les fichiers ne peuvent pas être affichés. Rafraîchissez ; si l’échec revient, copiez le diagnostic.")
    #expect(FilesText.unreadable == "Ce fichier ne peut pas être lu : il a disparu ou son accès est refusé. Rafraîchissez pour réessayer.")
    #expect(FilesText.baseUnavailable == "Les différences ne peuvent pas être calculées pour ce dossier : sa version de départ est introuvable.")
}

@Test("jargon-technique-expose-mac-et-ios/AC-7 : le diagnostic de Fichiers garde la commande git, le code, le stderr et le chemin")
func filesDiagnosticKeepsTheRawDetail() {
    let failed = FilesError.commandFailed(command: "ls-files", code: 128, detail: "fatal: bad object 1234567").failure
    #expect(failed.message == FilesText.commandFailed)
    #expect(failed.diagnostic.contains("git ls-files"))
    #expect(failed.diagnostic.contains("128"))
    #expect(failed.diagnostic.contains("fatal: bad object 1234567"))
    #expect(FilesError.commandTimedOut(command: "diff", seconds: 30).diagnostic.contains("git diff"))
    #expect(FilesError.gitCommandRefused(command: "push").diagnostic.contains("git push"))
    #expect(FilesError.notARepository(path: "/tmp/projet").diagnostic.contains("/tmp/projet"))
    #expect(FilesError.gitNotFound(searched: ["/nowhere/git"], override: nil, path: "/tmp/projet").diagnostic.contains("/nowhere/git"))
    for error in everyFilesError {
        #expect(FilesError.failure(for: error) == ReadableFailure(message: error.userMessage, diagnostic: error.diagnostic))
    }
    // Une erreur étrangère : la phrase générique, le `localizedDescription` en brut.
    let foreign = URLError(.fileDoesNotExist)
    #expect(FilesError.failure(for: foreign) == ReadableFailure(message: FilesText.readFailed, diagnostic: foreign.localizedDescription))
}

@Test("jargon-technique-expose-mac-et-ios/AC-8 : les libellés de Fichiers disent « dossier », sans octets ni worktree ni cible")
func filesLabelsAreReadable() {
    #expect(FilesText.targetPicker == "Dossier")
    #expect(FilesText.noFiles == "Aucun fichier dans ce dossier.")
    #expect(FilesText.noContract == "Aucun contrat dans ce dossier.")
    #expect(FilesText.noProjectDocument == "Aucun PROJECT.md dans ce dossier.")
    #expect(FilesText.binary == "Ce fichier n’est pas du texte : il ne peut pas être affiché.")
    for text in [FilesText.targetPicker, FilesText.noFiles, FilesText.noContract, FilesText.noProjectDocument, FilesText.binary, FilesText.baseUnavailable] {
        #expect(!text.lowercased().contains("worktree"), "\(text)")
        #expect(!text.lowercased().contains("cible"), "\(text)")
        #expect(!text.contains("octets"), "\(text)")
    }
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
