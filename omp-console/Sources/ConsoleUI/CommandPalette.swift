// La PALETTE de commandes (⌘K), sa recherche globale (⌘F : features et mémoire) et la
// feuille « Nouvelle feature » (⌘N), écrites une fois pour le Mac et l'iPhone/iPad.
//
// La liste et son tri viennent de `HarnessPalette` (client partagé). Choisir une entrée
// referme la palette ; la commande s'exécute à sa fermeture (`palettePending`) : une
// feuille ne s'ouvre pas pendant qu'une autre se referme. ↑ et ↓ surlignent, ↩
// exécute l'entrée surlignée (la première sinon), ⎋ referme.

import ConsoleClient
import ConsoleCore
import SwiftUI

extension View {
    /// Pose la palette et la feuille « Nouvelle feature » sous la racine d'une app.
    /// `sections` : les sections de l'app ; `memory` : l'app a une section Mémoire ;
    /// `select` montre une section.
    public func consolePalette(
        server: HarnessModel, drafts: HarnessDrafts, sections: [ConsoleSection], memory: Bool,
        select: @escaping @MainActor (ConsoleSection) -> Void
    ) -> some View {
        modifier(PalettePresenter(server: server, drafts: drafts, sections: sections, memory: memory, select: select))
    }
}

private struct PalettePresenter: ViewModifier {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let sections: [ConsoleSection]
    let memory: Bool
    let select: @MainActor (ConsoleSection) -> Void

    func body(content: Content) -> some View {
        content
            .sheet(isPresented: $drafts.paletteShown, onDismiss: runPending) {
                CommandPalette(server: server, drafts: drafts, history: server.history, sections: sections, memory: memory)
            }
            .sheet(isPresented: $drafts.launchSheetShown) {
                LaunchFeatureSheet(server: server, drafts: drafts)
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
    }

    private func runPending() {
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

struct CommandPalette: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory
    let sections: [ConsoleSection]
    let memory: Bool

    private var items: [HarnessPaletteItem] {
        HarnessPalette.items(
            query: drafts.paletteQuery,
            search: drafts.paletteSearch,
            sections: sections,
            systemPages: SystemPage.visible(isAdmin: server.isAdmin, autonomy: server.autonomy.isServed),
            inbox: server.inbox,
            history: history.runs,
            canAct: server.canAct,
            memory: memory
        )
    }

    var body: some View {
        let items = items
        NavigationStack {
            List {
                Section {
                    TextField(
                        drafts.paletteSearch ? PipelineServerText.searchPrompt : PipelineServerText.palettePrompt,
                        text: $drafts.paletteQuery
                    )
                    .consolePlainInput()
                    .onSubmit { choose(highlighted(in: items)) }
                    .onKeyPress(.downArrow) { move(1, in: items) }
                    .onKeyPress(.upArrow) { move(-1, in: items) }
                    .consoleID("palette.query")
                }
                Section {
                    if items.isEmpty {
                        Text(PipelineServerText.paletteEmpty).foregroundStyle(.secondary)
                    }
                    ForEach(items) { item in
                        Button { choose(item) } label: { row(item, highlighted: item.id == highlighted(in: items)?.id) }
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

    private func row(_ item: HarnessPaletteItem, highlighted: Bool) -> some View {
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

    /// L'entrée surlignée, la première sinon.
    private func highlighted(in items: [HarnessPaletteItem]) -> HarnessPaletteItem? {
        items.first { $0.id == drafts.paletteSelection } ?? items.first
    }

    private func move(_ step: Int, in items: [HarnessPaletteItem]) -> KeyPress.Result {
        guard !items.isEmpty else { return .ignored }
        let current = items.firstIndex { $0.id == drafts.paletteSelection } ?? 0
        let next = min(max(current + step, 0), items.count - 1)
        drafts.paletteSelection = items[next].id
        return .handled
    }

    private func choose(_ item: HarnessPaletteItem?) {
        guard let item else { return }
        drafts.palettePending = item.command
        drafts.paletteShown = false
    }
}
