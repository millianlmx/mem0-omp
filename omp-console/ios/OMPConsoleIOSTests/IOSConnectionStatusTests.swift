// Les preuves Swift du statut présenté de la mémoire du serveur et du vocabulaire
// du composant partagé (feature etats-non-connecte-heterogenes-ios, S-1, S-2, S-3).

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@Suite("etats-non-connecte-heterogenes-ios — statut de la mémoire")
struct IOSConnectionStatusTests {
    @Test("le statut suit l'accès : réglages en lecture, mémoire reliée, ou aucun code d'appairage")
    func statusFollowsTheAccess() {
        #expect(IOSConnectionStatus.resolve(isLoaded: false, isConfigured: false) == .connecting)
        #expect(IOSConnectionStatus.resolve(isLoaded: true, isConfigured: false) == .disconnected(.unpaired))
        #expect(IOSConnectionStatus.resolve(isLoaded: true, isConfigured: true) == .connected)
        #expect(IOSConnectionStatus.resolve(isLoaded: false, isConfigured: true) == .connected)
    }

    @Test("les gestes qui lisent la mémoire ne sont tapables qu'une fois reliée")
    func gesturesNeedTheMemory() {
        #expect(IOSConnectionStatus.connected.gesturesEnabled)
        #expect(!IOSConnectionStatus.connecting.gesturesEnabled)
        #expect(!IOSConnectionStatus.disconnected(.unpaired).gesturesEnabled)
    }

    @Test("la cause dit le geste qui relie : le code d'appairage dans la feuille Serveur, sans Mac")
    func causeNamesThePairingCode() {
        let cause = IOSConnectionStateText.cause(.unpaired)
        #expect(cause.contains("code d’appairage"))
        #expect(cause.contains("Serveur"))
        #expect(!cause.contains("Mac"))
        #expect(!IOSConnectionStateText.title.contains("Mac"))
    }

    @Test("les identifiants du composant sont uniques et préfixés")
    func connectionIdentifiersAreUniqueAndPrefixed() {
        let identifiers = IOSConnectionStateAccessibility.identifiers
        #expect(identifiers.count == 9)
        #expect(Set(identifiers).count == identifiers.count)
        for identifier in identifiers {
            #expect(identifier.hasPrefix("ios.connexion."), "\(identifier)")
        }
        #expect(IOSConnectionStateText.connectingTitle != IOSConnectionStateText.title)
        #expect(!IOSConnectionStateText.connectingTitle.contains(IOSConnectionStateText.connect))
    }
}
