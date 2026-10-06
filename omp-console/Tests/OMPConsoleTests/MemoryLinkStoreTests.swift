// Le fichier des liens MANUELS (S-11) : normalisation, lecture tolérante, écriture
// atomique et élagage — sur des racines JETABLES, jamais la racine de l'app.

import Foundation
import Testing

@testable import OMPConsole

/// Une racine jetable et son fichier de liens, supprimés en sortie.
private func temporaryLinks() -> (url: URL, cleanup: () -> Void) {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-console-links-\(UUID().uuidString)", isDirectory: true)
    return (
        url: root.appendingPathComponent(MemoryLinkStore.fileName),
        cleanup: { try? FileManager.default.removeItem(at: root) }
    )
}

@Test("graph-based-memeries-view/AC-13 : la forme canonique d'un lien ordonne ses extrémités et refuse l'auto-lien")
func ac13LinkNormalization() {
    #expect(MemoryLinkStore.normalized("b", "a") == MemoryLink(a: "a", b: "b"))
    #expect(MemoryLinkStore.normalized("a", "b") == MemoryLink(a: "a", b: "b"))
    #expect(MemoryLinkStore.normalized("a", "a") == nil)
    #expect(MemoryLinkStore.normalized("", "a") == nil)
    #expect(MemoryLinkStore.normalized("  ", "a") == nil)
    // Les blancs de bord ne créent pas deux liens distincts.
    #expect(MemoryLinkStore.normalized(" a ", "b") == MemoryLink(a: "a", b: "b"))
}

@Test("graph-based-memeries-view/AC-13 : un fichier absent, corrompu ou d'une autre version vaut un registre VIDE")
func ac13LoadIsTolerant() throws {
    let temporary = temporaryLinks()
    defer { temporary.cleanup() }
    let fileManager = FileManager.default
    try fileManager.createDirectory(at: temporary.url.deletingLastPathComponent(), withIntermediateDirectories: true)

    // Absent.
    #expect(MemoryLinkStore.load(temporary.url).isEmpty)

    // Non JSON.
    try Data("pas du json".utf8).write(to: temporary.url)
    #expect(MemoryLinkStore.load(temporary.url).isEmpty)

    // Une autre version.
    try memoryJSON(["version": 2, "links": [["a": "m-1", "b": "m-2"]]]).write(to: temporary.url)
    #expect(MemoryLinkStore.load(temporary.url).isEmpty)

    // JSON valide mais structure inattendue.
    try memoryJSON(["version": 1, "links": "pas un tableau"]).write(to: temporary.url)
    #expect(MemoryLinkStore.load(temporary.url).isEmpty)
    try memoryJSON(["links": [["a": "m-1", "b": "m-2"]]]).write(to: temporary.url)
    #expect(MemoryLinkStore.load(temporary.url).isEmpty)
}

@Test("graph-based-memeries-view/AC-13 : une entrée mal typée est écartée, les entrées valides survivent")
func ac13LoadKeepsValidEntriesOnly() throws {
    let temporary = temporaryLinks()
    defer { temporary.cleanup() }
    try FileManager.default.createDirectory(at: temporary.url.deletingLastPathComponent(), withIntermediateDirectories: true)
    let entries: [Any] = [
        ["a": "m-2", "b": "m-1"],
        ["a": "m-3"],
        ["a": 3, "b": "m-4"],
        ["a": "m-5", "b": "m-5"],
        ["a": "m-6", "b": "m-7"],
        "pas un objet",
    ]
    try memoryJSON(["version": 1, "links": entries]).write(to: temporary.url)

    let links = MemoryLinkStore.load(temporary.url)

    #expect(links == [MemoryLink(a: "m-1", b: "m-2"), MemoryLink(a: "m-6", b: "m-7")])
}

@Test("graph-based-memeries-view/AC-13 : un lien enregistré est relu par un store NEUF (relance simulée)")
func ac13SavedLinkSurvivesARelaunch() throws {
    let temporary = temporaryLinks()
    defer { temporary.cleanup() }

    #expect(MemoryLinkStore.save([MemoryLink(a: "m-1", b: "m-2")], to: temporary.url))
    // Un store NEUF (aucun état en mémoire) relit le fichier.
    #expect(MemoryLinkStore.load(temporary.url) == [MemoryLink(a: "m-1", b: "m-2")])
    // Le fichier est bien le format annoncé, répertoire créé au passage.
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: temporary.url)) as? [String: Any]
    #expect(root?["version"] as? Int == 1)
    #expect((root?["links"] as? [Any])?.count == 1)
}

@Test("graph-based-memeries-view/AC-14 : un lien détaché ne revient pas après relance")
func ac14DetachedLinkDoesNotComeBack() throws {
    let temporary = temporaryLinks()
    defer { temporary.cleanup() }

    #expect(MemoryLinkStore.save([MemoryLink(a: "m-1", b: "m-2"), MemoryLink(a: "m-3", b: "m-4")], to: temporary.url))
    #expect(MemoryLinkStore.save([MemoryLink(a: "m-3", b: "m-4")], to: temporary.url))

    #expect(MemoryLinkStore.load(temporary.url) == [MemoryLink(a: "m-3", b: "m-4")])
}

@Test("graph-based-memeries-view/AC-15 : l'élagage retire tout lien dont une extrémité a disparu")
func ac15PruneRemovesOrphans() {
    let links: Set<MemoryLink> = [
        MemoryLink(a: "m-1", b: "m-2"),
        MemoryLink(a: "m-1", b: "m-3"),
        MemoryLink(a: "m-4", b: "m-5"),
    ]

    #expect(MemoryLinkStore.prune(links, keeping: ["m-1", "m-2"]) == [MemoryLink(a: "m-1", b: "m-2")])
    #expect(MemoryLinkStore.prune(links, keeping: []) == [])
    #expect(MemoryLinkStore.prune(links, keeping: ["m-1", "m-2", "m-3", "m-4", "m-5"]) == links)
}

@Test("graph-based-memeries-view/AC-11 : un échec d'écriture est rendu à l'appelant, jamais silencieux")
func ac11SaveFailureIsReported() throws {
    // Un fichier là où le répertoire est attendu : l'écriture ne peut pas aboutir.
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-console-links-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try Data("obstacle".utf8).write(to: root)

    let url = root.appendingPathComponent(MemoryLinkStore.fileName)

    #expect(MemoryLinkStore.save([MemoryLink(a: "m-1", b: "m-2")], to: url) == false)
}
