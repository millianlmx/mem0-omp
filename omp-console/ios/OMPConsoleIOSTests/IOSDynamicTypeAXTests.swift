// Les preuves Swift de la feature ios-dynamic-type-ax-residuel.
//
// AC-8 (S-3) : la rangée « titre | puce | bouton » suit son CONTENU — une ligne
// quand tout y tient, le titre au-dessus de ses contrôles sinon, chacun sur sa
// ligne quand les contrôles ne tiennent pas ensemble. La règle pure
// `IOSRowAxis.of(title:controls:available:spacing:)` est éprouvée sans
// vue ; le conteneur `IOSAdaptiveRow` est mesuré dans un `UIHostingController`,
// à la taille de texte par défaut.
//
// AC-3 (S-2) : sans plafond, une rangée et son bouton grandissent encore entre
// accessibility3 (`accessibility-extra-large`) et accessibility5
// (`accessibility-extra-extra-extra-large`).
//
// AC-7 (S-6) : l'en-tête du graphe Mémoire garde « Étiquette » entier ; les trois
// commandes de zoom passent ensemble sous le menu quand elles n'y tiennent pas.

import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing
import UIKit

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-dynamic-type-ax-residuel — rangées adaptatives et tailles sans plafond")
struct IOSDynamicTypeAXTests {
    /// La largeur utile d'une rangée sur un iPhone 18 Pro (402 pt moins les marges).
    private static let phoneRowWidth: CGFloat = 370

    /// La taille d'une vue, proposée à la largeur `width` et à une hauteur libre.
    private static func fitted<Content: View>(_ view: Content, width: CGFloat, size: DynamicTypeSize = .large) -> CGSize {
        let host = UIHostingController(rootView: view.environment(\.dynamicTypeSize, size))
        return host.sizeThatFits(in: CGSize(width: width, height: .greatestFiniteMagnitude))
    }

    /// Les mots d'une rangée d'épreuve : une pastille et un bouton.
    private static let finished = ConsoleStatus(text: "Terminé", tone: .success)
    private static let resume = "Reprendre"
    /// Un titre trop long pour tenir à côté de ses contrôles.
    private static let longTitle = "Rangées de l’Accueil écrasées sur iPhone"

    /// Une rangée « titre | puce | bouton ».
    private static func resumeRow(title: String) -> some View {
        IOSAdaptiveRow(spacing: 12) {
            Text(verbatim: title).font(.body.weight(.medium))
            IOSStatusChip(status: Self.finished)
            Button(Self.resume) {}
                .buttonStyle(.bordered)
        }
    }

    @Test("ios-dynamic-type-ax-residuel/AC-8 : un titre court tient sur une ligne")
    func shortTitleStaysOnOneLine() {
        #expect(IOSRowAxis.of(title: 120, controls: [80, 100], available: 390, spacing: 12) == .horizontal)
        #expect(IOSRowAxis.of(title: 200, controls: [], available: 390, spacing: 12) == .horizontal)
        #expect(IOSRowAxis.of(title: 900, controls: [80, 100], available: nil, spacing: 12) == .horizontal, "largeur idéale demandée")
        // Égalité exacte : 166 + 12 + 80 + 12 + 100 = 370.
        #expect(IOSRowAxis.of(title: 166, controls: [80, 100], available: 370, spacing: 12) == .horizontal)

        // Rendue : la rangée a la hauteur de sa ligne la plus haute, pas deux lignes.
        let line = Self.fitted(Self.resumeRow(title: "x"), width: Self.phoneRowWidth)
        let button = Self.fitted(Button(Self.resume) {}.buttonStyle(.bordered), width: Self.phoneRowWidth)
        #expect(line.height < button.height * 1.5, "\(line) contre un bouton de \(button)")
    }

    @Test("ios-dynamic-type-ax-residuel/AC-8 : un titre long passe au-dessus de sa pastille et de son bouton")
    func longTitleSplitsAboveItsControls() {
        #expect(IOSRowAxis.of(title: 400, controls: [80, 100], available: 390, spacing: 12) == .twoLine)
        // Égalité exacte des contrôles seuls : 180 + 12 + 178 = 370.
        #expect(IOSRowAxis.of(title: 400, controls: [180, 178], available: 370, spacing: 12) == .twoLine)
        // Un seul contrôle qui tient seul.
        #expect(IOSRowAxis.of(title: 400, controls: [80], available: 390, spacing: 12) == .twoLine)

        // Rendue à la taille par défaut : le titre long de la recette `longTitles`
        // ne tient pas à côté de ses contrôles, la rangée passe sur deux lignes au
        // lieu de le couper ou de le tronquer.
        let short = Self.fitted(Self.resumeRow(title: "x"), width: Self.phoneRowWidth)
        let long = Self.fitted(Self.resumeRow(title: Self.longTitle), width: Self.phoneRowWidth)
        let title = Self.fitted(Text(verbatim: Self.longTitle).font(.body.weight(.medium)), width: Self.phoneRowWidth)
        #expect(long.height >= title.height + 8 + short.height - 1, "titre \(title), une ligne \(short), deux lignes \(long)")
        #expect(long.width <= Self.phoneRowWidth)
    }

    @Test("ios-dynamic-type-ax-residuel/AC-8 : des contrôles trop larges ensemble s'empilent")
    func controlsTooWideTogetherStack() {
        #expect(IOSRowAxis.of(title: 100, controls: [200, 200], available: 390, spacing: 12) == .stacked)
        #expect(IOSRowAxis.of(title: 100, controls: [400], available: 390, spacing: 12) == .stacked, "un contrôle plus large que la ligne")
        #expect(IOSRowAxis.of(title: 500, controls: [], available: 390, spacing: 12) == .stacked, "un titre seul trop large se replie")
        #expect(IOSRowAxis.of(title: 10, controls: [10], available: 0, spacing: 12) == .stacked)
        #expect(IOSRowAxis.of(title: 10, controls: [10], available: -1, spacing: 12) == .stacked)

        // Rendue : trois lignes, chacune repliée sur la largeur.
        let wide = String(repeating: "W", count: 30)
        let stacked = Self.fitted(
            IOSAdaptiveRow(spacing: 12) {
                Text(verbatim: "x")
                Text(verbatim: wide)
                Text(verbatim: wide)
            },
            width: 200
        )
        let one = Self.fitted(Text(verbatim: wide), width: 200)
        #expect(stacked.width <= 200)
        #expect(stacked.height >= 2 * one.height + 2 * 8, "\(stacked) contre une ligne pleine de \(one)")
    }

    @Test("ios-dynamic-type-ax-residuel/AC-3 : sans plafond, la rangée et son bouton grandissent d'accessibility3 à accessibility5")
    func rowAndButtonKeepGrowingAtTheLargestSize() {
        let button = Button(Self.resume) {}.buttonStyle(.bordered)
        let buttonXL = Self.fitted(button, width: Self.phoneRowWidth, size: .accessibility3)
        let buttonXXXL = Self.fitted(button, width: Self.phoneRowWidth, size: .accessibility5)
        #expect(buttonXXXL.height > buttonXL.height, "\(buttonXL) → \(buttonXXXL)")

        let title = Text(verbatim: "session-1").font(.body.weight(.medium))
        let titleXL = Self.fitted(title, width: Self.phoneRowWidth, size: .accessibility3)
        let titleXXXL = Self.fitted(title, width: Self.phoneRowWidth, size: .accessibility5)
        #expect(titleXXXL.height > titleXL.height, "\(titleXL) → \(titleXXXL)")

        let rowXL = Self.fitted(Self.resumeRow(title: "session-1"), width: Self.phoneRowWidth, size: .accessibility3)
        let rowXXXL = Self.fitted(Self.resumeRow(title: "session-1"), width: Self.phoneRowWidth, size: .accessibility5)
        #expect(rowXXXL.height > rowXL.height, "\(rowXL) → \(rowXXXL)")
        #expect(rowXXXL.width <= Self.phoneRowWidth)
    }

    /// L'en-tête du graphe Mémoire (IOSMemoryGraphView.commands) : le menu
    /// d'étiquettes, puis les trois commandes icônes, qui restent ensemble.
    private static func graphHeader() -> some View {
        IOSAdaptiveRow(spacing: 8) {
            Self.graphTagLabel()
            Self.graphZoomCommands()
        }
    }

    private static func graphTagLabel() -> some View {
        Label(MemoryText.tagMenu, systemImage: "tag")
            .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
    }

    private static func graphZoomCommands() -> some View {
        HStack(spacing: 8) {
            ForEach([MemoryText.zoomOut, MemoryText.zoomIn, MemoryText.recenter], id: \.self) { title in
                Button {} label: {
                    Label(title, systemImage: "plus.magnifyingglass")
                        .labelStyle(.iconOnly)
                        .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                }
            }
        }
    }

    @Test("ios-dynamic-type-ax-residuel/AC-7 : l'en-tête du graphe Mémoire garde « Étiquette » entier aux tailles d'accessibilité")
    func graphHeaderKeepsTheTagMenuWhole() {
        // Taille par défaut : menu et commandes sur une ligne.
        let headerLarge = Self.fitted(Self.graphHeader(), width: Self.phoneRowWidth)
        let commandsLarge = Self.fitted(Self.graphZoomCommands(), width: Self.phoneRowWidth)
        #expect(headerLarge.height < commandsLarge.height * 1.5, "une ligne attendue : \(headerLarge) contre \(commandsLarge)")

        for size in [DynamicTypeSize.accessibility3, .accessibility5] {
            let header = Self.fitted(Self.graphHeader(), width: Self.phoneRowWidth, size: size)
            let ideal = Self.fitted(Self.graphTagLabel(), width: .greatestFiniteMagnitude, size: size)
            let tag = Self.fitted(Self.graphTagLabel(), width: Self.phoneRowWidth, size: size)
            let commands = Self.fitted(Self.graphZoomCommands(), width: Self.phoneRowWidth, size: size)
            // « Étiquette » tient sur une ligne pleine : il n'est ni replié ni coupé.
            #expect(ideal.width <= Self.phoneRowWidth, "\(size) : « Étiquette » \(ideal)")
            #expect(tag.height == ideal.height, "\(size) : « Étiquette » replié \(tag) contre \(ideal)")
            // Le menu sur sa ligne, puis les trois commandes ensemble sous lui.
            #expect(header.height >= ideal.height + 8 + commands.height - 1, "\(size) : en-tête \(header), menu \(ideal), commandes \(commands)")
            #expect(header.height <= ideal.height + 8 + commands.height + 1, "\(size) : les commandes restent sur une ligne, \(header)")
            #expect(header.width <= Self.phoneRowWidth, "\(size) : \(header)")
            // Les commandes gardent leur cible de 44 pt.
            #expect(commands.height >= IOSMetrics.minimumTarget, "\(size) : \(commands)")
        }
    }
}
