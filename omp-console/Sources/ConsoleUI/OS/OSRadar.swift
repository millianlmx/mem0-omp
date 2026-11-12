// L'« OS agentique » : le RADAR, toujours en haut, partagé par le Mac et l'iPhone/iPad.
// Chaque agent est un symbole d'état et une ligne : ce qu'il fait maintenant (le pouls).
// Les features au travail, le poste, la vigie, les sessions omp locales, l'OS lui-même ;
// à droite le coût du jour (et le reste du budget de l'espace retenu) et « Tout
// suspendre » : la pause du serveur, après l'étape en cours ou tout de suite. En pause,
// la barre devient le bandeau orange : « En pause », qui et pourquoi, et « Reprendre »
// (sa hauteur ne change pas : rien ne bouge dessous). Un serveur sans pause garde les
// arrêts du poste et des fils. Un clic sur un agent ouvre son fil.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSRadar: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var pause: HarnessPauseModel
    @ObservedObject var localSessions: HarnessLocalSessionsModel
    @ObservedObject var spaces: HarnessSpacesModel
    let threads: [OSThread]

    public init(
        server: HarnessModel, workstation: WorkstationModel, vigie: HarnessVigie, pulse: OSPulse, workspace: OSWorkspace,
        threads: [OSThread]
    ) {
        self.server = server
        self.workstation = workstation
        self.vigie = vigie
        self.pulse = pulse
        self.workspace = workspace
        _pause = ObservedObject(wrappedValue: server.pause)
        _localSessions = ObservedObject(wrappedValue: server.localSessions)
        _spaces = ObservedObject(wrappedValue: server.spaces)
        self.threads = threads
    }

    /// Le geste qui attend sa confirmation.
    private enum Ask: Identifiable {
        case pauseAfterStep, pauseNow, stopPoste, stopRuns

        var id: Self { self }
    }

    @State private var ask: Ask?

    /// Les features au travail ou qui vous attendent, et leur phase : la boîte indexée une fois.
    private var liveRuns: [(run: HarnessRun, phase: OSPhase)] {
        let waiting = OSThreads.pendingByRun(server.inbox)
        return (server.inbox?.runs ?? []).compactMap { run in
            let phase = OSThreads.phase(of: run, pending: waiting[run.id] ?? 0)
            return phase == .working || phase == .yours ? (run, phase) : nil
        }
    }

    public var body: some View {
        // Sur le Mac, la hauteur ne change jamais : en pause, la barre elle-même devient le
        // bandeau orange. Sur l'iPhone et l'iPad, le Radar tient en deux rangées qui suivent
        // la taille du texte : la pause et le coût, puis les agents.
        // Seules les pastilles des agents suivent l'horloge (la fraîcheur du pouls) : le reste
        // de la barre ne se redessine pas toutes les cinq secondes.
        Group {
            #if os(macOS)
            HStack(spacing: 10) {
                if pause.isPaused { pausedLabel }
                ScrollView(.horizontal, showsIndicators: false) {
                    agentsTicking
                        .padding(.vertical, 6)
                }
                Spacer(minLength: 0)
                gauges
                if pause.isPaused { resumeButton } else { suspendMenu }
            }
            .padding(.horizontal, 12)
            #else
            VStack(alignment: .leading, spacing: 4) {
                // Côte à côte quand la largeur le permet ; l'un sous l'autre aux grandes tailles de texte.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        if pause.isPaused { pausedLabel } else { gauges }
                        Spacer(minLength: 0)
                        if pause.isPaused { resumeButton.fixedSize() } else { suspendMenu }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        if pause.isPaused { pausedLabel } else { HStack(spacing: 10) { gauges } }
                        if pause.isPaused { resumeButton } else { suspendMenu }
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                if pause.isPaused {
                    HStack(spacing: 10) { gauges }
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    agentsTicking
                        .padding(.horizontal, 16)
                }
                .padding(.horizontal, -16)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
            #endif
        }
        #if os(macOS)
        .frame(height: 46)
        #endif
        .background(pause.isPaused ? Color.orange.opacity(0.16) : Color.clear)
        .background(.bar)
        .background {
            // ⌘⇧P : suspendre (après confirmation) ou reprendre.
            Button("") { workspace.pauseRequested = true }
                .keyboardShortcut("p", modifiers: [.command, .shift])
                .hidden()
        }
        .confirmationDialog(askTitle, isPresented: asking, titleVisibility: .visible, presenting: ask) { ask in
            Button(askTitle(ask), role: .destructive) { confirm(ask) }
        }
        .onChange(of: workspace.pauseRequested) { _, requested in
            guard requested else { return }
            workspace.pauseRequested = false
            togglePause()
        }
        .task(id: server.address) {
            await pause.refresh()
            await localSessions.refresh()
        }
        // Les chiffres de l'espace retenu (coût du jour, reste du budget) se relisent quand il change.
        .task(id: spaceKey) {
            await spaces.refresh()
        }
    }

    /// Ce qui fait relire les espaces : le serveur relié et l'espace retenu.
    private var spaceKey: String {
        (server.address ?? "") + "|" + (workspace.spaceId ?? "")
    }

    /// Les pastilles des agents, redessinées toutes les cinq secondes : une activité trop
    /// vieille quitte la ligne.
    private var agentsTicking: some View {
        TimelineView(.periodic(from: .now, by: 5)) { context in
            agents(now: context.date)
        }
    }

    /// Une pastille par agent : les features vivantes, le poste, la vigie, les sessions locales, l'OS.
    private func agents(now: Date) -> some View {
        HStack(spacing: 8) {
            ForEach(liveRuns, id: \.run.id) { live in
                agent(
                    phase: live.phase,
                    name: OSThreads.clean(live.run.title).title,
                    line: live.run.repo + " · " + (pulse.current(.run(live.run.id), now: now)?.line ?? live.run.osState)
                ) {
                    workspace.open(runId: live.run.id, in: threads)
                }
            }
            poste(now: now)
            vigieChip
            localChip(now: now)
            if let system = pulse.current(.system, now: now) {
                agent(phase: .working, name: OSText.os, line: system.line, action: nil)
            }
        }
    }

    /// À droite : le refus d'un geste de pause, le coût du jour, le témoin du direct.
    @ViewBuilder
    private var gauges: some View {
        if let failure = pause.failure {
            Text(failure.message)
                .font(.caption)
                .foregroundStyle(.red)
                .lineLimit(1)
        }
        if let cost = costLine {
            Text(cost)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .layoutPriority(1)
        }
        Circle()
            .fill(pulse.isLive ? Color.green : Color.secondary.opacity(0.4))
            .frame(width: 7, height: 7)
            .help(pulse.isLive ? OSText.live : OSText.reconnecting)
    }

    // MARK: Agents

    private func agent(phase: OSPhase, name: String, line: String, symbol: String? = nil, action: (() -> Void)?) -> some View {
        Button {
            action?()
        } label: {
            HStack(spacing: 6) {
                if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundStyle(phase.color)
                        .frame(width: 19, height: 19)
                        .accessibilityLabel(phase.label)
                } else {
                    OSPhaseMark(phase: phase, size: 13)
                }
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
            .frame(minHeight: ConsolePlatform.minimumTarget)
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

    /// Les sessions omp ouvertes sur les machines de l'humain : leur nombre, et ce que fait
    /// la plus récemment active. Rien sans session ouverte, ni sur un serveur qui n'en sert pas.
    @ViewBuilder
    private func localChip(now: Date) -> some View {
        let live = localSessions.live
        if localSessions.isServed, let first = live.first {
            let intent = pulse.current(.localSession(first.id), now: now)?.line ?? first.intent ?? OSThreads.clean(first.title).title
            let lead = live.count > 1 ? OSWatchText.activeSessions(live.count) : first.host
            agent(
                phase: live.contains { $0.phase == .working } ? .working : .queued,
                name: OSWatchText.localSessions,
                line: lead + " · ↳ " + intent,
                symbol: "laptopcomputer"
            ) {
                if let thread = threads.first(where: { $0.localSession?.id == first.id }) { workspace.open(thread.id) }
            }
        }
    }

    // MARK: Coût

    /// Le coût du jour : celui de l'espace retenu, avec ce qu'il reste de son budget, sinon
    /// celui du serveur entier.
    private var costLine: String? {
        if let space = spaces.spaces.first(where: { $0.id == workspace.spaceId }) {
            let cost = OSText.today(space.stats.costToday)
            return space.stats.budgetLeftToday.map { cost + " · " + OSWatchText.budgetLeft($0) } ?? cost
        }
        guard let days = server.stats?.usage?.byDay else { return nil }
        let today = Date().formatted(.iso8601.year().month().day())
        return OSText.today(days.first { $0.day == today }?.cost ?? 0)
    }

    // MARK: Pause

    /// « En pause », et dessous qui, depuis quand, pourquoi : en tête de la barre, en orange.
    private var pausedLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: "pause.circle.fill")
                .font(.system(size: 17, weight: .semibold))
            VStack(alignment: .leading, spacing: 0) {
                Text(OSWatchText.pausedTitle)
                    .font(.caption.weight(.bold))
                if !pauseDetail.isEmpty {
                    Text(pauseDetail)
                        .font(.caption2)
                        .lineLimit(Self.pauseDetailLines)
                }
            }
        }
        .foregroundStyle(.orange)
        #if os(macOS)
        .frame(maxWidth: 300, alignment: .leading)
        .fixedSize(horizontal: true, vertical: false)
        #endif
        .help(pauseDetail)
        .accessibilityElement(children: .combine)
    }

    /// Qui, depuis quand, pourquoi : une ligne dans la barre du Mac, deux sur l'iPhone et l'iPad.
    #if os(macOS)
    private static let pauseDetailLines = 1
    #else
    private static let pauseDetailLines = 2
    #endif

    /// « Reprendre » : relance le tour.
    private var resumeButton: some View {
        Button {
            Task { await pause.setPause(paused: false) }
        } label: {
            Label(OSWatchText.resume, systemImage: "play.circle.fill")
        }
        .tint(.orange)
        .disabled(!server.canAct || pause.isSaving)
    }

    private var pauseDetail: String {
        guard let state = pause.pause else { return "" }
        let parts = [
            state.by.map(OSWatchText.pausedBy),
            state.at.map(\.osRelative),
            state.now ? OSWatchText.interrupted : nil,
            state.reason,
        ]
        return parts.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    /// « Tout suspendre » : la pause du serveur quand il la sert, sinon l'arrêt du poste et
    /// des fils en cours. Rien tant que l'état de la pause n'est pas lu, ni en pause (le
    /// bandeau porte « Reprendre »).
    @ViewBuilder
    private var suspendMenu: some View {
        let posteStop = Button(OSText.stopPoste, systemImage: "hand.raised.fill") { ask = .stopPoste }
            .disabled(workstation.availability != .available || workstation.status?.stopped != nil)
        switch pause.availability {
        case .available where !pause.isPaused:
            Menu {
                Button(OSWatchText.pauseAfterStep, systemImage: "pause.fill") { ask = .pauseAfterStep }
                Button(OSWatchText.pauseNow, systemImage: "stop.fill") { ask = .pauseNow }
                Divider()
                posteStop
            } label: {
                Label(OSText.suspend, systemImage: "pause.circle.fill")
            }
            .menuStyle(.button)
            .tint(.red)
            .osFixedSize()
            .disabled(!server.canAct || pause.isSaving)
        case .absent:
            Menu {
                posteStop
                Button(OSText.stopThreads(liveRuns.count), systemImage: "stop.fill") { ask = .stopRuns }
                    .disabled(liveRuns.isEmpty || !server.canAct)
            } label: {
                Label(OSText.suspend, systemImage: "pause.circle.fill")
            }
            .menuStyle(.button)
            .tint(.red)
            .osFixedSize()
        default:
            EmptyView()
        }
    }

    private var asking: Binding<Bool> {
        Binding(get: { ask != nil }, set: { shown in if !shown { ask = nil } })
    }

    private var askTitle: String {
        switch ask {
        case .pauseAfterStep: OSWatchText.confirmAfterStep
        case .pauseNow: OSWatchText.confirmNow
        case .stopPoste: OSText.stopPoste
        case .stopRuns: OSText.stopThreads(liveRuns.count)
        case nil: ""
        }
    }

    /// Le bouton qui confirme.
    private func askTitle(_ ask: Ask) -> String {
        switch ask {
        case .pauseAfterStep: OSText.suspend
        case .pauseNow: OSWatchText.interrupt
        case .stopPoste: OSText.stopPoste
        case .stopRuns: OSText.stopThreads(liveRuns.count)
        }
    }

    private func confirm(_ ask: Ask) {
        switch ask {
        case .pauseAfterStep:
            Task { await pause.setPause(paused: true) }
        case .pauseNow:
            Task { await pause.setPause(paused: true, now: true) }
        case .stopPoste:
            Task { await workstation.stop() }
        case .stopRuns:
            let ids = liveRuns.map(\.run.id)
            Task { for id in ids { await server.cancel(runId: id) } }
        }
    }

    /// ⌘⇧P : reprend si tout est suspendu, sinon demande la confirmation de la pause douce.
    /// Sans effet sur un serveur sans pause, ou pour un jeton qui ne peut pas agir.
    private func togglePause() {
        guard pause.availability == .available, server.canAct else { return }
        if pause.isPaused {
            Task { await pause.setPause(paused: false) }
        } else {
            ask = .pauseAfterStep
        }
    }
}
