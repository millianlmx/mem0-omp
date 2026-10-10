// La garde d'acceptation (BR-3, S-1) : le serveur ne répond qu'à une source
// locale. La classification est PURE — les plages privées, la boucle locale et
// les adresses de lien-local, IPv4 comme IPv6.

import Network
import Testing
@testable import OMPConsole

private func ipv4(_ text: String) -> NWEndpoint.Host {
    .ipv4(IPv4Address(text)!)
}

private func ipv6(_ text: String) -> NWEndpoint.Host {
    .ipv6(IPv6Address(text)!)
}

@Test("garde locale : les adresses IPv4 privées, boucle et lien-local sont acceptées")
func privateIPv4IsLocal() {
    let accepted = [
        "127.0.0.1",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.5",
        "169.254.1.1",
        "100.64.0.1",
    ]
    for text in accepted {
        #expect(RemoteAddressPolicy.isLocal(host: ipv4(text)), "\(text) doit être locale")
    }
}

@Test("garde locale : les adresses IPv4 publiques ou hors des plages sont refusées")
func publicIPv4IsNotLocal() {
    let refused = [
        "172.15.0.1",
        "172.32.0.1",
        "192.169.0.1",
        "8.8.8.8",
        "100.128.0.1",
    ]
    for text in refused {
        #expect(RemoteAddressPolicy.isLocal(host: ipv4(text)) == false, "\(text) ne doit pas être locale")
    }
}

@Test("garde locale : boucle, lien-local et unique-local IPv6 sont acceptées")
func localIPv6IsLocal() {
    for text in ["::1", "fe80::1", "fd00::1"] {
        #expect(RemoteAddressPolicy.isLocal(host: ipv6(text)), "\(text) doit être locale")
    }
}

@Test("garde locale : une IPv6 publique ou la seconde adresse de boucle est refusée")
func publicIPv6IsNotLocal() {
    for text in ["2001:db8::1", "::2"] {
        #expect(RemoteAddressPolicy.isLocal(host: ipv6(text)) == false, "\(text) ne doit pas être locale")
    }
}

@Test("garde locale : une IPv4 mappée est jugée sur sa partie IPv4")
func mappedIPv4IsJudgedOnItsIPv4Part() {
    #expect(RemoteAddressPolicy.isLocal(host: ipv6("::ffff:192.168.0.1")))
    #expect(RemoteAddressPolicy.isLocal(host: ipv6("::ffff:8.8.8.8")) == false)
}

@Test("garde locale : un hôte nommé n'est pas résolu et est refusé")
func namedHostIsRefused() {
    #expect(RemoteAddressPolicy.isLocal(host: .name("exemple.local", nil)) == false)
}

@Test("adresse affichée : l'adresse CLAT d'un partage de connexion iPhone n'est jamais montrée")
func displayedAddressSkipsUnreachableIPv4() {
    // En IPv6 seul (Wi-Fi « iPhone de … »), `en0` n'a que 192.0.0.2 : un autre
    // appareil ne peut pas la joindre, l'adresse suivante (ex. Tailscale) si.
    #expect(RemoteServer.primaryLocalAddress(among: ["192.0.0.2", "100.100.172.84"]) == "100.100.172.84")
    #expect(RemoteServer.primaryLocalAddress(among: ["192.0.0.2"]) == nil)
    #expect(RemoteServer.primaryLocalAddress(among: ["192.168.1.12", "100.100.172.84"]) == "192.168.1.12")
    #expect(RemoteServer.primaryLocalAddress(among: ["8.8.8.8"]) == nil)
}

@Test("mac-feuille-appairage-debordante/AC-11 : l'adresse de LAN est montrée avant Tailscale, quel que soit l'ordre des interfaces")
func displayedAddressPrefersPrivateLAN() {
    // Mesuré sur le poste : Tailscale (utun) précède en0 dans `getifaddrs`, et
    // l'app iOS refuse le HTTP vers 100.64/10 (ATS) — l'appairage échouait.
    #expect(RemoteServer.primaryLocalAddress(among: ["100.100.172.84", "192.168.1.175"]) == "192.168.1.175")
    #expect(RemoteServer.primaryLocalAddress(among: ["100.100.172.84", "10.0.0.4"]) == "10.0.0.4")
    #expect(RemoteServer.primaryLocalAddress(among: ["169.254.3.1", "100.100.172.84", "172.20.1.2"]) == "172.20.1.2")
    // Sans LAN privé : Tailscale avant le lien-local ; à rang égal, l'ordre des interfaces.
    #expect(RemoteServer.primaryLocalAddress(among: ["169.254.3.1", "100.100.172.84"]) == "100.100.172.84")
    #expect(RemoteServer.primaryLocalAddress(among: ["192.168.1.175", "10.0.0.4"]) == "192.168.1.175")
}
