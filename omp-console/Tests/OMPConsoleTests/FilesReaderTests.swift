// Le contenu d'un fichier, à l'identique (S-5, AC-7).

import Foundation
import Testing

@testable import OMPConsole

@Test("visionneuse-de-fichiers-et-diffs/AC-7 : le contenu rendu est exactement celui du disque, accents et fin de ligne comprises")
func contentIsByteExact() throws {
    let fixture = try FilesFixture()
    let sample = "ligne accentuée : éàü\nsans fin de ligne finale : ✓"
    let path = try fixture.write("accents.txt", sample)

    guard case let .text(text) = FilesReader.read(path: path, fileManager: .default) else {
        Issue.record("un fichier UTF-8 textuel doit être rendu en texte")
        return
    }
    #expect(text == sample)
    #expect(text.utf8.count == Data(sample.utf8).count)
    // Le contenu n'est ni rogné, ni normalisé : pas de numérotation, pas de \n ajouté.
    #expect(!text.hasSuffix("\n"))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-7 : un fichier vide est du texte vide, un NUL le classe binaire")
func binaryAndEmptyAreClassified() throws {
    let fixture = try FilesFixture()
    let empty = try fixture.write("empty.txt", "")
    #expect(FilesReader.read(path: empty, fileManager: .default) == .text(""))

    let withNul = joinPath(fixture.root, "binary.bin")
    try Data([0x41, 0x00, 0x42]).write(to: URL(fileURLWithPath: withNul))
    #expect(FilesReader.read(path: withNul, fileManager: .default) == .binary(bytes: 3))

    let invalid = joinPath(fixture.root, "latin1.txt")
    try Data([0xE9, 0xE8]).write(to: URL(fileURLWithPath: invalid))  // latin-1, pas de NUL
    #expect(FilesReader.read(path: invalid, fileManager: .default) == .binary(bytes: 2))
}

@Test("visionneuse-de-fichiers-et-diffs/AC-7 : un chemin absent est « missing », jamais un contenu erroné")
func missingPathIsMissing() throws {
    let fixture = try FilesFixture()
    let path = joinPath(fixture.root, "jamais-ecrit.txt")
    #expect(FilesReader.read(path: path, fileManager: .default) == .missing)
}

@Test("visionneuse-de-fichiers-et-diffs/AC-7 : lire un fichier ne le modifie pas — octets et date inchangés")
func readingDoesNotTouchTheFile() throws {
    let fixture = try FilesFixture()
    let path = try fixture.write("stable.txt", "contenu\n")
    let url = URL(fileURLWithPath: path)
    let before = try FileManager.default.attributesOfItem(atPath: path)
    let beforeData = try Data(contentsOf: url)

    for _ in 0..<3 {
        #expect(FilesReader.read(path: path, fileManager: .default) == .text("contenu\n"))
    }

    let after = try FileManager.default.attributesOfItem(atPath: path)
    #expect(try Data(contentsOf: url) == beforeData)
    #expect(after[.modificationDate] as? Date == before[.modificationDate] as? Date)
    #expect(after[.size] as? Int == before[.size] as? Int)
}
