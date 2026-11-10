// L'« OS agentique » : la carte BLOQUÉ d'une feature retenue en file. La cause en une
// ligne, puis ce qui la lève : la feature qui bloque (modules partagés, parent non
// fusionné) avec « Ouvrir », « Restreindre les modules… » (une ligne par chemin), l'heure
// de reprise d'une relance différée, « Reprendre » quand tout est suspendu, le plafond de
// l'espace quand son budget du jour est atteint — et « Arrêter… ».

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSRunBlockedCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var spaces: HarnessSpacesModel
    let run: HarnessRun
    let open: @MainActor (String) -> Void
    let stop: @MainActor () -> Void
    let failed: @MainActor () -> Void
    @State private var restricting = false
    @State private var resuming = false

    /// `open` : ouvre la feature qui bloque (son identifiant). `stop` : ouvre l'arrêt motivé.
    /// `failed` : un geste a été refusé (`server.pause.failure` ou `server.failure` dit pourquoi).
    public init(
        server: HarnessModel, run: HarnessRun, open: @escaping @MainActor (String) -> Void, stop: @escaping @MainActor () -> Void,
        failed: @escaping @MainActor () -> Void = {}
    ) {
        self.server = server
        spaces = server.spaces
        self.run = run
        self.open = open
        self.stop = stop
        self.failed = failed
    }

    private var cause: String { run.waitCause ?? "" }

    public var body: some View {
        let gestures = server.osGestures(run)
        OSCard(tint: .secondary, emphasized: true) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "pause.circle.fill")
                    Text(SessionGraphText.blocked.uppercased())
                    Text("·")
                    Text(OSThreads.clean(run.title).title).lineLimit(1)
                }
                .font(.caption2.weight(.bold))
                .foregroundStyle(.secondary)
                Text(OSDecideText.waitCause(cause))
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                detail
                OSLine(spacing: 8) {
                    if cause == "paused", server.osFeatures.contains(OSCapability.pause), server.canAct {
                        Button(OSDecideText.resume, systemImage: "play.fill", action: resume)
                            .buttonStyle(.borderedProminent)
                            .disabled(resuming)
                    }
                    if gestures.modules, cause == "modules" {
                        Button(OSDecideText.restrictModules) { restricting = true }
                    }
                    if gestures.stop {
                        Button(OSDecideText.stop, action: stop)
                    }
                    Spacer()
                }
            }
        }
        .sheet(isPresented: $restricting) {
            OSRunModulesSheet(server: server, run: run)
        }
        .task(id: cause) {
            if cause == "space_budget", spaces.availability == .unknown { await spaces.refresh() }
        }
    }

    /// Ce qui retient, au-delà de la cause : qui, jusqu'à quand, ou combien.
    @ViewBuilder
    private var detail: some View {
        switch cause {
        case "modules", "parent":
            ForEach(run.blockedBy) { blocker in
                // Sur le Mac, tout tient sur une ligne ; sur l'iPhone, l'état passe sous le titre.
                #if os(macOS)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    OSPhaseMark(phase: Self.phase(blocker.state), size: 11)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(OSThreads.clean(blocker.title).title).lineLimit(1)
                        if !blocker.modules.isEmpty {
                            Text(blocker.modules.joined(separator: " · "))
                                .font(.caption.monospaced())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer()
                    Text(Self.phase(blocker.state).label).font(.caption).foregroundStyle(.secondary)
                    Button(OSDecideText.open) { open(blocker.runId) }
                }
                #else
                HStack(alignment: .center, spacing: 8) {
                    OSPhaseMark(phase: Self.phase(blocker.state), size: 11)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(OSThreads.clean(blocker.title).title).lineLimit(2)
                        Text(([Self.phase(blocker.state).label] + blocker.modules).joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    Button(OSDecideText.open) { open(blocker.runId) }
                        .osRowButton()
                }
                #endif
            }
        case "backoff":
            if let until = run.waitUntil ?? run.notBefore {
                Label(PipelineServerText.resumeAt(ConsoleFormat.time(ms: until.timeIntervalSince1970 * 1000)), systemImage: "clock")
                    .foregroundStyle(.secondary)
            }
        case "space_budget":
            if let space = spaces.space(ofRepo: run.repo), let ceiling = space.dailyBudgetUsd {
                Label(OSDecideText.spaceCeiling(space.name, ceiling: ceiling), systemImage: "dollarsign.circle")
                    .foregroundStyle(.secondary)
            }
        case "paused", "inferring":
            EmptyView()
        default:
            // La phrase du serveur (« slots runner pleins 5/5 ») précise les causes d'admission.
            if let reason = run.reason, !reason.isEmpty {
                Text(OSThreads.firstLine(reason)).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }

    /// La phase d'une feature qui bloque, d'après son état brut.
    private static func phase(_ state: String) -> OSPhase {
        switch HarnessRunState(rawValue: state) {
        case .queued: .queued
        case .escalated, .awaitingHuman: .yours
        case .merged: .done
        case .failed: .failed
        case .cancelled: .stopped
        case .running, .merging, nil: .working
        }
    }

    private func resume() {
        resuming = true
        Task {
            if await !server.pause.setPause(paused: false) { failed() }
            resuming = false
        }
    }
}

/// « Restreindre les modules… » : les chemins que la feature touchera, un par ligne. Des
/// modules plus étroits ne recoupent plus ceux de la feature qui bloque : elle part.
public struct OSRunModulesSheet: View {
    @ObservedObject var server: HarnessModel
    let run: HarnessRun
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var working = false
    @State private var failed = false

    public init(server: HarnessModel, run: HarnessRun) {
        self.server = server
        self.run = run
        _text = State(initialValue: run.modules.joined(separator: "\n"))
    }

    private var modules: [String] { HarnessFeatureDraft.modules(of: text) }

    public var body: some View {
        NavigationStack {
            Form {
                if failed, let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                Section {
                    TextEditor(text: $text)
                        .font(.body.monospaced())
                        .frame(minHeight: 110)
                        .consolePlainInput()
                        .accessibilityLabel(OSDecideText.modulesPrompt)
                } header: {
                    Text(OSDecideText.modulesPrompt)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(OSDecideText.modulesTitle(OSThreads.clean(run.title).title))
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(OSText.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(MemoryText.save, action: save)
                        .disabled(working || modules.isEmpty || modules == run.modules)
                }
            }
        }
        .consoleSheetSize(minWidth: 420, minHeight: 280)
    }

    private func save() {
        working = true
        failed = false
        Task {
            let ok = await server.setModules(runId: run.id, modules: modules)
            working = false
            failed = !ok
            if ok { dismiss() }
        }
    }
}
