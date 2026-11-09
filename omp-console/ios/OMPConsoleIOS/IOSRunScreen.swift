import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// La PAGE d'une feature sur iPhone et iPad, poussée dans la pile de la section
// Features (`drafts.openedRun`) : son en-tête (titre, état, dépôt, jalons), puis des
// onglets segmentés — Aperçu (ce qu'elle attend de vous, sa demande, ses specs et sa
// revue), Preuves (captures, avant/après, rapports de tests et journaux de la revue,
// `RunProofsSections` ; absent d'un serveur qui ne les sert pas), Carte (le graphe de
// session en direct, `RunGraphSections` ; un nœud ouvre son entrée du Direct ; absente
// d'un serveur sans graphe), Direct, Fichiers,
// Tests et Frise (le contenu partagé du direct, `IOSSessionSections`). La consigne à
// l'agent se tape en pied de page tant que la feature l'accepte ; tous ses gestes
// tiennent dans un seul menu de barre (`RunActionsMenu`, avec la Live Activity de
// l'iPhone par `ConsoleShell.runActions`).
//
// Le direct suit la feature tant qu'un de ses onglets est montré et s'arrête quand la
// page disparaît. Les mots viennent du noyau (`ShellText`, `MonitoringText`) : aucun
// libellé en dur ici (`design-ios/AC-5`).

/// Les onglets de la page d'une feature.
enum IOSRunTab: Hashable, CaseIterable {
    case overview, proofs, map, live, changes, tests, timeline

    var title: String {
        switch self {
        case .overview: ShellText.tabOverview
        case .proofs: ProofsText.tab
        case .map: SessionGraphText.tab
        case .live: MonitoringText.tabLive
        case .changes: MonitoringText.tabFiles
        case .tests: MonitoringText.tabTests
        case .timeline: MonitoringText.tabTimeline
        }
    }

    /// Le contenu du direct montré par l'onglet ; `nil` pour l'Aperçu, les Preuves et la Carte.
    var session: IOSSessionTab? {
        switch self {
        case .overview, .proofs, .map: nil
        case .live: .live
        case .changes: .changes
        case .tests: .tests
        case .timeline: .timeline
        }
    }

    /// Les onglets montrés : les Preuves seulement quand le serveur les sert, la Carte
    /// seulement quand il sert le graphe de session (capacité `session-graph`).
    static func shown(proofs: Bool, map: Bool = false) -> [IOSRunTab] {
        allCases.filter { $0 != .proofs || proofs }.filter { $0 != .map || map }
    }

    /// L'onglet ouvert d'abord (`HarnessRunOpening`) : les Preuves quand la feature
    /// attend la validation de sa revue, l'Aperçu quand elle attend l'humain autrement,
    /// le Direct quand elle tourne, l'Aperçu sinon.
    static func initial(_ opening: HarnessRunOpening) -> IOSRunTab {
        switch opening {
        case .proofs: .proofs
        case .overview: .overview
        case .live: .live
        }
    }
}

struct IOSRunScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let runId: String
    @State private var chosen: IOSRunTab?
    @State private var followsEnd = true
    /// La vue complète lue au serveur : la feature quand ni la boîte ni l'historique ne
    /// la connaissent (une notification, une feature ancienne), et ses specs.
    @State private var detail: HarnessRunView?
    @State private var looked = false
    /// Les preuves de la feature (écran recréé à chaque feature : `.id(runId)`).
    @StateObject private var proofs: HarnessRunProofs
    /// Le graphe de session de la feature, relu sur l'événement `graph`.
    @StateObject private var graph: HarnessRunGraph
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(server: HarnessModel, drafts: HarnessDrafts, runId: String) {
        self.server = server
        self.drafts = drafts
        self.runId = runId
        _proofs = StateObject(wrappedValue: HarnessRunProofs(harness: server, runId: runId))
        _graph = StateObject(wrappedValue: HarnessRunGraph(harness: server, runId: runId))
    }

    var body: some View {
        Group {
            if let run {
                page(run)
            } else if looked {
                ContentUnavailableView {
                    Label(ShellText.unknownRun, systemImage: ConsoleSection.runs.systemImage)
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .task(id: runId) {
            detail = await server.runDetail(runId: runId)
            looked = true
            await proofs.load()
            await graph.load()
            await server.signals.loadOrigin(runId: runId)
        }
        .onChange(of: server.graphVersions[runId]) { _, version in
            Task { await graph.receive(version: version) }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.screen.run")
    }

    private var run: HarnessRun? {
        server.knownRun(runId) ?? detail?.run
    }

    private var target: HarnessSessionTarget { .run(runId) }

    private func shown(_ run: HarnessRun) -> IOSRunTab {
        let preferred = chosen ?? IOSRunTab.initial(HarnessRunOpening.of(
            run, pending: RunPendingCard.isPending(run, in: server.inbox), running: HarnessRunGroup.of(run) == .running, proofsShown: proofs.showsTab
        ))
        return IOSRunTab.shown(proofs: proofs.showsTab, map: graph.showsTab).contains(preferred) ? preferred : .overview
    }

    private func page(_ run: HarnessRun) -> some View {
        let tab = shown(run)
        return ScrollViewReader { proxy in
            List {
                Section {
                    RunDetailHeader(server: server, run: run)
                }
                Picker(PipelineServerText.sessionTitle, selection: Binding(get: { tab }, set: { chosen = $0 })) {
                    ForEach(IOSRunTab.shown(proofs: proofs.showsTab, map: graph.showsTab), id: \.self) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .iosBareListRow()
                .accessibilityIdentifier("ios.run.tabs")
                if let session = tab.session {
                    IOSSessionSections(server: server, target: target, tab: session, followsEnd: $followsEnd)
                } else if tab == .proofs {
                    RunProofsSections(proofs: proofs)
                } else if tab == .map {
                    RunGraphSections(
                        graph: graph, runState: run.state,
                        link: { node in
                            guard let read = graph.graph, let feed = server.session, feed.target == target else { return nil }
                            return HarnessGraphLink.entry(for: node, in: read, entries: feed.entries)
                        },
                        open: { seq in
                            // L'entrée du direct d'un nœud : l'onglet Direct, défilé jusqu'à elle.
                            followsEnd = false
                            chosen = .live
                            Task { @MainActor in
                                try? await Task.sleep(for: .milliseconds(150))
                                withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
                                    proxy.scrollTo(seq, anchor: .center)
                                }
                            }
                        }
                    )
                } else {
                    overview(run)
                }
            }
            .iosGroupedList()
            .listSectionSpacing(.compact)
            .iosFollowsSessionEnd(server: server, target: target, shown: tab == .live, followsEnd: followsEnd, proxy: proxy)
        }
        // Le texte de l'agent, ses commandes, leurs résultats et les specs se copient.
        .textSelection(.enabled)
        .safeAreaInset(edge: .bottom) {
            if run.acceptsInstructions {
                RunInstructionsComposer(server: server, drafts: drafts, runId: runId)
                    .padding(.horizontal)
                    .padding(.vertical, 10)
                    .background(.bar)
            }
        }
        .navigationTitle(run.title)
        .toolbar(removing: .title)
        .toolbar {
            if tab == .live {
                ToolbarItem(placement: .topBarTrailing) {
                    IOSFollowEndToggle(followsEnd: $followsEnd)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                RunActionsMenu(server: server, drafts: drafts, run: run)
            }
        }
        .onAppear {
            // L'onglet d'ouverture se fige une fois les preuves tranchées (servies ou non).
            if chosen == nil, proofs.isResolved { chosen = tab }
            follow(tab)
        }
        .onChange(of: proofs.isResolved) { _, resolved in
            if resolved, chosen == nil { chosen = shown(run) }
        }
        .onChange(of: tab) { _, tab in follow(tab) }
        .onDisappear { server.stopSession() }
    }

    /// Un onglet du direct montré : le modèle suit la feature (sans effet s'il la suit déjà).
    private func follow(_ tab: IOSRunTab) {
        guard tab.session != nil || tab == .map else { return }
        server.followSession(target)
    }

    @ViewBuilder
    private func overview(_ run: HarnessRun) -> some View {
        let pending = RunPendingCard.isPending(run, in: server.inbox)
        if pending {
            Section {
                RunPendingCard(server: server, drafts: drafts, run: run)
            } header: {
                Text(ShellText.waitsForYou)
            }
        }
        // La demande d'origine et les specs validées se relisent, repliées ; à valider,
        // les specs sont dans la carte du dessus.
        let specs = pending ? nil : detail?.specs.flatMap { $0.isEmpty ? nil : $0 }
        if !run.request.isEmpty || specs != nil {
            Section {
                RunRequestDisclosure(run: run)
                if let specs {
                    DisclosureGroup(ShellText.specs) {
                        ConsoleMarkdown(markdown: specs)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.top, 4)
                    }
                    .accessibilityIdentifier("ios.run.specs")
                }
            }
        }
        RunOriginSection(signals: server.signals, runId: run.id)
        if !pending, let verdict = run.verdict {
            Section {
                Text(PipelineServerText.risk(verdict.risk))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(verdict.isLowRisk ? Color.green : Color.orange)
                ConsoleMarkdown(markdown: verdict.summary)
                ForEach(verdict.blockers, id: \.self) { blocker in
                    Label(blocker, systemImage: DashboardText.alertsSymbol)
                        .font(.callout)
                        .foregroundStyle(.orange)
                }
            } header: {
                Text(ShellText.stepReview)
            }
        }
    }
}
