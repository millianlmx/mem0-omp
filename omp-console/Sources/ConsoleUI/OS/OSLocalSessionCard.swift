// L'« OS agentique » : la SESSION LOCALE d'un fil — une session omp qui travaille sur une
// machine de l'humain. Où elle tourne (machine, dossier, branche), avec quoi (modèle), ce
// qu'elle a coûté, ce qu'elle fait à l'instant (le pouls). Trois gestes : « Continuer sur le
// serveur » (l'usine reprend la branche dans une feature, dont le fil s'ouvre), « Copier la
// commande de reprise » (la branche à récupérer sur une autre machine), « Oublier ».

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSLocalSessionCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var sessions: HarnessLocalSessionsModel
    @ObservedObject var pulse: OSPulse
    let session: HarnessLocalSession
    let opened: @MainActor (String) -> Void
    let forgotten: @MainActor () -> Void
    @State private var copied = false
    @State private var failed = false

    /// `opened` : la feature créée par le passage de relais (son identifiant), à ouvrir.
    /// `forgotten` : la session a été retirée, son fil n'existe plus.
    public init(
        server: HarnessModel, pulse: OSPulse, session: HarnessLocalSession, opened: @escaping @MainActor (String) -> Void,
        forgotten: @escaping @MainActor () -> Void
    ) {
        self.server = server
        sessions = server.localSessions
        self.pulse = pulse
        self.session = session
        self.opened = opened
        self.forgotten = forgotten
    }

    private var phase: OSPhase { OSThreads.phase(of: session) }

    private var state: String {
        switch session.phase {
        case .working: OSText.phaseWorking
        case .idle: OSDecideText.sessionIdle
        case .ended: OSDecideText.sessionEnded
        case nil: session.state
        }
    }

    public var body: some View {
        let busy = sessions.busy.contains(session.id)
        TimelineView(.periodic(from: .now, by: 5)) { timeline in
            OSCard(tint: phase.color, emphasized: session.isLive) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        OSPhaseMark(phase: phase, size: 14)
                        Text(OSDecideText.localSession).font(.headline)
                        OSTag(text: state, tint: phase.color)
                        Spacer()
                    }
                    intent(now: timeline.date)
                    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                        fact(OSDecideText.machine, session.host)
                        fact(OSDecideText.folder, session.cwd)
                        fact(OSDecideText.branch, session.branch)
                        fact(OSDecideText.model, session.model)
                        fact(OSDecideText.cost, session.cost.map(MonitoringText.cost))
                    }
                    if failed, let failure = sessions.failure {
                        ConsoleFailureBanner(failure: failure)
                    }
                    OSFlow(spacing: 8) {
                        if session.canHandOff, server.canAct {
                            Button(OSDecideText.handoff, systemImage: "arrow.up.forward.app", action: handOff)
                                .buttonStyle(.borderedProminent)
                        }
                        if let command = OSLocalSessionCommand.resume(branch: session.branch) {
                            Button(copied ? OSDecideText.copied : OSDecideText.copyResume, systemImage: copied ? "checkmark" : "doc.on.doc") {
                                OSLocalSessionClipboard.copy(command)
                                copied = true
                            }
                        }
                        if server.canAct {
                            Button(OSDecideText.forget, role: .destructive, action: forget)
                        }
                    }
                    .disabled(busy)
                }
            }
        }
    }

    /// Ce que fait la session à l'instant : le pouls, sinon sa dernière intention connue.
    @ViewBuilder
    private func intent(now: Date) -> some View {
        let activity = pulse.current(.localSession(session.id), now: now)
        if let line = activity?.line ?? (session.isLive ? session.intent : nil), !line.isEmpty {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("↳")
                Text(line)
                if let tool = activity?.tool ?? session.tool {
                    Text(tool).font(.caption.monospaced()).foregroundStyle(.tertiary)
                }
            }
            .foregroundStyle(.secondary)
            .lineLimit(2)
        }
    }

    @ViewBuilder
    private func fact(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            GridRow {
                Text(label).font(.caption).foregroundStyle(.secondary)
                Text(value).font(.callout).osSelectable()
            }
        }
    }

    private func handOff() {
        failed = false
        Task {
            if let run = await sessions.handoff(session) {
                opened(run.id)
            } else {
                failed = true
            }
        }
    }

    private func forget() {
        failed = false
        Task {
            if await sessions.delete(session) {
                forgotten()
            } else {
                failed = true
            }
        }
    }
}
