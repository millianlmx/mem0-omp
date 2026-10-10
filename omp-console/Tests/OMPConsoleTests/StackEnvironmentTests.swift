// L'environnement d'exécution privé de podman (S-1, AC-3) : le `TMPDIR` de l'app
// existe, est privé (0700), et précède la PREMIÈRE commande podman — c'est lui qui
// déplace `gvproxy.pid`, `gvproxy.log` et les sockets hors du `$TMPDIR` système
// (mesuré le 2026-10-06 : les artefacts des deux machines cohabitaient).

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test("bug-embedded-podman-machine/AC-3 : le TMPDIR privé est créé en 0700 AVANT la première commande podman")
func tmpDirIsCreatedPrivateBeforeAnyPodmanCall() async throws {
    let sandbox = try StackSandbox()
    defer { sandbox.remove() }
    let fake = FakePodman()
    fake.confPath = sandbox.paths.configDir.appendingPathComponent("containers/containers.conf").path
    fake.tmpPath = sandbox.paths.tmpDir.path
    #expect(!FileManager.default.fileExists(atPath: sandbox.paths.tmpDir.path))

    try await sandbox.stack(run: fake.runner(), session: stubSession()).ensureRunning { _ in }

    #expect(fake.tmpExistedAtFirstCall == true)
    var isDirectory: ObjCBool = false
    #expect(FileManager.default.fileExists(atPath: sandbox.paths.tmpDir.path, isDirectory: &isDirectory))
    #expect(isDirectory.boolValue)
    let attributes = try FileManager.default.attributesOfItem(atPath: sandbox.paths.tmpDir.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o700)
}

@Test("bug-embedded-podman-machine/AC-3 : AppPaths.tmpDir vit sous la racine de support, jamais sous un chemin système partagé")
func tmpDirLivesUnderTheSupportRoot() {
    let paths = AppPaths(supportRoot: URL(fileURLWithPath: "/tmp/omp-racine", isDirectory: true))
    #expect(paths.tmpDir.path == "/tmp/omp-racine/tmp")
    #expect(paths.tmpDir.path.hasPrefix(paths.supportRoot.path))
    #expect(paths.tmpDir.path != "/tmp")
}
