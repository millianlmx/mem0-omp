// L'« OS agentique » : les PROPOSITIONS, partagées par le Mac et l'iPhone/iPad — le
// travail que les agents ont trouvé seuls et qu'un geste lance ou écarte. Elles sont
// groupées par source (issues, vigie, audits, Jira, signalements, paliers, relances, PR
// dormantes, intégration continue en échec) ; une ligne dit le titre, le lieu et une
// phrase. Le geste qui accepte porte le nom de ce qu'il fait ; quand il crée une feature,
// son fil s'ouvre. Un serveur sans propositions ne montre rien.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les propositions d'une même source, dans l'ordre du serveur (les plus récentes d'abord).
public struct OSProposalGroup: Identifiable, Equatable, Sendable {
    /// Le code de la source ; vide pour les sources que cette version de l'app ne connaît pas.
    public var source: String
    public var items: [HarnessProposal]

    public var id: String { source }

    public init(source: String, items: [HarnessProposal]) {
        self.source = source
        self.items = items
    }
}

public enum OSProposalGroups {
    /// L'ordre de lecture : ce qui vient du dehors (issues, incidents), ce que l'OS a vu
    /// lui-même, puis ce qui traîne (relances, PR dormantes, branche principale en échec).
    public static let order: [HarnessProposalSource] = [.issue, .vigie, .audit, .jira, .signal, .autonomy, .retry, .pr, .ci]

    /// Les propositions groupées par source, dans `order` ; les sources inconnues sont
    /// réunies en un dernier groupe. Aucun groupe vide.
    public static func build(_ proposals: [HarnessProposal]) -> [OSProposalGroup] {
        var groups = order.compactMap { source -> OSProposalGroup? in
            let items = proposals.filter { $0.origin == source }
            return items.isEmpty ? nil : OSProposalGroup(source: source.rawValue, items: items)
        }
        let unknown = proposals.filter { $0.origin == nil }
        if !unknown.isEmpty { groups.append(OSProposalGroup(source: "", items: unknown)) }
        return groups
    }

    /// Ce jeton peut accepter la proposition : un opérateur partout ; appliquer un palier
    /// est réservé à l'administrateur ; confirmer un signalement et lancer un item du plan
    /// Jira, à l'approbateur.
    public static func canAccept(_ proposal: HarnessProposal, canAct: Bool, isAdmin: Bool, approver: Bool) -> Bool {
        guard canAct else { return false }
        switch proposal.origin {
        case .autonomy: return isAdmin
        case .signal, .jira: return approver
        default: return proposal.gesture == .apply ? isAdmin : true
        }
    }
}

public struct OSProposalsView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var proposals: HarnessProposalsModel
    let threads: [OSThread]

    /// `threads` : les fils connus, pour ouvrir celui de la feature qu'une proposition crée.
    public init(server: HarnessModel, workspace: OSWorkspace, threads: [OSThread]) {
        self.server = server
        self.workspace = workspace
        _proposals = ObservedObject(wrappedValue: server.proposals)
        self.threads = threads
    }

    public var body: some View {
        let groups = OSProposalGroups.build(proposals.proposals)
        Form {
            if let failure = proposals.failure {
                ConsoleFailureBanner(failure: failure)
            }
            if groups.isEmpty, proposals.availability == .available {
                Text(OSWatchText.noProposal).foregroundStyle(.secondary)
            }
            ForEach(groups) { group in
                Section(OSWatchText.proposalSource(group.source) + " · \(group.items.count)") {
                    ForEach(group.items) { proposal in
                        row(proposal)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(OSWatchText.proposals)
        .task(id: server.address) { await proposals.refresh() }
    }

    private func row(_ proposal: HarnessProposal) -> some View {
        let busy = proposals.busy.contains(proposal.id)
        // Le Mac pose les gestes au bout de la ligne ; l'iPhone et l'iPad les posent sous le
        // texte, à la taille du doigt.
        #if os(macOS)
        return HStack(alignment: .top, spacing: 10) {
            Image(systemName: Self.symbol(proposal.origin))
                .foregroundStyle(Color.accentColor)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(proposal.title)
                    .fontWeight(.semibold)
                    .lineLimit(2)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if let repo = proposal.repo {
                        OSTag(text: repo, symbol: "shippingbox")
                    }
                    if !proposal.detail.isEmpty {
                        Text(proposal.detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
            Spacer(minLength: 8)
            if busy { ProgressView().controlSize(.small) }
            link(proposal)
            gestures(proposal, busy: busy)
        }
        .padding(.vertical, 2)
        #else
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: Self.symbol(proposal.origin))
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 22)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(proposal.title)
                        .fontWeight(.semibold)
                        .fixedSize(horizontal: false, vertical: true)
                    if let repo = proposal.repo {
                        OSTag(text: repo, symbol: "shippingbox")
                    }
                    if !proposal.detail.isEmpty {
                        Text(proposal.detail)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.small) }
            }
            OSLine {
                gestures(proposal, busy: busy)
                link(proposal)
            }
        }
        .padding(.vertical, 4)
        #endif
    }

    /// La page d'origine de la proposition (l'issue, l'incident, la PR), quand elle en a une.
    @ViewBuilder
    private func link(_ proposal: HarnessProposal) -> some View {
        if let url = proposal.url.flatMap(URL.init(string:)) {
            Link(destination: url) {
                Image(systemName: "arrow.up.right.square")
                    .frame(minWidth: ConsolePlatform.minimumTarget, minHeight: ConsolePlatform.minimumTarget)
            }
            .help(OSWatchText.openLink)
            .accessibilityLabel(OSWatchText.openLink)
        }
    }

    /// Accepter (le geste porte le nom de ce qu'il fait) et écarter.
    @ViewBuilder
    private func gestures(_ proposal: HarnessProposal, busy: Bool) -> some View {
        Button(OSWatchText.proposalAction(proposal.action)) { accept(proposal) }
            .buttonStyle(.borderedProminent)
            .disabled(busy || !OSProposalGroups.canAccept(proposal, canAct: server.canAct, isAdmin: server.isAdmin, approver: server.client?.approver ?? false))
        Button(OSText.dismiss) {
            Task { await proposals.dismiss(proposal) }
        }
        .disabled(busy || !server.canAct)
    }

    /// Accepte la proposition ; la feature qu'elle crée ou relance ouvre son fil.
    private func accept(_ proposal: HarnessProposal) {
        Task {
            guard let accepted = await proposals.accept(proposal), let runId = accepted.created?.runId else { return }
            workspace.open(runId: runId, in: threads)
        }
    }

    private static func symbol(_ source: HarnessProposalSource?) -> String {
        switch source {
        case .issue: "exclamationmark.bubble"
        case .vigie: "binoculars"
        case .audit: "magnifyingglass"
        case .jira: "list.bullet.clipboard"
        case .signal: "megaphone"
        case .autonomy: "dial.medium"
        case .retry: "arrow.clockwise"
        case .pr: "arrow.triangle.pull"
        case .ci: "xmark.seal"
        case nil: "lightbulb"
        }
    }
}
