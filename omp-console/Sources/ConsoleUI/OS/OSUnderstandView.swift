// L'« OS agentique » : COMPRENDRE, un zoom en quatre niveaux sur une feature, à la place
// des sept onglets de sa page, partagé par le Mac et l'iPhone/iPad :
//   Résumé  — ce qu'elle attend de vous (les cartes complètes), son verdict, ses specs ;
//   Récit   — la carte de session (ce que l'agent a lu, décidé, fait), sinon la frise ;
//   Preuves — captures et rapports, fichiers touchés, tests ;
//   Brut    — le direct de l'agent.
// Chaque niveau réutilise les vues existantes. Le direct d'une session (journal, fichiers
// touchés, tests, frise) diffère d'une plateforme à l'autre : l'app le fournit (`session`).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Ce que « Comprendre » demande au direct d'une feature.
public enum OSSessionPane: Hashable, Sendable {
    case live, files, tests, timeline
}

/// Le direct d'une feature, rendu par l'app : l'identifiant de la feature, le panneau,
/// « suivre la fin », et l'entrée à montrer (remise à `nil` une fois montrée).
public typealias OSSessionContent = @MainActor (_ runId: String, _ pane: OSSessionPane, _ followsEnd: Binding<Bool>, _ focus: Binding<Int?>) -> AnyView

public struct OSUnderstandView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workspace: OSWorkspace
    let runId: String
    let session: OSSessionContent

    @StateObject private var proofs: HarnessRunProofs
    @StateObject private var graph: HarnessRunGraph
    @State private var view: HarnessRunView?
    @State private var proofPane: OSProofPane = .captures
    @State private var followsEnd = true
    @State private var focus: Int?

    /// `session` : le direct de la feature tel que l'app le rend (voir `OSSessionContent`).
    public init(
        server: HarnessModel, drafts: HarnessDrafts, workspace: OSWorkspace, runId: String,
        session: @escaping OSSessionContent
    ) {
        self.server = server
        self.drafts = drafts
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
        // ⌘+ / ⌘− : plus près, plus loin.
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
            case .story: story(run)
            case .proofs: proofsLevel(run)
            case .raw: live(run, .live, focus: $focus)
            }
        } else {
            ContentUnavailableView(OSText.noRun, systemImage: "questionmark.circle")
        }
    }

    private func summary(_ run: HarnessRun) -> some View {
        // La carte en attente porte déjà le verdict et la demande : pas deux fois.
        let pending = RunPendingCard.isPending(run, in: server.inbox)
        return Form {
            if pending {
                Section {
                    RunPendingCard(server: server, drafts: drafts, run: run)
                }
            }
            if !pending, let verdict = run.verdict {
                Section(OSText.kindVerdict) {
                    Text(PipelineServerText.risk(verdict.risk)).font(.caption.weight(.semibold)).foregroundStyle(verdict.isLowRisk ? .green : .orange)
                    ConsoleMarkdown(markdown: verdict.summary).frame(maxWidth: .infinity, alignment: .leading)
                    ForEach(verdict.blockers + verdict.risks, id: \.self) { item in
                        Label(item, systemImage: "exclamationmark.triangle").font(.callout)
                    }
                }
            }
            if !pending, !run.request.isEmpty {
                Section {
                    DisclosureGroup(OSText.request) {
                        ConsoleMarkdown(markdown: run.request).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            if let specs = view?.specs, !specs.isEmpty {
                Section {
                    DisclosureGroup(OSText.specsFull) {
                        ConsoleMarkdown(markdown: specs).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private func story(_ run: HarnessRun) -> some View {
        if graph.showsTab {
            Form {
                RunGraphSections(
                    graph: graph, runState: run.state,
                    link: { node in
                        guard let read = graph.graph, let feed = server.session, feed.target == .run(run.id) else { return nil }
                        return HarnessGraphLink.entry(for: node, in: read, entries: feed.entries)
                    },
                    open: { seq in
                        followsEnd = false
                        focus = seq
                        workspace.level = .raw
                    }
                )
            }
            .formStyle(.grouped)
            .onAppear { server.followSession(.run(run.id)) }
        } else {
            live(run, .timeline)
        }
    }

    private func proofsLevel(_ run: HarnessRun) -> some View {
        VStack(spacing: 0) {
            Picker(OSLevel.proofs.title, selection: $proofPane) {
                ForEach(OSProofPane.allCases) { pane in Text(pane.title).tag(pane) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
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
}
