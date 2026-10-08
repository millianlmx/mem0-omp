// L'URL d'un endpoint : l'adresse qu'un Mac découvert par Bonjour sur un partage
// de connexion rend est un lien-local IPv6 avec sa zone (`fe80::…%en0`). `URL`
// refuse cette forme nue ; l'ancien `URL(string:)!` faisait planter l'app au
// premier geste (« Appairer »).

@testable import ConsoleClient
import Testing

@Suite("URL d'un endpoint")
struct EndpointURLTests {
    @Test("un lien-local IPv6 découvert par Bonjour s'écrit entre crochets, zone échappée")
    func linkLocalIPv6() {
        let endpoint = ClientEndpoint.bonjour(name: "OMP Console", host: "fe80::499:8cbf:e74:53e1%en0", port: 8787)
        #expect(endpoint.baseURL?.absoluteString == "http://[fe80::499:8cbf:e74:53e1%25en0]:8787")
        #expect(endpoint.display == "OMP Console — [fe80::499:8cbf:e74:53e1%en0]:8787")
    }

    @Test("un IPv4 et un nom gardent leur forme")
    func ipv4AndName() {
        #expect(ClientEndpoint.manual(host: "100.100.172.84", port: 8787).baseURL?.absoluteString == "http://100.100.172.84:8787")
        #expect(ClientEndpoint.manual(host: "mac.local", port: 9000).baseURL?.absoluteString == "http://mac.local:9000")
        #expect(ClientEndpoint.manual(host: "100.100.172.84", port: 8787).display == "100.100.172.84:8787")
    }

    @Test("un hôte qui ne s'écrit pas en URL donne nil, jamais un plantage")
    func unwritableHostIsNil() {
        #expect(ClientEndpoint.manual(host: "exemple com", port: 90).baseURL == nil)
    }
}
