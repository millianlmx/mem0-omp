// Le hub SYSTÈME, écrit une fois pour le Mac et l'iPhone/iPad : une rangée par page de
// ce qui se règle ou se consulte rarement (vigie, planifications, statistiques et santé,
// administration, serveur), avec son état d'un coup d'œil à droite. Chaque rangée pousse
// sa page dans la pile de navigation de l'app (`NavigationLink(value: SystemPage)`) ;
// le Serveur ouvre la feuille de connexion.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct SystemHubSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var schedules: HarnessSchedules

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
        self.vigie = server.vigie
        self.schedules = server.schedules
    }

    public var body: some View {
        Section {
            ForEach(SystemPage.visible(isAdmin: server.isAdmin).filter { $0 != .server }) { page in
                NavigationLink(value: page) {
                    row(page)
                }
                .consoleID("system." + page.rawValue)
            }
        } footer: {
            Text(ShellText.systemHint)
        }
        Section {
            Button {
                drafts.serverSheetShown = true
            } label: {
                row(.server)
            }
            .buttonStyle(.plain)
            .consoleID("system.server")
        }
    }

    private func row(_ page: SystemPage) -> some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: page.systemImage)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(page.title)
                    .font(.body.weight(.medium))
                Text(page.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            status(page)
        }
        .contentShape(Rectangle())
        .padding(.vertical, 4)
    }

    @ViewBuilder
    private func status(_ page: SystemPage) -> some View {
        switch page {
        case .vigie:
            if vigie.availability == .absent {
                Text(ShellText.unavailable).font(.caption).foregroundStyle(.secondary)
            } else if vigie.isSilent {
                ConsoleStatusChip(status: ConsoleStatus(text: ShellText.vigieSilent, tone: .danger))
            } else if let mode = vigie.view?.settings.mode {
                ConsoleStatusChip(status: ConsoleStatus(text: ControlText.vigieMode(mode), tone: mode == "off" ? .neutral : .info))
            }
        case .schedules:
            if schedules.availability == .absent {
                Text(ShellText.unavailable).font(.caption).foregroundStyle(.secondary)
            } else if !schedules.schedules.isEmpty {
                Text(ShellText.schedulesCount(schedules.schedules.filter(\.enabled).count, of: schedules.schedules.count))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
        case .server:
            HStack(spacing: 6) {
                Circle().fill(server.isLive ? Color.green : Color.secondary).frame(width: 8, height: 8)
                Text(server.address ?? PipelineServerText.notConfigured)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
        case .stats, .admin, .autonomy:
            EmptyView()
        }
    }
}
