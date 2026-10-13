// Les doublures d'un VRAI client (`ConsoleClientModel`) branché sur la vraie pile
// (`RemoteStack`) : partagées par le contrat client (ClientContractTests) et par le
// rejeu des gestes iPhone contre le Mac (RemoteActionRoutesTests). Le harnais de
// ConsoleClientTests n'est pas visible depuis cette cible.

import ConsoleClient
import ConsoleCore
import Foundation
@testable import OMPConsole

/// Une découverte Bonjour muette : l'adresse se saisit à la main.
@MainActor
final class ContractDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

/// Un chemin réseau muet : le client se croit toujours en ligne.
@MainActor
final class ContractPath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

/// Un client réel (transport `URLSession`, jeton en mémoire) prêt à être appairé.
@MainActor
func makeContractClient(
    discovery: any DiscoverySource,
    tokens: InMemoryTokenStore = InMemoryTokenStore(),
    deviceName: String = "Tests"
) -> ConsoleClientModel {
    ConsoleClientModel(
        transport: ConsoleClient.URLSessionTransport(),
        discovery: discovery,
        preferences: InMemoryClientPreferences(),
        tokens: tokens,
        pacer: LiveClientPacer(),
        pathSource: ContractPath(),
        deviceName: deviceName
    )
}

/// L'endpoint d'une pile réelle.
func endpoint(of stack: RemoteStack) -> ClientEndpoint {
    .manual(host: "127.0.0.1", port: Int(stack.port))
}
