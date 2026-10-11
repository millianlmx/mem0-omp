// Le format partagé du code d'appairage (S-8) : le Mac l'affiche « XXXX-XXXX »,
// l'appareil le saisit comme il veut.

import ConsoleCore
import Testing

@Suite("PairingCodeFormat")
struct PairingCodeFormatTests {
    @Test("mac-feuille-appairage-debordante/AC-11 : avec ou sans tiret, toute casse, le code se normalise pareil")
    func normalizeIgnoresSeparatorsAndCase() {
        for raw in ["ABCD-EFGH", "ABCDEFGH", "abcd-efgh", "abcd efgh", " AbCd\u{2011}eFgH\n", "ABCD\u{2013}EFGH"] {
            let normalized = PairingCodeFormat.normalize(raw)
            #expect(normalized == "ABCDEFGH", "« \(raw) »")
            #expect(PairingCodeFormat.isWellFormed(normalized), "« \(raw) »")
        }
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : un code mal formé le reste après normalisation")
    func malformedCodesStayMalformed() {
        // Trop court, trop long, hors alphabet Crockford (U, seul symbole ni dans
        // l'alphabet ni lu comme chiffre), ponctuation.
        for raw in ["", "abc", "ABCD-EFGHJ", "UUUUUUUU", "ABCD-EFG!", "ABCD_EFGH"] {
            #expect(!PairingCodeFormat.isWellFormed(PairingCodeFormat.normalize(raw)), "« \(raw) »")
        }
    }

    @Test("ios-onboarding-et-connexion/AC-7 : I et L sont lus 1, O est lu 0, en toute casse, U reste refusé")
    func lookalikeLettersReadAsDigits() {
        #expect(PairingCodeFormat.lookalikes == ["I": "1", "L": "1", "O": "0"])
        // Les trois saisies du code « ABCD-EFGH » donnent le même code.
        let forms = ["abcd-efgh", "ABCD EFGH", "ABCDEFGH"].map(PairingCodeFormat.normalize)
        #expect(forms == ["ABCDEFGH", "ABCDEFGH", "ABCDEFGH"])
        // Sosies majuscules et minuscules, mêlés aux chiffres et séparateurs.
        #expect(PairingCodeFormat.normalize("oIl0-1LOi") == "01101101")
        #expect(PairingCodeFormat.normalize("ABCD-EFGO") == "ABCDEFG0")
        #expect(PairingCodeFormat.normalize("ABCD efgl") == "ABCDEFG1")
        #expect(PairingCodeFormat.normalize("abcd-efgi") == "ABCDEFG1")
        for raw in ["oIl0-1LOi", "ABCD-EFGO", "ABCD efgl", "abcd-efgi", "IIIIIIII", "llll-oooo"] {
            #expect(PairingCodeFormat.isWellFormed(PairingCodeFormat.normalize(raw)), "« \(raw) »")
        }
        // U n'est ni dans l'alphabet ni un sosie : le code reste mal formé.
        #expect(PairingCodeFormat.normalize("abcd-efgu") == "ABCDEFGU")
        #expect(!PairingCodeFormat.isWellFormed(PairingCodeFormat.normalize("UUUUUUUU")))
        // Un sosie compte pour UN caractère significatif dans la saisie bornée.
        #expect(PairingCodeFormat.limitInput("oooo-iiiiX") == "oooo-iiii")
    }

    @Test("mac-feuille-appairage-debordante/AC-11 : la saisie s'arrête au 8e caractère significatif")
    func limitInputStopsAtEighthSignificantCharacter() {
        #expect(PairingCodeFormat.limitInput("ABCD-EFGH") == "ABCD-EFGH")
        #expect(PairingCodeFormat.limitInput("ABCD-EFGHX") == "ABCD-EFGH")
        #expect(PairingCodeFormat.limitInput("ABCD-EFGH-") == "ABCD-EFGH")
        #expect(PairingCodeFormat.limitInput("ABCDEFGHIJ") == "ABCDEFGH")
        #expect(PairingCodeFormat.limitInput("abcd efgh ij") == "abcd efgh")
        #expect(PairingCodeFormat.limitInput("ab") == "ab")
        #expect(PairingCodeFormat.limitInput("") == "")
    }
}
