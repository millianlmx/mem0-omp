// La LISTE des features (`HarnessRunsHistory`, `GET /v1/runs`, plus la boîte pour l'état
// le plus frais), écrite une fois pour le Mac et l'iPhone/iPad : groupée en « À vous »,
// « En cours », « En file » et « Terminées » (`HarnessRunGroups`), une ligne dense par
// feature (`RunListRow`), aucun bouton dans la ligne. Choisir une ligne ouvre la page de
// la feature (`drafts.openedRun`) ; son menu contextuel reprend ses gestes.
//
// Les filtres tiennent dans un menu (dépôt, projet, ordre) et la recherche dans le champ
// de recherche de la plateforme : rien ne s'empile au-dessus de la liste.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les features groupées, dans une `List` de la plateforme. `selectable` : les lignes
/// portent leur identité pour la sélection de la liste (Mac, iPad) ; sinon chaque ligne
/// est un lien de navigation (`NavigationLink(value:)`, iPhone).
public struct RunsListSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory
    let selectable: Bool

    public init(server: HarnessModel, drafts: HarnessDrafts, selectable: Bool) {
        self.server = server
        self.drafts = drafts
        self.history = server.history
        self.selectable = selectable
    }

    public var body: some View {
        let groups = HarnessRunGroups.groups(history.filtered, live: live)
        if let failure = history.failure {
            Section { ConsoleFailureBanner(failure: failure) }
        }
        if groups.isEmpty, !history.isLoading {
            Section {
                Text(history.isFiltered ? ShellText.noMatch : ShellText.noRun)
                    .foregroundStyle(.secondary)
            }
        }
        ForEach(groups, id: \.group) { entry in
            Section {
                ForEach(shown(entry)) { run in
                    row(run)
                }
                if entry.group == .done, history.hasMore {
                    Button(PipelineServerText.showMore) { history.showMore() }
                        .consoleID("runs.more")
                }
            } header: {
                HStack {
                    Text(Self.title(entry.group))
                    Spacer()
                    Text(entry.runs.count, format: .number)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    /// Les features terminées se montrent par pages ; les vivantes toutes.
    private func shown(_ entry: (group: HarnessRunGroup, runs: [HarnessRun])) -> [HarnessRun] {
        entry.group == .done ? Array(entry.runs.prefix(history.shown)) : entry.runs
    }

    @ViewBuilder
    private func row(_ run: HarnessRun) -> some View {
        let content = RunListRow(run: run, cost: server.inbox?.costs[run.id], alerts: server.inbox?.alerts(of: run.id).count ?? 0)
            .contextMenu { RunMenuItems(server: server, drafts: drafts, run: run) }
        if selectable {
            content.tag(run.id)
        } else {
            NavigationLink(value: run.id) { content }
        }
    }

    /// La boîte, filtrée comme l'historique : son état prime, et les features lancées
    /// depuis la dernière lecture de l'historique s'y ajoutent.
    private var live: [HarnessRun] {
        guard let inbox = server.inbox else { return [] }
        let all = inbox.batches.compactMap(\.run) + inbox.awaiting + inbox.runs
        return HarnessRunsHistory.filter(all, projectId: history.projectId, query: history.query)
            .filter { history.repo == nil || $0.repo == history.repo }
            .filter { history.states.isEmpty || $0.phase.map(history.states.contains) == true }
    }

    public static func title(_ group: HarnessRunGroup) -> String {
        switch group {
        case .needsYou: ShellText.groupNeedsYou
        case .running: ShellText.groupRunning
        case .queued: ShellText.groupQueued
        case .done: ShellText.groupDone
        }
    }
}

/// Le menu des filtres de la liste : dépôt, projet et ordre ; « Effacer » s'il y en a.
public struct RunsFilterMenu: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var history: HarnessRunsHistory

    public init(server: HarnessModel) {
        self.server = server
        self.history = server.history
    }

    public var body: some View {
        Menu {
            Picker(PipelineServerText.filterRepo, selection: $history.repo) {
                Text(ShellText.allRepos).tag(String?.none)
                ForEach(server.repos) { repo in
                    Text(repo.name).tag(Optional(repo.name))
                }
            }
            if !server.projects.isEmpty {
                Picker(PipelineServerText.filterProject, selection: $history.projectId) {
                    Text(ShellText.allProjects).tag(String?.none)
                    ForEach(server.projects) { project in
                        Text(project.title).tag(Optional(project.id))
                    }
                }
            }
            Picker(PipelineServerText.sortLabel, selection: $history.sort) {
                ForEach(HarnessRunsSort.allCases) { sort in
                    Text(PipelineServerText.sort(sort.rawValue)).tag(sort)
                }
            }
            if history.isFiltered {
                Divider()
                Button(PipelineServerText.clearFilters) { history.clearFilters() }
            }
        } label: {
            Label(ShellText.filters, systemImage: history.isFiltered ? ShellText.filtersSymbol + ".fill" : ShellText.filtersSymbol)
        }
        .consoleID("runs.filters")
    }
}

/// Les gestes d'une feature dans un menu (ligne, page) : l'ouvrir, ceux de la plateforme
/// (`ConsoleShell.runActions`), la consigne, le budget, la priorité, la PR, puis
/// relance, annulation de la fusion et arrêt — ces trois-là toujours confirmés.
public struct RunMenuItems: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.consoleShell) private var shell
    @Environment(\.openURL) private var openURL
    let run: HarnessRun
    var includesOpen = true

    public init(server: HarnessModel, drafts: HarnessDrafts, run: HarnessRun, includesOpen: Bool = true) {
        self.server = server
        self.drafts = drafts
        self.run = run
        self.includesOpen = includesOpen
    }

    public var body: some View {
        if includesOpen {
            Button(ShellText.openRun, systemImage: ShellText.openRunSymbol) {
                ConsoleNavigation.openRun(run.id, drafts: drafts, select: shell.select)
            }
        }
        shell.runActions(run)
        if server.canAct {
            if run.acceptsInstructions {
                Button(ControlText.instructionsAction, systemImage: ControlText.instructionsSymbol) { drafts.instructionsRequest = run }
            }
            if run.acceptsBudget {
                Button(ControlText.budgetAction, systemImage: ControlText.budgetSymbol) { drafts.beginBudget(run) }
            }
            if run.acceptsPriority {
                PriorityMenu(server: server, run: run)
            }
        }
        if let pr = run.prUrl, let url = URL(string: pr) {
            Button(ShellText.openPR, systemImage: ShellText.openPRSymbol) { openURL(url) }
        }
        if server.canAct {
            if run.canRetry || run.canRevert || run.canStop { Divider() }
            if run.canRetry {
                Button(PipelineServerText.retry, systemImage: "arrow.clockwise") { drafts.beginRetry(run) }
            }
            if run.canRevert {
                Button(PipelineServerText.revertFeature, systemImage: "arrow.uturn.backward", role: .destructive) { drafts.revertRequest = run }
            }
            if run.canStop {
                Button(PipelineServerText.stopFeature, systemImage: "stop.circle", role: .destructive) { drafts.stopRequest = run }
            }
        }
    }
}
