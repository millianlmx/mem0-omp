// L'« OS agentique » : le TRI, partagé par le Mac et l'iPhone/iPad. Les décisions en grand,
// une étape à la fois : une décision seule (⏎ prend le geste principal), ou un LOT de
// décisions de même sorte qui se tranchent d'un geste — commentaires Jira, envois du poste,
// revues à risque faible sans réserve : une ligne par élément, cases cochées, « Tout
// envoyer (n) » ou « Tout valider (n) ». → passe l'étape, ↑ ouvre « Comprendre » sur la
// feature. La coque le présente (en feuille sur le Mac) et lui donne sa taille.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSTriageView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var workspace: OSWorkspace
    /// Le tri est la page d'un onglet (iPhone, iPad) : la barre porte son titre, et rien ne
    /// le referme.
    let embedded: Bool
    @Environment(\.dismiss) private var dismiss
    @State private var skipped: Set<String> = []
    @State private var checks = OSLotChecks()

    /// `embedded` : la coque le montre en page et non en feuille — ni titre, ni « OK ».
    public init(
        server: HarnessModel, workstation: WorkstationModel, intakes: HarnessIntakes, workspace: OSWorkspace, embedded: Bool = false
    ) {
        self.server = server
        self.workstation = workstation
        self.intakes = intakes
        self.workspace = workspace
        self.embedded = embedded
    }

    public var body: some View {
        let steps = OSTriage.steps(OSDecisions.all(server: server), skipped: skipped)
        VStack(alignment: .leading, spacing: 16) {
            if !embedded {
                HStack {
                    Text(OSText.triage).font(.title2.weight(.bold))
                    Spacer()
                    if !steps.isEmpty {
                        Text(OSText.decisions(OSTriage.count(steps))).foregroundStyle(.secondary).monospacedDigit()
                    }
                }
            } else if !steps.isEmpty {
                Text(OSText.decisions(OSTriage.count(steps))).foregroundStyle(.secondary).monospacedDigit()
            }
            if let current = steps.first {
                if embedded {
                    // En page : la carte et ses gestes défilent ensemble, à toute taille de texte.
                    ScrollView {
                        VStack(alignment: .leading, spacing: 16) {
                            card(current)
                            OSLine { footer(current) }
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    ScrollView {
                        card(current)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    HStack { footer(current) }
                        .foregroundStyle(.secondary)
                }
            } else {
                ContentUnavailableView(OSText.nothing, systemImage: "checkmark.circle")
                    .frame(maxWidth: .infinity, maxHeight: embedded ? .infinity : nil)
            }
            if !embedded {
                HStack {
                    Spacer()
                    Button(OSText.done) { dismiss() }.keyboardShortcut(.cancelAction)
                }
            }
        }
        .padding(embedded ? 16 : 24)
        .task { await server.osReadFeatures() }
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
        }
    }

    /// « Passer → » et, pour une décision seule, « Comprendre ↑ ».
    @ViewBuilder
    private func footer(_ current: OSTriageStep) -> some View {
        Button(OSText.skip + " →") { skipped.formUnion(current.decisions.map(\.id)) }
            .keyboardShortcut(.rightArrow, modifiers: [])
        Spacer()
        if case let .one(decision) = current, let runId = decision.runId {
            Button(OSText.understand + " ↑") {
                dismiss()
                workspace.understand(runId: runId, level: .summary)
            }
            .keyboardShortcut(.upArrow, modifiers: [])
        }
    }
}

/// Un lot du tri : une ligne par décision, sa case cochée d'emblée, et le geste qui tranche
/// toutes les cochées.
struct OSTriageLotCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var workspace: OSWorkspace
    let lot: OSDecisionLot
    @Binding var checks: OSLotChecks
    @State private var working = false
    @State private var failure: HarnessFailure?

    var body: some View {
        let checked = checks.checked(in: lot)
        OSCard(tint: .orange, emphasized: true) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 6) {
                    Image(systemName: symbol)
                    Text(title.uppercased())
                }
                .font(.caption2.weight(.bold))
                .foregroundStyle(.orange)
                ForEach(lot.items) { item in
                    row(item)
                }
                if let failure {
                    ConsoleFailureBanner(failure: failure)
                }
                OSLine {
                    Button {
                        settle(checked)
                    } label: {
                        Label(primary(checked.count), systemImage: lot.kind == .verdict ? "checkmark" : "paperplane")
                    }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(checked.isEmpty || !server.canAct)
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
                    workspace.understand(runId: runId, level: .summary)
                } label: {
                    Label(OSText.read, systemImage: "text.magnifyingglass").labelStyle(.iconOnly)
                }
                .osBorderless()
            }
        }
    }

    /// Ce qu'une ligne dit de sa décision : de quoi la reconnaître, puis l'essentiel de son contenu.
    private static func line(_ item: ConsoleClient.OSDecision) -> (title: String, detail: String) {
        switch item {
        case let .jira(write):
            (write.issueKey + " · " + OSThreads.firstLine(write.why), OSThreads.firstLine(write.body))
        case let .approval(action):
            (action.approval?.summary ?? action.kind, OSText.to(action.approval?.recipients ?? []))
        case let .verdict(run):
            (OSThreads.clean(run.title).title + " · " + run.repo, run.verdict.map { OSThreads.firstLine($0.summary) } ?? "")
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
