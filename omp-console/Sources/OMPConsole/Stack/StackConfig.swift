// La configuration de la pile mémoire de l'app (S-2, S-3, S-6).
//
// Elle est persistée dans `<stackRoot>/env` (`StackEnvStore`) au format du `.env`
// de la pile manuelle — MÊMES noms de clés, MÊMES défauts que
// `mem0-stack/.env.example` — pour qu'un `.env` existant s'importe sans
// traduction (S-3) et qu'un œil humain relise le fichier de l'app comme celui de
// la pile manuelle.
//
// Défauts (mesurés sur `mem0-stack/.env.example` le 2026-10-04) : la clé Qdrant
// locale `mem0-local-qdrant-key`, `OMLX_BASE_URL` par défaut (host.containers.internal
// :8000/v1), les modèles `qwen3-8b`/`bge-m3`, 1024 dimensions, jetons vides.

import Foundation

struct StackConfig: Equatable, Sendable {
    var qdrantApiKey: String
    var mem0HttpToken: String
    var omlxBaseURL: String
    var omlxApiToken: String
    var omlxLLMModel: String
    var omlxEmbedModel: String
    var embeddingDims: Int

    /// Les défauts de `.env.example` : la seule valeur non vide qui n'est pas un
    /// choix d'utilisateur est la clé Qdrant locale (défense en profondeur, pas un
    /// secret de production).
    static let defaults = StackConfig(
        qdrantApiKey: "mem0-local-qdrant-key",
        mem0HttpToken: "",
        omlxBaseURL: "http://host.containers.internal:8000/v1",
        omlxApiToken: "",
        omlxLLMModel: "qwen3-8b",
        omlxEmbedModel: "bge-m3",
        embeddingDims: 1024
    )

    /// Les clés connues, dans l'ordre où `serialized` les écrit.
    static let keys = [
        "QDRANT_API_KEY",
        "MEM0_HTTP_TOKEN",
        "OMLX_BASE_URL",
        "OMLX_API_TOKEN",
        "OMLX_LLM_MODEL",
        "OMLX_EMBED_MODEL",
        "EMBEDDING_DIMS",
    ]

    init(
        qdrantApiKey: String = StackConfig.defaults.qdrantApiKey,
        mem0HttpToken: String = StackConfig.defaults.mem0HttpToken,
        omlxBaseURL: String = StackConfig.defaults.omlxBaseURL,
        omlxApiToken: String = StackConfig.defaults.omlxApiToken,
        omlxLLMModel: String = StackConfig.defaults.omlxLLMModel,
        omlxEmbedModel: String = StackConfig.defaults.omlxEmbedModel,
        embeddingDims: Int = StackConfig.defaults.embeddingDims
    ) {
        self.qdrantApiKey = qdrantApiKey
        self.mem0HttpToken = mem0HttpToken
        self.omlxBaseURL = omlxBaseURL
        self.omlxApiToken = omlxApiToken
        self.omlxLLMModel = omlxLLMModel
        self.omlxEmbedModel = omlxEmbedModel
        self.embeddingDims = embeddingDims
    }

    /// Applique des valeurs lues d'un `.env` aux défauts : une clé connue écrase
    /// son défaut (une valeur VIDE reste une valeur — un jeton vide est un choix),
    /// une clé inconnue est ignorée, une clé absente garde son défaut.
    init(values: [String: String]) {
        self = .defaults
        if let value = values["QDRANT_API_KEY"] { qdrantApiKey = value }
        if let value = values["MEM0_HTTP_TOKEN"] { mem0HttpToken = value }
        if let value = values["OMLX_BASE_URL"] { omlxBaseURL = value }
        if let value = values["OMLX_API_TOKEN"] { omlxApiToken = value }
        if let value = values["OMLX_LLM_MODEL"] { omlxLLMModel = value }
        if let value = values["OMLX_EMBED_MODEL"] { omlxEmbedModel = value }
        if let value = values["EMBEDDING_DIMS"] { embeddingDims = Int(value) ?? StackConfig.defaults.embeddingDims }
    }

    /// Les sept variables, prêtes pour l'environnement d'un conteneur ou l'écriture
    /// du fichier.
    var values: [String: String] {
        [
            "QDRANT_API_KEY": qdrantApiKey,
            "MEM0_HTTP_TOKEN": mem0HttpToken,
            "OMLX_BASE_URL": omlxBaseURL,
            "OMLX_API_TOKEN": omlxApiToken,
            "OMLX_LLM_MODEL": omlxLLMModel,
            "OMLX_EMBED_MODEL": omlxEmbedModel,
            "EMBEDDING_DIMS": String(embeddingDims),
        ]
    }

    /// Le contenu de `stack/env` : une ligne `CLÉ=valeur` par variable connue,
    /// dans l'ordre de `keys`, terminé par un saut de ligne.
    var serialized: String {
        var text = ""
        for key in StackConfig.keys {
            text += "\(key)=\(values[key] ?? "")\n"
        }
        return text
    }

    /// L'URL sondée pour oMLX (S-6, S-5 « Prérequis ») : l'hôte 127.0.0.1 (le Mac
    /// lui-même, où oMLX tourne en natif), le port d'`OMLX_BASE_URL` — 8000 par
    /// défaut, y compris si l'URL est illisible — et le chemin `/models`.
    var omlxProbeURL: URL {
        let port = URL(string: omlxBaseURL)?.port ?? 8000
        var components = URLComponents()
        components.scheme = "http"
        components.host = "127.0.0.1"
        components.port = port
        components.path = "/models"
        return components.url ?? URL(string: "http://127.0.0.1:8000/models")!
    }
}

/// La lecture/écriture de `stack/env` (S-3, BR-2) : le fichier de l'app a les
/// droits 0600, comme le `.env` de la pile manuelle.
enum StackEnvStore {
    /// Lit un fichier au format `.env` ; `nil` si le fichier est absent ou
    /// illisible. Un fichier lisible mais sans clé connue rend les défauts.
    static func load(at url: URL, fileManager: FileManager = .default) -> StackConfig? {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        return StackConfig(values: parse(text))
    }

    /// Écrit le fichier en 0600, en créant son dossier au besoin. L'écriture est
    /// atomique (fichier temporaire puis renommage) : un lecteur ne voit jamais
    /// un fichier à moitié écrit.
    static func write(_ config: StackConfig, to url: URL, fileManager: FileManager = .default) throws {
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(config.serialized.utf8).write(to: url, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    /// Le décodage tolérant d'un `.env` : lignes `CLÉ=valeur`, commentaires `#` et
    /// lignes vides ignorés, espaces de bord retirés, guillemets simples ou
    /// doubles entourant la valeur retirés (forme compose).
    static func parse(_ text: String) -> [String: String] {
        var values: [String: String] = [:]
        for rawLine in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            guard !line.isEmpty, !line.hasPrefix("#"), let separator = line.firstIndex(of: "=") else { continue }
            let key = String(line[line.startIndex..<separator]).trimmingCharacters(in: .whitespaces)
            var value = String(line[line.index(after: separator)...]).trimmingCharacters(in: .whitespaces)
            if value.count >= 2, (value.hasPrefix("\"") && value.hasSuffix("\"")) || (value.hasPrefix("'") && value.hasSuffix("'")) {
                value = String(value.dropFirst().dropLast())
            }
            guard !key.isEmpty else { continue }
            values[key] = value
        }
        return values
    }
}
