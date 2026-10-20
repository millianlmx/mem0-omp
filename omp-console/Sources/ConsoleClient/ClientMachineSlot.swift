// Les deux machines que le client sait joindre (S-10 de orchestrator-living-in-a-vps) :
// chacune a son PROPRE jeu de préférences, son PROPRE compte de trousseau et son
// propre appairage. Le slot `mac` garde les clés d'origine — rien ne migre ; le
// slot `vps` n'a ni découverte Bonjour ni valeur par défaut : son adresse
// (Tailscale) est toujours saisie.

import ConsoleCore
import Foundation

public enum ClientMachineSlot: String, CaseIterable, Sendable, Hashable {
    case mac, vps

    /// La machine que ce slot DOIT joindre : `machine.kind` du serveur est contrôlé contre elle.
    public var machine: RepoMachine {
        switch self {
        case .mac: .mac
        case .vps: .vps
        }
    }

    /// L'adresse manuelle de ce slot.
    public var manualAddressKey: String {
        switch self {
        case .mac: ClientPreferenceKey.manualAddress
        case .vps: ClientPreferenceKey.vpsManualAddress
        }
    }

    /// L'identifiant d'appareil appairé auprès de cette machine.
    public var deviceIdKey: String {
        switch self {
        case .mac: ClientPreferenceKey.deviceId
        case .vps: ClientPreferenceKey.vpsDeviceId
        }
    }

    /// L'identité de l'installation envoyée à cette machine.
    public var installationIdKey: String {
        switch self {
        case .mac: ClientPreferenceKey.installationId
        case .vps: ClientPreferenceKey.vpsInstallationId
        }
    }

    /// Le service de trousseau de l'app iOS pour ce slot.
    public var keychainService: String {
        switch self {
        case .mac: KeychainTokenStore.defaultService
        case .vps: KeychainTokenStore.vpsService
        }
    }

    /// Seul le Mac se découvre par Bonjour.
    public var usesDiscovery: Bool { self == .mac }
}

/// Le slot et la machine annoncée ne coïncident pas : l'adresse saisie est celle
/// de l'AUTRE machine. Aucun geste n'est émis dans cet état.
public struct ClientWrongMachine: Equatable, Sendable {
    public var expected: RepoMachine
    public var actual: RepoMachine

    public init(expected: RepoMachine, actual: RepoMachine) {
        self.expected = expected
        self.actual = actual
    }
}

/// La découverte du slot `vps` : elle ne trouve jamais rien. Le VPS ne s'annonce pas.
@MainActor
public final class NoDiscoverySource: DiscoverySource {
    public var onChange: (([DiscoveredMac]) -> Void)?
    public var onProtocolVersion: ((Int) -> Void)?
    public var onDenied: ((Bool) -> Void)?

    public init() {}

    public func start(serviceType: String) {}
    public func stop() {}
}
