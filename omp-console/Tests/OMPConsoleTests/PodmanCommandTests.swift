// Les `argv` de la pile, figés AU CARACTÈRE PRÈS (BR-2, S-2).
//
// Une option perdue (le `-p 127.0.0.1:` de l'isolation réseau, le `--network` du
// DNS entre conteneurs, le `-v` du stockage Qdrant) ferait diverger la pile de
// celle de S-2 sans qu'aucun test d'orchestration ne s'en aperçoive : c'est ici,
// sur les valeurs littérales, que ces formes sont tenues.

import Foundation
import Testing

@testable import OMPConsole

private let paths = AppPaths(supportRoot: URL(fileURLWithPath: "/tmp/omp-br2-test", isDirectory: true))

// MARK: - Machine

@Test("all-in-one-app/AC-1 : `machine inspect` interroge la machine dédiée en JSON")
func machineInspectIsExact() {
    #expect(PodmanCommand.machineInspect("omp-console") == ["machine", "inspect", "omp-console", "--format", "json"])
}

@Test("all-in-one-app/AC-1 : `machine init` porte l'image du manifeste et les 4 vCPU/4096 Mo/50 GiB de S-2")
func machineInitIsExact() {
    #expect(
        PodmanCommand.machineInit("omp-console", image: "docker://quay.io/podman/machine-os:6.1") == [
            "machine", "init", "omp-console",
            "--image", "docker://quay.io/podman/machine-os:6.1",
            "--cpus", "4",
            "--memory", "4096",
            "--disk-size", "50",
        ]
    )
}

@Test("all-in-one-app/AC-1 : `machine start` et `machine rm -f` nomment la machine dédiée")
func machineStartAndRemoveAreExact() {
    #expect(PodmanCommand.machineStart("omp-console") == ["machine", "start", "omp-console"])
    #expect(PodmanCommand.machineRemove("omp-console") == ["machine", "rm", "-f", "omp-console"])
}

// MARK: - Réseau, images

@Test("all-in-one-app/AC-1 : `network inspect` puis `network create` du réseau de la pile")
func networkCommandsAreExact() {
    #expect(PodmanCommand.networkInspect("omp-console-stack") == ["network", "inspect", "omp-console-stack"])
    #expect(PodmanCommand.networkCreate("omp-console-stack") == ["network", "create", "omp-console-stack"])
}

@Test("all-in-one-app/AC-1 : les images se vérifient, se tirent et se construisent avec la référence épinglée")
func imageCommandsAreExact() {
    #expect(PodmanCommand.imageExists("docker.io/qdrant/qdrant:v1.19.0") == ["image", "exists", "docker.io/qdrant/qdrant:v1.19.0"])
    #expect(PodmanCommand.imagePull("docker.io/qdrant/qdrant:v1.19.0") == ["image", "pull", "docker.io/qdrant/qdrant:v1.19.0"])
    #expect(
        PodmanCommand.imageBuild(tag: "omp-console-mem0-http:1", context: URL(fileURLWithPath: "/tmp/ctx")) == [
            "image", "build", "-t", "omp-console-mem0-http:1", "/tmp/ctx",
        ]
    )
}

// MARK: - Conteneurs

@Test("all-in-one-app/AC-1 : inspecter/retirer/démarrer un conteneur ne nomme que lui, jamais l'ancienne pile")
func containerCommandsAreExact() {
    #expect(PodmanCommand.containerInspect("omp-console-qdrant") == ["container", "inspect", "omp-console-qdrant", "--format", "json"])
    #expect(PodmanCommand.containerRemove("omp-console-qdrant") == ["container", "rm", "-f", "omp-console-qdrant"])
    #expect(PodmanCommand.containerStart("omp-console-qdrant") == ["container", "start", "omp-console-qdrant"])
}

@Test("all-in-one-app/AC-1 : le `run` de Qdrant publie 6333 et 6334 sur 127.0.0.1 et monte le stockage de l'app")
func qdrantRunIsExact() {
    let arguments = PodmanCommand.qdrantRun(
        name: "omp-console-qdrant",
        image: "docker.io/qdrant/qdrant:v1.19.0",
        network: "omp-console-stack",
        storage: URL(fileURLWithPath: "/tmp/omp-br2-test/stack/qdrant_storage", isDirectory: true),
        apiKey: "mem0-local-qdrant-key"
    )
    #expect(
        arguments == [
            "run", "-d",
            "--name", "omp-console-qdrant",
            "--restart", "unless-stopped",
            "--network", "omp-console-stack",
            "-p", "127.0.0.1:6333:6333",
            "-p", "127.0.0.1:6334:6334",
            "-v", "/tmp/omp-br2-test/stack/qdrant_storage:/qdrant/storage",
            "-e", "QDRANT__SERVICE__API_KEY=mem0-local-qdrant-key",
            "docker.io/qdrant/qdrant:v1.19.0",
        ]
    )
}

@Test("all-in-one-app/AC-1 : le `run` de mem0-http porte les dix variables de `StackConfig` et son hôte Qdrant")
func mem0RunIsExact() {
    let config = StackConfig(
        qdrantApiKey: "key",
        mem0HttpToken: "mem0-token",
        omlxBaseURL: "http://host.containers.internal:8000/v1",
        omlxApiToken: "omlx-token",
        omlxLLMModel: "qwen3-8b",
        omlxEmbedModel: "bge-m3",
        embeddingDims: 1024
    )
    let arguments = PodmanCommand.mem0Run(
        name: "omp-console-mem0-http",
        image: "omp-console-mem0-http:1",
        network: "omp-console-stack",
        qdrantHost: "omp-console-qdrant",
        config: config
    )
    #expect(
        arguments == [
            "run", "-d",
            "--name", "omp-console-mem0-http",
            "--restart", "unless-stopped",
            "--network", "omp-console-stack",
            "-p", "127.0.0.1:8321:8321",
            "-e", "QDRANT_HOST=omp-console-qdrant",
            "-e", "QDRANT_PORT=6333",
            "-e", "QDRANT_API_KEY=key",
            "-e", "OMLX_BASE_URL=http://host.containers.internal:8000/v1",
            "-e", "OMLX_API_TOKEN=omlx-token",
            "-e", "OMLX_LLM_MODEL=qwen3-8b",
            "-e", "OMLX_EMBED_MODEL=bge-m3",
            "-e", "EMBEDDING_DIMS=1024",
            "-e", "MEM0_HTTP_TOKEN=mem0-token",
            "-e", "PYTHONUNBUFFERED=1",
            "omp-console-mem0-http:1",
        ]
    )
}

@Test("all-in-one-app/AC-1 : chaque publication de port est liée à 127.0.0.1, jamais à 0.0.0.0")
func everyPublishedPortBindsLoopback() {
    let qdrant = PodmanCommand.qdrantRun(
        name: "omp-console-qdrant",
        image: "docker.io/qdrant/qdrant:v1.19.0",
        network: "omp-console-stack",
        storage: paths.qdrantStorage,
        apiKey: "key"
    )
    let mem0 = PodmanCommand.mem0Run(
        name: "omp-console-mem0-http",
        image: "omp-console-mem0-http:1",
        network: "omp-console-stack",
        qdrantHost: "omp-console-qdrant",
        config: .defaults
    )
    for arguments in [qdrant, mem0] {
        var index = 0
        var seen = 0
        while index < arguments.count {
            if arguments[index] == "-p" {
                seen += 1
                #expect(arguments[index + 1].hasPrefix("127.0.0.1:"))
            }
            index += 1
        }
        #expect(seen >= 1)
    }
}

@Test("all-in-one-app/AC-1 : les noms de la pile sont ceux de S-2 et ne heurtent pas l'ancienne pile")
func stackNamesAreTheOnesOfS2() {
    #expect(MemoryStack.machineName == "omp-console")
    #expect(MemoryStack.networkName == "omp-console-stack")
    #expect(MemoryStack.qdrantContainer == "omp-console-qdrant")
    #expect(MemoryStack.mem0Container == "omp-console-mem0-http")
    #expect(MemoryStack.qdrantContainer != "mem0-qdrant")
    #expect(MemoryStack.mem0Container != "mem0-http")
}

// MARK: - Isolation et configuration

@Test("all-in-one-app/AC-1 : chaque invocation podman reçoit les XDG app-privés, sous la racine de support")
func environmentCarriesPrivateXDG() {
    let environment = PodmanCommand.environment(
        base: ["PATH": "/usr/bin", "XDG_CONFIG_HOME": "/home/other/.config"],
        paths: paths
    )
    #expect(environment["PATH"] == "/usr/bin")
    #expect(environment["XDG_CONFIG_HOME"] == "/tmp/omp-br2-test/config")
    #expect(environment["XDG_DATA_HOME"] == "/tmp/omp-br2-test/data")
}

@Test("all-in-one-app/AC-1 : le `containers.conf` app-privé porte `[engine] helper_binaries_dir`")
func containersConfIsExact() {
    let content = PodmanCommand.containersConf(
        helperBinariesDir: URL(fileURLWithPath: "/tmp/omp-br2-test/components/podman/6.1.3/bin", isDirectory: true)
    )
    #expect(content == "[engine]\nhelper_binaries_dir = [\"/tmp/omp-br2-test/components/podman/6.1.3/bin\"]\n")
}

// MARK: - Lecture d'un argv

@Test("all-in-one-app/AC-1 : le libellé d'une commande nomme le couple sous-commande, utile aux erreurs")
func labelsNameTheSubcommand() {
    #expect(PodmanCommand.label(of: ["machine", "init", "omp-console"]) == "machine init")
    #expect(PodmanCommand.label(of: ["image", "pull", "ref"]) == "image pull")
    #expect(PodmanCommand.label(of: ["network", "create", "omp-console-stack"]) == "network create")
    #expect(PodmanCommand.label(of: ["run", "-d", "--name", "x"]) == "run")
}

@Test("all-in-one-app/AC-1 : les ports publiés d'un `run` se lisent de ses `-p` (adresse ignorée)")
func publishedPortsComeFromArgv() {
    let arguments = PodmanCommand.qdrantRun(
        name: "omp-console-qdrant",
        image: "docker.io/qdrant/qdrant:v1.19.0",
        network: "omp-console-stack",
        storage: paths.qdrantStorage,
        apiKey: "key"
    )
    #expect(PodmanCommand.publishedPorts(in: arguments) == [6333, 6334])
    #expect(PodmanCommand.publishedPorts(in: ["run", "-p", "8321:8321", "img"]) == [8321])
}

@Test("all-in-one-app/AC-1 : deux références d'image égales à un préfixe de registre près sont la même image")
func imageReferencesIgnoreRegistryPrefix() {
    #expect(PodmanCommand.sameImage("docker://quay.io/podman/machine-os:6.1", "quay.io/podman/machine-os:6.1"))
    #expect(PodmanCommand.sameImage("localhost/omp-console-mem0-http:1", "omp-console-mem0-http:1"))
    #expect(PodmanCommand.sameImage("docker.io/qdrant/qdrant:v1.19.0", "docker.io/qdrant/qdrant:v1.19.0"))
    #expect(!PodmanCommand.sameImage("docker.io/qdrant/qdrant:v1.19.0", "docker.io/qdrant/qdrant:v1.18.0"))
}
