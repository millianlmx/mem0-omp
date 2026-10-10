// La saisie du code d'appairage dans la feuille de connexion (S-8, BR-3) : le Mac
// affiche le code groupé « XXXX-XXXX », et le champ doit l'accepter tel quel,
// sans tiret ou en minuscules. Le défaut corrigé : la saisie était tronquée à huit
// caractères BRUTS (« ABCD-EFGH » devenait « ABCD-EFG ») et « Appairer » exigeait
// huit caractères bruts.
//
// La frappe est rejouée caractère par caractère à travers la même borne que
// `onChange` du champ (`PairingCodeFormat.limitInput`), puis le bouton est jugé par
// `ConnectionSheet.canPair(code:knownEndpoint:)`, le prédicat du vrai bouton.

import ConsoleCore
import Testing

@testable import OMPConsoleIOS

@Suite("Saisie du code d'appairage")
struct ConnectionCodeTests {
    /// Ce que le champ contient après la frappe de `keys`, touche par touche.
    private static func typed(_ keys: String) -> String {
        var field = ""
        for key in keys {
            field = PairingCodeFormat.limitInput(field + String(key))
        }
        return field
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : avec ou sans tiret, toute casse, le code tapé arme « Appairer »")
    func threeFormsArmPairing() {
        for form in ["ABCD-EFGH", "ABCDEFGH", "abcd-efgh"] {
            let field = Self.typed(form)
            #expect(field == form, "la frappe de \(form) est conservée entière")
            #expect(ConnectionSheet.canPair(code: field, knownEndpoint: true), "\(form) arme « Appairer »")
            #expect(PairingCodeFormat.normalize(field) == "ABCDEFGH", "\(form) part normalisé")
        }
        // Collé d'un bloc avec des espaces, comme un code dicté.
        #expect(ConnectionSheet.canPair(code: Self.typed(" abcd efgh "), knownEndpoint: true))
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : la frappe au-delà du 8e caractère significatif est ignorée")
    func typingBeyondEightIsIgnored() {
        #expect(Self.typed("ABCD-EFGHJK") == "ABCD-EFGH")
        #expect(Self.typed("ABCDEFGHJK") == "ABCDEFGH")
        #expect(Self.typed("abcd-efgh-") == "abcd-efgh")
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : incomplet ou sans Mac connu, « Appairer » reste désactivé")
    func incompleteOrNoEndpointKeepsPairingDisabled() {
        #expect(!ConnectionSheet.canPair(code: "", knownEndpoint: true))
        #expect(!ConnectionSheet.canPair(code: Self.typed("ABCD-EFG"), knownEndpoint: true))
        #expect(!ConnectionSheet.canPair(code: Self.typed("ABCD----"), knownEndpoint: true))
        #expect(!ConnectionSheet.canPair(code: Self.typed("ABCD-EFGH"), knownEndpoint: false))
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : un symbole hors alphabet laisse « Appairer » actif, le modèle refuse ensuite")
    func outOfAlphabetStaysArmed() {
        // « I » n'est pas dans l'alphabet Crockford : le bouton s'arme, et c'est
        // `ConsoleClientModel.pair` qui rend `.malformedCode` (message existant).
        let field = Self.typed("ABCD-EFGI")
        #expect(ConnectionSheet.canPair(code: field, knownEndpoint: true))
        #expect(!PairingCodeFormat.isWellFormed(PairingCodeFormat.normalize(field)))
    }
}
