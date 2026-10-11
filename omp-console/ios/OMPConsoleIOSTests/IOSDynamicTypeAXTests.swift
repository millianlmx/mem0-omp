// Les preuves Swift de la feature ios-dynamic-type-ax-residuel.
//
// AC-8 (S-3) : la rangée « titre | puce | bouton » suit son CONTENU — une ligne
// quand tout y tient, le titre au-dessus de ses contrôles sinon, chacun sur sa
// ligne quand les contrôles ne tiennent pas ensemble. La règle pure
// `IOSHomeContent.rowAxis(title:controls:available:spacing:)` est éprouvée sans
// vue ; le conteneur `IOSAdaptiveRow` est mesuré dans un `UIHostingController`,
// à la taille de texte par défaut.
//
// AC-3 (S-2) : sans plafond, une rangée et son bouton grandissent encore entre
// accessibility3 (`accessibility-extra-large`) et accessibility5
// (`accessibility-extra-extra-extra-large`).
//
// AC-4 (S-4) : les boutons de la carte d'attente de l'Accueil partagent une ligne
// tant qu'ils y tiennent ; sinon « Valider les specs » passe sur la sienne, en
// capsule plus large que haute, au lieu d'être écrasé en disque.
//
// AC-7 (S-6) : l'en-tête du graphe Mémoire garde « Étiquette » entier ; les trois
// commandes de zoom passent ensemble sous le menu quand elles n'y tiennent pas.
//
// AC-6 (S-5) : l'en-tête d'un appel d'outil de la visionneuse garde
// « Mémorisation » entier ; son statut passe sous le titre quand il n'y tient pas.
//
// AC-10 (S-5) : la recette `erreur` ouvre la visionneuse sur l'état d'erreur
// stable — la bannière d'erreur, que « Réessayer » ramène à l'identique.
//
// AC-5 (S-7) : la rangée de Sessions empile, aux tailles d'accessibilité, ses
// textes (feature, situation, heure) puis la pastille « Terminé », sans couper
// « session-1 ».

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

    /// Une rangée de l'Accueil « À reprendre » : titre, puce, bouton « Reprendre ».
    private static func resumeRow(title: String) -> some View {
        IOSAdaptiveRow(spacing: 12) {
            Text(verbatim: title).font(.body.weight(.medium))
            IOSStatusChip(status: .finishedRun)
            Button(KanbanText.resume) {}
                .buttonStyle(.bordered)
        }
    }

    @Test("ios-dynamic-type-ax-residuel/AC-8 : un titre court tient sur une ligne")
    func shortTitleStaysOnOneLine() {
        #expect(IOSHomeContent.rowAxis(title: 120, controls: [80, 100], available: 390, spacing: 12) == .horizontal)
        #expect(IOSHomeContent.rowAxis(title: 200, controls: [], available: 390, spacing: 12) == .horizontal)
        #expect(IOSHomeContent.rowAxis(title: 900, controls: [80, 100], available: nil, spacing: 12) == .horizontal, "largeur idéale demandée")
        // Égalité exacte : 166 + 12 + 80 + 12 + 100 = 370.
        #expect(IOSHomeContent.rowAxis(title: 166, controls: [80, 100], available: 370, spacing: 12) == .horizontal)

        // Rendue : la rangée a la hauteur de sa ligne la plus haute, pas deux lignes.
        let line = Self.fitted(Self.resumeRow(title: "x"), width: Self.phoneRowWidth)
        let button = Self.fitted(Button(KanbanText.resume) {}.buttonStyle(.bordered), width: Self.phoneRowWidth)
        #expect(line.height < button.height * 1.5, "\(line) contre un bouton de \(button)")
    }

    @Test("ios-dynamic-type-ax-residuel/AC-8 : un titre long passe au-dessus de sa pastille et de son bouton")
    func longTitleSplitsAboveItsControls() {
        #expect(IOSHomeContent.rowAxis(title: 400, controls: [80, 100], available: 390, spacing: 12) == .twoLine)
        // Égalité exacte des contrôles seuls : 180 + 12 + 178 = 370.
        #expect(IOSHomeContent.rowAxis(title: 400, controls: [180, 178], available: 370, spacing: 12) == .twoLine)
        // Un seul contrôle qui tient seul.
        #expect(IOSHomeContent.rowAxis(title: 400, controls: [80], available: 390, spacing: 12) == .twoLine)

        // Rendue à la taille par défaut : le titre long de la recette `longTitles`
        // ne tient pas à côté de ses contrôles, la rangée passe sur deux lignes au
        // lieu de le couper ou de le tronquer.
        let short = Self.fitted(Self.resumeRow(title: "x"), width: Self.phoneRowWidth)
        let long = Self.fitted(Self.resumeRow(title: IOSHomeText.recipeLongTitle), width: Self.phoneRowWidth)
        let title = Self.fitted(Text(verbatim: IOSHomeText.recipeLongTitle).font(.body.weight(.medium)), width: Self.phoneRowWidth)
        #expect(long.height >= title.height + 8 + short.height - 1, "titre \(title), une ligne \(short), deux lignes \(long)")
        #expect(long.width <= Self.phoneRowWidth)
    }

    @Test("ios-dynamic-type-ax-residuel/AC-8 : des contrôles trop larges ensemble s'empilent")
    func controlsTooWideTogetherStack() {
        #expect(IOSHomeContent.rowAxis(title: 100, controls: [200, 200], available: 390, spacing: 12) == .stacked)
        #expect(IOSHomeContent.rowAxis(title: 100, controls: [400], available: 390, spacing: 12) == .stacked, "un contrôle plus large que la ligne")
        #expect(IOSHomeContent.rowAxis(title: 500, controls: [], available: 390, spacing: 12) == .stacked, "un titre seul trop large se replie")
        #expect(IOSHomeContent.rowAxis(title: 10, controls: [10], available: 0, spacing: 12) == .stacked)
        #expect(IOSHomeContent.rowAxis(title: 10, controls: [10], available: -1, spacing: 12) == .stacked)

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
        let button = Button(KanbanText.resume) {}.buttonStyle(.bordered)
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

    /// La rangée de boutons de la carte d'attente de l'Accueil (HomeView.attentionCard) :
    /// « Lire le contrat », puis le bouton d'attente en style proéminent.
    private static func attentionButtons() -> some View {
        IOSAdaptiveRow(spacing: 8, pinsControlsTrailing: false) {
            Button {} label: {
                Text(ContractText.open)
                    .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                    .contentShape(Rectangle())
            }
            Button(KanbanText.validateSpecs) {}
                .buttonStyle(.borderedProminent)
        }
        .buttonStyle(.borderless)
    }

    /// La largeur utile d'une carte de l'Accueil sur iPhone 18 Pro (rangée moins
    /// le retrait de la carte).
    private static let phoneCardWidth: CGFloat = 338

    @Test("ios-dynamic-type-ax-residuel/AC-4 : « Valider les specs » passe sur sa ligne en capsule aux tailles d'accessibilité")
    func attentionButtonsSplitIntoCapsules() {
        let validate = Button(KanbanText.validateSpecs) {}.buttonStyle(.borderedProminent)

        // Taille par défaut : les deux boutons tiennent sur une ligne.
        let rowLarge = Self.fitted(Self.attentionButtons(), width: Self.phoneCardWidth)
        let validateLarge = Self.fitted(validate, width: Self.phoneCardWidth)
        #expect(rowLarge.height < validateLarge.height * 1.5, "une ligne attendue : \(rowLarge) contre \(validateLarge)")

        for size in [DynamicTypeSize.accessibility3, .accessibility5] {
            let row = Self.fitted(Self.attentionButtons(), width: Self.phoneCardWidth, size: size)
            let alone = Self.fitted(validate, width: Self.phoneCardWidth, size: size)
            let contract = Self.fitted(Text(ContractText.open), width: Self.phoneCardWidth, size: size)
            // Deux lignes : « Lire le contrat », puis « Valider les specs » sous lui.
            #expect(row.height >= contract.height + 8 + alone.height - 1, "\(size) : rangée \(row), contrat \(contract), bouton \(alone)")
            #expect(row.width <= Self.phoneCardWidth, "\(size) : \(row)")
            // Une capsule, pas un disque : plus large que haute, dans la carte.
            #expect(alone.width > alone.height, "\(size) : \(alone)")
            #expect(alone.width <= Self.phoneCardWidth, "\(size) : \(alone)")
        }
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

    // MARK: - La visionneuse (S-5)

    /// L'en-tête d'un appel d'outil (IOSSessionRowView.toolHeader) : le bloc titre
    /// (chevron, symbole, verbe et cible), puis le statut « Interrompu ».
    private static func toolHeader(title: String) -> some View {
        IOSAdaptiveRow(spacing: 8) {
            Self.toolTitle(title)
            Self.toolStatus()
        }
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
    }

    private static func toolTitle(_ title: String) -> some View {
        ToolTitleBlock(title: title)
    }

    private static func toolSymbols() -> some View {
        HStack(spacing: 8) {
            Image(systemName: IOSSessionText.chevron(false))
                .font(.caption2)
            Image(systemName: ToolVerb.symbol("mem0_add"))
        }
    }

    private static func toolStatus() -> some View {
        Label(IOSSessionText.toolStatusLabel(.interrupted), systemImage: ConversationText.toolInterruptedSymbol)
            .labelStyle(.titleAndIcon)
            .font(.caption)
    }

    /// La largeur du bouton d'un appel d'outil dans la visionneuse d'un iPhone 18 Pro
    /// (cadre AX `ios.session.toolcall.*` des captures « avant » : 370 pt).
    private static let phoneToolWidth: CGFloat = 370

    @Test("ios-dynamic-type-ax-residuel/AC-6 : l'en-tête d'un appel garde « Mémorisation » entier et passe son statut dessous")
    func toolHeaderKeepsItsVerbWhole() {
        let verb = ToolVerb.title("mem0_add")
        let title = "\(verb) · la correction est appliquée"

        // Taille par défaut : symboles, titre et statut sur une ligne, comme avant.
        let headerLarge = Self.fitted(Self.toolHeader(title: title), width: Self.phoneToolWidth)
        #expect(headerLarge.height <= IOSMetrics.minimumTarget + 1, "une ligne attendue : \(headerLarge)")

        // Taille par défaut, long chemin : le titre se replie À CÔTÉ de ses symboles,
        // comme avant, et le statut passe dessous.
        let path = "Lecture · omp-console/ios/OMPConsoleIOS/IOSSessionRowView.swift et sa suite de tests"
        let longBlock = Self.fitted(Self.toolTitle(path), width: Self.phoneToolWidth)
        let longText = Self.fitted(Text(verbatim: path).font(.callout), width: Self.phoneToolWidth)
        let symbolsLarge = Self.fitted(Self.toolSymbols(), width: .greatestFiniteMagnitude)
        #expect(longBlock.height < symbolsLarge.height + 8 + longText.height, "symboles à côté du titre : \(longBlock)")
        let longHeader = Self.fitted(Self.toolHeader(title: path), width: Self.phoneToolWidth)
        #expect(longHeader.height >= longBlock.height + 8, "statut sous le titre : \(longHeader) contre \(longBlock)")

        for size in [DynamicTypeSize.accessibility3, .accessibility5] {
            let header = Self.fitted(Self.toolHeader(title: title), width: Self.phoneToolWidth, size: size)
            let block = Self.fitted(Self.toolTitle(title), width: Self.phoneToolWidth, size: size)
            let status = Self.fitted(Self.toolStatus(), width: Self.phoneToolWidth, size: size)
            let word = Self.fitted(Text(verbatim: verb).font(.callout), width: .greatestFiniteMagnitude, size: size)
            let symbols = Self.fitted(Self.toolSymbols(), width: .greatestFiniteMagnitude, size: size)
            // Le verbe tient sur une ligne pleine : un repli ne le coupe jamais.
            #expect(word.width <= Self.phoneToolWidth, "\(size) : « \(verb) » \(word)")
            // Le statut passe sous le titre : aucune ligne ne les partage, donc aucun
            // chevauchement, et le titre garde toute la largeur.
            #expect(header.height >= block.height + 8 + status.height - 1, "\(size) : en-tête \(header), titre \(block), statut \(status)")
            #expect(header.width <= Self.phoneToolWidth, "\(size) : \(header)")
            // Le titre entier ne tient pas à côté des symboles : il passe dessous, sur
            // toute la largeur, au lieu de couper « Mémorisation » contre eux.
            #expect(block.height >= symbols.height + 8 + word.height - 1, "\(size) : titre \(block), symboles \(symbols), verbe \(word)")
        }
    }

    /// La largeur du contenu d'une rangée de `List(.insetGrouped)` sur un iPhone
    /// 18 Pro : 402 pt moins 16 pt de marge et 16 pt de retrait de cellule de
    /// chaque côté.
    private static let phoneListRowWidth: CGFloat = 338

    /// Les textes d'une rangée de Sessions (IOSSessionsScreen.row) : la feature,
    /// sa situation, l'heure, l'un sous l'autre.
    private static func sessionTexts() -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: "parity-session-1").font(.headline).multilineTextAlignment(.leading)
            Text(verbatim: "Publication · omp-parity").font(.caption).foregroundStyle(.secondary)
            Text(verbatim: "14:05").font(.caption).foregroundStyle(.secondary)
        }
    }

    /// Une rangée de Sessions, réplique de IOSSessionsScreen.row : icône et textes,
    /// puis la pastille « Terminé ».
    private static func sessionRow() -> some View {
        IOSAdaptiveRow(spacing: 10) {
            IOSAdaptiveRow(spacing: 10, pinsControlsTrailing: false) {
                Image(systemName: "checkmark.circle").frame(width: 24)
                sessionTexts()
            }
            IOSStatusChip(status: .finishedRun)
        }
    }

    @Test("ios-dynamic-type-ax-residuel/AC-5 : la rangée de Sessions empile titre, heure et pastille « Terminé » sans couper « session-1 »")
    func sessionRowStacksItsTitleTimeAndChip() {
        // Taille par défaut : la pastille reste à côté des textes.
        let rowLarge = Self.fitted(Self.sessionRow(), width: Self.phoneListRowWidth)
        let textsLarge = Self.fitted(Self.sessionTexts(), width: Self.phoneListRowWidth)
        let chipLarge = Self.fitted(IOSStatusChip(status: .finishedRun), width: Self.phoneListRowWidth)
        #expect(rowLarge.height < textsLarge.height + 8 + chipLarge.height, "pastille à côté des textes : \(rowLarge)")

        for size in [DynamicTypeSize.accessibility3, .accessibility5] {
            let row = Self.fitted(Self.sessionRow(), width: Self.phoneListRowWidth, size: size)
            let texts = Self.fitted(Self.sessionTexts(), width: Self.phoneListRowWidth, size: size)
            let chip = Self.fitted(IOSStatusChip(status: .finishedRun), width: Self.phoneListRowWidth, size: size)
            let word = Self.fitted(Text(verbatim: "session-1").font(.headline), width: .greatestFiniteMagnitude, size: size)
            let chipWord = Self.fitted(Text(verbatim: ConsoleStatus.finishedRun.text).font(.caption), width: .greatestFiniteMagnitude, size: size)
            // Les mots tiennent sur une ligne pleine : un repli ne les coupe pas.
            #expect(word.width <= Self.phoneListRowWidth, "\(size) : « session-1 » \(word)")
            #expect(chipWord.width <= Self.phoneListRowWidth, "\(size) : « Terminé » \(chipWord)")
            // La pastille passe sous les textes (eux-mêmes sous l'icône) : aucune
            // ligne partagée, donc aucun chevauchement.
            #expect(row.height >= texts.height + 8 + chip.height - 1, "\(size) : rangée \(row), textes \(texts), pastille \(chip)")
            #expect(row.width <= Self.phoneListRowWidth, "\(size) : \(row)")
        }
    }

    @Test("ios-dynamic-type-ax-residuel/AC-10 : la recette erreur montre la bannière d'erreur de la visionneuse")
    func errorRecipeShowsTheErrorBanner() async throws {
        #expect(IOSSessionsRecipe.resolve([IOSSessionText.recipeFlag, IOSSessionText.recipeErreur]) == .erreur)
        #expect(IOSSessionsRecipe.erreur.list.choices.count == 1, "la feuille s'ouvre sur la session de la fixture")
        let thread = try #require(IOSSessionsRecipe.erreur.thread)
        let run = try #require(thread.run)
        #expect(run.state == .live(.running), "la recette ouvre le fil d'un run vivant")
        #expect(thread.readNeverEnds == false)

        let expected = try #require(IOSMacErrorText.message(for: ClientError.unexpectedStatus(500)))
        let model = IOSSessionThreadModel(
            source: IOSSessionsRecipeSource(thread: thread),
            file: thread.file,
            title: thread.title,
            subtitle: thread.subtitle,
            tracksRun: true
        )
        await model.read()
        #expect(model.errorBanner == expected)
        #expect(model.isLoading == false)
        // Aucun fait lu, run vivant : la pastille du fil dit l'attente (« Démarrage »).
        #expect(model.threadStatus == ConsoleStatus(text: ConversationText.starting, tone: .info))

        // « Réessayer » relit et retombe dans la même erreur : l'état est stable.
        model.retry()
        #expect(model.errorBanner == nil)
        #expect(model.isLoading)
        for _ in 0..<200 where model.isLoading { await Task.yield() }
        #expect(model.isLoading == false)
        #expect(model.errorBanner == expected)
    }
}

/// Le bloc titre d'un en-tête d'appel (IOSSessionRowView.toolTitleLayout) : à côté
/// des symboles aux tailles ordinaires, dessous aux tailles d'accessibilité quand
/// il n'y tient pas.
private struct ToolTitleBlock: View {
    let title: String
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        let layout = dynamicTypeSize.isAccessibilitySize
            ? AnyLayout(IOSAdaptiveRow(spacing: 8, pinsControlsTrailing: false))
            : AnyLayout(HStackLayout(spacing: 8))
        layout {
            HStack(spacing: 8) {
                Image(systemName: IOSSessionText.chevron(false))
                    .font(.caption2)
                Image(systemName: ToolVerb.symbol("mem0_add"))
            }
            Text(verbatim: title)
                .font(.callout)
                .multilineTextAlignment(.leading)
        }
    }
}
