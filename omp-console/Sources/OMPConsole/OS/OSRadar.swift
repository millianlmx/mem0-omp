// PROTOTYPE « OS agentique » (branche proto/os-fils) : le RADAR, toujours en haut.
// Chaque agent est un symbole d'état et une ligne : ce qu'il fait maintenant (le pouls).
// Les features au travail, le poste, la vigie, l'OS lui-même ; à droite le coût du
// jour et « Tout suspendre ». Un clic sur un agent ouvre son fil.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct OSRadar: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    let threads: [OSThread]

    @State private var confirmStopPoste = false
    @State private var confirmStopRuns = false

    private var liveRuns: [HarnessRun] {
        (server.inbox?.runs ?? []).filter { run in
            let phase = OSThreads.phase(of: run, inbox: server.inbox)
            return phase == .working || phase == .yours
        }
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            HStack(spacing: 10) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(liveRuns) { run in
                            agent(
                                phase: OSThreads.phase(of: run, inbox: server.inbox),
                                name: OSThreads.clean(run.title).title,
                                line: pulse.current(.run(run.id), now: context.date)?.line ?? OSText.runState(run)
                            ) {
                                if let thread = threads.first(where: { $0.runs.contains { $0.id == run.id } }) { workspace.open(thread.id) }
                            }
                        }
                        poste(now: context.date)
                        vigieChip
                        if let system = pulse.current(.system, now: context.date) {
                            agent(phase: .working, name: OSText.os, line: system.line, action: nil)
                        }
                    }
                    .padding(.vertical, 6)
                }
                Spacer(minLength: 0)
                if let cost = todayCost {
                    Text(OSText.today(cost))
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
                Circle()
                    .fill(pulse.isLive ? Color.green : Color.secondary.opacity(0.4))
                    .frame(width: 7, height: 7)
                    .help(pulse.isLive ? "En direct" : "Reconnexion…")
                suspendMenu
            }
            .padding(.horizontal, 12)
        }
        .frame(height: 46)
        .background(.bar)
    }

    // MARK: Agents

    private func agent(phase: OSPhase, name: String, line: String, action: (() -> Void)?) -> some View {
        Button {
            action?()
        } label: {
            HStack(spacing: 6) {
                OSPhaseMark(phase: phase, size: 13)
                VStack(alignment: .leading, spacing: 0) {
                    Text(name)
                        .font(.caption.weight(.semibold))
                        .lineLimit(1)
                    Text(line)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                .frame(maxWidth: 210, alignment: .leading)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(Capsule().fill(phase == .yours ? Color.orange.opacity(0.12) : Color.primary.opacity(0.05)))
        }
        .buttonStyle(.plain)
        .help(name + " — " + line)
    }

    @ViewBuilder
    private func poste(now: Date) -> some View {
        if workstation.availability == .available, let status = workstation.status {
            let live = pulse.workstation(now: now)
            let running = workstation.requests?.first { $0.state == .running }
            let phase: OSPhase = status.stopped != nil ? .failed : status.paused ? .stopped : live != nil || running != nil ? .working : status.online ? .queued : .stopped
            let line = status.stopped != nil ? OSText.stopped
                : status.paused ? OSText.paused
                : live?.activity.line ?? running.map { OSThreads.firstLine($0.instruction) }
                ?? (status.online ? OSText.idle : OSText.offline)
            agent(phase: phase, name: OSText.poste, line: line) {
                if let running { workspace.open("w:" + running.id) }
            }
        }
    }

    @ViewBuilder
    private var vigieChip: some View {
        if let view = vigie.view {
            let fresh = view.incidents["new"] ?? 0
            let phase: OSPhase = view.isSilent ? .failed : .queued
            agent(phase: phase, name: OSText.vigie, line: view.isSilent ? OSText.silent : OSText.incidents(fresh), action: nil)
        }
    }

    // MARK: Coût et frein

    private var todayCost: Double? {
        guard let days = server.stats?.usage?.byDay else { return nil }
        let today = Date().formatted(.iso8601.year().month().day())
        return days.first { $0.day == today }?.cost ?? 0
    }

    private var suspendMenu: some View {
        Menu {
            Button(OSText.stopPoste, systemImage: "hand.raised.fill") { confirmStopPoste = true }
                .disabled(workstation.availability != .available || workstation.status?.stopped != nil)
            Button(OSText.stopThreads(liveRuns.count), systemImage: "stop.fill") { confirmStopRuns = true }
                .disabled(liveRuns.isEmpty || !server.canAct)
        } label: {
            Label(OSText.suspend, systemImage: "pause.circle.fill")
        }
        .menuStyle(.button)
        .tint(.red)
        .fixedSize()
        .confirmationDialog(OSText.stopPoste, isPresented: $confirmStopPoste) {
            Button(OSText.stopPoste, role: .destructive) { Task { await workstation.stop() } }
        }
        .confirmationDialog(OSText.stopThreads(liveRuns.count), isPresented: $confirmStopRuns) {
            Button(OSText.stopThreads(liveRuns.count), role: .destructive) {
                let ids = liveRuns.map(\.id)
                Task { for id in ids { await server.cancel(runId: id) } }
            }
        }
    }
}
