// Preuves de S-4 : le seul binaire que l'app héberge est le composant qu'elle a
// installé (ou l'échappatoire de test) — jamais un binaire système (AC-3).
//
// Aucun test ne dépend du PATH réel du poste : l'environnement est injecté et les
// binaires sont créés dans des racines temporaires.

import Foundation
import Testing
@testable import OMPConsole

/// Une racine de support temporaire.
private func makeRoot() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("omp-binary-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

/// Le binaire du composant, exécutable ou non.
@discardableResult
private func writeComponentBinary(paths: AppPaths, executable: Bool) throws -> URL {
    let binary = paths.ompDir(ComponentManifest.current.ompVersion).appendingPathComponent("omp")
    try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
    try FileManager.default.setAttributes([.posixPermissions: executable ? 0o755 : 0o644], ofItemAtPath: binary.path)
    return binary
}

/// Un `omp` système factice dans son propre dossier (ce que `PATH` trouverait).
private func writeSystemBinary(executable: Bool = true) throws -> URL {
    let directory = try makeRoot().appendingPathComponent("bun-bin")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let binary = directory.appendingPathComponent("omp")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
    try FileManager.default.setAttributes([.posixPermissions: executable ? 0o755 : 0o644], ofItemAtPath: binary.path)
    return binary
}

@Test("all-in-one-app/AC-3 : le composant est le seul candidat, même quand un omp système est dans le PATH")
func componentIsTheOnlyCandidate() throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = AppPaths(supportRoot: root)
    let component = try writeComponentBinary(paths: paths, executable: true)
    let system = try writeSystemBinary()
    let environment = ["PATH": system.deletingLastPathComponent().path, "HOME": "/h"]

    let candidates = OmpBinaryResolver.candidates(
        environment: environment, paths: paths, manifest: .current
    )
    #expect(candidates == [component.path], "un seul candidat : le composant de l'app")

    guard case .success(let resolved) = OmpBinaryResolver.resolve(
        environment: environment, paths: paths, manifest: .current
    ) else {
        Issue.record("le composant installé doit résoudre")
        return
    }
    #expect(resolved == component)
    #expect(resolved.path != system.path)
}

@Test("all-in-one-app/AC-3 : sans composant, un omp système ne sauve pas la résolution")
func systemBinaryNeverRescues() throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = AppPaths(supportRoot: root)
    let system = try writeSystemBinary()
    let environment = ["PATH": system.deletingLastPathComponent().path, "HOME": "/h"]

    let searched = paths.ompDir(ComponentManifest.current.ompVersion).appendingPathComponent("omp").path
    let resolution = OmpBinaryResolver.resolve(environment: environment, paths: paths, manifest: .current)
    guard case .failure(let error) = resolution else {
        Issue.record("un omp système ne doit jamais être retenu")
        return
    }
    #expect(error == .binaryNotFound(searched: [searched], override: nil))
}

@Test("all-in-one-app/AC-3 : OMP_CONSOLE_OMP_BINARY est le seul candidat quand elle est posée")
func overrideIsAlone() throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = AppPaths(supportRoot: root)
    let component = try writeComponentBinary(paths: paths, executable: true)
    let override = try writeSystemBinary()

    let environment = [OmpBinaryResolver.overrideKey: override.path, "PATH": "/usr/bin"]
    #expect(OmpBinaryResolver.candidates(environment: environment, paths: paths, manifest: .current) == [override.path])
    guard case .success(let resolved) = OmpBinaryResolver.resolve(
        environment: environment, paths: paths, manifest: .current
    ) else {
        Issue.record("l'override exécutable doit résoudre")
        return
    }
    #expect(resolved == override, "l'override passe avant le composant, jamais l'inverse")
    #expect(resolved != component)

    // Une variable vide est traitée comme absente : le composant reprend.
    let empty = [OmpBinaryResolver.overrideKey: "", "PATH": "/usr/bin"]
    #expect(OmpBinaryResolver.candidates(environment: empty, paths: paths, manifest: .current) == [component.path])
}

@Test("all-in-one-app/AC-3 : un composant non exécutable n'est jamais retenu")
func nonExecutableComponentIsMissing() throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = AppPaths(supportRoot: root)
    let component = try writeComponentBinary(paths: paths, executable: false)

    let resolution = OmpBinaryResolver.resolve(environment: [:], paths: paths, manifest: .current)
    guard case .failure(let error) = resolution else {
        Issue.record("un fichier non exécutable ne doit pas résoudre")
        return
    }
    #expect(error == .binaryNotFound(searched: [component.path], override: nil))
}

@Test("all-in-one-app/AC-3 : un override absent échoue et le message le nomme")
func missingOverrideFails() throws {
    let root = try makeRoot()
    defer { try? FileManager.default.removeItem(at: root) }
    let paths = AppPaths(supportRoot: root)
    let missing = root.appendingPathComponent("absent/omp").path

    let resolution = OmpBinaryResolver.resolve(
        environment: [OmpBinaryResolver.overrideKey: missing], paths: paths, manifest: .current
    )
    guard case .failure(let error) = resolution else {
        Issue.record("un override absent doit échouer")
        return
    }
    #expect(error == .binaryNotFound(searched: [missing], override: missing))
}
