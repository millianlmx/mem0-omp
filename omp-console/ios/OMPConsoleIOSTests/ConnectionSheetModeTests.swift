// Les preuves Swift de la feuille Connexion par mode (S-2, S-3, S-5, S-6 de
// connexion-ios-feuille-intrusive-et-sans) : quand la feuille s'ouvre d'elle-même,
// ce qu'elle montre pour chaque statut d'appairage et chaque état de connexion,
// où va le focus initial, et les mots de ses nouveaux états.
//
// La preuve visuelle (arbre d'accessibilité, focus réel, cadre de 44 pt) est celle
// de la recette idb de la feature ; ici, la résolution PURE qui la décide.

import ConsoleClient
import ConsoleCore
import Testing

@testable import OMPConsoleIOS

@Suite("ConnectionSheetMode — modes de la feuille Connexion")
struct ConnectionSheetModeTests {
    private let manual = ClientEndpoint.manual(host: "192.168.1.20", port: 8787)
    private let bonjour = ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.30", port: 8787)

    /// Tous les états de connexion d'un appareil appairé.
    private var everyState: [ClientState] {
        [
            .unpaired,
            .searching,
            .connecting(endpoint: manual),
            .connected(endpoint: manual),
            .noNetwork,
            .macAbsent(endpoint: manual),
            .revoked,
            .incompatibleProtocol(local: 1, remote: 2),
        ]
    }

    private func resolve(
        _ pairing: ClientPairingStatus,
        _ state: ClientState,
        effective: ClientEndpoint? = nil,
        manualAddress: ClientAddress? = nil
    ) -> ConnectionSheetMode {
        ConnectionSheetMode.resolve(
            pairing: pairing, state: state, effectiveEndpoint: effective, manualAddress: manualAddress)
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-1 : appairé et connecté, la feuille ne s'ouvre pas d'elle-même et montre le mode connecté")
    func pairedConnectedNeverAutoPresents() {
        // Ni pendant la lecture du trousseau (le statut de tout lancement), ni une
        // fois l'appairage lu.
        #expect(ConnectionSheetMode.autoPresents(.restoring) == false)
        #expect(ConnectionSheetMode.autoPresents(.paired) == false)
        #expect(resolve(.restoring, .unpaired) == .restoring)
        #expect(resolve(.paired, .connected(endpoint: manual)) == .connected(address: manual.display))
        #expect(resolve(.paired, .connected(endpoint: bonjour)) == .connected(address: bonjour.display))
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-2 : appairé et Mac injoignable, aucune ouverture ; le mode est déconnecté et l'Accueil dit « Mac injoignable »")
    func pairedUnreachableStaysClosed() {
        #expect(ConnectionSheetMode.autoPresents(.paired) == false)
        #expect(resolve(.paired, .macAbsent(endpoint: manual)) == .disconnected(address: manual.display))
        // Le libellé du bandeau d'Accueil déconnecté (HomeView) nomme l'endpoint.
        let banner = ConnectionText.state(.macAbsent(endpoint: manual))
        #expect(banner == "Mac injoignable — \(manual.display)")
        #expect(!banner.contains("Mac absent"))
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-3 : sans jeton, la feuille s'ouvre en mode non appairé avec le focus sur le code")
    func noTokenAutoPresentsUnpaired() {
        #expect(ConnectionSheetMode.autoPresents(.unpaired))
        let mode = resolve(.unpaired, .unpaired, manualAddress: ClientAddress(host: "10.0.0.5", port: 9000))
        #expect(mode == .unpaired(refused: false, prefill: nil))
        #expect(mode.initialFocusOnCode)
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-4 : jeton refusé, la feuille s'ouvre en non appairé refusé, adresse préremplie")
    func refusedAutoPresentsWithPrefill() {
        #expect(ConnectionSheetMode.autoPresents(.refused(endpoint: manual)))
        #expect(ConnectionSheetMode.autoPresents(.refused(endpoint: nil)))

        // Sans adresse manuelle : l'adresse de l'endpoint refusé, sans nom Bonjour.
        let fromBonjour = resolve(.refused(endpoint: bonjour), .revoked)
        #expect(fromBonjour == .unpaired(refused: true, prefill: "192.168.1.30:8787"))
        // L'adresse manuelle en vigueur prime.
        let fromManual = resolve(
            .refused(endpoint: bonjour), .revoked, manualAddress: ClientAddress(host: "10.0.0.5", port: 9000))
        #expect(fromManual == .unpaired(refused: true, prefill: "10.0.0.5:9000"))
        // Endpoint inconnu : rien à préremplir.
        #expect(resolve(.refused(endpoint: nil), .revoked) == .unpaired(refused: true, prefill: nil))
        #expect(fromBonjour.initialFocusOnCode)

        // L'état dit « Non appairé », le message explique pourquoi.
        #expect(ConnectionText.sheetState(.revoked) == ConnectionText.unpaired)
        #expect(ConnectionText.refusedMessage == "Le Mac ne reconnaît plus cet appareil. Saisissez un nouveau code d'appairage.")

        // Relancement : le refus n'est pas persisté, le statut lu est `.unpaired`,
        // donc le mode non appairé SANS message.
        #expect(resolve(.unpaired, .unpaired) == .unpaired(refused: false, prefill: nil))
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-5 : sur un appareil appairé, aucun mode ne focalise un champ")
    func pairedModesNeverFocus() {
        #expect(ConnectionSheetMode.restoring.initialFocusOnCode == false)
        for state in everyState {
            #expect(resolve(.paired, state, effective: manual).initialFocusOnCode == false, "\(state)")
        }
        #expect(ConnectionSheetMode.unpaired(refused: false, prefill: nil).initialFocusOnCode)
        #expect(ConnectionSheetMode.unpaired(refused: true, prefill: "h:1").initialFocusOnCode)
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-6 : connecté, l'état dit « Connecté » sans adresse ; l'adresse ne vient qu'une fois")
    func connectedStateWithoutAddress() {
        #expect(ConnectionText.sheetState(.connected(endpoint: manual)) == "Connecté")
        #expect(resolve(.paired, .connected(endpoint: manual)) == .connected(address: "192.168.1.20:8787"))
        // Aucun libellé d'état de la feuille ne répète l'adresse.
        for state in everyState {
            #expect(!ConnectionText.sheetState(state).contains(manual.display), "\(state)")
            #expect(!ConnectionText.sheetState(state).contains(manual.host), "\(state)")
        }
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-7 : appairé hors connexion, le mode est déconnecté, adresse de l'état sinon effective")
    func pairedNotConnectedIsDisconnected() {
        let other = ClientEndpoint.manual(host: "10.0.0.9", port: 8787)
        #expect(resolve(.paired, .macAbsent(endpoint: manual), effective: other) == .disconnected(address: manual.display))
        #expect(resolve(.paired, .connecting(endpoint: manual), effective: other) == .disconnected(address: manual.display))
        #expect(resolve(.paired, .noNetwork, effective: other) == .disconnected(address: other.display))
        #expect(resolve(.paired, .searching) == .disconnected(address: nil))
        #expect(resolve(.paired, .incompatibleProtocol(local: 1, remote: 2), effective: other) == .disconnected(address: other.display))
        #expect(ConnectionText.sheetState(.macAbsent(endpoint: manual)) == "Mac injoignable")
        #expect(ConnectionText.addressEdit == "Modifier l'adresse")
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-8 : le Mac redevenu joignable fait passer la feuille de déconnecté à connecté")
    func retrySuccessTurnsConnected() {
        let before = resolve(.paired, .macAbsent(endpoint: manual))
        let during = resolve(.paired, .connecting(endpoint: manual))
        let after = resolve(.paired, .connected(endpoint: manual))
        #expect(before == .disconnected(address: manual.display))
        #expect(ConnectionText.sheetState(.connecting(endpoint: manual)) == "Connexion…")
        #expect(during == .disconnected(address: manual.display))
        #expect(after == .connected(address: manual.display))
        #expect(ConnectionText.retry == "Réessayer")
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-9 : la confirmation d'oubli nomme l'effet et offre « Annuler » distinct de l'action")
    func forgetConfirmationWords() {
        #expect(ConnectionText.forget == "Oublier ce Mac")
        #expect(ConnectionText.forgetTitle == "Oublier ce Mac ?")
        #expect(ConnectionText.forgetMessage.contains("nouveau code d'appairage"))
        #expect(ConnectionText.forgetCancel == "Annuler")
        #expect(ConnectionText.forgetCancel != ConnectionText.forget)
        #expect(ConnectionAccessibility.identifiers.contains(ConnectionAccessibility.forgetConfirm))
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-11 : après l'oubli, la feuille passe en non appairé et s'ouvrira au relancement")
    func forgottenIsUnpaired() {
        // L'oubli publie `.unpaired` et garde l'adresse manuelle : la feuille, restée
        // ouverte, passe au mode non appairé sans message de refus.
        let manualAddress = ClientAddress(host: "127.0.0.1", port: 9)
        #expect(resolve(.unpaired, .unpaired, manualAddress: manualAddress) == .unpaired(refused: false, prefill: nil))
        #expect(ConnectionSheetMode.autoPresents(.unpaired))
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-12 : la ligne d'aide nomme le menu, le raccourci et le bouton du Mac")
    func codeHelpNamesTheMacPath() {
        #expect(ConnectionText.codeHelp.contains("Appairage…"))
        #expect(ConnectionText.codeHelp.contains("⌥⌘A"))
        #expect(ConnectionText.codeHelp.contains("Générer un code"))
        #expect(ConnectionAccessibility.identifiers.contains(ConnectionAccessibility.help))
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-13 : le message de format exclut exactement les lettres absentes de l'alphabet Crockford")
    func malformedCodeNamesTheRealAlphabet() {
        let alphabet = Set(ConsoleAPI.Service.pairingCodeAlphabet)
        let excluded = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".filter { !alphabet.contains($0) }.map(String.init)
        #expect(excluded == ["I", "L", "O", "U"])
        let tail = excluded.dropLast().joined(separator: ", ") + " et " + excluded.last!
        #expect(ConnectionText.codeMalformed.contains("sauf \(tail)"))
        #expect(ConnectionText.codeMalformed.contains("0–9"))
        #expect(!ConnectionText.codeMalformed.contains("A–Z, 0–9"))
        #expect(ConnectionText.pairingFailure(.malformedCode) == ConnectionText.codeMalformed)
        #expect(!PairingCodeFormat.isWellFormed(PairingCodeFormat.normalize("IIIIIIII")))
    }

    @Test("connexion-ios-feuille-intrusive-et-sans/AC-14 : « Utiliser cette adresse » est inactif sur un champ vide ou blanc")
    func saveAddressNeedsText() {
        #expect(ConnectionSheetMode.canSaveAddress("") == false)
        #expect(ConnectionSheetMode.canSaveAddress("   ") == false)
        #expect(ConnectionSheetMode.canSaveAddress(" \n\t") == false)
        #expect(ConnectionSheetMode.canSaveAddress("1"))
        #expect(ConnectionSheetMode.canSaveAddress(" 10.0.0.5 "))
    }
}
