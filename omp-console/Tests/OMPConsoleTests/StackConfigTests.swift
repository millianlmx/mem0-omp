// La configuration de la pile et son fichier `stack/env` (BR-2, S-2/S-3/S-6).
//
// Les défauts sont ceux de `mem0-stack/.env.example` (mesurés le 2026-10-04) : un
// `.env` de la pile manuelle doit s'importer sans traduction, et le fichier de
// l'app doit se relire comme celui de la pile manuelle.

import Foundation
import Testing

@testable import OMPConsole

@Test("all-in-one-app/AC-1 : les défauts sont exactement ceux de `.env.example`")
func defaultsMatchTheExampleFile() {
    let defaults = StackConfig.defaults
    #expect(defaults.qdrantApiKey == "mem0-local-qdrant-key")
    #expect(defaults.mem0HttpToken == "")
    #expect(defaults.omlxBaseURL == "http://host.containers.internal:8000/v1")
    #expect(defaults.omlxApiToken == "")
    #expect(defaults.omlxLLMModel == "qwen3-8b")
    #expect(defaults.omlxEmbedModel == "bge-m3")
    #expect(defaults.embeddingDims == 1024)
    #expect(StackConfig.keys == [
        "QDRANT_API_KEY", "MEM0_HTTP_TOKEN", "OMLX_BASE_URL",
        "OMLX_API_TOKEN", "OMLX_LLM_MODEL", "OMLX_EMBED_MODEL", "EMBEDDING_DIMS",
    ])
}

@Test("all-in-one-app/AC-1 : sérialiser puis relire rend la même configuration")
func serializationRoundTrips() {
    let config = StackConfig(
        qdrantApiKey: "key",
        mem0HttpToken: "token",
        omlxBaseURL: "http://host.containers.internal:8000/v1",
        omlxApiToken: "omlx",
        omlxLLMModel: "qwen3-8b",
        omlxEmbedModel: "bge-m3",
        embeddingDims: 1024
    )
    #expect(StackConfig(values: StackEnvStore.parse(config.serialized)) == config)
    // Une valeur VIDE reste une valeur (un jeton vide est un choix), pas un défaut.
    let empty = StackConfig(mem0HttpToken: "", omlxApiToken: "")
    #expect(StackConfig(values: StackEnvStore.parse(empty.serialized)).mem0HttpToken == "")
}

@Test("all-in-one-app/AC-1 : le parseur retire les guillemets et ignore commentaires, blancs et clés inconnues")
func parserHandlesComposeQuirks() {
    let text = """
    # un commentaire
    OMLX_API_TOKEN="  espace conservé  "

    MEM0_HTTP_TOKEN='simple'
    INCONNUE=valeur
    """
    let values = StackEnvStore.parse(text)
    #expect(values["OMLX_API_TOKEN"] == "  espace conservé  ")
    #expect(values["MEM0_HTTP_TOKEN"] == "simple")
    // Une clé inconnue est ignorée : elle n'écrase aucun défaut.
    let config = StackConfig(values: values)
    #expect(config.omlxApiToken == "  espace conservé  ")
    #expect(config.mem0HttpToken == "simple")
    #expect(config.embeddingDims == StackConfig.defaults.embeddingDims)
}

@Test("all-in-one-app/AC-1 : un `EMBEDDING_DIMS` illisible garde le défaut, jamais 0")
func unreadableEmbeddingDimsFallsBack() {
    let config = StackConfig(values: ["EMBEDDING_DIMS": "beaucoup"])
    #expect(config.embeddingDims == 1024)
}

@Test("all-in-one-app/AC-1 : un fichier `env` absent rend `nil`, un fichier vide rend les défauts")
func loadDistinguishesAbsentFromEmpty() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-stack-env-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }

    #expect(StackEnvStore.load(at: root.appendingPathComponent("env")) == nil)

    let empty = root.appendingPathComponent("env")
    try Data().write(to: empty)
    #expect(StackEnvStore.load(at: empty) == .defaults)
}

@Test("all-in-one-app/AC-1 : `stack/env` s'écrit en 0600")
func envFileIsWrittenPrivate() throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent("omp-stack-env-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let url = root.appendingPathComponent("env")

    try StackEnvStore.write(StackConfig(mem0HttpToken: "secret"), to: url)

    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    #expect(attributes[.posixPermissions] as? Int == 0o600)
    #expect(StackEnvStore.load(at: url)?.mem0HttpToken == "secret")
}

@Test("all-in-one-app/AC-1 : l'URL sondée pour oMLX est 127.0.0.1 avec le port d'`OMLX_BASE_URL`, 8000 par défaut")
func omlxProbeURLDerivesThePort() {
    #expect(
        StackConfig(omlxBaseURL: "http://host.containers.internal:9000/v1").omlxProbeURL
            == URL(string: "http://127.0.0.1:9000/models")!
    )
    #expect(StackConfig(omlxBaseURL: "http://localhost:8000/v1").omlxProbeURL
        == URL(string: "http://127.0.0.1:8000/models")!)
    #expect(StackConfig(omlxBaseURL: "pas une url").omlxProbeURL
        == URL(string: "http://127.0.0.1:8000/models")!)
    #expect(StackConfig.defaults.omlxProbeURL == URL(string: "http://127.0.0.1:8000/models")!)
}
