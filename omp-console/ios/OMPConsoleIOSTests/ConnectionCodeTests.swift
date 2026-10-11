// La saisie du code d'appairage dans la feuille de connexion (S-8, BR-3) : le Mac
// affiche le code groupé « XXXX-XXXX », et le champ doit l'accepter tel quel,
// sans tiret ou en minuscules. Le défaut corrigé : la saisie était tronquée à huit
// caractères BRUTS (« ABCD-EFGH » devenait « ABCD-EFG ») et « Appairer » exigeait
// huit caractères bruts.
//
// La frappe est rejouée caractère par caractère à travers la même borne que
// `onChange` du champ (`PairingCodeFormat.limitInput`), puis le bouton est jugé par
// `ConnectionSheet.canPair(code:knownEndpoint:inFlight:)`, le prédicat du vrai bouton.

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
            #expect(ConnectionSheet.canPair(code: field, knownEndpoint: true, inFlight: false), "\(form) arme « Appairer »")
            #expect(PairingCodeFormat.normalize(field) == "ABCDEFGH", "\(form) part normalisé")
        }
        // Collé d'un bloc avec des espaces, comme un code dicté.
        #expect(ConnectionSheet.canPair(code: Self.typed(" abcd efgh "), knownEndpoint: true, inFlight: false))
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : la frappe au-delà du 8e caractère significatif est ignorée")
    func typingBeyondEightIsIgnored() {
        #expect(Self.typed("ABCD-EFGHJK") == "ABCD-EFGH")
        #expect(Self.typed("ABCDEFGHJK") == "ABCDEFGH")
        #expect(Self.typed("abcd-efgh-") == "abcd-efgh")
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : incomplet ou sans Mac connu, « Appairer » reste désactivé")
    func incompleteOrNoEndpointKeepsPairingDisabled() {
        #expect(!ConnectionSheet.canPair(code: "", knownEndpoint: true, inFlight: false))
        #expect(!ConnectionSheet.canPair(code: Self.typed("ABCD-EFG"), knownEndpoint: true, inFlight: false))
        #expect(!ConnectionSheet.canPair(code: Self.typed("ABCD----"), knownEndpoint: true, inFlight: false))
        #expect(!ConnectionSheet.canPair(code: Self.typed("ABCD-EFGH"), knownEndpoint: false, inFlight: false))
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : un symbole hors alphabet laisse « Appairer » actif, le modèle refuse ensuite")
    func outOfAlphabetStaysArmed() {
        // « U » n'est pas dans l'alphabet Crockford ni lu comme un chiffre : le
        // bouton s'arme, et c'est `ConsoleClientModel.pair` qui rend
        // `.malformedCode` (message existant).
        let field = Self.typed("ABCD-EFGU")
        #expect(ConnectionSheet.canPair(code: field, knownEndpoint: true, inFlight: false))
        #expect(!PairingCodeFormat.isWellFormed(PairingCodeFormat.normalize(field)))
    }

    @Test("ios-onboarding-et-connexion/AC-7 : une saisie avec O, I ou L arme « Appairer » et part avec 0 et 1")
    func lookalikeLettersArmPairing() {
        // Les trois formes du même code donnent le même envoi.
        let sent = ["abcd-efgh", "ABCD EFGH", "ABCDEFGH"].map { PairingCodeFormat.normalize(Self.typed($0)) }
        #expect(sent == ["ABCDEFGH", "ABCDEFGH", "ABCDEFGH"])
        // Le code « 0K1M-1Z0P » du Mac, tapé avec ses sosies en toute casse.
        for form in ["oK1M-lZ0P", "OKIM IZOP", "0kim-izop", "okLm lzop"] {
            let field = Self.typed(form)
            #expect(ConnectionSheet.canPair(code: field, knownEndpoint: true, inFlight: false), "\(form) arme « Appairer »")
            let normalized = PairingCodeFormat.normalize(field)
            #expect(normalized == "0K1M1Z0P", "\(form) part avec O → 0, I/L → 1")
            #expect(PairingCodeFormat.isWellFormed(normalized), "\(form) est bien formé")
        }
    }

    @Test("ios-onboarding-et-connexion/AC-8 : pendant la requête d'appairage, « Appairer » ne peut pas être relancé")
    func pairingInFlightDisarmsPair() {
        let field = Self.typed("ABCD-EFGH")
        #expect(ConnectionSheet.canPair(code: field, knownEndpoint: true, inFlight: false), "code armé, aucune requête : actif")
        #expect(!ConnectionSheet.canPair(code: field, knownEndpoint: true, inFlight: true), "requête en cours : désactivé")
    }
}
