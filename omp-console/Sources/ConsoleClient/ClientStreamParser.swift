// Le parseur de trames SSE (S-2, Doc-6) : on découpe les OCTETS sur `\n\n`, jamais
// les lignes — `AsyncLineSequence` ne rend pas les lignes vides de façon fiable et
// perdrait le dernier évènement.
//
// Un `data:` illisible et une trame de nom inconnu sont IGNORÉS sans couper le
// flux : c'est ce qui rend le client tolérant à une coque plus récente.

import ConsoleCore
import Foundation

/// Un évènement du flux, décodé.
public enum ClientStreamEvent: Equatable, Sendable {
    case hello(RemoteHelloEvent)
    case store(StoreSnapshot)
    case sessions(RemoteSessionsEvent)
    case hosted(RemoteHostedEvent)
    case devices(RemoteDevicesEvent)
    /// Nom inconnu, ou charge utile illisible : ignoré par le modèle.
    case unknown(String)

    /// Le nom de la trame, tel que reçu.
    public var name: String {
        switch self {
        case .hello: return "hello"
        case .store: return "store"
        case .sessions: return "sessions"
        case .hosted: return "hosted"
        case .devices: return "devices"
        case .unknown(let name): return name
        }
    }
}

/// Le décodeur incrémental des trames SSE.
public struct ClientStreamParser {
    private var buffer = Data()
    private let decoder = JSONDecoder()

    public init() {}

    /// Consomme des octets et rend les évènements COMPLETS disponibles.
    public mutating func consume(_ data: Data) -> [ClientStreamEvent] {
        buffer.append(data)
        var events: [ClientStreamEvent] = []
        while let range = buffer.range(of: Data("\n\n".utf8)) {
            let frame = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
            buffer.removeSubrange(buffer.startIndex..<range.upperBound)
            if let event = decode(frame) { events.append(event) }
        }
        return events
    }

    private func decode(_ frame: Data) -> ClientStreamEvent? {
        guard let text = String(data: frame, encoding: .utf8) else { return nil }
        var name: String?
        var payload: String?
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if line.hasPrefix(":") { continue }
            if line.hasPrefix("event:") {
                name = String(line.dropFirst("event:".count)).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                let value = String(line.dropFirst("data:".count)).trimmingCharacters(in: .whitespaces)
                payload = payload.map { $0 + "\n" + value } ?? value
            }
        }
        guard let name, let payload, let data = payload.data(using: .utf8) else { return nil }
        switch name {
        case "hello":
            return (try? decoder.decode(RemoteHelloEvent.self, from: data)).map(ClientStreamEvent.hello)
                ?? .unknown(name)
        case "store":
            return (try? decoder.decode(StoreSnapshot.self, from: data)).map(ClientStreamEvent.store)
                ?? .unknown(name)
        case "sessions":
            return (try? decoder.decode(RemoteSessionsEvent.self, from: data)).map(ClientStreamEvent.sessions)
                ?? .unknown(name)
        case "hosted":
            return (try? decoder.decode(RemoteHostedEvent.self, from: data)).map(ClientStreamEvent.hosted)
                ?? .unknown(name)
        case "devices":
            return (try? decoder.decode(RemoteDevicesEvent.self, from: data)).map(ClientStreamEvent.devices)
                ?? .unknown(name)
        default:
            return .unknown(name)
        }
    }
}
