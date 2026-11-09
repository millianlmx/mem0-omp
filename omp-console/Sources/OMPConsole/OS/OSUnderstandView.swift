// PROTOTYPE « OS agentique » (branche proto/os-fils) : COMPRENDRE, un zoom en quatre
// niveaux sur une feature, à la place des sept onglets de sa page :
//   Résumé  — ce qu'elle attend de vous (les cartes complètes), son verdict, ses specs ;
//   Récit   — la carte de session (ce que l'agent a lu, décidé, fait), sinon la frise ;
//   Preuves — captures et rapports, fichiers touchés, tests ;
//   Brut    — le direct de l'agent.
// Chaque niveau réutilise les vues existantes de l'app.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSUnderstandView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workspace: OSWorkspace
    let runId: String

    @StateObject private var proofs: HarnessRunProofs
    @StateObject private var graph: HarnessRunGraph
    @State private var view: HarnessRunView?
    @State private var proofPane: OSText.ProofPane = .captures
    @State private var followsEnd = true
    @State private var focus: Int?

    init(server: HarnessModel, drafts: HarnessDrafts, workspace: OSWorkspace, runId: String) {
        self.server = server
        self.drafts = drafts
        self.workspace = workspace
        self.runId = runId
        _proofs = StateObject(wrappedValue: HarnessRunProofs(harness: server, runId: runId))
        _graph = StateObject(wrappedValue: HarnessRunGraph(harness: server, runId: runId))
    }

    private var run: HarnessRun? { server.knownRun(runId) ?? view?.run }

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                if let run {
                    Text(OSThreads.clean(run.title).title)
                        .font(.headline)
                        .lineLimit(2)
                    HStack {
                        OSStepDots(run: run)
                        Text(OSText.runState(run)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                Picker(OSText.understand, selection: $workspace.level) {
                    ForEach(OSText.Level.allCases) { level in
                        Text(level.rawValue).tag(level)
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
        let all = OSText.Level.allCases
        guard let index = all.firstIndex(of: workspace.level) else { return }
        workspace.level = all[max(0, min(all.count - 1, index + step))]
    }

    @ViewBuilder
    private var level: some View {
        if let run {
            switch workspace.level {
            case .summary: summary(run)
            case .story: story(run)
            case .proofs: proofsLevel(run)
            case .raw:
                HarnessSessionContent(server: server, target: .run(run.id), pane: .live, followsEnd: $followsEnd, focus: $focus)
                    .onAppear { server.followSession(.run(run.id)) }
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
                Section(OSText.verdict) {
                    Text(OSText.risk(verdict)).font(.caption.weight(.semibold)).foregroundStyle(verdict.isLowRisk ? .green : .orange)
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
            HarnessSessionContent(server: server, target: .run(run.id), pane: .timeline, followsEnd: $followsEnd)
                .onAppear { server.followSession(.run(run.id)) }
        }
    }

    private func proofsLevel(_ run: HarnessRun) -> some View {
        VStack(spacing: 0) {
            Picker(OSText.Level.proofs.rawValue, selection: $proofPane) {
                ForEach(OSText.ProofPane.allCases) { pane in Text(pane.rawValue).tag(pane) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            switch proofPane {
            case .captures:
                Form { RunProofsSections(proofs: proofs) }.formStyle(.grouped)
            case .files:
                HarnessSessionContent(server: server, target: .run(run.id), pane: .files, followsEnd: $followsEnd)
                    .onAppear { server.followSession(.run(run.id)) }
            case .tests:
                HarnessSessionContent(server: server, target: .run(run.id), pane: .tests, followsEnd: $followsEnd)
                    .onAppear { server.followSession(.run(run.id)) }
            }
        }
    }
}
