// La garde d'acceptation (S-1) : le serveur ne répond QU'À une source locale.
//
// Classification PURE, sans E/S : les plages privées, la boucle locale et les
// adresses de lien-local IPv4 et IPv6 (Doc-1 : `connection.endpoint` est le seul
// endroit où l'adresse distante est lisible). Un hôte qui n'est pas une adresse
// numérique (`.name`) est refusé : on ne résout rien à l'acceptation.

import Foundation
import Network

enum RemoteAddressPolicy {
    /// L'adresse d'une connexion est-elle locale ?
    static func isLocal(host: NWEndpoint.Host) -> Bool {
        switch host {
        case .ipv4(let address): return isLocal(ipv4: address.rawValue)
        case .ipv6(let address): return isLocal(ipv6: address.rawValue)
        default: return false
        }
    }

    /// L'adresse d'un `sockaddr` nu (utilisé quand Network.framework n'en donne
    /// pas d'`NWEndpoint` typé).
    static func isLocal(_ address: UnsafePointer<sockaddr>) -> Bool {
        switch Int32(address.pointee.sa_family) {
        case AF_INET:
            let raw = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
            return withUnsafeBytes(of: raw) { isLocal(ipv4: Data($0)) }
        case AF_INET6:
            let raw = UnsafeRawPointer(address).assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
            return withUnsafeBytes(of: raw) { isLocal(ipv6: Data($0)) }
        default:
            return false
        }
    }

    /// 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16,
    /// 100.64.0.0/10.
    static func isLocal(ipv4 raw: Data) -> Bool {
        let bytes = [UInt8](raw)
        guard bytes.count == 4 else { return false }
        switch bytes[0] {
        case 127: return true
        case 10: return true
        case 172: return (16...31).contains(bytes[1])
        case 192: return bytes[1] == 168
        case 169: return bytes[1] == 254
        case 100: return (64...127).contains(bytes[1])
        default: return false
        }
    }

    /// `::1`, `fe80::/10`, `fc00::/7` — et les adresses IPv4 mappées (`::ffff:a.b.c.d`),
    /// qui sont jugées sur leur partie IPv4.
    static func isLocal(ipv6 raw: Data) -> Bool {
        let bytes = [UInt8](raw)
        guard bytes.count == 16 else { return false }
        if bytes[0] == 0, bytes[1] == 0, bytes[2] == 0, bytes[3] == 0,
           bytes[4] == 0, bytes[5] == 0, bytes[6] == 0, bytes[7] == 0,
           bytes[8] == 0, bytes[9] == 0, bytes[10] == 0xFF, bytes[11] == 0xFF {
            return isLocal(ipv4: Data(bytes[12..<16]))
        }
        let loopback = bytes[0...14].allSatisfy { $0 == 0 } && bytes[15] == 1
        if loopback { return true }
        if bytes[0] == 0xFE, bytes[1] & 0xC0 == 0x80 { return true }   // fe80::/10
        if bytes[0] & 0xFE == 0xFC { return true }                     // fc00::/7
        return false
    }
}
