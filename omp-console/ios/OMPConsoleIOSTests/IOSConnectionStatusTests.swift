// Les preuves Swift du statut de connexion présenté et du vocabulaire du
// composant partagé (feature etats-non-connecte-heterogenes-ios, S-1, S-2, S-3).
// Le rendu dans les sept sections se prouve par la recette idb (S-6).

import ConsoleClient
import Foundation
import Testing

@testable import OMPConsoleIOS

@Suite("etats-non-connecte-heterogenes-ios — statut de connexion présenté")
struct IOSConnectionStatusTests {
    private static let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)

    /// La table EXHAUSTIVE de S-1 : (état du client, échec précédent) → statut.
    private static let table: [(ClientState, Bool, IOSConnectionStatus)] = [
        (.connected(endpoint: endpoint), false, .connected),
        (.connected(endpoint: endpoint), true, .connected),
        (.connecting(endpoint: endpoint), false, .connecting),
        (.connecting(endpoint: endpoint), true, .disconnected(.unreachable)),
        (.searching, false, .connecting),
        (.searching, true, .disconnected(.unreachable)),
        (.macAbsent(endpoint: endpoint), false, .disconnected(.unreachable)),
        (.macAbsent(endpoint: endpoint), true, .disconnected(.unreachable)),
        (.noNetwork, false, .disconnected(.unreachable)),
        (.noNetwork, true, .disconnected(.unreachable)),
        (.unpaired, false, .disconnected(.unpaired)),
        (.unpaired, true, .disconnected(.unpaired)),
        (.revoked, false, .disconnected(.refused)),
        (.revoked, true, .disconnected(.refused)),
        (.incompatibleProtocol(local: 1, remote: 2), false, .disconnected(.updateApp)),
        (.incompatibleProtocol(local: 1, remote: 2), true, .disconnected(.updateApp)),
        (.incompatibleProtocol(local: 2, remote: 1), false, .disconnected(.updateMac)),
        (.incompatibleProtocol(local: 1, remote: nil), true, .disconnected(.updateMac)),
        (.incompatibleProtocol(local: 1, remote: 1), false, .disconnected(.updateMac)),
    ]

    private static let causes: [IOSDisconnectCause] = [.unpaired, .refused, .unreachable, .updateApp, .updateMac]

    @Test("etats-non-connecte-heterogenes-ios/AC-3 : chaque état du client donne son statut et sa cause (table de S-1)")
    func resolvesEveryClientState() {
        for (state, failed, expected) in Self.table {
            #expect(
                IOSConnectionStatus.resolve(state, attemptFollowsFailure: failed) == expected,
                "\(state) / échec précédent : \(failed)"
            )
        }
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-6 : une tentative fraîche est « connexion en cours », jamais « non connecté »")
    func freshAttemptIsConnecting() {
        let fresh = IOSConnectionStatus.resolve(.connecting(endpoint: Self.endpoint), attemptFollowsFailure: false)
        #expect(fresh == .connecting)
        let searching = IOSConnectionStatus.resolve(.searching, attemptFollowsFailure: false)
        #expect(searching == .connecting)
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-7 : après un échec, la relance automatique reste « non connecté » (Mac injoignable)")
    func retryAfterFailureStaysDisconnected() {
        // La suite réelle du client sur un Mac muet : tentative, échec, relance, échec.
        let sequence: [(ClientState, Bool)] = [
            (.connecting(endpoint: Self.endpoint), false),
            (.macAbsent(endpoint: Self.endpoint), true),
            (.connecting(endpoint: Self.endpoint), true),
            (.macAbsent(endpoint: Self.endpoint), true),
        ]
        let shown = sequence.map { IOSConnectionStatus.resolve($0.0, attemptFollowsFailure: $0.1) }
        #expect(shown == [.connecting, .disconnected(.unreachable), .disconnected(.unreachable), .disconnected(.unreachable)])
        // La connexion qui aboutit efface le composant.
        #expect(IOSConnectionStatus.resolve(.connected(endpoint: Self.endpoint), attemptFollowsFailure: false) == .connected)
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-8 : les gestes exigeant le Mac ne sont tapables qu'une fois connecté")
    func gesturesOnlyWhenConnected() {
        #expect(IOSConnectionStatus.connected.gesturesEnabled)
        #expect(!IOSConnectionStatus.connecting.gesturesEnabled)
        for cause in Self.causes {
            #expect(!IOSConnectionStatus.disconnected(cause).gesturesEnabled, "\(cause)")
        }
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-3 : chaque cause a sa propre phrase, non vide")
    func causesHaveDistinctPhrases() {
        let phrases = Self.causes.map(IOSConnectionStateText.cause)
        #expect(Set(phrases).count == Self.causes.count)
        for phrase in phrases {
            #expect(!phrase.isEmpty)
            #expect(phrase != IOSConnectionStateText.title)
            #expect(!phrase.contains("://"), "aucune adresse ni endpoint : \(phrase)")
            #expect(!phrase.contains("/"), "aucun chemin : \(phrase)")
        }
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-3 : les phrases de version nomment l'app à mettre à jour, sans numéro")
    func updatePhrasesNameTheAppWithoutVersionNumbers() {
        for cause in Self.causes {
            let phrase = IOSConnectionStateText.cause(cause)
            #expect(phrase.rangeOfCharacter(from: .decimalDigits) == nil, "\(cause) : \(phrase)")
        }
        #expect(IOSConnectionStateText.cause(.updateApp).contains("cet appareil"))
        #expect(IOSConnectionStateText.cause(.updateMac).contains("sur le Mac"))
    }

    @Test("etats-non-connecte-heterogenes-ios/AC-1 : les identifiants du composant sont uniques et préfixés")
    func connectionIdentifiersAreUniqueAndPrefixed() {
        let identifiers = IOSConnectionStateAccessibility.identifiers
        #expect(identifiers.count == 9)
        #expect(Set(identifiers).count == identifiers.count)
        for identifier in identifiers {
            #expect(identifier.hasPrefix("ios.connexion."), "\(identifier)")
        }
        // Le composant « connexion en cours » ne dit ni « Pas de connexion au Mac » ni « Se connecter ».
        #expect(IOSConnectionStateText.connectingTitle != IOSConnectionStateText.title)
        #expect(!IOSConnectionStateText.connectingTitle.contains(IOSConnectionStateText.connect))
    }
}
