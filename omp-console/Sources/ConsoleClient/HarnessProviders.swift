// Les fournisseurs LLM et les chaînes de modèles du serveur de pipelines, déclarés
// depuis les apps par un client admin (`/v1/providers`, `/v1/models`) : le contrat
// JSON et les brouillons des formulaires, partagés par la coque Mac et l'app iOS.
//
// Une clé part vers le serveur et n'en revient jamais : le serveur ne rend que
// `hasKey` et ses quatre derniers caractères (`keyHint`).

import Foundation

/// Un modèle d'un fournisseur compatible OpenAI.
public struct HarnessProviderModel: Codable, Equatable, Sendable {
    public var id: String
    public var contextWindow: Int?
    public var maxTokens: Int?

    public init(id: String, contextWindow: Int? = nil, maxTokens: Int? = nil) {
        self.id = id
        self.contextWindow = contextWindow
        self.maxTokens = maxTokens
    }
}

/// Un fournisseur tel que le serveur le décrit (jamais sa clé).
public struct HarnessProvider: Decodable, Equatable, Sendable, Identifiable {
    public var name: String
    /// Un fournisseur connu d'omp (`anthropic`, `openai`…) ou `openai-compatible`.
    public var kind: String
    /// `api` : déclaré depuis les apps ; `config` : par la configuration du serveur (lecture seule).
    public var source: String
    public var baseUrl: String?
    public var api: String?
    public var models: [HarnessProviderModel]
    public var capacity: Int?
    public var refillPerMinute: Int?
    public var keyVariable: String
    public var hasKey: Bool
    public var keyHint: String?
    public var updatedBy: String?

    public var id: String { name }
    public var isCompatible: Bool { kind == HarnessProviderDraft.compatible }
    public var isEditable: Bool { source == "api" }

    public init(
        name: String, kind: String, source: String = "api", baseUrl: String? = nil, api: String? = nil,
        models: [HarnessProviderModel] = [], capacity: Int? = nil, refillPerMinute: Int? = nil,
        keyVariable: String = "", hasKey: Bool = false, keyHint: String? = nil, updatedBy: String? = nil
    ) {
        self.name = name
        self.kind = kind
        self.source = source
        self.baseUrl = baseUrl
        self.api = api
        self.models = models
        self.capacity = capacity
        self.refillPerMinute = refillPerMinute
        self.keyVariable = keyVariable
        self.hasKey = hasKey
        self.keyHint = keyHint
        self.updatedBy = updatedBy
    }

    private enum CodingKeys: String, CodingKey {
        case name, kind, source, baseUrl, api, models, capacity, refillPerMinute, keyVariable, hasKey, keyHint, updatedBy
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        kind = try container.decode(String.self, forKey: .kind)
        source = (try? container.decode(String.self, forKey: .source)) ?? "api"
        baseUrl = try? container.decode(String.self, forKey: .baseUrl)
        api = try? container.decode(String.self, forKey: .api)
        models = (try? container.decode([HarnessProviderModel].self, forKey: .models)) ?? []
        capacity = try? container.decode(Int.self, forKey: .capacity)
        refillPerMinute = try? container.decode(Int.self, forKey: .refillPerMinute)
        keyVariable = (try? container.decode(String.self, forKey: .keyVariable)) ?? ""
        hasKey = (try? container.decode(Bool.self, forKey: .hasKey)) ?? false
        keyHint = try? container.decode(String.self, forKey: .keyHint)
        updatedBy = try? container.decode(String.self, forKey: .updatedBy)
    }
}

/// Un maillon d'une chaîne de modèles : `fournisseur/modèle`.
public struct HarnessModelChoice: Codable, Equatable, Hashable, Sendable {
    public var provider: String
    public var model: String

    public init(provider: String, model: String) {
        self.provider = provider
        self.model = model
    }

    public var label: String { "\(provider)/\(model)" }
}

/// Les chaînes de modèles de chaque niveau, dans l'ordre de bascule.
public struct HarnessModelChains: Codable, Equatable, Sendable {
    /// Les niveaux, du plus léger au plus lourd (les clés du serveur).
    public static let tiers = ["fast", "standard", "heavy"]

    public var fast: [HarnessModelChoice]
    public var standard: [HarnessModelChoice]
    public var heavy: [HarnessModelChoice]

    public init(fast: [HarnessModelChoice] = [], standard: [HarnessModelChoice] = [], heavy: [HarnessModelChoice] = []) {
        self.fast = fast
        self.standard = standard
        self.heavy = heavy
    }

    public subscript(tier: String) -> [HarnessModelChoice] {
        get {
            switch tier {
            case "fast": fast
            case "standard": standard
            default: heavy
            }
        }
        set {
            switch tier {
            case "fast": fast = newValue
            case "standard": standard = newValue
            default: heavy = newValue
            }
        }
    }

    /// Une chaîne saisie (`anthropic/claude-opus-5-5, vps-ollama/qwen3:8b`), ou `nil`
    /// si un maillon n'a pas la forme `fournisseur/modèle`.
    public static func parse(_ text: String) -> [HarnessModelChoice]? {
        var chain: [HarnessModelChoice] = []
        for part in text.split(whereSeparator: { $0 == "," || $0 == "\n" }) {
            let item = part.trimmingCharacters(in: .whitespaces)
            if item.isEmpty { continue }
            guard let slash = item.firstIndex(of: "/") else { return nil }
            let provider = String(item[..<slash])
            let model = String(item[item.index(after: slash)...])
            guard !provider.isEmpty, !model.isEmpty else { return nil }
            chain.append(HarnessModelChoice(provider: provider, model: model))
        }
        return chain
    }

    /// Une chaîne telle qu'on la saisit.
    public static func text(_ chain: [HarnessModelChoice]) -> String {
        chain.map(\.label).joined(separator: ", ")
    }
}

/// La réponse de `GET /v1/providers` (et de `PUT /v1/models`).
public struct HarnessProviderCatalog: Decodable, Equatable, Sendable {
    public var providers: [HarnessProvider]
    public var models: HarnessModelChains
    /// `api` : chaînes choisies depuis les apps ; `config` : celles de la configuration.
    public var modelsSource: String
    public var kinds: [String]
    public var apis: [String]

    public init(
        providers: [HarnessProvider] = [], models: HarnessModelChains = HarnessModelChains(), modelsSource: String = "config",
        kinds: [String] = [], apis: [String] = []
    ) {
        self.providers = providers
        self.models = models
        self.modelsSource = modelsSource
        self.kinds = kinds
        self.apis = apis
    }

    private enum CodingKeys: String, CodingKey { case providers, models, modelsSource, kinds, apis }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        providers = try container.decode([HarnessProvider].self, forKey: .providers)
        models = (try? container.decode(HarnessModelChains.self, forKey: .models)) ?? HarnessModelChains()
        modelsSource = (try? container.decode(String.self, forKey: .modelsSource)) ?? "config"
        kinds = (try? container.decode([String].self, forKey: .kinds)) ?? []
        apis = (try? container.decode([String].self, forKey: .apis)) ?? []
    }

    /// Les chaînes viennent des apps (on peut revenir à celles de la configuration).
    public var modelsFromApps: Bool { modelsSource == "api" }
}

/// Un fournisseur en cours de saisie : création ou modification.
public struct HarnessProviderDraft: Equatable, Sendable, Identifiable {
    /// La sorte des fournisseurs compatibles OpenAI (Ollama, vLLM, LiteLLM…).
    public static let compatible = "openai-compatible"
    /// Les fournisseurs connus d'omp, dans l'ordre du sélecteur.
    public static let knownKinds = ["anthropic", "openai", "openrouter", "google", "mistral", "xai"]
    /// Les protocoles d'un fournisseur compatible.
    public static let apis = ["openai-completions", "openai-responses", "anthropic-messages"]

    /// Le fournisseur modifié (`nil` : une création).
    public var editing: String?
    public var kind: String
    /// Le nom (libre pour un compatible ; celui de la sorte sinon).
    public var name: String
    public var baseUrl: String
    public var api: String
    /// Les modèles, séparés par des virgules (`qwen3:8b, llama3.3`).
    public var models: String
    /// Une clé neuve ; vide : la clé déclarée reste.
    public var apiKey: String
    /// Retirer la clé déclarée.
    public var removeKey: Bool
    /// Le débit permis : capacité et remplissage par minute (vides : sans limite).
    public var capacity: String
    public var refillPerMinute: String
    /// Le fournisseur a une clé déclarée (pour l'indication du champ).
    public var keyHint: String?

    public var id: String { editing ?? "nouveau" }

    public init(kind: String = "anthropic") {
        editing = nil
        self.kind = kind
        name = kind == Self.compatible ? "" : kind
        baseUrl = ""
        api = Self.apis[0]
        models = ""
        apiKey = ""
        removeKey = false
        capacity = ""
        refillPerMinute = ""
        keyHint = nil
    }

    /// La modification d'un fournisseur déclaré : ses champs, sans sa clé.
    public init(editing provider: HarnessProvider) {
        editing = provider.name
        kind = provider.kind
        name = provider.name
        baseUrl = provider.baseUrl ?? ""
        api = provider.api ?? Self.apis[0]
        models = provider.models.map(\.id).joined(separator: ", ")
        apiKey = ""
        removeKey = false
        capacity = provider.capacity.map(String.init) ?? ""
        refillPerMinute = provider.refillPerMinute.map(String.init) ?? ""
        keyHint = provider.hasKey ? provider.keyHint : nil
    }

    public var isCompatible: Bool { kind == Self.compatible }

    /// Le nom envoyé : celui de la sorte pour un fournisseur connu.
    public var effectiveName: String {
        isCompatible ? name.trimmingCharacters(in: .whitespaces).lowercased() : kind
    }

    /// Les identifiants de modèles saisis, sans doublon.
    public var modelList: [String] {
        var seen = Set<String>()
        return models
            .split(whereSeparator: { $0 == "," || $0 == " " || $0 == "\n" })
            .map(String.init)
            .filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    /// Ce qui manque ou cloche, ou `nil` si le fournisseur peut partir.
    public var problem: Problem? {
        if isCompatible {
            if effectiveName.range(of: #"^[a-z][a-z0-9-]{0,31}$"#, options: .regularExpression) == nil { return .name }
            if effectiveName == "omlx" { return .reservedName }
            let url = baseUrl.trimmingCharacters(in: .whitespaces).lowercased()
            if !(url.hasPrefix("http://") || url.hasPrefix("https://")) || url.contains(" ") { return .address }
            if modelList.isEmpty { return .models }
        }
        let key = apiKey.trimmingCharacters(in: .whitespaces)
        if !key.isEmpty, key.count < 8 || key.contains(" ") { return .key }
        let capacityValue = Int(capacity.trimmingCharacters(in: .whitespaces))
        let refillValue = Int(refillPerMinute.trimmingCharacters(in: .whitespaces))
        let capacityEmpty = capacity.trimmingCharacters(in: .whitespaces).isEmpty
        let refillEmpty = refillPerMinute.trimmingCharacters(in: .whitespaces).isEmpty
        if capacityEmpty != refillEmpty { return .limit }
        if !capacityEmpty, (capacityValue ?? 0) < 1 || (refillValue ?? 0) < 1 { return .limit }
        return nil
    }

    public enum Problem: Equatable, Sendable {
        case name, reservedName, address, models, key, limit
    }

    /// Le corps du `PUT /v1/providers/{name}`.
    public var body: HarnessProviderBody {
        let key = apiKey.trimmingCharacters(in: .whitespaces)
        let capacityValue = Int(capacity.trimmingCharacters(in: .whitespaces))
        let refillValue = Int(refillPerMinute.trimmingCharacters(in: .whitespaces))
        return HarnessProviderBody(
            kind: kind,
            baseUrl: isCompatible ? baseUrl.trimmingCharacters(in: .whitespaces) : nil,
            api: isCompatible ? api : nil,
            models: isCompatible ? modelList.map { HarnessProviderModel(id: $0) } : nil,
            apiKey: removeKey ? "" : (key.isEmpty ? nil : key),
            capacity: capacityValue.map { .value($0) } ?? .null,
            refillPerMinute: refillValue.map { .value($0) } ?? .null
        )
    }
}

/// Un entier à envoyer, ou `null` explicite (retirer la limite).
public enum HarnessNullableInt: Encodable, Equatable, Sendable {
    case value(Int)
    case null

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .value(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }
}

/// Le corps d'une déclaration : les champs `nil` ne partent pas (la clé absente reste).
public struct HarnessProviderBody: Encodable, Equatable, Sendable {
    public var kind: String
    public var baseUrl: String?
    public var api: String?
    public var models: [HarnessProviderModel]?
    public var apiKey: String?
    public var capacity: HarnessNullableInt
    public var refillPerMinute: HarnessNullableInt
}

/// Le corps de `PUT /v1/models` : des chaînes, ou `null` (retour à la configuration).
struct HarnessChainsBody: Encodable {
    var models: HarnessModelChains?

    private enum CodingKeys: String, CodingKey { case models }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let models { try container.encode(models, forKey: .models) } else { try container.encodeNil(forKey: .models) }
    }
}

/// La réponse de `PUT /v1/providers/{name}`.
struct HarnessProviderReply: Decodable {
    var provider: HarnessProvider
}
