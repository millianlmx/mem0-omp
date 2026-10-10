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
        // Trop court, trop long, hors alphabet Crockford (I, L, O, U), ponctuation.
        for raw in ["", "abc", "ABCD-EFGHJ", "IIIIIIII", "ABCD-EFG!", "ABCD_EFGH"] {
            #expect(!PairingCodeFormat.isWellFormed(PairingCodeFormat.normalize(raw)), "« \(raw) »")
        }
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
