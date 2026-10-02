// Preuves de S-1 : résolution du binaire `omp` et échec du lancement réel d'un
// chemin inexploitable (AC-14, BR-5 step 3).
//
// L'environnement est INJECTÉ : aucun test ne dépend du PATH réel du poste, sauf
// celui qui crée son propre exécutable dans un dossier temporaire. C'est ce qui
// rend la preuve du chemin « binaire introuvable » reproductible partout.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - Outils

/// Crée un dossier temporaire propre au test.
private func makeTemporaryDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("omp-binary-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

/// Écrit un fichier `omp` exécutable (ou non) dans un dossier.
@discardableResult
private func writeBinary(in directory: URL, executable: Bool) throws -> URL {
    let url = directory.appendingPathComponent("omp")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: url)
    try FileManager.default.setAttributes(
        [.posixPermissions: executable ? 0o755 : 0o644],
        ofItemAtPath: url.path
    )
    return url
}

// MARK: - Cas

@Test("client-rpc-omp/AC-14 : le premier candidat exécutable du PATH gagne")
func firstExecutablePathEntryWins() throws {
    let directory = try makeTemporaryDirectory()
    let binary = try writeBinary(in: directory, executable: true)

    let resolution = OmpBinaryResolver.resolve(environment: [
        "PATH": "/nonexistent-first:\(directory.path)",
        "HOME": "/nonexistent-home",
        "OMP_CONSOLE_OMP_BINARY": "",
    ], chosen: nil)

    guard case .success(let url) = resolution else {
        Issue.record("résolution attendue en succès, obtenu \(resolution)")
        return
    }
    #expect(url.path == binary.path)
}

@Test("client-rpc-omp/AC-14 : un chemin explicite non exécutable ne gagne jamais")
func nonExecutableOverrideNeverWins() throws {
    let directory = try makeTemporaryDirectory()
    let binary = try writeBinary(in: directory, executable: false)

    let resolution = OmpBinaryResolver.resolve(environment: [
        "PATH": "/nonexistent",
        "HOME": "/nonexistent",
        "OMP_CONSOLE_OMP_BINARY": binary.path,
    ])

    guard case .failure(let error) = resolution else {
        Issue.record("un fichier non exécutable ne doit pas être retenu")
        return
    }
    #expect(error == .binaryNotFound(searched: [binary.path], override: binary.path))
    #expect(error.userMessage.contains("Binaire `omp` introuvable"))
    #expect(error.userMessage.contains("Chemin demandé : \(binary.path)"))
}

@Test("client-rpc-omp/AC-14 : un chemin explicite absent échoue et le message le nomme")
func missingOverrideFails() {
    let resolution = OmpBinaryResolver.resolve(environment: [
        "PATH": "/nonexistent",
        "HOME": "/nonexistent",
        "OMP_CONSOLE_OMP_BINARY": "/nonexistent/omp",
    ])

    guard case .failure(let error) = resolution else {
        Issue.record("un chemin absent ne doit pas être retenu")
        return
    }
    #expect(error == .binaryNotFound(searched: ["/nonexistent/omp"], override: "/nonexistent/omp"))
    #expect(error.userMessage == "Binaire `omp` introuvable : cherché dans PATH, ~/.bun/bin, /opt/homebrew/bin, /usr/local/bin. Chemin demandé : /nonexistent/omp")
}

@Test("client-rpc-omp/AC-14 : l'ordre des candidats est celui de S-1")
func candidateOrderFollowsSpecification() {
    let candidates = OmpBinaryResolver.candidates(environment: ["PATH": "/a:/b", "HOME": "/h"])
    #expect(candidates == [
        "/a/omp",
        "/b/omp",
        "/omp",
        "/h/.bun/bin/omp",
        "/opt/homebrew/bin/omp",
        "/usr/local/bin/omp",
    ])
}

@Test("client-rpc-omp/AC-14 : un PATH absent laisse les candidats de repli")
func missingPathKeepsFallbacks() {
    let candidates = OmpBinaryResolver.candidates(environment: ["HOME": "/h"])
    #expect(candidates == [
        "/omp",
        "/h/.bun/bin/omp",
        "/opt/homebrew/bin/omp",
        "/usr/local/bin/omp",
    ])
}

@Test("client-rpc-omp/AC-14 : un HOME absent omet le candidat ~/.bun/bin")
func missingHomeDropsBunCandidate() {
    let candidates = OmpBinaryResolver.candidates(environment: ["PATH": "/a"])
    #expect(candidates == [
        "/a/omp",
        "/omp",
        "/opt/homebrew/bin/omp",
        "/usr/local/bin/omp",
    ])
}

@Test("client-rpc-omp/AC-14 : une variable d'échappement vide est traitée comme absente")
func emptyOverrideIsIgnored() {
    var environment = ["PATH": "/a", "HOME": "/h"]
    environment["OMP_CONSOLE_OMP_BINARY"] = ""
    #expect(OmpBinaryResolver.candidates(environment: environment).first == "/a/omp")
}

@Test("omp-console-redesign/AC-7 : l'emplacement choisi passe avant PATH, jamais avant la variable d'échappement")
func chosenPathComesAfterOverrideBeforePath() throws {
    #expect(OmpBinaryResolver.candidates(environment: ["PATH": "/a", "HOME": "/h"], chosen: "/choisi/omp") == [
        "/choisi/omp",
        "/a/omp",
        "/omp",
        "/h/.bun/bin/omp",
        "/opt/homebrew/bin/omp",
        "/usr/local/bin/omp",
    ])
    #expect(OmpBinaryResolver.candidates(
        environment: ["PATH": "/a", "OMP_CONSOLE_OMP_BINARY": "/x/omp"], chosen: "/choisi/omp"
    ) == ["/x/omp"], "un chemin imposé reste le SEUL candidat")

    // Un `omp` choisi hors des emplacements connus est trouvé.
    let directory = try makeTemporaryDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let binary = try writeBinary(in: directory, executable: true)
    let resolution = OmpBinaryResolver.resolve(
        environment: ["PATH": "/nonexistent", "HOME": "/nonexistent"],
        chosen: binary.path
    )
    guard case .success(let url) = resolution else {
        Issue.record("l'emplacement choisi devait être retenu, obtenu \(resolution)")
        return
    }
    #expect(url.path == binary.path)

    // Une préférence vide est absente.
    let suite = "omp-binary-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    defaults.set("", forKey: OmpBinaryResolver.chosenPathKey)
    #expect(OmpBinaryResolver.chosenPath(defaults: defaults) == nil)
}

@Test("client-rpc-omp/AC-14 : le lancement réel d'un chemin inexploitable lève sans session vivante")
@MainActor
func realLaunchOfInvalidPathThrows() throws {
    let directory = try makeTemporaryDirectory()
    let transport = ProcessTransport()
    let missing = directory.appendingPathComponent("absent-omp")

    #expect(throws: (any Error).self) {
        try transport.start(binary: missing, arguments: [], cwd: directory)
    }
    #expect(transport.isRunning == false)
    #expect(transport.pid == nil)
}
