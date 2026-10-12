// Les `argv` podman gardés pour la migration unique et le nettoyage, figés AU
// CARACTÈRE PRÈS : la migration et le nettoyage ne voient que ces formes.

import Foundation
import Testing

@testable import OMPConsole

private let paths = AppPaths(supportRoot: URL(fileURLWithPath: "/tmp/omp-br2-test", isDirectory: true))

// MARK: - Machine

@Test("all-in-one-app/AC-1 : `machine inspect` interroge la machine dédiée — le défaut de podman est le JSON, jamais `--format json` (template)")
func machineInspectIsExact() {
    #expect(PodmanCommand.machineInspect("omp-console") == ["machine", "inspect", "omp-console"])
}

@Test("all-in-one-app/AC-1 : `machine start`, `machine stop` et `machine rm -f` nomment la machine dédiée")
func machineStartAndRemoveAreExact() {
    #expect(PodmanCommand.machineStart("omp-console") == ["machine", "start", "omp-console"])
    #expect(PodmanCommand.machineStop("omp-console") == ["machine", "stop", "omp-console"])
    #expect(PodmanCommand.machineRemove("omp-console") == ["machine", "rm", "-f", "omp-console"])
}

// MARK: - Conteneurs

@Test("all-in-one-app/AC-1 : inspecter/démarrer un conteneur ne nomme que lui, jamais l'ancienne pile")
func containerCommandsAreExact() {
    #expect(PodmanCommand.containerInspect("omp-console-qdrant") == ["container", "inspect", "omp-console-qdrant", "--format", "json"])
    #expect(PodmanCommand.containerStart("omp-console-qdrant") == ["container", "start", "omp-console-qdrant"])
}

@Test("omp-console-sans-podman/AC-6 : l'arrêt de la migration ignore un conteneur absent, et `cp` sort history.db du conteneur vers l'hôte")
func migrationStopAndCopyAreExact() {
    #expect(
        PodmanCommand.containerStop(["omp-console-mem0-http", "omp-console-qdrant"])
            == ["stop", "--ignore", "omp-console-mem0-http", "omp-console-qdrant"]
    )
    #expect(
        PodmanCommand.copyOut(
            container: "omp-console-mem0-http",
            path: "/home/mem0/.mem0/history.db",
            to: URL(fileURLWithPath: "/tmp/omp-br2-test/stack/podman-migration/history.db")
        ) == ["cp", "omp-console-mem0-http:/home/mem0/.mem0/history.db", "/tmp/omp-br2-test/stack/podman-migration/history.db"]
    )
}

// MARK: - Isolation et configuration

@Test("bug-embedded-podman-machine/AC-3 : chaque invocation podman reçoit les XDG app-privés ET le TMPDIR privé, sous la racine de support")
func environmentCarriesPrivateXDG() {
    let environment = PodmanCommand.environment(
        base: ["PATH": "/usr/bin", "XDG_CONFIG_HOME": "/home/other/.config", "TMPDIR": "/var/folders/autre/T"],
        paths: paths
    )
    #expect(environment["PATH"] == "/usr/bin")
    #expect(environment["XDG_CONFIG_HOME"] == "/tmp/omp-br2-test/config")
    #expect(environment["XDG_DATA_HOME"] == "/tmp/omp-br2-test/data")
    // Le TMPDIR du process est ÉCRASÉ : c'est lui qui déplace gvproxy.pid,
    // gvproxy.log et les sockets hors du dossier partagé `$TMPDIR/podman/`.
    #expect(environment["TMPDIR"] == "/tmp/omp-br2-test/tmp")
}

@Test("all-in-one-app/AC-1 : le `containers.conf` app-privé porte `[engine] helper_binaries_dir`")
func containersConfIsExact() {
    let content = PodmanCommand.containersConf(
        helperBinariesDir: URL(fileURLWithPath: "/tmp/omp-br2-test/components/podman/6.1.3/bin", isDirectory: true)
    )
    #expect(content == "[engine]\nhelper_binaries_dir = [\"/tmp/omp-br2-test/components/podman/6.1.3/bin\"]\n")
}
