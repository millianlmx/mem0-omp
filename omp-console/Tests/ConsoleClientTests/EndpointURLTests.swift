// L'URL et l'affichage d'un endpoint. Network.framework rend l'adresse d'un Mac
// découvert par Bonjour AVEC sa zone d'interface, en IPv6 lien-local
// (`fe80::…%en0`, partage de connexion) comme en IPv4 (`192.168.1.175%en0`).
// `URL` refuse ces formes nues : l'ancien `URL(string:)!` faisait planter l'app
// au premier geste (« Appairer »), puis la zone IPv4 donnait « adresse du Mac
// invalide ». Dans l'URL, un IPv6 garde sa zone échappée ; un IPv4 ou un nom la
// perd. À l'écran, aucune adresse ne montre de zone.

@testable import ConsoleClient
import Testing

@Suite("URL d'un endpoint")
struct EndpointURLTests {
    @Test("un lien-local IPv6 découvert par Bonjour s'écrit entre crochets, zone échappée")
    func linkLocalIPv6() {
        let endpoint = ClientEndpoint.bonjour(name: "OMP Console", host: "fe80::499:8cbf:e74:53e1%en0", port: 8787)
        #expect(endpoint.baseURL?.absoluteString == "http://[fe80::499:8cbf:e74:53e1%25en0]:8787")
        #expect(endpoint.display == "OMP Console — [fe80::499:8cbf:e74:53e1]:8787")
        #expect(ClientEndpoint.manual(host: "fe80::1", port: 8787).baseURL?.absoluteString == "http://[fe80::1]:8787")
        #expect(ClientEndpoint.manual(host: "[fe80::1%en0]", port: 8787).baseURL?.host == "fe80::1%en0")
    }

    @Test("un hôte IPv4 ou un nom zoné s'écrit sans zone dans l'URL")
    func zonedIPv4AndNameLoseZone() {
        #expect(ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.175%en0", port: 8787).baseURL?.absoluteString == "http://192.168.1.175:8787")
        #expect(ClientEndpoint.manual(host: "127.0.0.1%en0", port: 8787).baseURL?.absoluteString == "http://127.0.0.1:8787")
        #expect(ClientEndpoint.manual(host: "mac.local%en0", port: 8787).baseURL?.absoluteString == "http://mac.local:8787")
        // Plusieurs `%` : tout ce qui suit le premier est la zone ; le port n'est pas touché.
        #expect(ClientEndpoint.manual(host: "10.0.0.2%en0%x", port: 9000).baseURL?.absoluteString == "http://10.0.0.2:9000")
        // Rien ne reste une fois la zone retirée : pas d'URL.
        #expect(ClientEndpoint.manual(host: "%en0", port: 8787).baseURL == nil)
    }

    @Test("un IPv4 et un nom gardent leur forme")
    func ipv4AndName() {
        #expect(ClientEndpoint.manual(host: "100.100.172.84", port: 8787).baseURL?.absoluteString == "http://100.100.172.84:8787")
        #expect(ClientEndpoint.manual(host: "192.168.1.175", port: 8787).baseURL?.absoluteString == "http://192.168.1.175:8787")
        #expect(ClientEndpoint.manual(host: "mac.local", port: 9000).baseURL?.absoluteString == "http://mac.local:9000")
        #expect(ClientEndpoint.manual(host: "100.100.172.84", port: 8787).display == "100.100.172.84:8787")
    }

    @Test("un hôte qui ne s'écrit pas en URL donne nil, jamais un plantage")
    func unwritableHostIsNil() {
        #expect(ClientEndpoint.manual(host: "exemple com", port: 90).baseURL == nil)
    }

    @Test("bonjour-adresse-ipv4-invalide/AC-3 : une adresse zonée s'affiche sans zone, en IPv4 comme en IPv6")
    func displayNeverShowsZone() {
        let table: [(ClientEndpoint, String)] = [
            (.bonjour(name: "OMP Console", host: "192.168.1.175%en0", port: 8787), "OMP Console — 192.168.1.175:8787"),
            (.manual(host: "192.168.1.175%en0", port: 8787), "192.168.1.175:8787"),
            (.bonjour(name: "OMP Console", host: "fe80::499:8cbf:e74:53e1%en0", port: 8787), "OMP Console — [fe80::499:8cbf:e74:53e1]:8787"),
            (.manual(host: "[fe80::1%en0]", port: 8787), "[fe80::1]:8787"),
            (.manual(host: "100.100.172.84", port: 8787), "100.100.172.84:8787"),
            (.manual(host: "mac.local", port: 9000), "mac.local:9000"),
        ]
        for (endpoint, shown) in table {
            #expect(endpoint.display == shown)
            #expect(!endpoint.display.contains("%"))
        }
    }
}
