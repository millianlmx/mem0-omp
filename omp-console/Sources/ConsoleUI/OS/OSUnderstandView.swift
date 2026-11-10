// L'« OS agentique » : COMPRENDRE, trois vues sur une tâche, à la place des sept onglets
// de sa page, partagées par le Mac et l'iPhone/iPad :
//   Résumé  — trois blocs écrits par l'app : ce qui a été fait, pourquoi on vous
//             demande, ce qui reste douteux ; puis le verdict intégral, la demande et les
//             specs, repliés ;
//   Preuves — captures et rapports, fichiers touchés, tests, sur une rangée de volets ;
//   Journal — la carte de la session (ce que l'agent a lu, décidé, fait) et son direct ;
//             sur une tâche finie, sa frise tant que le direct n'est pas arrivé.
// AUCUN geste de décision ici : ils vivent sur la carte du fil, une fois. Le direct d'une
// session (journal, fichiers touchés, tests) diffère d'une plateforme à l'autre : l'app le
// fournit (`session`). La logique pure est dans `OSUnderstandLogic.swift`.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Ce que « Comprendre » demande au direct d'une feature (`timeline` : sa frise, sans le direct).
public enum OSSessionPane: Hashable, Sendable {
    case live, files, tests, timeline
}

/// Le direct d'une feature, rendu par l'app : l'identifiant de la feature, le panneau,
/// « suivre la fin », et l'entrée à montrer (remise à `nil` une fois montrée).
public typealias OSSessionContent = @MainActor (_ runId: String, _ pane: OSSessionPane, _ followsEnd: Binding<Bool>, _ focus: Binding<Int?>) -> AnyView

public struct OSUnderstandView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workspace: OSWorkspace
    let runId: String
    let session: OSSessionContent

    @StateObject private var proofs: HarnessRunProofs
    @StateObject private var graph: HarnessRunGraph
    @State private var view: HarnessRunView?
    @State private var proofPane: OSProofPane = .captures
    @State private var followsEnd = true
    @State private var focus: Int?
    /// La carte de la session est dépliée ; `nil` : d'office sur une tâche finie.
    @State private var showsMap: Bool?

    /// `session` : le direct de la feature tel que l'app le rend (voir `OSSessionContent`).
    /// `drafts` : gardé pour la signature (les gestes de décision ont quitté « Comprendre »).
    public init(
        server: HarnessModel, drafts: HarnessDrafts, workspace: OSWorkspace, runId: String,
        session: @escaping OSSessionContent
    ) {
        self.server = server
        self.workspace = workspace
        self.runId = runId
        self.session = session
        _proofs = StateObject(wrappedValue: HarnessRunProofs(harness: server, runId: runId))
        _graph = StateObject(wrappedValue: HarnessRunGraph(harness: server, runId: runId))
    }

    private var run: HarnessRun? { server.knownRun(runId) ?? view?.run }

    public var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if let run {
                    Text(OSThreads.clean(run.title).title)
                        .font(.headline)
                        .lineLimit(2)
                    HStack {
                        OSStepDots(run: run)
                        Text(run.osState).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Picker(OSText.understand, selection: $workspace.level) {
                    ForEach(OSLevel.allCases) { level in
                        Text(level.title).tag(level)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            Divider()
            level
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .task(id: runId) {
            view = await server.runView(runId)
            await proofs.load()
            await graph.load()
        }
        .onChange(of: server.graphVersions[runId]) { _, version in
            Task { await graph.receive(version: version) }
        }
        .onDisappear {
            if server.session?.target == .run(runId) { server.stopSession() }
        }
        // ⌘+ / ⌘− : la vue suivante, la précédente.
        .background {
            Group {
                Button("") { zoom(+1) }.keyboardShortcut("+", modifiers: .command)
                Button("") { zoom(-1) }.keyboardShortcut("-", modifiers: .command)
            }
            .hidden()
        }
    }

    private func zoom(_ step: Int) {
        let all = OSLevel.allCases
        guard let index = all.firstIndex(of: workspace.level) else { return }
        workspace.level = all[max(0, min(all.count - 1, index + step))]
    }

    /// Le direct de la feature dans un panneau ; celui qui le pose l'ouvre (`followSession`).
    private func live(_ run: HarnessRun, _ pane: OSSessionPane, focus: Binding<Int?> = .constant(nil)) -> some View {
        session(run.id, pane, $followsEnd, focus)
            .onAppear { server.followSession(.run(run.id)) }
    }

    @ViewBuilder
    private var level: some View {
        if let run {
            switch workspace.level {
            case .summary: summary(run)
            case .proofs: proofsLevel(run)
            case .journal: journal(run)
            }
        } else {
            ContentUnavailableView(OSText.noRun, systemImage: "questionmark.circle")
        }
    }

    // MARK: Résumé

    private func summary(_ run: HarnessRun) -> some View {
        let summary = OSSummary(run: run)
        return Form {
            Section(OSText.summaryDone) {
                Text(summary.done)
                    .consoleReadable()
            }
            if !summary.why.isEmpty {
                Section(OSText.summaryWhy) {
                    ForEach(Array(summary.why.enumerated()), id: \.offset) { _, cause in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(cause.text)
                                .consoleReadable()
                            if let detail = cause.detail {
                                Text(detail)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .consoleReadable()
                            }
                        }
                    }
                }
            }
            if let doubts = summary.doubts {
                Section(OSText.summaryDoubts) {
                    if doubts.isEmpty {
                        Label(OSText.noDoubt, systemImage: "checkmark.circle")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(doubts) { doubt in
                        Label {
                            Text(doubt.text)
                                .consoleReadable()
                        } icon: {
                            Image(systemName: doubt.kind.symbol)
                                .foregroundStyle(doubt.kind.tint)
                                .accessibilityLabel(doubt.kind.label)
                        }
                    }
                }
            }
            Section {
                if let verdict = run.verdict {
                    DisclosureGroup(OSText.readAll) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(PipelineServerText.risk(verdict.risk))
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(verdict.isLowRisk ? .green : .orange)
                            ConsoleMarkdown(markdown: verdict.summary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if !run.request.isEmpty {
                    DisclosureGroup(OSText.request) {
                        ConsoleMarkdown(markdown: run.request).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                if let specs = view?.specs, !specs.isEmpty {
                    DisclosureGroup(OSText.specsFull) {
                        ConsoleMarkdown(markdown: specs).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                details(run)
            }
        }
        .formStyle(.grouped)
    }

    /// La branche, le modèle et la demande de fusion : ce que l'en-tête d'un fil ne porte plus.
    @ViewBuilder
    private func details(_ run: HarnessRun) -> some View {
        let branch = run.branch ?? ""
        let model = run.model ?? ""
        let link = run.prUrl.flatMap { URL(string: $0) }
        if !branch.isEmpty || !model.isEmpty || link != nil {
            DisclosureGroup(SessionGraphText.details) {
                if !branch.isEmpty { LabeledContent(OSDecideText.branch, value: branch) }
                if !model.isEmpty { LabeledContent(OSDecideText.model, value: model) }
                if let link {
                    Link(destination: link) {
                        Label(OSText.mergeRequest, systemImage: "arrow.up.right.square")
                    }
                }
            }
        }
    }

    // MARK: Preuves

    private func proofsLevel(_ run: HarnessRun) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ForEach(OSProofPane.allCases) { pane in
                    Button {
                        proofPane = pane
                    } label: {
                        Label(title(of: pane, run), systemImage: pane.symbol)
                            .font(.callout.weight(proofPane == pane ? .semibold : .regular))
                            .lineLimit(1)
                            .frame(maxWidth: .infinity, minHeight: ConsolePlatform.minimumTarget)
                            .padding(.vertical, 6)
                            .background(
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(proofPane == pane ? Color.accentColor.opacity(0.18) : Color.primary.opacity(0.06))
                            )
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(proofPane == pane ? .isSelected : [])
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            switch proofPane {
            case .captures:
                Form { RunProofsSections(proofs: proofs) }.formStyle(.grouped)
            case .files:
                live(run, .files)
            case .tests:
                live(run, .tests)
            }
        }
    }

    /// Le nom d'un volet, et ce qu'il contient quand on le sait : « Captures · 3 ».
    private func title(of pane: OSProofPane, _ run: HarnessRun) -> String {
        let count: Int
        switch pane {
        case .captures:
            if case let .loaded(rounds) = proofs.availability { count = rounds.current.proofs.count } else { count = 0 }
        case .files:
            count = run.verdict?.files.count ?? 0
        case .tests:
            count = server.session?.target == .run(run.id) ? server.session?.tests.count ?? 0 : 0
        }
        return count > 0 ? OSText.paneCount(pane.title, count) : pane.title
    }

    // MARK: Journal

    /// La carte de la session, repliable, au-dessus du direct : un nœud ouvre son entrée
    /// dans le direct, juste dessous. Sans carte (serveur sans graphe, session muette), le
    /// direct seul.
    private func journal(_ run: HarnessRun) -> some View {
        VStack(spacing: 0) {
            if let read = graph.graph, !read.isEmpty {
                DisclosureGroup(isExpanded: mapShown(run)) {
                    ScrollView {
                        SessionGraphMapView(
                            graph: read, runState: run.state,
                            link: { node in
                                guard let feed = server.session, feed.target == .run(run.id) else { return nil }
                                return HarnessGraphLink.entry(for: node, in: read, entries: feed.entries)
                            },
                            open: { seq in
                                followsEnd = false
                                focus = seq
                            }
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                    }
                    .frame(maxHeight: 260)
                } label: {
                    Label(OSText.sessionMap, systemImage: SessionGraphText.tabSymbol)
                        .font(.callout.weight(.medium))
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                Divider()
            }
            // Le direct d'une tâche qui ne travaille plus peut tarder à s'ouvrir : sa frise
            // (lue d'un trait) tient la place tant que le journal n'est pas arrivé.
            if run.phase == .running || run.phase == .merging || journalLoaded(run) {
                live(run, .live, focus: $focus)
            } else {
                live(run, .timeline)
            }
        }
    }

    /// Le journal du direct de cette tâche est arrivé.
    private func journalLoaded(_ run: HarnessRun) -> Bool {
        guard let feed = server.session, feed.target == .run(run.id) else { return false }
        return feed.isLoaded
    }

    /// La carte s'ouvre d'office sur une tâche finie (on la relit) ; au travail, le direct d'abord.
    private func mapShown(_ run: HarnessRun) -> Binding<Bool> {
        let finished = run.phase == .merged || run.phase == .failed || run.phase == .cancelled
        return Binding(
            get: { showsMap ?? finished },
            set: { showsMap = $0 }
        )
    }
}

private extension OSProofPane {
    var symbol: String {
        switch self {
        case .captures: "photo.on.rectangle"
        case .files: "doc.text"
        case .tests: "checkmark.circle"
        }
    }
}

private extension OSDoubt.Kind {
    var symbol: String {
        switch self {
        case .blocker: "xmark.octagon.fill"
        case .risk: "exclamationmark.triangle.fill"
        case .unverified: "questionmark.circle.fill"
        }
    }

    var tint: Color {
        switch self {
        case .blocker: .red
        case .risk: .orange
        case .unverified: .secondary
        }
    }

    var label: String {
        switch self {
        case .blocker: OSText.doubtBlocker
        case .risk: OSText.doubtRisk
        case .unverified: OSText.doubtUnverified
        }
    }
}
