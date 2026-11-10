// L'« OS agentique » : le TRI de ce qui est « À vous », partagé par le Mac et
// l'iPhone/iPad. Les décisions en grand, une étape à la fois, espace après espace : une
// décision seule (⏎ prend le geste principal), ou un LOT de décisions de même sorte ET de
// même espace qui se tranchent d'un geste — commentaires Jira, envois du poste, revues à
// risque faible sans réserve : une ligne par élément, cases cochées, « Tout envoyer (n) »
// ou « Tout valider (n) ». L'en-tête dit la position (« 1 sur 3 ») ; quand les décisions
// sont de plusieurs espaces, l'espace de l'étape est annoncé (« ● Client Acme — 2 ») ;
// avec un espace choisi, le tri ne montre que les siennes. → remet l'étape à plus tard.
// La coque le présente (en feuille sur le Mac) et lui donne sa taille.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSTriageView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var spaces: HarnessSpacesModel
    /// Le tri est la page d'un onglet (iPhone, iPad) : la barre porte son titre, et rien ne
    /// le referme.
    let embedded: Bool
    @Environment(\.dismiss) private var dismiss
    /// Les décisions remises à plus tard : elles ne reviennent pas dans ce tri.
    @State private var skipped: Set<String> = []
    /// Toutes les décisions vues depuis l'ouverture du tri : le total de la position.
    @State private var known: Set<String> = []
    @State private var checks = OSLotChecks()

    /// `embedded` : la coque le montre en page et non en feuille — ni titre, ni « Fermer ».
    public init(
        server: HarnessModel, workstation: WorkstationModel, intakes: HarnessIntakes, workspace: OSWorkspace, embedded: Bool = false
    ) {
        self.server = server
        self.workstation = workstation
        self.intakes = intakes
        self.workspace = workspace
        spaces = server.spaces
        self.embedded = embedded
    }

    public var body: some View {
        let decisions = OSDecisions.scoped(OSDecisions.all(server: server), spaceId: workspace.spaceId, spaces: spaces.spaces)
        let ids = decisions.map(\.id)
        let steps = OSTriage.steps(decisions, skipped: skipped, spaces: spaces.spaces)
        VStack(alignment: .leading, spacing: 16) {
            if !embedded {
                HStack(alignment: .firstTextBaseline) {
                    Text(OSText.yours).font(.title2.weight(.bold))
                    Spacer()
                    position(steps, total: max(known.count, ids.count))
                }
            } else {
                position(steps, total: max(known.count, ids.count))
            }
            if let current = steps.first {
                if embedded {
                    // En page : la carte et ses gestes défilent ensemble, à toute taille de texte.
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            spaceHeader(current, in: steps)
                            card(current)
                            OSLine { footer(current) }
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    spaceHeader(current, in: steps)
                    ScrollView {
                        card(current)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }
            } else {
                ContentUnavailableView(OSText.nothing, systemImage: "checkmark.circle")
                    .frame(maxWidth: .infinity, maxHeight: embedded ? .infinity : nil)
            }
            if !embedded {
                HStack(spacing: 8) {
                    if let current = steps.first { footer(current) }
                    Spacer()
                    Button(PipelineServerText.close) { dismiss() }.keyboardShortcut(.cancelAction)
                }
            }
        }
        .padding(embedded ? 16 : 24)
        .task {
            await server.osReadFeatures()
            if spaces.availability == .unknown { await spaces.refresh() }
        }
        .onChange(of: ids, initial: true) { known.formUnion(ids) }
    }

    /// « 1 sur 3 » : où l'on en est ; rien quand plus rien n'attend.
    @ViewBuilder
    private func position(_ steps: [OSTriageStep], total: Int) -> some View {
        if let current = steps.first {
            let range = OSTriage.position(total: total, remaining: OSTriage.count(steps), size: current.decisions.count)
            Text(OSDecideText.position(first: range.lowerBound, last: range.upperBound, total: total))
                .foregroundStyle(.secondary)
                .monospacedDigit()
        }
    }

    /// « ● Client Acme — 2 » : l'espace de l'étape, quand le tri en traverse plusieurs.
    @ViewBuilder
    private func spaceHeader(_ current: OSTriageStep, in steps: [OSTriageStep]) -> some View {
        if let found = OSTriage.group(of: current, in: steps, spaces: spaces.spaces) {
            HStack(spacing: 6) {
                if let space = found.space { OSSpaceMark(space: space, size: 11) }
                Text(OSDecideText.spaceGroup(found.space?.name ?? OSDecideText.noSpace, count: found.count))
                    .font(.headline)
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// L'étape montrée : une décision en grand, ou un lot.
    @ViewBuilder
    private func card(_ current: OSTriageStep) -> some View {
        switch current {
        case let .one(decision):
            OSDecisionCard(server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: decision, large: true)
                .id(current.id)
        case let .lot(lot):
            OSTriageLotCard(server: server, workstation: workstation, workspace: workspace, lot: lot, checks: $checks)
                .id(current.id)
        }
    }

    /// « Plus tard → » : l'étape est remise, la suivante arrive.
    private func footer(_ current: OSTriageStep) -> some View {
        Button {
            skipped.formUnion(current.decisions.map(\.id))
        } label: {
            HStack(spacing: 6) {
                Text(OSDecideText.later)
                OSKeyHint(key: "→")
            }
        }
        .keyboardShortcut(.rightArrow, modifiers: [])
    }
}

/// Un lot du tri : pour qui, une ligne par décision, sa case cochée d'emblée, et le geste
/// qui tranche toutes les cochées.
struct OSTriageLotCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var spaces: HarnessSpacesModel
    let lot: OSDecisionLot
    @Binding var checks: OSLotChecks
    @State private var working = false
    @State private var failure: HarnessFailure?

    init(server: HarnessModel, workstation: WorkstationModel, workspace: OSWorkspace, lot: OSDecisionLot, checks: Binding<OSLotChecks>) {
        self.server = server
        self.workstation = workstation
        self.workspace = workspace
        spaces = server.spaces
        self.lot = lot
        _checks = checks
    }

    var body: some View {
        let ticked = checks.checked(in: lot)
        OSCard(tint: .orange, emphasized: true) {
            VStack(alignment: .leading, spacing: 12) {
                OSSpaceLine(
                    space: spaces.spaces.first { $0.id == lot.spaceId },
                    items: [OSSpaceLine.Item(title, strong: true, tint: .orange, symbol: symbol)]
                )
                ForEach(lot.items) { item in
                    row(item)
                }
                if let failure {
                    ConsoleFailureBanner(failure: failure)
                }
                OSLine {
                    Button {
                        settle(ticked)
                    } label: {
                        HStack(spacing: 6) {
                            Label(primary(ticked.count), systemImage: lot.kind == .verdict ? "checkmark" : "paperplane")
                            OSKeyHint(key: "⏎")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(ticked.isEmpty || !server.canAct)
                    Spacer()
                }
            }
            .disabled(working)
        }
    }

    private var title: String {
        switch lot.kind {
        case .jira: OSDecideText.jiraLot(lot.items.count)
        case .approval: OSDecideText.sendLot(lot.items.count)
        default: OSDecideText.reviewLot(lot.items.count)
        }
    }

    private var symbol: String {
        switch lot.kind {
        case .jira: "text.bubble.fill"
        case .approval: "paperplane.fill"
        default: "checkmark.seal.fill"
        }
    }

    private func primary(_ count: Int) -> String {
        lot.kind == .verdict ? OSDecideText.validateAll(count) : OSDecideText.sendAll(count)
    }

    private func row(_ item: ConsoleClient.OSDecision) -> some View {
        let line = Self.line(item)
        return HStack(alignment: .top, spacing: 8) {
            Button {
                checks.toggle(item)
            } label: {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: checks.isChecked(item) ? "checkmark.square.fill" : "square")
                        .foregroundStyle(checks.isChecked(item) ? Color.accentColor : .secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.title).fontWeight(.medium).lineLimit(1)
                        if !line.detail.isEmpty {
                            Text(line.detail).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                }
                .frame(maxWidth: .infinity, minHeight: ConsolePlatform.minimumTarget, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(checks.isChecked(item) ? .isSelected : [])
            if let runId = item.runId {
                Button {
                    workspace.triage = false
                    workspace.understand(runId: runId, level: .summary)
                } label: {
                    Label(OSText.understand, systemImage: "text.magnifyingglass").labelStyle(.iconOnly)
                }
                .osBorderless()
            }
        }
    }

    /// Ce qu'une ligne dit de sa décision : de quoi la reconnaître (son dépôt compris), puis
    /// l'essentiel — le message à envoyer, ou pourquoi la revue vous revient.
    private static func line(_ item: ConsoleClient.OSDecision) -> (title: String, detail: String) {
        switch item {
        case let .jira(write):
            (write.issueKey + " · " + OSThreads.firstLine(write.why), OSThreads.firstLine(write.body))
        case let .approval(action):
            (action.approval?.summary ?? action.kind, OSText.to(action.approval?.recipients ?? []))
        case let .verdict(run):
            (run.repo + " · " + OSThreads.clean(run.title).title, OSGateReason.of(run).first?.text ?? "")
        default:
            ("", "")
        }
    }

    /// Tranche les décisions cochées, l'une après l'autre ; le premier refus est montré, les
    /// autres partent quand même.
    private func settle(_ items: [ConsoleClient.OSDecision]) {
        working = true
        failure = nil
        Task {
            var refusal: HarnessFailure?
            for item in items {
                if await !send(item), refusal == nil { refusal = server.failure ?? workstation.failure }
            }
            failure = refusal
            working = false
        }
    }

    private func send(_ item: ConsoleClient.OSDecision) async -> Bool {
        switch item {
        case let .jira(write): await server.atlassian.approve(write.id)
        case let .approval(action): await workstation.approve(shown: action)
        case let .verdict(run): await server.validate(runId: run.id, approve: true, reason: "")
        default: false
        }
    }
}
