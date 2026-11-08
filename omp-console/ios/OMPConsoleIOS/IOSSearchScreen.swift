import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

/// La palette de commandes au doigt, sans clavier : les entrées retenues par une saisie
/// — sections, pages de Système, gestes (lancer, valider, actualiser, relier) et
/// features, vivantes et terminées ; une saisie propose aussi de la chercher dans la
/// mémoire. Choisir une entrée l'exécute comme la palette ⌘K (`ConsolePaletteActions`) :
/// une feature s'ouvre en page dans Features, une section s'affiche — puis la recherche
/// se referme. Posée dans une `List` : l'onglet de recherche de l'iPad
/// (`IOSSearchScreen`) et le champ de recherche de « À traiter » sur iPhone.
struct IOSPaletteResults: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory
    let query: String
    @Environment(\.consoleShell) private var shell
    @Environment(\.dismissSearch) private var dismissSearch

    init(server: HarnessModel, drafts: HarnessDrafts, query: String) {
        self.server = server
        self.drafts = drafts
        self.history = server.history
        self.query = query
    }

    var body: some View {
        let items = HarnessPalette.items(
            query: query,
            search: false,
            sections: IOSSection.all,
            systemPages: SystemPage.visible(isAdmin: server.isAdmin),
            inbox: server.inbox,
            history: history.runs,
            canAct: server.canAct,
            memory: true
        )
        Section {
            if items.isEmpty {
                ContentUnavailableView.search(text: query)
                    .iosBareListRow()
            }
            ForEach(items) { item in
                Button {
                    dismissSearch()
                    ConsolePaletteActions.perform(item.command, server: server, drafts: drafts) { shell.select($0) }
                } label: {
                    row(item)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("ios.search.item")
            }
        }
        // L'historique nourrit la recherche des features terminées.
        .task { if history.runs.isEmpty { await history.refresh() } }
    }

    private func row(_ item: HarnessPaletteItem) -> some View {
        HStack(spacing: 12) {
            Image(systemName: item.symbol)
                .frame(width: 24)
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.title)
                    .foregroundStyle(.primary)
                if let subtitle = item.subtitle {
                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
    }
}

/// L'onglet de recherche (`Tab(role: .search)`, iPad) : la palette au doigt, dans le
/// champ de recherche du système.
struct IOSSearchScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @State private var query = ""

    var body: some View {
        List {
            IOSPaletteResults(server: server, drafts: drafts, query: query)
        }
        .iosGroupedList()
        .navigationTitle(PipelineServerText.searchTitle)
        .searchable(text: $query, prompt: Text(PipelineServerText.palettePrompt))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.screen.search")
    }
}
