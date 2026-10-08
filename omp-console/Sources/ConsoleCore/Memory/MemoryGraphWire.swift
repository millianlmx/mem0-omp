// Le VOCABULAIRE DU FIL du graphe des souvenirs, en un seul endroit (S-2) : un
// identifiant de nœud se sérialise en `"memory:<id>"` ou `"tag:<nom>"`, la nature
// d'un lien en `"semantic"` / `"tag"` / `"manual"`. La route (`RemoteReads`) émet
// par ces fonctions et relit par les mêmes — plus de seconde table de
// correspondance.

import Foundation

public enum MemoryGraphWire {
    /// L'identifiant de fil d'un nœud : `"memory:<id>"` ou `"tag:<nom>"`.
    public static func id(_ node: MemoryGraphNodeID) -> String {
        switch node {
        case let .memory(id): return "memory:\(id)"
        case let .tag(name): return "tag:\(name)"
        }
    }

    /// L'identité d'un nœud depuis son identifiant de fil, ou `nil` si illisible.
    public static func nodeID(_ text: String) -> MemoryGraphNodeID? {
        if let id = text.dropPrefix("memory:"), !id.isEmpty { return .memory(String(id)) }
        if let name = text.dropPrefix("tag:"), !name.isEmpty { return .tag(String(name)) }
        return nil
    }

    /// Le nom de fil d'une nature de lien : `"semantic"`, `"tag"` ou `"manual"`.
    public static func name(_ kind: MemoryGraphLinkKind) -> String {
        switch kind {
        case .semantic: return "semantic"
        case .tag: return "tag"
        case .manual: return "manual"
        }
    }

    /// La nature d'un lien depuis son nom de fil, ou `nil` si inconnu. `score` sert
    /// aux seules arêtes `semantic`.
    public static func kind(_ name: String, score: Double?) -> MemoryGraphLinkKind? {
        switch name {
        case "semantic": return .semantic(score: score ?? 0)
        case "tag": return .tag
        case "manual": return .manual
        default: return nil
        }
    }
}

private extension String {
    /// La fin de la chaîne quand elle commence par `prefix`, sinon `nil`.
    func dropPrefix(_ prefix: String) -> Substring? {
        hasPrefix(prefix) ? dropFirst(prefix.count) : nil
    }
}
