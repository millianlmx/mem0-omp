// L'HISTORIQUE des features (`HarnessRunsHistory`, `GET /v1/runs`), terminées comprises,
// avec ses filtres : état (plusieurs), dépôt, projet, recherche texte, et l'ordre.
//
// - iOS : une liste filtrable dans la liste groupée de l'écran Pipelines, par pages
//   (« Afficher plus ») ;
// - Mac : un tableau triable par colonne, ou un kanban par état où glisser une feature
//   sur une autre la fait passer devant elle (priorité d'admission).
//
// Les gestes passent par `RunRow`, `PriorityMenu` et les confirmations de
// `harnessGestures`.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les filtres de l'historique, en rangées de formulaire (iOS) ou en barre (Mac).
struct RunsHistoryFilters: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var history: HarnessRunsHistory

    var body: some View {
        TextField(PipelineServerText.searchRuns, text: $history.query)
            .consolePlainInput()
            .consoleID("pipelines.history.search")
        stateMenu
        Picker(PipelineServerText.filterRepo, selection: $history.repo) {
            Text(PipelineServerText.filterAll).tag(String?.none)
            ForEach(server.repos) { repo in
                Text(repo.name).tag(Optional(repo.name))
            }
        }
        .consoleID("pipelines.history.repo")
        Picker(PipelineServerText.filterProject, selection: $history.projectId) {
            Text(PipelineServerText.filterAll).tag(String?.none)
            ForEach(server.projects) { project in
                Text(project.title).tag(Optional(project.id))
            }
        }
        .consoleID("pipelines.history.project")
        Picker(PipelineServerText.sortLabel, selection: $history.sort) {
            ForEach(HarnessRunsSort.allCases) { sort in
                Text(PipelineServerText.sort(sort.rawValue)).tag(sort)
            }
        }
        .consoleID("pipelines.history.sort")
        if history.isFiltered {
            Button(PipelineServerText.clearFilters) { history.clearFilters() }
                .consoleID("pipelines.history.clear")
        }
    }

    /// Plusieurs états à la fois : un menu de cases à cocher.
    private var stateMenu: some View {
        Menu {
            ForEach(HarnessRunState.allCases, id: \.self) { state in
                Toggle(PipelineServerText.state(state.rawValue), isOn: Binding(
                    get: { history.states.contains(state) },
                    set: { on in
                        if on { history.states.insert(state) } else { history.states.remove(state) }
                    }
                ))
            }
        } label: {
            Label(stateSummary, systemImage: PipelineServerText.filterSymbol)
        }
        .consoleID("pipelines.history.state")
    }

    private var stateSummary: String {
        let names = HarnessRunState.allCases.filter { history.states.contains($0) }.map { PipelineServerText.state($0.rawValue) }
        return PipelineServerText.filterState + " · " + (names.isEmpty ? PipelineServerText.filterAll : names.joined(separator: ", "))
    }
}

/// L'historique dans une liste groupée (iOS) : filtres, puis la page de features.
public struct RunsHistorySections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory

    public init(server: HarnessModel, drafts: HarnessDrafts, history: HarnessRunsHistory) {
        self.server = server
        self.drafts = drafts
        self.history = history
    }

    public var body: some View {
        Section {
            RunsHistoryFilters(server: server, history: history)
        } header: {
            Text(PipelineServerText.historyTitle)
        } footer: {
            Text(PipelineServerText.historyHint)
        }
        Section {
            if let failure = history.failure {
                ConsoleFailureBanner(failure: failure)
            }
            let shown = history.page
            if shown.isEmpty, !history.isLoading {
                Text(history.isFiltered ? PipelineServerText.noMatch : PipelineServerText.noRun).foregroundStyle(.secondary)
            }
            ForEach(shown) { run in
                RunRow(server: server, drafts: drafts, run: run)
            }
            if history.hasMore {
                Button(PipelineServerText.showMore) { history.showMore() }
                    .consoleID("pipelines.history.more")
            }
        } header: {
            Text(PipelineServerText.allRuns)
        } footer: {
            Text(PipelineServerText.shown(history.page.count, of: history.filtered.count))
                .monospacedDigit()
        }
        .task { await history.refresh() }
    }
}

#if os(macOS)
/// L'historique du Mac : la barre des filtres, puis le tableau triable ou le kanban.
public struct RunsHistoryPanel: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory

    public init(server: HarnessModel, drafts: HarnessDrafts, history: HarnessRunsHistory) {
        self.server = server
        self.drafts = drafts
        self.history = history
    }

    public var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                RunsHistoryFilters(server: server, history: history)
                    .fixedSize()
                Spacer(minLength: 0)
                Picker(PipelineServerText.presentationLabel, selection: $drafts.historyBoard) {
                    Label(PipelineServerText.tableView, systemImage: PipelineServerText.tableSymbol).tag(false)
                    Label(PipelineServerText.boardView, systemImage: PipelineServerText.boardSymbol).tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("pipelines.history.layout")
            }
            .padding(.horizontal)
            .padding(.vertical, 10)
            if let failure = history.failure {
                ConsoleFailureBanner(failure: failure)
                    .padding(.horizontal)
            }
            Divider()
            if drafts.historyBoard {
                RunsBoard(server: server, drafts: drafts, history: history)
            } else {
                table
                HStack {
                    Text(PipelineServerText.shown(history.page.count, of: history.filtered.count))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Spacer()
                    if history.hasMore {
                        Button(PipelineServerText.showMore) { history.showMore() }
                            .accessibilityIdentifier("pipelines.history.more")
                    }
                }
                .font(.callout)
                .padding(.horizontal)
                .padding(.vertical, 8)
            }
        }
        .task { await history.refresh() }
        .accessibilityIdentifier("pipelines.history")
    }

    private var table: some View {
        Table(history.page, selection: $history.selection, sortOrder: $history.order) {
            TableColumn(PipelineServerText.columnFeature, value: \.title) { run in
                VStack(alignment: .leading, spacing: 2) {
                    Text(run.title)
                    if let detail = run.detailLine() {
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .width(min: 220, ideal: 340)
            TableColumn(PipelineServerText.filterRepo, value: \.repo)
                .width(min: 90, ideal: 120)
            TableColumn(PipelineServerText.filterState, value: \.state) { run in
                ConsoleStatusChip(status: ConsoleStatus(text: run.statusLine, tone: run.tone))
            }
            .width(min: 110, ideal: 150)
            TableColumn(PipelineServerText.priorityLabel, value: \.admissionPriority) { run in
                if HarnessKanbanColumn.of(run)?.acceptsPriority == true {
                    PriorityMenu(server: server, run: run)
                } else {
                    Text(String(run.admissionPriority))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .width(min: 90, ideal: 120)
            TableColumn(PipelineServerText.columnUpdated, value: \.updatedAt) { run in
                Text(ConsoleFormat.relative(ms: run.updatedAt, nowMs: Date().timeIntervalSince1970 * 1000))
                    .monospacedDigit()
            }
            .width(min: 90, ideal: 120)
            TableColumn(PipelineServerText.columnCreated, value: \.createdAt) { run in
                Text(ConsoleFormat.dateTime(ms: run.createdAt))
                    .monospacedDigit()
            }
            .width(min: 110, ideal: 140)
        }
        .contextMenu(forSelectionType: String.self) { ids in
            if ids.count == 1, let id = ids.first, let run = history.run(id) {
                RunMenuItems(drafts: drafts, run: run)
            }
        } primaryAction: { ids in
            if let id = ids.first, let run = history.run(id), run.canFollowSession {
                drafts.sessionRequest = HarnessSessionRequest(run: run)
            }
        }
    }
}

/// Le kanban du Mac : une colonne par état, chaque colonne dans l'ordre d'admission ;
/// glisser une feature sur une autre (colonnes vivantes) la fait passer devant elle.
struct RunsBoard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(PipelineServerText.boardHint)
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.horizontal)
                .padding(.top, 8)
            ScrollView(.horizontal) {
                HStack(alignment: .top, spacing: 12) {
                    ForEach(HarnessKanban.columns(history.filtered), id: \.column) { entry in
                        column(entry.column, runs: entry.runs)
                    }
                }
                .padding()
            }
        }
    }

    private func column(_ column: HarnessKanbanColumn, runs: [HarnessRun]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(PipelineServerText.column(column.rawValue))
                    .font(.headline)
                Spacer()
                Text(String(runs.count))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(runs) { run in
                        card(run)
                    }
                }
            }
        }
        .frame(width: 260)
        .padding(10)
        .background(.quaternary.opacity(0.4), in: .rect(cornerRadius: ConsolePlatform.cardRadius))
        .accessibilityIdentifier("pipelines.board." + column.rawValue)
    }

    private func card(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(run.title)
                .font(.callout.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(run.repo)
                .font(.caption)
                .foregroundStyle(.secondary)
            ConsoleStatusChip(status: ConsoleStatus(text: run.statusLine, tone: run.tone))
            if HarnessKanbanColumn.of(run)?.acceptsPriority == true {
                PriorityMenu(server: server, run: run)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleCardSurface()
        .contextMenu { RunMenuItems(drafts: drafts, run: run) }
        .draggable(run.id)
        .dropDestination(for: String.self) { ids, _ in
            guard let id = ids.first, let moved = history.run(id),
                  let priority = HarnessKanban.priority(moving: moved, before: run)
            else { return false }
            Task { await server.setPriority(runId: moved.id, priority: priority) }
            return true
        }
    }
}

#endif

/// Les gestes d'une feature dans un menu (rangée, tableau, kanban) : le direct, ceux de
/// la plateforme (`ConsoleShell.runActions`), puis relance, annulation de la fusion et
/// arrêt — ces trois-là toujours confirmés, jamais exécutés du menu.
struct RunMenuItems: View {
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.consoleShell) private var shell
    let run: HarnessRun

    var body: some View {
        if run.canFollowSession {
            Button(PipelineServerText.sessionTitle, systemImage: PipelineServerText.sessionSymbol) { drafts.sessionRequest = HarnessSessionRequest(run: run) }
        }
        shell.runActions(run)
        if run.canRetry {
            Button(PipelineServerText.retry) { drafts.retryRequest = run }
        }
        if run.canRevert {
            Button(PipelineServerText.revertFeature, role: .destructive) { drafts.revertRequest = run }
        }
        if run.canStop {
            Button(PipelineServerText.stopFeature, role: .destructive) { drafts.stopRequest = run }
        }
    }
}
