// La section « Dépôts » de l'app iOS (S-6 de orchestrator-living-in-a-vps) : les
// dépôts des deux machines dans UNE seule liste, chacun marqué de sa machine
// (badge « Mac » / « VPS »). Chaque ligne dit son état (injoignable, bascule en
// cours, bascule à terminer, conflit) et offre le geste « Confier au … » avec sa
// confirmation, ou son motif de désactivation. Aucun balayage : les gestes sont
// des boutons dans la ligne.
//
// Composants SYSTÈME seulement ; aucune phrase n'est composée ici : tout vient de
// `ReposText` (via `IOSReposContent`) et de `IOSReposText` (identifiants).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Un geste « Confier » en attente de confirmation.
private struct PendingOffer: Identifiable {
    let line: UnifiedRepo
    let offer: HandoverOffer
    var id: String { line.id + offer.to.rawValue }
}

struct IOSReposScreen: View {
    @ObservedObject var clients: MachineClients
    @ObservedObject var model: UnifiedReposModel
    /// La feuille Connexion de la racine : le VPS s'y appaire.
    @Binding var showConnection: Bool

    @State private var pending: PendingOffer?

    init(clients: MachineClients, showConnection: Binding<Bool>) {
        self.clients = clients
        model = clients.repos
        _showConnection = showConnection
    }

    private var rows: [IOSReposRow] {
        IOSReposContent.rows(model.lines, busy: model.busy) { clients.client(for: $0).macHomeDirectory }
    }

    var body: some View {
        List {
            banners
            if let message = model.message {
                messageRow(message)
            }
            if !clients.vpsConfigured {
                vpsMissingSection
            }
            content
        }
        .iosGroupedList()
        .navigationTitle(ReposText.title)
        .refreshable { await model.refresh() }
        .task { await model.refresh() }
        .confirmationDialog(
            pending.map { ReposText.handoverButton(to: $0.offer.to) } ?? "",
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            titleVisibility: .visible,
            presenting: pending
        ) { target in
            Button(ReposText.confirmButton) {
                Task { await model.handOver(target.line, offer: target.offer) }
            }
            Button(ReposText.cancelButton, role: .cancel) {}
        } message: { target in
            Text(model.confirmation(for: target.line, offer: target.offer))
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSReposText.screen)
    }

    // MARK: - Bandeaux

    /// « Mac injoignable » / « VPS injoignable » : une machine configurée qui ne répond pas.
    @ViewBuilder
    private var banners: some View {
        ForEach(IOSReposContent.unreachableBanners(clients), id: \.self) { machine in
            Text(ReposText.machineBanner(machine))
                .font(.callout)
                .iosBanner(tone: .attention)
                .iosBareListRow()
                .accessibilityIdentifier(IOSReposText.banner(machine.rawValue))
        }
    }

    private func messageRow(_ message: ReposMessage) -> some View {
        let tone: ConsoleTone
        let text: String
        switch message {
        case .success(let value):
            tone = .success
            text = value
        case .failure(let value):
            tone = .danger
            text = value
        }
        return HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(text)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button(ReposText.cancelButton) { model.dismissMessage() }
        }
        .font(.callout)
        .iosBanner(tone: tone)
        .iosBareListRow()
        .accessibilityIdentifier(IOSReposText.message)
    }

    /// Le VPS n'est pas appairé : la feuille Connexion s'ouvre sur sa section « VPS ».
    private var vpsMissingSection: some View {
        Section(ReposText.vpsSectionTitle) {
            Text(ReposText.notPaired(.vps))
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(IOSReposText.vpsMissing)
            Button {
                showConnection = true
            } label: {
                Text(ConnectionText.title)
                    .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier(IOSReposText.connect)
        }
    }

    // MARK: - Lignes

    @ViewBuilder
    private var content: some View {
        let rows = rows
        if rows.isEmpty {
            Section {
                switch model.phase {
                case .loading:
                    HStack(spacing: 8) {
                        ProgressView()
                        Text(ReposText.loading)
                    }
                    .accessibilityIdentifier(IOSReposText.loading)
                case .ready:
                    Text(ReposText.empty)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(IOSReposText.empty)
                }
            }
        } else {
            Section {
                ForEach(rows) { row in
                    rowView(row)
                }
            }
            .accessibilityIdentifier(IOSReposText.list)
        }
    }

    private func rowView(_ row: IOSReposRow) -> some View {
        let line = model.lines.first { $0.id == row.id }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(verbatim: row.name)
                    .font(.headline)
                    .frame(maxWidth: .infinity, alignment: .leading)
                ForEach(row.badges, id: \.self) { machine in
                    machineBadge(machine, rowId: row.id)
                }
            }
            ForEach(row.paths, id: \.machine) { path in
                Text(verbatim: path.text)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(ReposText.accessibility(path.text, machine: path.machine))
            }
            if let status = row.status {
                Text(status)
                    .font(.callout)
                    .accessibilityIdentifier(IOSReposText.status(row.id))
            }
            if let finishing = row.finishing {
                Text(finishing)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            if let line {
                actions(row, line: line)
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSReposText.row(row.id))
    }

    private func machineBadge(_ machine: RepoMachine, rowId: String) -> some View {
        Text(machine.label)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.accentColor.opacity(0.15)))
            .accessibilityLabel(IOSReposContent.badgeLabel(machine))
            .accessibilityIdentifier(IOSReposText.badge(rowId, machine: machine.rawValue))
    }

    @ViewBuilder
    private func actions(_ row: IOSReposRow, line: UnifiedRepo) -> some View {
        if row.canCancel {
            actionButton(ReposText.cancelHandover, id: IOSReposText.cancel(row.id), disabled: row.busy) {
                Task { await model.cancelHandover(line) }
            }
        }
        if row.canRetry {
            actionButton(ReposText.retryHandover, id: IOSReposText.retry(row.id), disabled: row.busy) {
                Task { await model.retry(line) }
            }
        }
        ForEach(row.offers, id: \.to) { offer in
            actionButton(
                ReposText.handoverButton(to: offer.to),
                id: IOSReposText.handover(row.id, to: offer.to.rawValue),
                disabled: !offer.isEnabled || row.busy
            ) {
                pending = PendingOffer(line: line, offer: offer)
            }
            if let reason = offer.disabledReason {
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(IOSReposText.reason(row.id, to: offer.to.rawValue))
            }
            if row.busy {
                ProgressView()
            }
        }
    }

    /// Un bouton de ligne : la cible de 44 pt est portée par l'étiquette, comme dans
    /// la feuille Connexion ; `.borderless` pour qu'un toucher sur la ligne ne le déclenche pas.
    private func actionButton(_ title: String, id: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
        .accessibilityIdentifier(id)
    }
}
