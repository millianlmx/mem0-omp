// L'« OS agentique » : le hub SYSTÈME, partagé par le Mac et l'iPhone/iPad. Une grille de
// tuiles, une par écran qui se règle ou se consulte rarement : le Poste, les dépôts, les
// planifications, l'autonomie, la vigie, les statistiques, les issues, l'administration et
// le serveur. Chaque tuile se lit sans phrase : un symbole, un mot, et à droite son état en
// pastille (un point coloré) ou en compteur. Les dépôts et l'administration ne se montrent
// qu'à un administrateur ; l'autonomie, qu'à un serveur qui la sert.
//
// Le hub n'ouvre rien lui-même : `open` remet la destination à la coque, qui la traduit en
// écran (Mac : le centre de l'OS ; iPhone/iPad : une route poussée dans la pile ; le
// serveur : sa feuille).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Un écran du hub Système.
public enum OSSystemDestination: String, CaseIterable, Identifiable, Hashable, Sendable {
    case workstation, repos, schedules, autonomy, vigie, stats, issues, admin, server

    public var id: String { rawValue }

    /// La destination d'une page du hub nommée par un lien ou la palette.
    public init(_ page: SystemPage) {
        self = Self(rawValue: page.rawValue) ?? .server
    }

    public var title: String {
        page?.title ?? ConsoleSection.workstation.title
    }

    public var symbol: String {
        page?.systemImage ?? ConsoleSection.workstation.systemImage
    }

    /// La page du hub qui porte le même nom (toutes, sauf le Poste).
    public var page: SystemPage? {
        SystemPage(rawValue: rawValue)
    }

    /// Les destinations montrées à ce jeton : les dépôts et l'administration à un
    /// administrateur seulement, l'autonomie seulement si le serveur relié la sert.
    public static func visible(isAdmin: Bool, autonomy: Bool) -> [OSSystemDestination] {
        allCases.filter { destination in
            guard let page = destination.page else { return true }
            return (isAdmin || !page.isAdminOnly) && (autonomy || page != .autonomy)
        }
    }

    /// La teinte de la tuile : chaque écran garde la sienne, d'une app à l'autre.
    var tint: Color {
        switch self {
        case .workstation: .indigo
        case .repos: .orange
        case .schedules: .purple
        case .autonomy: .green
        case .vigie: .teal
        case .stats: .pink
        case .issues: .mint
        case .admin: .gray
        case .server: .blue
        }
    }
}

public struct OSSystemHub: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var schedules: HarnessSchedules
    @ObservedObject var admin: HarnessAdmin
    @ObservedObject var autonomy: HarnessAutonomy
    let open: @MainActor (OSSystemDestination) -> Void

    public init(server: HarnessModel, open: @escaping @MainActor (OSSystemDestination) -> Void) {
        self.server = server
        self.open = open
        _workstation = ObservedObject(wrappedValue: server.workstation)
        _vigie = ObservedObject(wrappedValue: server.vigie)
        _schedules = ObservedObject(wrappedValue: server.schedules)
        _admin = ObservedObject(wrappedValue: server.admin)
        _autonomy = ObservedObject(wrappedValue: server.autonomy)
    }

    public var body: some View {
        ScrollView {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: Self.tileWidth), spacing: 12)], spacing: 12) {
                ForEach(OSSystemDestination.visible(isAdmin: server.isAdmin, autonomy: autonomy.isServed)) { destination in
                    Button { open(destination) } label: {
                        OSSystemTile(destination: destination, state: state(of: destination), caption: caption(of: destination))
                    }
                    .buttonStyle(.plain)
                    .consoleID("system.tile." + destination.rawValue)
                }
            }
            .osPagePadding(20)
        }
        .navigationTitle(OSSystemText.title)
        .task(id: server.address) {
            guard server.isConfigured else { return }
            await workstation.load()
            await vigie.load()
            await schedules.refresh()
            await autonomy.refresh()
            if server.isAdmin { await admin.refresh() }
            if server.repos.isEmpty { await server.refreshCatalog() }
        }
    }

    #if os(macOS)
    private static let tileWidth: CGFloat = 170
    #else
    private static let tileWidth: CGFloat = 150
    #endif

    /// L'état d'une tuile : un compteur, un point, ou rien.
    private func state(of destination: OSSystemDestination) -> OSSystemTile.State? {
        switch destination {
        case .workstation:
            if workstation.status?.stopped != nil { return .dot(.red, OSSystemText.stopped) }
            if workstation.pendingCount > 0 { return .count(workstation.pendingCount, .orange, OSSystemText.pending(workstation.pendingCount)) }
            guard let status = workstation.status else { return nil }
            return status.online ? .dot(.green, OSSystemText.online) : .dot(.secondary, OSText.offline)
        case .repos:
            return server.repos.isEmpty ? nil : .count(server.repos.count, .secondary, OSSystemText.repos(server.repos.count))
        case .schedules:
            let active = schedules.schedules.filter(\.enabled).count
            return active == 0 ? nil : .count(active, .secondary, OSSystemText.activeSchedules(active))
        case .vigie:
            guard let view = vigie.view else { return nil }
            if view.isSilent { return .dot(.red, OSSystemText.silent) }
            let fresh = view.incidents["new"] ?? 0
            return fresh > 0 ? .count(fresh, .orange, OSText.incidents(fresh)) : .dot(.green, OSSystemText.watching)
        case .admin:
            return admin.clients.isEmpty ? nil : .count(admin.clients.count, .secondary, OSSystemText.clients(admin.clients.count))
        case .server:
            return server.isLive ? .dot(.green, OSSystemText.online) : .dot(.secondary, OSText.offline)
        case .autonomy, .stats, .issues:
            return nil
        }
    }

    /// La seule ligne sous un titre : l'hôte du serveur relié.
    private func caption(of destination: OSSystemDestination) -> String? {
        guard destination == .server, let address = server.address else { return nil }
        return URL(string: address)?.host ?? address
    }
}

/// Une tuile du hub : le symbole sur sa pastille de couleur, l'état en haut à droite, le mot
/// dessous.
struct OSSystemTile: View {
    enum State {
        /// Un nombre en capsule, et ce que VoiceOver en dit.
        case count(Int, Color, String)
        /// Un point de couleur, et le mot qu'il remplace.
        case dot(Color, String)
    }

    let destination: OSSystemDestination
    let state: State?
    let caption: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top) {
                Image(systemName: destination.symbol)
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(destination.tint)
                    .frame(width: 38, height: 38)
                    .background(destination.tint.opacity(0.15), in: .rect(cornerRadius: 10, style: .continuous))
                    .accessibilityHidden(true)
                Spacer(minLength: 4)
                switch state {
                case let .count(value, tint, _):
                    Text("\(value)")
                        .font(.caption.weight(.bold).monospacedDigit())
                        .foregroundStyle(tint == .secondary ? Color.primary : Color.white)
                        .padding(.horizontal, 7)
                        .padding(.vertical, 2)
                        .background(Capsule().fill(tint == .secondary ? Color.primary.opacity(0.1) : tint))
                case let .dot(tint, _):
                    Circle().fill(tint).frame(width: 9, height: 9).padding(4)
                case nil:
                    EmptyView()
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(destination.title)
                    .font(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                if let caption {
                    Text(caption)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, minHeight: 108, alignment: .topLeading)
        .background(.fill.quaternary, in: .rect(cornerRadius: 14, style: .continuous))
        .contentShape(.rect(cornerRadius: 14))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([destination.title, caption, stateLabel].compactMap { $0 }.joined(separator: ", "))
        .accessibilityAddTraits(.isButton)
    }

    private var stateLabel: String? {
        switch state {
        case let .count(_, _, label): label
        case let .dot(_, label): label
        case nil: nil
        }
    }
}
