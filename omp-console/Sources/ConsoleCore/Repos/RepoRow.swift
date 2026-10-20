// Un dépôt connu d'une machine, tel que `GET /v1/repos` le sert (S-5 de
// orchestrator-living-in-a-vps) : la clé calculée par la machine, le chemin réel,
// le nom, l'identité GitHub quand il y en a une, et la bascule inscrite sur cette
// machine. VIT DANS `ConsoleCore` : la fusion des deux machines et les deux coques
// la partagent ; `ConsoleClient.RemoteRepoRow` en est un alias.

import Foundation

/// Une machine qui conduit des pipelines.
public enum RepoMachine: String, CaseIterable, Sendable, Codable, Hashable {
    case mac, vps

    /// Le nom affiché : « Mac » ou « VPS ».
    public var label: String {
        switch self {
        case .mac: "Mac"
        case .vps: "VPS"
        }
    }

    public var other: RepoMachine { self == .mac ? .vps : .mac }
}

/// La bascule d'un dépôt, inscrite sur la machine SOURCE : `frozen` entre
/// l'inventaire des features et leur retrait, `done` ensuite (la source ne
/// conduit plus ce dépôt).
public struct RepoHandover: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable {
        case frozen, done
    }

    public var id: String
    public var to: RepoMachine
    public var state: State

    public init(id: String, to: RepoMachine, state: State) {
        self.id = id
        self.to = to
        self.state = state
    }
}

public struct RepoRow: Codable, Equatable, Sendable {
    public var repoKey: String
    public var repoRoot: String
    public var name: String
    public var identity: String?
    public var handover: RepoHandover?

    public init(repoKey: String, repoRoot: String, name: String, identity: String? = nil, handover: RepoHandover? = nil) {
        self.repoKey = repoKey
        self.repoRoot = repoRoot
        self.name = name
        self.identity = identity
        self.handover = handover
    }
}
