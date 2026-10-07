// Le flux temps réel (S-13) : `GET /v1/stream` pousse ce qui change, sans que le
// client sonde. Un seul jeu de sources pour tous les abonnés — l'agrégat du
// magasin, les fichiers de session des runs VIVANTS, l'état de la session hébergée,
// le registre des appareils — et un battement de cœur par flux.
//
// Révocation (AC-5) : `close(deviceId:)` coupe les connexions AVANT de rendre la
// main, donc le client voit la fin du flux immédiatement.
//
// Client lent : au-delà de 64 évènements encore en vol sur une connexion,
// l'évènement est ABANDONNÉ pour ce client — jamais de blocage du serveur, jamais
// de coupure des autres flux.

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

struct RemoteSessionsEvent: Encodable, Equatable {
    var file: String
    var added: [RemoteConversationEntry]?
    var issue: String?
}

struct RemoteHostedEvent: Encodable, Equatable {
    var state: String
    var dialogs: [RpcDialogRequest]
    var added: [TranscriptLine]
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

    private let storeHub: StoreHub
    private let registry: DeviceRegistry
    private let session: SessionConsoleModel
    private let project: ProjectConsoleModel
    private let clock: RemoteClock

    private var subscribers: [UUID: Subscriber] = [:]
    private var tasks: [Task<Void, Never>] = []
    private var watchers: [String: FileWatcher] = [:]
    private var readers: [String: SessionReader] = [:]
    private var started = false
    private var lastTranscriptId = 0

    init(
        storeHub: StoreHub,
        registry: DeviceRegistry,
        session: SessionConsoleModel,
        project: ProjectConsoleModel,
        clock: RemoteClock = .live
    ) {
        self.storeHub = storeHub
        self.registry = registry
        self.session = session
        self.project = project
        self.clock = clock
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
        // À l'ouverture : `hello`, l'instantané courant et l'état de la conduite —
        // le client n'a jamais à faire un `GET` initial. La connexion n'est
        // déclarée au registre qu'APRÈS ces trois trames : `markConnected` publie
        // `devices` par `registry.changeHandler`, donc la trame `devices` vient en
        // dernier (S-13, S-6).
        deliver(subscriber, SSE.frame("hello", RemoteHelloEvent(protocolVersion: ConsoleAPI.protocolVersion)))
        deliver(subscriber, SSE.frame("store", storeHub.current()))
        deliver(subscriber, SSE.frame("conduite", RemoteActions.conduitePayload(project)))
        registry.markConnected(subscriber.deviceId, true)
        refreshWatchedRuns()
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
        for watcher in watchers.values { watcher.stop() }
        watchers.removeAll()
        readers.removeAll()
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

        // Le PREMIER élément d'un abonnement est l'instantané courant, déjà envoyé
        // à l'activation : on n'émet que sur changement RÉEL, comme la couche qui
        // publie.
        let snapshots = storeHub.snapshots()
        tasks.append(Task { @MainActor [weak self] in
            var last = self?.storeHub.current()
            for await snapshot in snapshots {
                guard let self else { return }
                defer { self.refreshWatchedRuns() }
                guard snapshot != last else { continue }
                last = snapshot
                self.broadcast(SSE.frame("store", snapshot))
            }
        })

        tasks.append(Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Self.heartbeatSeconds * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                self.broadcast(SSE.heartbeat)
            }
        })

        // Session hébergée : état, dialogues, transcript ajouté.
        let host = session.host
        tasks.append(Task { @MainActor [weak self] in
            for await _ in host.$state.values {
                guard let self else { return }
                self.broadcastHosted()
            }
        })
        tasks.append(Task { @MainActor [weak self] in
            for await _ in host.$dialogQueue.values {
                guard let self else { return }
                self.broadcastHosted()
            }
        })
        tasks.append(Task { @MainActor [weak self] in
            for await _ in host.$transcript.values {
                guard let self else { return }
                self.broadcastHosted()
            }
        })

        // Conduite de projet : l'état de la conduite et sa file d'escalades. Le hub
        // publie la charge utile COMPLÈTE à chaque changement — jamais un delta
        // (S-6, S-11). Le PREMIER élément de chaque abonnement est l'état courant,
        // déjà porté par la trame `conduite` d'ouverture : on n'émet que sur
        // changement RÉEL, comme le flux du magasin ci-dessus.
        let projectHost = project.host
        tasks.append(Task { @MainActor [weak self] in
            for await _ in projectHost.$state.dropFirst().values {
                guard let self else { return }
                self.broadcastConduite()
            }
        })
        tasks.append(Task { @MainActor [weak self] in
            for await _ in projectHost.$dialogQueue.dropFirst().values {
                guard let self else { return }
                self.broadcastConduite()
            }
        })
    }

    private func broadcastConduite() {
        guard !subscribers.isEmpty else { return }
        broadcast(SSE.frame("conduite", RemoteActions.conduitePayload(project)))
    }

    /// La veille des fichiers de session des runs VIVANTS : un fichier qui
    /// apparaît entre sous surveillance, un run qui meurt en sort.
    private func refreshWatchedRuns() {
        let live = Set(
            storeRuns(of: storeHub.current())
                .filter(storeRunIsLive)
                .map(\.sessionFile)
                .filter { !$0.isEmpty }
        )
        for file in live where watchers[file] == nil { watch(file) }
        for file in watchers.keys where !live.contains(file) {
            watchers[file]?.stop()
            watchers[file] = nil
            readers[file] = nil
        }
    }

    private func watch(_ file: String) {
        let watcher = FileWatcher(path: file)
        watchers[file] = watcher
        let reader = SessionReader(path: file)
        readers[file] = reader
        let changes = watcher.changes
        tasks.append(Task { @MainActor [weak self] in
            for await _ in changes {
                guard let self, self.watchers[file] != nil else { return }
                self.publish(file)
            }
        })
    }

    /// Lit ce qu'un fichier de session a produit depuis la dernière lecture.
    private func publish(_ file: String) {
        guard let reader = readers[file] else { return }
        let read = reader.read()
        if let issue = read.issue {
            switch issue {
            case .truncated, .replaced:
                broadcast(SSE.frame("sessions", RemoteSessionsEvent(
                    file: file,
                    added: nil,
                    issue: issue == .replaced ? "replaced" : "truncated"
                )))
                return
            default:
                break
            }
        }
        guard !read.added.isEmpty else { return }
        broadcast(SSE.frame("sessions", RemoteSessionsEvent(
            file: file,
            added: read.added.map(RemoteConversationEntry.init),
            issue: nil
        )))
    }

    private func broadcastHosted() {
        let host = session.host
        let fresh = host.transcript.filter { $0.id > lastTranscriptId }
        if let last = host.transcript.last?.id { lastTranscriptId = max(lastTranscriptId, last) }
        broadcast(SSE.frame("hosted", RemoteHostedEvent(
            state: RemoteActions.stateName(host.state),
            dialogs: host.dialogQueue,
            added: fresh
        )))
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
