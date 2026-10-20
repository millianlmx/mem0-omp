// La section « Dépôts » (S-6 de orchestrator-living-in-a-vps) : en UNE vue, les dépôts
// du Mac et du VPS, chacun marqué de sa machine, et le bloc de connexion au VPS.
//
// Aucune phrase n'est composée ici : `ReposText` (ConsoleCore, partagé avec iOS) et
// `ReposViewText` (le bloc de connexion) portent tous les textes. L'état des gestes vit
// dans `UnifiedReposModel` et `VpsConnectionModel` ; la confirmation de « Confier »
// dans `ReposScreenModel` (`@State` évité, comme dans les autres sections).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Le geste « Confier » en attente de confirmation.
struct ReposConfirmation: Equatable, Identifiable {
    let line: UnifiedRepo
    let offer: HandoverOffer
    var id: String { line.id + ">" + offer.to.rawValue }
}

@MainActor
final class ReposScreenModel: ObservableObject {
    @Published var confirming: ReposConfirmation?
}

struct ReposView: ConsoleSectionView {
    static let section = ConsoleSection.repos

    @ObservedObject var hub: MachineHub
    @ObservedObject private var repos: UnifiedReposModel
    @ObservedObject private var connection: VpsConnectionModel
    @StateObject private var screen = ReposScreenModel()

    init(hub: MachineHub) {
        self.hub = hub
        repos = hub.repos
        connection = hub.connection
    }

    var body: some View {
        List {
            Section(ReposText.vpsSectionTitle) {
                VpsConnectionBlock(model: connection)
            }
            Section(ReposText.title) {
                if let message = repos.message {
                    messageRow(message)
                }
                switch repos.phase {
                case .loading:
                    ProgressView(ReposText.loading)
                        .accessibilityIdentifier("repos.loading")
                case .ready where repos.lines.isEmpty:
                    Text(verbatim: ReposText.empty)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("repos.empty")
                case .ready:
                    ForEach(repos.lines) { line in
                        ReposRow(line: line, repos: repos, screen: screen)
                    }
                }
            }
        }
        .task { await repos.refresh() }
        .confirmationDialog(
            screen.confirming.map { ReposText.handoverButton(to: $0.offer.to) } ?? "",
            isPresented: Binding(get: { screen.confirming != nil }, set: { if !$0 { screen.confirming = nil } }),
            titleVisibility: .visible,
            presenting: screen.confirming
        ) { confirmation in
            Button(ReposText.confirmButton) {
                let line = confirmation.line, offer = confirmation.offer
                Task { await repos.handOver(line, offer: offer) }
            }
            Button(ReposText.cancelButton, role: .cancel) {}
        } message: { confirmation in
            Text(verbatim: repos.confirmation(for: confirmation.line, offer: confirmation.offer))
        }
        .accessibilityIdentifier("repos.view")
    }

    private func messageRow(_ message: ReposMessage) -> some View {
        let (text, failed): (String, Bool) = switch message {
        case .success(let text): (text, false)
        case .failure(let text): (text, true)
        }
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: failed ? "exclamationmark.triangle" : "checkmark.circle")
            Text(verbatim: text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
        .foregroundStyle(failed ? Color.orange : Color.green)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(failed ? "repos.message.failure" : "repos.message.success")
    }
}

/// Une ligne de la vue unifiée : le nom, les badges des machines qui connaissent le dépôt,
/// leur chemin, l'état, et le geste « Confier ».
struct ReposRow: View {
    let line: UnifiedRepo
    @ObservedObject var repos: UnifiedReposModel
    @ObservedObject var screen: ReposScreenModel

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(verbatim: line.name)
                    .font(.headline)
                ForEach(RepoMachine.allCases.filter { line.row(on: $0) != nil }, id: \.self) { machine in
                    MachineBadge(machine: machine)
                }
                Spacer()
                if repos.busy.contains(line.id) {
                    ProgressView()
                        .controlSize(.small)
                    Text(verbatim: ReposViewText.handoverBusy)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            ForEach(RepoMachine.allCases.filter { line.row(on: $0) != nil }, id: \.self) { machine in
                if let row = line.row(on: machine) {
                    Text(verbatim: ReposViewText.path(machine, ConsoleFormat.path(row.repoRoot)))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            status
            if let finishing = line.finishing {
                Text(verbatim: ReposText.finishing(finishing.count, on: finishing.machine))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("repos.finishing.\(line.id)")
            }
            offers
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("repos.row.\(line.id)")
    }

    @ViewBuilder
    private var status: some View {
        let busy = repos.busy.contains(line.id)
        switch line.status {
        case .drivable:
            EmptyView()
        case .unreachable(let machine):
            statusText(ReposText.unreachable(machine), tint: .orange)
        case .handoverInProgress(let target):
            HStack(spacing: 8) {
                statusText(ReposText.handoverInProgress(to: target), tint: .orange)
                Button(ReposText.cancelHandover) { Task { await repos.cancelHandover(line) } }
                    .disabled(busy)
                    .accessibilityIdentifier("repos.cancelHandover.\(line.id)")
            }
        case .handoverToFinish:
            HStack(spacing: 8) {
                statusText(ReposText.handoverToFinish, tint: .orange)
                Button(ReposText.retryHandover) { Task { await repos.retry(line) } }
                    .disabled(busy)
                    .accessibilityIdentifier("repos.retry.\(line.id)")
            }
        case .conflict:
            statusText(ReposText.conflict, tint: .orange)
        }
    }

    private func statusText(_ text: String, tint: Color) -> some View {
        Text(verbatim: text)
            .font(.callout)
            .foregroundStyle(tint)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("repos.status.\(line.id)")
    }

    @ViewBuilder
    private var offers: some View {
        let busy = repos.busy.contains(line.id)
        ForEach(line.offers, id: \.to) { offer in
            VStack(alignment: .leading, spacing: 2) {
                Button(ReposText.handoverButton(to: offer.to)) {
                    screen.confirming = ReposConfirmation(line: line, offer: offer)
                }
                .disabled(!offer.isEnabled || busy)
                .accessibilityIdentifier("repos.handover.\(line.id).\(offer.to.rawValue)")
                if let reason = offer.disabledReason {
                    Text(verbatim: reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("repos.handoverReason.\(line.id).\(offer.to.rawValue)")
                }
            }
        }
    }
}

/// Le bloc « VPS » : adresse Tailscale, code d'appairage, « Oublier ce VPS », état.
struct VpsConnectionBlock: View {
    @ObservedObject var model: VpsConnectionModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let text = Self.statusText(model.state) {
                Text(verbatim: text)
                    .foregroundStyle(Self.isHealthy(model.state) ? Color.green : Color.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("repos.vps.status")
            }
            if Self.offersPairing(model.state) {
                TextField(ReposText.vpsAddressLabel, text: $model.addressText, prompt: Text(verbatim: ReposViewText.addressPlaceholder))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("repos.vps.address")
                TextField(ReposText.pairingCodeLabel, text: $model.codeText, prompt: Text(verbatim: ReposViewText.codePlaceholder))
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("repos.vps.code")
                HStack(spacing: 8) {
                    Button(ReposText.pairButton) { Task { await model.pair() } }
                        .disabled(!model.canPair)
                        .accessibilityIdentifier("repos.vps.pair")
                    if model.pairingInFlight {
                        ProgressView()
                            .controlSize(.small)
                        Text(verbatim: ReposViewText.pairing)
                            .foregroundStyle(.secondary)
                    }
                }
                if let error = model.error {
                    Text(verbatim: error)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("repos.vps.error")
                }
            }
            if model.state != .notPaired {
                Button(ReposText.forgetVps, role: .destructive) { Task { await model.forget() } }
                    .accessibilityIdentifier("repos.vps.forget")
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("repos.vps")
    }

    /// La ligne d'état ; aucune tant que rien n'est appairé.
    static func statusText(_ state: VpsBlockState) -> String? {
        switch state {
        case .notPaired: nil
        case .connecting: ReposViewText.connecting
        case .connected(let address): ReposViewText.connected(address: address)
        case .unreachable(let address): ReposText.vpsUnreachable(address: address)
        case .noNetwork: ReposViewText.noNetwork
        case .wrongMachine(let expected, let actual): ReposText.wrongMachine(expected: expected, actual: actual)
        case .incompatible(let app, let vps): ReposText.incompatibleVersion(app: app, vps: vps)
        case .refused: ReposViewText.refused
        }
    }

    static func isHealthy(_ state: VpsBlockState) -> Bool {
        if case .connected = state { return true }
        return false
    }

    /// La saisie de l'adresse et du code est offerte tant qu'il n'y a pas d'appairage
    /// valable : jamais appairé, refusé, ou adresse de l'autre machine.
    static func offersPairing(_ state: VpsBlockState) -> Bool {
        switch state {
        case .notPaired, .refused, .wrongMachine: true
        case .connecting, .connected, .unreachable, .noNetwork, .incompatible: false
        }
    }
}
