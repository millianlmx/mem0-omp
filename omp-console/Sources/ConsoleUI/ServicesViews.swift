// La carte « Services » des statistiques, écrite une fois pour le Mac et l'iPhone/iPad :
// chaque service du serveur — sonde de santé (`GET /v1/health` : base, ordonnancement,
// disque), mémoire du projet et écritures perdues, service mem0 et sauvegardes
// (`GET /v1/status`), extension Chrome du poste — avec son niveau et ses chiffres. La
// carte relit les services à son apparition puis chaque minute.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// La relecture des services tant que la carte est à l'écran.
private struct ServicesPolling: ViewModifier {
    let server: HarnessModel

    func body(content: Content) -> some View {
        content.task(id: server.address) {
            while !Task.isCancelled {
                await server.refreshServices()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }
}

/// La carte des services (Statistiques et santé).
public struct ServicesSection: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel

    public init(server: HarnessModel) {
        self.server = server
        self.workstation = server.workstation
    }

    public var body: some View {
        Section {
            ForEach(server.serviceLines) { line in
                ServiceLineView(line: line)
            }
        } header: {
            Label(MonitoringText.servicesTitle, systemImage: MonitoringText.servicesSymbol)
        }
        .modifier(ServicesPolling(server: server))
        .consoleID("stats.services")
    }
}

/// Une ligne de service : son nom, son niveau, ses chiffres.
struct ServiceLineView: View {
    let line: HarnessServiceLine

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline) { name; Spacer(minLength: 8); chip }
                VStack(alignment: .leading, spacing: 4) { name; chip }
            }
            ForEach(Self.details(line), id: \.self) { detail in
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .consoleID("service." + line.kind.rawValue)
    }

    private var name: some View {
        Text(MonitoringText.service(line.kind.rawValue))
    }

    private var chip: some View {
        ConsoleStatusChip(status: ConsoleStatus(text: MonitoringText.serviceLevel(line.level.rawValue), tone: Self.tone(line.level)))
    }

    static func tone(_ level: HarnessServiceLine.Level) -> ConsoleTone {
        switch level {
        case .ok: .success
        case .unknown: .neutral
        case .warning: .attention
        case .down: .danger
        }
    }

    /// Les chiffres d'un service, en phrases.
    static func details(_ line: HarnessServiceLine) -> [String] {
        var out: [String] = []
        let now = Date().timeIntervalSince1970 * 1000
        if line.level == .unknown, [.oracle, .memory].contains(line.kind) {
            out.append(MonitoringText.serviceNotConfigured)
        }
        if let version = line.version { out.append(MonitoringText.serviceVersion(version)) }
        switch line.kind {
        case .scheduler:
            if let age = line.ageSec { out.append(MonitoringText.lastTick(PipelineServerText.duration(age))) }
        case .disk:
            if let free = line.freeMiB { out.append(MonitoringText.freeSpace(PipelineServerText.mebibytes(free))) }
        case .oracle:
            if let count = line.count, count > 0 { out.append(MonitoringText.lostWrites(count)) }
        case .memory:
            if let count = line.count { out.append(MonitoringText.memories(count)) }
        case .backups:
            if let at = line.at { out.append(MonitoringText.lastBackup(ConsoleFormat.dateTime(ms: at))) }
        case .workstation:
            if let at = line.at { out.append(WorkstationText.lastSeen(ConsoleFormat.relative(ms: at, nowMs: now))) }
        case .server, .database:
            break
        }
        if let error = line.error, !error.isEmpty { out.append(MonitoringText.lastError(error)) }
        return out
    }
}
