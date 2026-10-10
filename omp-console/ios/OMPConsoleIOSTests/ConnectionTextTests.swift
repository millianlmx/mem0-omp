// Les preuves Swift de la feuille de connexion (BR-6) : les mots de `ConnectionText`
// couvrent tous les états, l'état version incompatible porte les DEUX numéros, les
// quatre zones ont leurs libellés, et les identifiants d'accessibilité sont uniques.
//
// Aucun slug de critère qualifié ici : la preuve canonique d'AC-21 vit dans
// `test/client-distant-ios.test.ts`, et l'invariant du dépôt veut qu'un slug de
// feature ne vive que dans un seul fichier de test.

import ConsoleClient
import Testing

@testable import OMPConsoleIOS

@Suite("ConnectionText — mots et identifiants de la feuille")
struct ConnectionTextTests {
    @Test("ConnectionText : chaque état de ClientState a un libellé, l'endpoint nommé")
    func everyStateHasLabel() {
        let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)
        #expect(ConnectionText.state(.unpaired) == ConnectionText.unpaired)
        #expect(ConnectionText.state(.searching) == ConnectionText.searching)
        #expect(ConnectionText.state(.connecting(endpoint: endpoint)) == ConnectionText.connecting(endpoint: endpoint.display))
        #expect(ConnectionText.state(.connected(endpoint: endpoint)) == ConnectionText.connected(endpoint: endpoint.display))
        #expect(ConnectionText.state(.noNetwork) == ConnectionText.noNetwork)
        #expect(ConnectionText.state(.macAbsent(endpoint: endpoint)) == ConnectionText.macAbsent(endpoint: endpoint.display))
        #expect(ConnectionText.state(.macAbsent(endpoint: endpoint)).hasPrefix("Mac injoignable"))
        #expect(ConnectionText.state(.connecting(endpoint: endpoint)).contains("127.0.0.1:8787"))
        #expect(ConnectionText.state(.connected(endpoint: endpoint)).contains("127.0.0.1:8787"))
    }

    @Test("ConnectionText : un Mac découvert avec une zone s'affiche sans zone")
    func zonedEndpointShownWithoutZone() {
        let endpoint = ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.175%en0", port: 8787)
        for state in [ConnectionText.state(.connecting(endpoint: endpoint)),
                      ConnectionText.state(.connected(endpoint: endpoint)),
                      ConnectionText.state(.macAbsent(endpoint: endpoint))] {
            #expect(state.contains("192.168.1.175:8787"))
            #expect(!state.contains("%"))
        }
    }

    @Test("ConnectionText : l'état version incompatible porte les deux numéros")
    func incompatibleProtocolHasBothNumbers() {
        let text = ConnectionText.state(.incompatibleProtocol(local: 3, remote: 5))
        #expect(text.contains("app 3"))
        #expect(text.contains("Mac 5"))
        #expect(text.contains("Version d'API incompatible"))

        // Le numéro du Mac absent : le libellé le dit, il n'invente pas de valeur.
        let unknown = ConnectionText.incompatibleProtocol(local: 3, remote: nil)
        #expect(unknown.contains("app 3"))
        #expect(unknown.contains("Mac inconnu"))
    }

    @Test("ConnectionText : les quatre zones ont leurs libellés")
    func fourZonesHaveLabels() {
        #expect(ConnectionText.stateTitle == "État")
        #expect(ConnectionText.discoveryTitle == "Découverte")
        #expect(ConnectionText.addressTitle == "Adresse manuelle")
        #expect(ConnectionText.codeTitle == "Code d'appairage")

        // Les mots d'action de chaque zone, écrits une seule fois dans ConnectionText.
        #expect(ConnectionText.macFound == "Mac trouvé")
        #expect(ConnectionText.noMacFound == "Aucun Mac trouvé.")
        #expect(ConnectionText.addressSave == "Utiliser cette adresse")
        #expect(ConnectionText.addressClear == "Effacer")
        #expect(ConnectionText.codePair == "Appairer")
        #expect(ConnectionText.retry == "Réessayer")
        #expect(ConnectionText.close == "Fermer")
    }

    @Test("ConnectionText : l'appairage refuse avec un seul message et rend le refus")
    func pairingFailureMessages() {
        #expect(ConnectionText.pairingFailure(.malformedCode) == ConnectionText.codeMalformed)
        #expect(ConnectionText.pairingFailure(.refused) == ConnectionText.codeRefused)
        #expect(ConnectionText.pairingFailure(.incompatibleProtocol(local: 3, remote: nil)).contains("Mac inconnu"))
        #expect(ConnectionText.pairingFailure(.transport(.unreachable("muet"))) == ConnectionText.codeUnavailable)
    }

    @Test("ConnectionAccessibility : les identifiants sont uniques, préfixés et complets")
    func identifiersAreUniqueAndComplete() {
        let identifiers = ConnectionAccessibility.identifiers
        #expect(identifiers.count == 20)
        #expect(Set(identifiers).count == identifiers.count)
        #expect(identifiers.allSatisfy { $0.hasPrefix("connection.") })
        #expect(identifiers.contains(ConnectionAccessibility.sheet))
        #expect(identifiers.contains(ConnectionAccessibility.codePair))
        for added in [
            ConnectionAccessibility.refused,
            ConnectionAccessibility.help,
            ConnectionAccessibility.forget,
            ConnectionAccessibility.forgetConfirm,
            ConnectionAccessibility.addressEdit,
        ] {
            #expect(identifiers.contains(added))
        }
        #expect(identifiers.contains(ConnectionAccessibility.close))
        #expect(identifiers.contains(ConnectionAccessibility.open))
    }
}
