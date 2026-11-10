// La PALETTE de commandes (⌘K), sa recherche globale (⌘F : features et mémoire) et la
// feuille « Nouveau fil… » (⌘N), écrites une fois pour le Mac et l'iPhone/iPad. Dans la
// nouvelle interface du Mac, la palette propose les écrans de la coque (`screens` :
// « Maintenant », « À vous », les outils…) à la place des sections classiques.
//
// La liste et son tri viennent de `HarnessPalette` (client partagé). Choisir une entrée
// referme la palette ; la commande s'exécute à sa fermeture (`palettePending`) : une
// feuille ne s'ouvre pas pendant qu'une autre se referme. ↑ et ↓ surlignent, ↩
// exécute l'entrée surlignée (la première sinon), ⎋ referme.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Un écran que seule la coque sait ouvrir (la nouvelle interface : « Maintenant », « À vous »,
/// un outil…) : la palette le propose à la place des sections classiques.
public struct ConsolePaletteScreen: Identifiable, Hashable, Sendable {
    /// Ce que la coque reçoit quand l'entrée est choisie.
    public var id: String
    public var title: String
    public var subtitle: String?
    public var symbol: String

    public init(id: String, title: String, subtitle: String? = nil, symbol: String) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.symbol = symbol
    }
}

extension View {
    /// Pose la palette et la feuille « Nouveau fil… » sous la racine d'une app.
    /// `sections` : les sections de l'app ; `memory` : l'app a une section Mémoire ;
    /// `select` montre une section. `screens` et `openScreen` : les écrans de la nouvelle
    /// interface, proposés À LA PLACE des sections et des pages de Système. `launch` : les
    /// dépôts que la feuille de lancement propose (ceux de l'espace choisi).
    public func consolePalette(
        server: HarnessModel, drafts: HarnessDrafts, sections: [ConsoleSection], memory: Bool,
        screens: [ConsolePaletteScreen] = [], openScreen: (@MainActor (String) -> Void)? = nil,
        launch: LaunchScope = LaunchScope(),
        select: @escaping @MainActor (ConsoleSection) -> Void
    ) -> some View {
        modifier(PalettePresenter(
            server: server, drafts: drafts, sections: sections, memory: memory, screens: screens, openScreen: openScreen,
            launch: launch, select: select
        ))
    }
}

private struct PalettePresenter: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let sections: [ConsoleSection]
    let memory: Bool
    let screens: [ConsolePaletteScreen]
    let openScreen: (@MainActor (String) -> Void)?
    let launch: LaunchScope
    let select: @MainActor (ConsoleSection) -> Void
    /// L'écran choisi dans la palette, ouvert à sa fermeture (comme `palettePending`).
    @State private var pendingScreen: String?

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $drafts.paletteShown, onDismiss: runPending) {
                CommandPalette(
                    server: server, drafts: drafts, history: server.history, sections: sections, memory: memory,
                    screens: screens, pendingScreen: $pendingScreen
                )
            }
            .sheet(isPresented: $drafts.launchSheetShown) {
                LaunchFeatureSheet(server: server, drafts: drafts, scope: launch)
            }
            .sheet(isPresented: $drafts.projectSheetShown) {
                NewProjectSheet(server: server, drafts: drafts)
            }
            .sheet(isPresented: $drafts.auditSheetShown) {
                NewAuditSheet(server: server, drafts: drafts)
            }
            .sheet(isPresented: $drafts.scheduleSheetShown) {
                NewScheduleSheet(server: server, drafts: drafts)
            }
            .sheet(isPresented: $drafts.intakeSheetShown) {
                IntakeSheet(server: server, drafts: drafts)
            }
            .sheet(item: $drafts.intakeEdit) { intake in
                IntakePlanSheet(server: server, drafts: drafts, intake: intake)
            }
    }

    private func runPending() {
        if let screen = pendingScreen {
            pendingScreen = nil
            openScreen?(screen)
            return
        }
        guard let command = drafts.palettePending else { return }
        drafts.palettePending = nil
        ConsolePaletteActions.perform(command, server: server, drafts: drafts, select: select)
    }
}

/// L'exécution d'une commande de la palette, la même dans les deux apps.
public enum ConsolePaletteActions {
    @MainActor
    public static func perform(
        _ command: HarnessPaletteCommand, server: HarnessModel, drafts: HarnessDrafts, select: @MainActor (ConsoleSection) -> Void
    ) {
        switch command {
        case .intake:
            drafts.openIntake()
        case .section(let section):
            if section == .system { drafts.systemPage = nil }
            select(section)
        case .system(let page):
            ConsoleNavigation.open(page, drafts: drafts, select: select)
        case .run(let id):
            ConsoleNavigation.openRun(id, drafts: drafts, select: select)
        case .newFeature:
            drafts.launchSheetShown = true
        case .inbox(let anchor):
            select(.inbox)
            drafts.homeAnchor = anchor
        case .refresh:
            Task {
                await server.refresh()
                await server.refreshCatalog()
                await server.refreshServices()
            }
        case .server:
            drafts.serverSheetShown = true
        case .searchMemory(let query):
            drafts.memorySearchRequest = query
            select(.memory)
        case .stopWorkstation:
            select(.workstation)
            drafts.workstationStopAsked = true
        }
    }
}

/// Une ligne de la palette : une commande du serveur, ou un écran de la coque.
enum PaletteRow: Identifiable, Hashable {
    case item(HarnessPaletteItem)
    case screen(ConsolePaletteScreen)

    var id: PaletteRow { self }

    var title: String {
        switch self {
        case let .item(item): item.title
        case let .screen(screen): screen.title
        }
    }

    var subtitle: String? {
        switch self {
        case let .item(item): item.subtitle
        case let .screen(screen): screen.subtitle
        }
    }

    var symbol: String {
        switch self {
        case let .item(item): item.symbol
        case let .screen(screen): screen.symbol
        }
    }

    /// Les lignes d'une coque qui a ses écrans : ils remplacent les sections classiques ; ceux
    /// que la saisie retient passent en tête, et sans saisie ils suivent la Demande. Sans
    /// écran (interface classique, app iOS), les commandes telles quelles.
    static func rows(items: [HarnessPaletteItem], screens: [ConsolePaletteScreen], query: String, search: Bool) -> [PaletteRow] {
        guard !screens.isEmpty else { return items.map(PaletteRow.item) }
        let kept = items.compactMap { item -> PaletteRow? in
            switch item.command {
            case .section, .system: return nil
            case .newFeature: return .item(HarnessPaletteItem(title: OSText.newThread, subtitle: item.subtitle, symbol: item.symbol, command: item.command))
            default: return .item(item)
            }
        }
        // ⌘F ne cherche que les fils et la mémoire.
        if search { return kept }
        let words = query.split(whereSeparator: \.isWhitespace).map { fold(String($0)) }
        guard !words.isEmpty else {
            return Array(kept.prefix(1)) + screens.map(PaletteRow.screen) + kept.dropFirst()
        }
        let matching = screens.filter { screen in
            let title = fold(screen.title)
            return words.allSatisfy { title.contains($0) }
        }
        return matching.map(PaletteRow.screen) + kept
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
}

struct CommandPalette: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory
    let sections: [ConsoleSection]
    let memory: Bool
    var screens: [ConsolePaletteScreen] = []
    var pendingScreen: Binding<String?> = .constant(nil)
    /// L'écran surligné (les commandes le sont par `drafts.paletteSelection`).
    @State private var screenSelection: String?

    private var rows: [PaletteRow] {
        let items = HarnessPalette.items(
            query: drafts.paletteQuery,
            search: drafts.paletteSearch,
            sections: sections,
            systemPages: SystemPage.visible(isAdmin: server.isAdmin, autonomy: server.autonomy.isServed),
            inbox: server.inbox,
            history: history.runs,
            canAct: server.canAct,
            memory: memory
        )
        return PaletteRow.rows(items: items, screens: screens, query: drafts.paletteQuery, search: drafts.paletteSearch)
    }

    var body: some View {
        let rows = rows
        NavigationStack {
            List {
                Section {
                    TextField(
                        drafts.paletteSearch ? PipelineServerText.searchPrompt : PipelineServerText.palettePrompt,
                        text: $drafts.paletteQuery
                    )
                    .consolePlainInput()
                    .onSubmit { choose(highlighted(in: rows)) }
                    .onKeyPress(.downArrow) { move(1, in: rows) }
                    .onKeyPress(.upArrow) { move(-1, in: rows) }
                    .consoleID("palette.query")
                }
                Section {
                    if rows.isEmpty {
                        Text(PipelineServerText.paletteEmpty).foregroundStyle(.secondary)
                    }
                    ForEach(rows) { item in
                        Button { choose(item) } label: { row(item, highlighted: item == highlighted(in: rows)) }
                            .buttonStyle(.plain)
                            .consoleID("palette.item")
                    }
                }
            }
            .navigationTitle(drafts.paletteSearch ? PipelineServerText.searchTitle : PipelineServerText.paletteTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { drafts.paletteShown = false }
                }
            }
        }
        .consoleSheetSize(minWidth: 560, minHeight: 440)
        // L'historique nourrit la recherche des features terminées.
        .task { if history.runs.isEmpty { await history.refresh() } }
    }

    private func row(_ item: PaletteRow, highlighted: Bool) -> some View {
        HStack(spacing: 10) {
            Image(systemName: item.symbol)
                .frame(width: 22)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
        .frame(maxWidth: .infinity, minHeight: ConsolePlatform.minimumTarget, alignment: .leading)
        .contentShape(.rect)
        .background(highlighted ? Color.accentColor.opacity(0.15) : Color.clear, in: .rect(cornerRadius: 6))
        .accessibilityAddTraits(highlighted ? .isSelected : [])
    }

    /// La ligne surlignée, la première sinon.
    private func highlighted(in rows: [PaletteRow]) -> PaletteRow? {
        rows.first { isSelected($0) } ?? rows.first
    }

    private func isSelected(_ row: PaletteRow) -> Bool {
        switch row {
        case let .item(item): screenSelection == nil && item.id == drafts.paletteSelection
        case let .screen(screen): screen.id == screenSelection
        }
    }

    private func move(_ step: Int, in rows: [PaletteRow]) -> KeyPress.Result {
        guard !rows.isEmpty else { return .ignored }
        let current = rows.firstIndex { isSelected($0) } ?? 0
        switch rows[min(max(current + step, 0), rows.count - 1)] {
        case let .item(item):
            screenSelection = nil
            drafts.paletteSelection = item.id
        case let .screen(screen):
            screenSelection = screen.id
            drafts.paletteSelection = nil
        }
        return .handled
    }

    private func choose(_ row: PaletteRow?) {
        guard let row else { return }
        switch row {
        case let .item(item): drafts.palettePending = item.command
        case let .screen(screen): pendingScreen.wrappedValue = screen.id
        }
        drafts.paletteShown = false
    }
}
