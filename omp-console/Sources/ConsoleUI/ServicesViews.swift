// La carte « Services » et le rapport du matin, écrits une fois pour le Mac et
// l'iPhone/iPad :
//
// - `ServicesSection` (Statistiques) : chaque service du serveur — sonde de santé
//   (`GET /v1/health` : base, ordonnancement, disque), mémoire du projet et écritures
//   perdues, service mem0 et sauvegardes (`GET /v1/status`), extension Chrome du poste
//   — avec son niveau et ses chiffres ;
// - `ServicesSummarySection` (Accueil) : une ligne, et les seuls services qui
//   demandent un regard ;
// - `DigestSection` (en tête de l'Accueil) : le rapport du matin (`GET /v1/digest`).
//
// Les deux cartes relisent les services à leur apparition puis chaque minute.

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

/// La carte complète (Statistiques).
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
        } footer: {
            Text(MonitoringText.servicesHint)
        }
        .modifier(ServicesPolling(server: server))
        .consoleID("stats.services")
    }
}

/// Le résumé de l'Accueil : tout va, ou les services qui demandent un regard.
public struct ServicesSummarySection: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel

    public init(server: HarnessModel) {
        self.server = server
        self.workstation = server.workstation
    }

    public var body: some View {
        let lines = server.serviceLines
        let problems = lines.filter { $0.level >= .warning }
        Section {
            if problems.isEmpty {
                Label(MonitoringText.servicesAllGood, systemImage: MonitoringText.serviceSymbol(HarnessServiceLine.Level.ok.rawValue))
                    .foregroundStyle(.green)
            } else {
                Label(MonitoringText.servicesProblems(problems.count), systemImage: MonitoringText.serviceSymbol(HarnessServices.worst(problems).rawValue))
                    .foregroundStyle(HarnessServices.worst(problems) == .down ? Color.red : Color.orange)
                ForEach(problems) { line in
                    ServiceLineView(line: line)
                }
            }
        } header: {
            Text(MonitoringText.servicesTitle)
        }
        .modifier(ServicesPolling(server: server))
        .consoleID("home.services")
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

/// Le rapport du matin, en tête de l'Accueil : ce qui s'est fait seul depuis 24 h.
public struct DigestSection: View {
    @ObservedObject var server: HarnessModel

    public init(server: HarnessModel) {
        self.server = server
    }

    public var body: some View {
        if let digest = server.digest {
            Section {
                DisclosureGroup {
                    ConsoleMarkdown(markdown: digest.text)
                        .padding(.vertical, 4)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Label(MonitoringText.digestTitle, systemImage: MonitoringText.digestSymbol)
                            .font(.headline)
                        Text(MonitoringText.digestWindow(ConsoleFormat.dateTime(ms: digest.since)))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .consoleID("home.digest")
            }
        }
    }
}
