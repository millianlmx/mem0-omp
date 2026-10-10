// Les preuves Swift de la feature `ios-finitions-titres-icones` : les décisions
// PURES des finitions de la coque iOS (icônes de section, …). Chaque test PORTE
// l'id d'acceptation qu'il prouve.

@testable import OMPConsoleIOS
import ConsoleCore
import Testing
import UIKit

@MainActor
@Suite("ios-finitions-titres-icones")
struct IOSFinitionsTests {
    @Test("ios-finitions-titres-icones/AC-4 : l'icône iOS de Sessions diffère de celle de Session OMP")
    func sessionsIconDiffersFromSessionOmp() {
        let session = IOSSection.systemImage(of: .session)
        let sessions = IOSSection.systemImage(of: .sessions)
        #expect(session != sessions)
        #expect(!sessions.contains("bubble"))
        #expect(UIImage(systemName: session) != nil)
        #expect(UIImage(systemName: sessions) != nil)
    }

    @Test("ios-finitions-titres-icones/AC-4 : le macOS garde les icônes de ConsoleSection")
    func macOSSectionIconsAreUnchanged() {
        #expect(ConsoleSection.session.systemImage == "bubble.left.and.bubble.right")
        #expect(ConsoleSection.sessions.systemImage == "bubble.left.and.text.bubble.right")
    }

    @Test("ios-finitions-titres-icones/AC-5 : « Sommaire » et « Liste » portent deux icônes différentes")
    func summaryAndListIconsDiffer() {
        #expect(IOSMemoryText.summarySymbol != IOSMemoryText.listSymbol)
        #expect(UIImage(systemName: IOSMemoryText.summarySymbol) != nil)
        #expect(UIImage(systemName: IOSMemoryText.listSymbol) != nil)
    }

    @Test("ios-finitions-titres-icones/AC-6 : chaque cas d'indisponibilité de « Sommaire » a sa phrase")
    func summaryReasonNamesEachUnavailableCase() {
        for graphShown in [true, false] {
            for isSearching in [true, false] {
                for isLoading in [true, false] {
                    let reason = IOSMemoryModel.summaryUnavailableReason(
                        graphShown: graphShown, isSearching: isSearching, isLoading: isLoading
                    )
                    let expected: String? =
                        graphShown ? IOSMemoryText.summaryReasonGraph
                        : !isSearching ? IOSMemoryText.summaryReasonShown
                        : isLoading ? IOSMemoryText.summaryReasonSearching
                        : nil
                    #expect(reason == expected)
                    if !graphShown { #expect((reason == nil) == (isSearching && !isLoading)) }
                }
            }
        }
        #expect(IOSMemoryText.summaryReasonShown == "Le sommaire est déjà affiché.")
        #expect(IOSMemoryText.summaryReasonSearching
            == "Une recherche est en cours : le sommaire reviendra quand elle sera finie.")
        #expect(IOSMemoryText.summaryReasonGraph
            == "Le sommaire s'affiche en mode Liste : touchez d'abord « Liste ».")
    }

    // MARK: - Nom de feature (S-7)

    @Test("ios-finitions-titres-icones/AC-8 : featureName place chaque coupure avant le tiret et ne perd rien")
    func featureNameMovesEveryBreakBeforeTheHyphen() {
        let names = [
            "ios-finitions-titres-icones", "ios-pipelines-lanes-interminables",
            "sansTiret", "", "-tete", "a--b", "a\u{2013}b", "a\u{2010}b",
        ]
        for name in names {
            let shown = IOSHomeText.featureName(name)
            let restored = shown.replacingOccurrences(of: "\u{200B}", with: "")
                .replacingOccurrences(of: "\u{2011}", with: "-")
            #expect(restored == name)
            #expect(!shown.contains("-"))
        }
        #expect(IOSHomeText.featureName("sansTiret") == "sansTiret")
        #expect(IOSHomeText.featureName("") == "")
        #expect(IOSHomeText.featureName("-tete") == "\u{200B}\u{2011}tete")
        #expect(IOSHomeText.featureName("a--b") == "a\u{200B}\u{2011}\u{200B}\u{2011}b")
        #expect(IOSHomeText.featureName("a\u{2013}b") == "a\u{2013}b")
        #expect(IOSHomeText.featureName("a\u{2010}b") == "a\u{2010}b")
    }

    /// Les lignes qu'une mise en page CoreText (le moteur sous `Text`) produit pour
    /// `text` à `width` pt dans la police `.headline` de la catégorie donnée.
    private func lines(
        of text: String, width: CGFloat, category: UIContentSizeCategory
    ) -> [String] {
        let font = UIFont.preferredFont(
            forTextStyle: .headline,
            compatibleWith: UITraitCollection(preferredContentSizeCategory: category)
        )
        let attributed = NSAttributedString(string: text, attributes: [.font: font])
        let framesetter = CTFramesetterCreateWithAttributedString(attributed)
        let path = CGPath(rect: CGRect(x: 0, y: 0, width: width, height: 100_000), transform: nil)
        let frame = CTFramesetterCreateFrame(framesetter, CFRange(location: 0, length: 0), path, nil)
        let ns = text as NSString
        let ctLines = CTFrameGetLines(frame) as! [CTLine]
        return ctLines.map { line in
            let range = CTLineGetStringRange(line)
            return ns.substring(with: NSRange(location: range.location, length: range.length))
        }
    }

    @Test("ios-finitions-titres-icones/AC-8 : un nom de feature ne finit jamais une ligne par un tiret")
    func featureNameNeverEndsALineWithAHyphen() {
        let categories: [UIContentSizeCategory] = [
            .large, .accessibilityExtraLarge, .accessibilityExtraExtraExtraLarge,
        ]
        let names = ["ios-finitions-titres-icones", "ios-pipelines-lanes-interminables"]
        var rawEndsWithHyphen = false
        for name in names {
            let shown = IOSHomeText.featureName(name)
            for category in categories {
                for width in stride(from: CGFloat(100), through: 360, by: 20) {
                    let ls = lines(of: shown, width: width, category: category)
                    #expect(ls.joined() == shown)
                    for line in ls {
                        let visible = line.replacingOccurrences(of: "\u{200B}", with: "")
                        #expect(!visible.hasSuffix("-"), "\(name) \(category.rawValue) \(width) : « \(line) »")
                        #expect(!visible.hasSuffix("\u{2011}"), "\(name) \(category.rawValue) \(width) : « \(line) »")
                    }
                    let raw = lines(of: name, width: width, category: category)
                    if raw.contains(where: { $0.hasSuffix("-") }) { rawEndsWithHyphen = true }
                }
            }
        }
        // Témoin : sans la transformation, la coupure tombe bien après un tiret.
        #expect(rawEndsWithHyphen)
    }
}
