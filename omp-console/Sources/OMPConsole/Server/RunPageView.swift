// La PAGE d'une feature sur le Mac, à droite de la liste de Features — comme une
// session cmux : l'en-tête fixe (titre, état, dépôt, jalons), puis des onglets
// segmentés — Aperçu (ce qu'elle attend de vous, sa demande, ses specs, son verdict),
// Preuves (captures, avant/après, rapports de tests, journaux de la revue ; absent
// d'un serveur qui ne les sert pas), Direct, Fichiers, Tests et Frise (le contenu de
// session partagé avec la feuille des audits) — et la consigne à l'agent en pied de
// page tant qu'elle en accepte une. Ses gestes tiennent dans UN menu de la barre
// d'outils (`RunActionsMenu`).
//
// Le direct suit la feature dès qu'un onglet de session s'ouvre, et s'arrête quand la
// page disparaît.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

/// Les onglets de la page.
enum RunPageTab: Hashable, CaseIterable {
    case overview, proofs, live, files, tests, timeline

    var title: String {
        switch self {
        case .overview: ShellText.tabOverview
        case .proofs: ProofsText.tab
        case .live: MonitoringText.tabLive
        case .files: MonitoringText.tabFiles
        case .tests: MonitoringText.tabTests
        case .timeline: MonitoringText.tabTimeline
        }
    }

    /// Le contenu de session de l'onglet ; aucun pour l'Aperçu et les Preuves.
    var pane: HarnessSessionPane? {
        switch self {
        case .overview, .proofs: nil
        case .live: .live
        case .files: .files
        case .tests: .tests
        case .timeline: .timeline
        }
    }

    /// Les onglets montrés : les Preuves seulement quand le serveur les sert.
    static func shown(proofs: Bool) -> [RunPageTab] {
        allCases.filter { $0 != .proofs || proofs }
    }

    /// L'onglet d'ouverture (`HarnessRunOpening`) : les Preuves quand la feature attend
    /// la validation de sa revue, l'Aperçu quand elle vous attend autrement, le Direct
    /// quand elle tourne, l'Aperçu sinon.
    @MainActor
    static func initial(for run: HarnessRun, inbox: HarnessInbox?, proofs: Bool) -> RunPageTab {
        let opening = HarnessRunOpening.of(
            run, pending: RunPendingCard.isPending(run, in: inbox), running: HarnessRunGroup.of(run) == .running, proofsShown: proofs
        )
        switch opening {
        case .proofs: return .proofs
        case .overview: return .overview
        case .live: return .live
        }
    }
}

struct RunPageView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let runId: String
    /// L'onglet choisi ; `nil` tant que l'humain n'en a pas choisi (celui d'ouverture).
    @State private var chosen: RunPageTab?
    @State private var followsEnd = true
    /// La vue du serveur : ses specs, et la feature si ni la boîte ni l'historique ne la connaissent.
    @State private var view: HarnessRunView?
    @State private var isLoaded = false
    /// Les preuves de la feature (page recréée à chaque feature : `.id(runId)`).
    @StateObject private var proofs: HarnessRunProofs

    init(server: HarnessModel, drafts: HarnessDrafts, runId: String) {
        self.server = server
        self.drafts = drafts
        self.runId = runId
        _proofs = StateObject(wrappedValue: HarnessRunProofs(harness: server, runId: runId))
    }

    var body: some View {
        Group {
            if let run = server.knownRun(runId) ?? view?.run {
                page(run)
            } else if isLoaded {
                ContentUnavailableView(ShellText.unknownRun, systemImage: ConsoleSection.runs.systemImage)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: runId + "|" + (server.knownRun(runId)?.state ?? "")) {
            view = await server.runView(runId)
            isLoaded = true
            await proofs.load()
        }
        .onDisappear {
            if server.session?.target == .run(runId) { server.stopSession() }
        }
        .accessibilityIdentifier("run.page")
    }

    private func page(_ run: HarnessRun) -> some View {
        let tabs = RunPageTab.shown(proofs: proofs.showsTab)
        let preferred = chosen ?? RunPageTab.initial(for: run, inbox: server.inbox, proofs: proofs.showsTab)
        let tab = tabs.contains(preferred) ? preferred : .overview
        return VStack(spacing: 0) {
            RunDetailHeader(server: server, run: run)
                .padding(.horizontal, 20)
                .padding(.top, 16)
                .padding(.bottom, 12)
            HStack {
                Picker(ShellText.scope, selection: Binding(get: { tab }, set: { chosen = $0 })) {
                    ForEach(tabs, id: \.self) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("run.tabs")
                Spacer()
                if tab == .live || tab == .tests {
                    HarnessFollowEndToggle(followsEnd: $followsEnd)
                        .toggleStyle(.button)
                        .labelStyle(.iconOnly)
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 10)
            Divider()
            if let pane = tab.pane {
                HarnessSessionContent(server: server, target: .run(run.id), pane: pane, followsEnd: $followsEnd)
                    .onAppear { server.followSession(.run(run.id)) }
            } else if tab == .proofs {
                Form {
                    RunProofsSections(proofs: proofs)
                }
                .formStyle(.grouped)
                .accessibilityIdentifier("run.proofs")
            } else {
                overview(run)
            }
            if run.acceptsInstructions {
                Divider()
                RunInstructionsComposer(server: server, drafts: drafts, runId: run.id)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                RunActionsMenu(server: server, drafts: drafts, run: run)
            }
        }
    }

    /// L'Aperçu : ce qu'elle attend de vous, sa demande, puis ce que l'agent a écrit
    /// (specs et verdict) quand ce n'est pas déjà dans la carte d'attente.
    private func overview(_ run: HarnessRun) -> some View {
        let pending = RunPendingCard.isPending(run, in: server.inbox)
        let awaiting = server.inbox?.awaiting.contains { $0.id == run.id } == true
        return Form {
            if pending {
                Section {
                    RunPendingCard(server: server, drafts: drafts, run: run)
                } header: {
                    Text(ShellText.waitsForYou)
                }
            }
            if !run.request.isEmpty {
                Section {
                    RunRequestDisclosure(run: run)
                }
            }
            if !awaiting, let specs = view?.specs, !specs.isEmpty {
                Section {
                    ConsoleMarkdown(markdown: specs)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } header: {
                    Text(ShellText.specs)
                }
            }
            if !awaiting, let verdict = run.verdict {
                Section {
                    Text(PipelineServerText.risk(verdict.risk))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(verdict.isLowRisk ? Color.green : Color.orange)
                    ConsoleMarkdown(markdown: verdict.summary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    list(PipelineServerText.blockers, verdict.blockers)
                    list(PipelineServerText.risks, verdict.risks)
                    list(PipelineServerText.unverified, verdict.unverified)
                } header: {
                    Text(ShellText.verdict)
                }
            }
        }
        .formStyle(.grouped)
    }

    @ViewBuilder
    private func list(_ title: String, _ items: [String]) -> some View {
        if !items.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption.weight(.semibold))
                ForEach(items, id: \.self) { item in
                    Text(MarkdownDocument.inline(PipelineServerText.bullet(item)))
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}
