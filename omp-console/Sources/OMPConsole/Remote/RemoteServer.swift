// Le serveur HTTP/1.1 local de la coque (S-1) : UN `NWListener` TCP annoncé par
// Bonjour, une garde d'acceptation (source locale seulement), une boucle de
// lecture/écriture par connexion, une réponse et fermeture.
//
// Tout vit sur l'acteur principal : le listener et chaque connexion démarrent sur
// la file principale, si bien que le parseur, la table de routes et les modèles de
// la coque ne sont jamais touchés depuis deux files. Le service est petit et
// bavard (l'API est un canal de contrôle), pas un serveur de fichiers.
//
// Doc-1 : API CLASSIQUE (`NWListener`/`NWConnection`/`NWTXTRecord`) — elle est
// documentée depuis macOS 10.14 et couvre exactement le besoin (TCP + Bonjour +
// TXT). Doc-2 : le refus du privilège de réseau local arrive en
// `kDNSServiceErr_PolicyDenied` (-65570) et donne l'état `denied`.

import ConsoleCore
import Darwin
import Foundation
import Network

/// Le contrat du service vu par la coque : la feuille d'appairage n'observe que
/// ceci (et les tests substituent une doublure).
@MainActor
protocol RemoteListening: AnyObject {
    var state: RemoteServiceState { get }
    var onState: ((RemoteServiceState) -> Void)? { get set }
    /// L'adresse d'écoute affichable (`192.168.1.12:8787`), quand le service tourne.
    var address: String? { get }
    func start(port: Int) async throws
    func stop()
}

/// Un flux qui prend la main sur sa connexion : le serveur écrit l'en-tête SSE
/// puis appelle `start()`, et la fermeture coupe le flux.
@MainActor
protocol RemoteStreamStartable: AnyObject {
    func start()
    func stop()
}

/// Ce qu'un handler rend au serveur : une réponse, ou un flux.
enum RemoteHandlerOutcome {
    case respond(HTTPResponse)
    case stream(any RemoteStreamStartable)
}

/// Le point d'écriture d'une connexion, remis au handler : c'est par lui que le
/// flux pousse ses évènements.
@MainActor
final class RemoteConnectionHandle {
    let id: UUID
    private weak var connection: RemoteConnection?

    fileprivate init(id: UUID, connection: RemoteConnection) {
        self.id = id
        self.connection = connection
    }

    func send(_ data: Data) { connection?.write(data) }
    func close() { connection?.finish() }

    /// Les écritures encore en vol sur cette connexion : le flux s'en sert pour
    /// abandonner les évènements d'un client lent (S-13).
    var pending: Int { connection?.pendingWrites ?? 0 }
}

/// Le serveur : un listener à la fois, un handler injecté.
@MainActor
final class RemoteServer: RemoteListening {
    typealias Handler = @MainActor (HTTPRequest, RemoteConnectionHandle) async -> RemoteHandlerOutcome

    private(set) var state: RemoteServiceState = .off {
        didSet { if state != oldValue { onState?(state) } }
    }
    var onState: ((RemoteServiceState) -> Void)?
    private(set) var address: String?

    private let handler: Handler
    private var listener: NWListener?
    private var connections: [UUID: RemoteConnection] = [:]
    private var startContinuation: CheckedContinuation<Void, Error>?

    init(handler: @escaping Handler) {
        self.handler = handler
    }

    /// Le port effectif, une fois `.ready` (utile quand on écoute sur `0`).
    var port: UInt16? { listener?.port?.rawValue }

    deinit {
        // `stop()` est @MainActor : la terminaison passe par l'accroche de l'app.
    }

    func start(port: Int) async throws {
        stop()
        state = .starting
        let nwPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) ?? .any
        let listener: NWListener
        do {
            listener = try NWListener(using: .tcp, on: nwPort)
        } catch {
            let reason = Self.motif(error, port: port)
            state = .failed(reason: reason)
            throw RemoteServiceFailure(reason)
        }
        // Le service Bonjour est posé AVANT `start` : c'est à ce moment qu'il est
        // annoncé, et un conflit de nom fait seulement renommer l'instance.
        listener.service = NWListener.Service(
            name: ConsoleAPI.Service.bonjourName,
            type: ConsoleAPI.Service.bonjourType,
            domain: nil,
            txtRecord: NWTXTRecord([
                "v": String(ConsoleAPI.protocolVersion),
                "api": ConsoleAPI.Service.basePath,
            ])
        )
        listener.stateUpdateHandler = { [weak self] newState in
            MainActor.assumeIsolated { self?.apply(newState, port: port) }
        }
        listener.newConnectionHandler = { [weak self] connection in
            MainActor.assumeIsolated { self?.acceptConnection(connection) }
        }
        self.listener = listener
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            startContinuation = continuation
            listener.start(queue: .main)
        }
    }

    func stop() {
        listener?.stateUpdateHandler = nil
        listener?.newConnectionHandler = nil
        listener?.cancel()
        listener = nil
        for connection in connections.values { connection.finish() }
        connections.removeAll()
        address = nil
        state = .off
    }

    /// La garde d'acceptation, avant toute lecture : une source non locale est
    /// coupée sans un octet lu ni écrit.
    func acceptConnection(_ connection: NWConnection) {
        guard case .hostPort(let host, _) = connection.endpoint, RemoteAddressPolicy.isLocal(host: host) else {
            connection.cancel()
            return
        }
        let id = UUID()
        let remote = RemoteConnection(
            id: id,
            connection: connection,
            handler: handler,
            onClose: { [weak self] in self?.connections[id] = nil }
        )
        connections[id] = remote
        remote.start()
    }

    // MARK: - État du listener

    private func apply(_ newState: NWListener.State, port: Int) {
        switch newState {
        case .ready:
            let effective = listener?.port?.rawValue ?? UInt16(clamping: port)
            let host = Self.primaryLocalAddress(among: Self.interfaceIPv4Addresses()) ?? "127.0.0.1"
            let shown = "\(host):\(effective)"
            address = shown
            state = .running(address: shown)
            resolveStart()
        case .failed(let error):
            address = nil
            state = .failed(reason: Self.motif(error, port: port))
            resolveStart(throwing: RemoteServiceFailure(Self.motif(error, port: port)))
        case .waiting(let error):
            if Self.isLocalNetworkDenied(error) {
                state = .denied(reason: Self.motif(error, port: port))
                resolveStart()
            }
        case .cancelled:
            resolveStart(throwing: RemoteServiceFailure("listener annulé"))
        case .setup:
            break
        @unknown default:
            break
        }
    }

    private func resolveStart(throwing error: Error? = nil) {
        guard let continuation = startContinuation else { return }
        startContinuation = nil
        if let error { continuation.resume(throwing: error) } else { continuation.resume() }
    }

    // MARK: - Diagnostic

    /// Le motif d'un échec, tiré du CAS d'erreur (jamais de `localizedDescription`
    /// seul) : c'est ce que l'état et le journal montrent.
    static func motif(_ error: Error, port: Int) -> String {
        if let failure = error as? RemoteServiceFailure { return failure.reason }
        guard let nw = error as? NWError else { return "échec du listener (\(error))" }
        switch nw {
        case let .posix(code) where code == .EADDRINUSE:
            return "port \(port) déjà utilisé"
        case let .posix(code):
            return "erreur système \(code.rawValue) (\(String(cString: strerror(code.rawValue))))"
        case let .dns(code):
            return "erreur Bonjour \(code)"
        case let .tls(status):
            return "erreur TLS \(status)"
        @unknown default:
            return "échec du listener (\(nw))"
        }
    }

    /// Doc-2 : `kDNSServiceErr_PolicyDenied` = -65570.
    static func isLocalNetworkDenied(_ error: Error) -> Bool {
        guard let nw = error as? NWError, case .dns(let code) = nw else { return false }
        return code == -65570
    }

    /// L'adresse que la garde d'acceptation accepterait pour un pair du même
    /// réseau, la plus joignable d'abord : une adresse privée de LAN (10/8,
    /// 172.16/12, 192.168/16), puis le partage d'adresses 100.64/10 (Tailscale),
    /// puis le lien-local ; à rang égal, l'ordre des interfaces. L'app iOS
    /// n'atteint en HTTP que le réseau local (ATS, `NSAllowsLocalNetworking`) :
    /// une adresse Tailscale montrée en premier lui fait échouer l'appairage
    /// (NSURLError -1022), alors que l'adresse de LAN du même Mac passe. L'adresse
    /// CLAT d'un réseau IPv6 seul (`192.0.0.2`, partage de connexion iPhone) ou une
    /// adresse publique n'est joignable par personne : jamais montrée.
    nonisolated static func primaryLocalAddress(among addresses: [String]) -> String? {
        var best: (rank: Int, text: String)?
        for text in addresses {
            guard let ipv4 = IPv4Address(text), RemoteAddressPolicy.isLocal(ipv4: ipv4.rawValue) else { continue }
            let rank = displayRank(ipv4: [UInt8](ipv4.rawValue))
            if best.map({ rank < $0.rank }) ?? true { best = (rank, text) }
        }
        return best?.text
    }

    /// 0 : LAN privé ; 1 : 100.64/10 ; 2 : lien-local (et boucle locale).
    private nonisolated static func displayRank(ipv4 bytes: [UInt8]) -> Int {
        switch bytes[0] {
        case 10: return 0
        case 172 where (16...31).contains(bytes[1]): return 0
        case 192 where bytes[1] == 168: return 0
        case 100: return 1
        default: return 2
        }
    }

    /// Les adresses IPv4 non-loopback des interfaces actives, en ordre d'interface.
    nonisolated static func interfaceIPv4Addresses() -> [String] {
        var addresses: [String] = []
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return [] }
        defer { freeifaddrs(head) }
        for pointer in sequence(first: first, next: { $0.pointee.ifa_next }) {
            let flags = Int32(pointer.pointee.ifa_flags)
            guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
            guard let socket = pointer.pointee.ifa_addr, socket.pointee.sa_family == UInt8(AF_INET) else { continue }
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(
                socket,
                socklen_t(socket.pointee.sa_len),
                &host,
                socklen_t(host.count),
                nil,
                0,
                NI_NUMERICHOST
            ) == 0 {
                addresses.append(String(cString: host))
            }
        }
        return addresses
    }
}

/// L'échec du service, en clair (jamais un `localizedDescription`).
struct RemoteServiceFailure: Error, Equatable {
    let reason: String
    init(_ reason: String) { self.reason = reason }
}

/// Une connexion acceptée : lecture incrémentale, une requête, une réponse.
@MainActor
final class RemoteConnection {
    let id: UUID
    private let connection: NWConnection
    private let handler: RemoteServer.Handler
    private let onClose: () -> Void
    private var parser = HTTPRequestParser()
    private var closed = false
    private var inFlight = 0
    private var closeAfterSend = false
    private var startAfterSend: (any RemoteStreamStartable)?
    /// Le flux DÉMARRÉ sur cette connexion : `finish()` doit le rendre (S-6/S-13),
    /// sinon un client qui ferme son flux laisse l'abonnement — et le drapeau
    /// `connected` — vivants côté coque.
    private var startedStream: (any RemoteStreamStartable)?

    /// Les écritures encore en vol (S-13 : client lent).
    var pendingWrites: Int { inFlight }

    fileprivate init(
        id: UUID,
        connection: NWConnection,
        handler: @escaping RemoteServer.Handler,
        onClose: @escaping () -> Void
    ) {
        self.id = id
        self.connection = connection
        self.handler = handler
        self.onClose = onClose
    }

    func start() {
        connection.stateUpdateHandler = { [weak self] state in
            MainActor.assumeIsolated {
                guard case .failed = state else { return }
                self?.finish()
            }
        }
        connection.start(queue: .main)
        receive()
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            MainActor.assumeIsolated {
                guard let self else { return }
                if let data, !data.isEmpty { self.consume(data) }
                if error != nil || isComplete { self.finish() } else { self.receive() }
            }
        }
    }

    private func consume(_ data: Data) {
        guard !closed else { return }
        parser.append(data)
        switch parser.next() {
        case .incomplete:
            return
        case .invalid(let reason):
            closeAfterSend = true
            write(HTTPResponse.error(.badRequest(reason)).serialized())
        case .ok(let request):
            Task { @MainActor in await self.perform(request) }
        }
    }

    private func perform(_ request: HTTPRequest) async {
        let handle = RemoteConnectionHandle(id: id, connection: self)
        switch await handler(request, handle) {
        case .respond(let response):
            closeAfterSend = true
            write(response.serialized())
        case .stream(let stream):
            startAfterSend = stream
            write(HTTPResponse.stream().serialized())
        }
    }

    /// Écrit des octets ; la suite (fermeture ou démarrage du flux) est décidée
    /// par l'état, jamais par une fermeture capturée par un envoi.
    func write(_ data: Data) {
        guard !closed else { return }
        inFlight += 1
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            MainActor.assumeIsolated {
                guard let self, !self.closed else { return }
                if error != nil { self.finish(); return }
                self.inFlight -= 1
                self.settle()
            }
        })
    }

    private func settle() {
        guard inFlight == 0 else { return }
        if let stream = startAfterSend {
            startAfterSend = nil
            startedStream = stream
            stream.start()
            return
        }
        if closeAfterSend { finish() }
    }

    func finish() {
        guard !closed else { return }
        closed = true
        let stream = startedStream
        startedStream = nil
        connection.stateUpdateHandler = nil
        connection.cancel()
        stream?.stop()
        onClose()
    }
}
