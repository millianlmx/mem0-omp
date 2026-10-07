// La machine d'état HONNÊTE (S-10) : une fonction PURE des faits observables, sans
// E/S — donc testable exhaustivement, sans réseau (patron `RemoteGuard.evaluate`).
//
// Priorité, du plus fort au plus faible : révocation, version, réseau, jeton,
// connecté, tentative, Mac absent, recherche. Ce que le client ne peut pas
// distinguer (refus, délai, fermeture silencieuse) rend le MÊME état.

import Foundation

/// Le verrou de version d'API.
public struct ClientIncompatibility: Equatable, Sendable {
    public var local: Int
    public var remote: Int?

    public init(local: Int, remote: Int?) {
        self.local = local
        self.remote = remote
    }
}

/// Les faits observables dont l'état est une fonction.
public struct ClientFacts: Equatable, Sendable {
    public var revoked: Bool
    public var incompatible: ClientIncompatibility?
    public var hasNetwork: Bool
    public var hasToken: Bool
    public var connectedEndpoint: ClientEndpoint?
    public var connectingEndpoint: ClientEndpoint?
    public var lastFailure: ClientEndpoint?

    public init(
        revoked: Bool = false,
        incompatible: ClientIncompatibility? = nil,
        hasNetwork: Bool = true,
        hasToken: Bool = false,
        connectedEndpoint: ClientEndpoint? = nil,
        connectingEndpoint: ClientEndpoint? = nil,
        lastFailure: ClientEndpoint? = nil
    ) {
        self.revoked = revoked
        self.incompatible = incompatible
        self.hasNetwork = hasNetwork
        self.hasToken = hasToken
        self.connectedEndpoint = connectedEndpoint
        self.connectingEndpoint = connectingEndpoint
        self.lastFailure = lastFailure
    }
}

/// La table de priorité de S-10, en un seul endroit.
public enum ClientStateMachine {
    public static func resolve(_ facts: ClientFacts) -> ClientState {
        if facts.revoked { return .revoked }
        if let incompatible = facts.incompatible {
            return .incompatibleProtocol(local: incompatible.local, remote: incompatible.remote)
        }
        if !facts.hasNetwork { return .noNetwork }
        if !facts.hasToken { return .unpaired }
        if let endpoint = facts.connectedEndpoint { return .connected(endpoint: endpoint) }
        if let endpoint = facts.connectingEndpoint { return .connecting(endpoint: endpoint) }
        if let endpoint = facts.lastFailure { return .macAbsent(endpoint: endpoint) }
        return .searching
    }
}
