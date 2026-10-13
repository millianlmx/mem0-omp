// La demande de dialogue d'une session hébergée par le service OMP : forme exacte
// de `DialogRequest` (omp-mem0-req/serviceApi.ts), réduite aux champs publiés.
//
// Type de domaine transporté tel quel (trame SSE `dialog`, `GET /v1/session`,
// `GET /v1/conduite`, évènements de l'API distante) : il vit UNE fois dans le
// noyau, comme `StoreSnapshot`, et la coque comme le client le partagent. Le
// décodeur de trame, qui lit un `JSONValue`, reste dans la coque.

import Foundation

/// Les quatre méthodes de dialogue auxquelles l'app répond.
public enum RpcDialogMethod: String, CaseIterable, Codable, Sendable {
    case select
    case confirm
    case input
    case editor
}

/// Une demande de dialogue. `Codable` synthétisé : une clé optionnelle absente se
/// décode en `nil`, et un `nil` omet sa clé à l'encodage.
public struct RpcDialogRequest: Identifiable, Codable, Equatable, Sendable {
    public let id: String
    public let method: RpcDialogMethod
    public let title: String
    public let message: String?
    public let options: [String]
    /// `optionDescriptions[i]` correspond POSITIONNELLEMENT à `options[i]`.
    public let optionDescriptions: [String?]
    public let placeholder: String?
    public let prefill: String?
    public let promptStyle: Bool
    /// L'instant où le service a créé le dialogue, en ms epoch ; `nil` quand le
    /// service (ou le Mac) ne l'a pas fourni.
    public let at: Double?

    public init(
        id: String,
        method: RpcDialogMethod,
        title: String,
        message: String? = nil,
        options: [String] = [],
        optionDescriptions: [String?] = [],
        placeholder: String? = nil,
        prefill: String? = nil,
        promptStyle: Bool = false,
        at: Double? = nil
    ) {
        self.id = id
        self.method = method
        self.title = title
        self.message = message
        self.options = options
        self.optionDescriptions = optionDescriptions
        self.placeholder = placeholder
        self.prefill = prefill
        self.promptStyle = promptStyle
        self.at = at
    }
}
