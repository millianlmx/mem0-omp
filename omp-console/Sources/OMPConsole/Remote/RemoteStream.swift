// Le flux temps réel (S-13) : `GET /v1/stream` pousse ce qui change, sans que le
// client sonde. Un seul jeu de sources pour tous les abonnés — l'état des
// composants et le registre des appareils — et un battement de cœur par flux.
//
// Révocation (AC-5) : `close(deviceId:)` coupe les connexions AVANT de rendre la
// main, donc le client voit la fin du flux immédiatement.
//
// Client lent : au-delà de 64 évènements encore en vol sur une connexion,
// l'évènement est ABANDONNÉ pour ce client — jamais de blocage du serveur, jamais
// de coupure des autres flux.

import Combine
import ConsoleCore
import Foundation

/// Le format SSE (Doc-5) : `event:`, `data:` puis une ligne vide qui dispatche.
enum SSE {
    static func frame(_ event: String, _ data: Data) -> Data {
        var out = Data("event: \(event)\ndata: ".utf8)
        out.append(data)
        out.append(Data("\n\n".utf8))
        return out
    }

    static func frame(_ event: String, _ value: some Encodable) -> Data {
        frame(event, (try? HTTPJSON.encode(value)) ?? Data("{}".utf8))
    }

    static let heartbeat = Data(": ping\n\n".utf8)
}

struct RemoteHelloEvent: Encodable, Equatable {
    var protocolVersion: Int
}

struct RemoteDevicesEvent: Encodable, Equatable {
    var devices: [RemoteDeviceRow]
}

/// L'abonnement d'UNE connexion : c'est lui que le serveur démarre une fois
/// l'en-tête SSE écrit.
@MainActor
final class RemoteStreamSubscription: RemoteStreamStartable {
    private let hub: RemoteStreamHub
    let id: UUID

    fileprivate init(hub: RemoteStreamHub, id: UUID) {
        self.hub = hub
        self.id = id
    }

    func start() { hub.activate(id) }
    func stop() { hub.unsubscribe(id) }
}

@MainActor
final class RemoteStreamHub {
    /// Au-delà, l'évènement est abandonné pour ce client (S-13).
    static let backlogLimit = 64
    static let heartbeatSeconds: Double = 15

    private final class Subscriber {
        let id: UUID
        let deviceId: UUID
        let connection: RemoteConnectionHandle
        var active = false

        init(id: UUID, deviceId: UUID, connection: RemoteConnectionHandle) {
            self.id = id
            self.deviceId = deviceId
            self.connection = connection
        }
    }

    private let registry: DeviceRegistry
    private let clock: RemoteClock
    /// L'état des composants et de la préparation (S-4), fourni par la racine.
    private let components: @MainActor () -> RemoteComponentsPayload
    /// Les changements réels : l'instantané initial part à l'activation, ce flux
    /// ne pousse que sur mutation.
    private let componentsChanges: AnyPublisher<Void, Never>

    private var subscribers: [UUID: Subscriber] = [:]
    private var tasks: [Task<Void, Never>] = []
    private var started = false

    init(
        registry: DeviceRegistry,
        clock: RemoteClock = .live,
        components: @escaping @MainActor () -> RemoteComponentsPayload = {
            RemoteComponentsPayload(ompInstalled: false, ompPath: nil, setupBanner: nil)
        },
        componentsChanges: AnyPublisher<Void, Never> = Empty<Void, Never>(completeImmediately: false).eraseToAnyPublisher()
    ) {
        self.registry = registry
        self.clock = clock
        self.components = components
        self.componentsChanges = componentsChanges
    }

    // MARK: - Abonnements

    func subscribe(deviceId: UUID, connection: RemoteConnectionHandle) -> RemoteStreamSubscription {
        let id = UUID()
        subscribers[id] = Subscriber(id: id, deviceId: deviceId, connection: connection)
        return RemoteStreamSubscription(hub: self, id: id)
    }

    fileprivate func activate(_ id: UUID) {
        guard let subscriber = subscribers[id], !subscriber.active else { return }
        subscriber.active = true
        startSources()
        // À l'ouverture : `hello`, puis `devices` (publié par `markConnected` via
        // `registry.changeHandler`), puis `components` — le client n'a jamais à faire
        // un `GET` initial (S-13, S-4).
        deliver(subscriber, SSE.frame("hello", RemoteHelloEvent(protocolVersion: ConsoleAPI.protocolVersion)))
        registry.markConnected(subscriber.deviceId, true)
        deliver(subscriber, SSE.frame("components", components()))
    }

    fileprivate func unsubscribe(_ id: UUID) {
        guard let subscriber = subscribers.removeValue(forKey: id) else { return }
        // La déconnexion se publie par `changeHandler` : une seule trame `devices`.
        registry.markConnected(subscriber.deviceId, false)
    }

    /// Coupe TOUS les flux d'un appareil — appelé par la révocation, avant qu'elle
    /// rende la main.
    func close(deviceId: UUID) {
        let doomed = subscribers.values.filter { $0.deviceId == deviceId }
        for subscriber in doomed {
            subscribers[subscriber.id] = nil
            subscriber.connection.close()
        }
        if !doomed.isEmpty {
            registry.markConnected(deviceId, false)
        }
    }

    func closeAll() {
        for subscriber in subscribers.values { subscriber.connection.close() }
        subscribers.removeAll()
        for task in tasks { task.cancel() }
        tasks.removeAll()
        started = false
    }

    var connectedDeviceIds: Set<UUID> {
        Set(subscribers.values.map(\.deviceId))
    }

    // MARK: - Sources

    private func startSources() {
        guard !started else { return }
        started = true

        tasks.append(Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.heartbeatSeconds * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                self.broadcast(SSE.heartbeat)
            }
        })

        // Composants et préparation (S-4) : un changement réel pousse la charge
        // utile complète, jamais un delta.
        let components = componentsChanges
        tasks.append(Task { @MainActor [weak self] in
            for await _ in components.values {
                guard let self else { return }
                self.broadcast(SSE.frame("components", self.components()))
            }
        })
    }

    func broadcastDevices() {
        guard !subscribers.isEmpty else { return }
        broadcast(SSE.frame("devices", RemoteDevicesEvent(devices: registry.devices.map { device in
            RemoteDeviceRow(
                id: device.id.uuidString.lowercased(),
                name: device.name,
                pairedAtMs: device.pairedAtMs,
                lastSeenAtMs: device.lastSeenAtMs,
                connected: self.connectedDeviceIds.contains(device.id)
            )
        })))
    }

    // MARK: - Diffusion

    private func broadcast(_ data: Data) {
        for subscriber in subscribers.values where subscriber.active {
            deliver(subscriber, data)
        }
    }

    private func deliver(_ subscriber: Subscriber, _ data: Data) {
        guard subscriber.connection.pending <= Self.backlogLimit else { return }
        subscriber.connection.send(data)
    }
}
