// L'« OS agentique » : la carte EN ATTENTE d'une tâche retenue en file. Une phrase de
// l'app dit pourquoi, tirée du CODE de la cause (jamais la phrase du serveur) : « Attend
// la fin de « X » (même zone du code) », « Reprend à 14:05 », « Client Acme est
// suspendu », « Budget du jour de Client Acme atteint »… Puis ce qu'il y a à faire : rien
// (« Rien à faire, ça partira seul »). Les gestes sont discrets : « Ouvrir « X » » (le fil
// attendu), « Reprendre » quand tout est suspendu ; « Restreindre les modules… »,
// l'autonomie et « Arrêter… » vivent dans le menu « … ».

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSRunBlockedCard: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var spaces: HarnessSpacesModel
    @ObservedObject var pause: HarnessPauseModel
    let run: HarnessRun
    /// Le titre de la tâche, quand son fil en a plusieurs.
    let title: String?
    let open: @MainActor (String) -> Void
    let stop: @MainActor () -> Void
    let failed: @MainActor () -> Void
    @State private var restricting = false
    @State private var resuming = false

    /// `open` : ouvre le fil attendu (l'identifiant de sa tâche). `stop` : ouvre l'arrêt
    /// motivé. `failed` : un geste a été refusé (`server.pause.failure` ou `server.failure`
    /// dit pourquoi). `title` : le titre de la tâche, dans un fil qui en a plusieurs.
    public init(
        server: HarnessModel, run: HarnessRun, open: @escaping @MainActor (String) -> Void, stop: @escaping @MainActor () -> Void,
        failed: @escaping @MainActor () -> Void = {}, title: String? = nil
    ) {
        self.server = server
        spaces = server.spaces
        pause = server.pause
        self.run = run
        self.title = title
        self.open = open
        self.stop = stop
        self.failed = failed
    }

    private var cause: String { run.waitCause ?? "" }

    public var body: some View {
        let gestures = server.osGestures(run)
        let line = OSWaitLine.of(run, space: spaces.space(ofRepo: run.repo), globalPause: pause.isPaused)
        OSCard(tint: .secondary, emphasized: true) {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    OSPhaseMark(phase: .queued, size: 14)
                    Text(OSDecideText.cardWaiting).font(.headline)
                    if let title {
                        Text(title).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    moreMenu(gestures)
                }
                Text(line.headline)
                    .fixedSize(horizontal: false, vertical: true)
                if let hint = line.hint {
                    Text(hint).font(.callout).foregroundStyle(.secondary)
                }
                if !run.blockedBy.isEmpty || canResume {
                    OSLine(spacing: 8) {
                        if canResume {
                            Button(OSWatchText.resume, systemImage: "play.fill", action: resume)
                                .disabled(resuming)
                        }
                        blockers
                        Spacer()
                    }
                }
            }
        }
        .sheet(isPresented: $restricting) {
            OSRunModulesSheet(server: server, run: run)
        }
        .task(id: cause) {
            if spaces.availability == .unknown { await spaces.refresh() }
            if cause == "paused", pause.availability == .unknown { await pause.refresh() }
        }
    }

    /// « Reprendre » : la pause de tout le serveur se lève d'ici ; celle d'un espace, depuis le Radar.
    private var canResume: Bool {
        cause == "paused" && pause.isPaused && server.osFeatures.contains(OSCapability.pause) && server.canAct
    }

    /// « Ouvrir « X » » : le fil dont on attend la fin (ou la livraison) ; à plusieurs, un bouton chacun.
    @ViewBuilder
    private var blockers: some View {
        ForEach(run.blockedBy.prefix(3)) { blocker in
            Button(OSDecideText.openThread(OSThreads.clean(blocker.title).title)) { open(blocker.runId) }
                .lineLimit(1)
        }
    }

    /// Le menu « … » : restreindre les modules (pour ne plus recouper le fil attendu),
    /// l'autonomie, l'arrêt motivé.
    @ViewBuilder
    private func moreMenu(_ gestures: OSRunGestures) -> some View {
        let restricts = gestures.modules && cause == "modules"
        if restricts || gestures.autonomy || gestures.stop {
            Menu {
                if restricts {
                    Button(OSDecideText.restrictModules, systemImage: "square.dashed") { restricting = true }
                }
                OSAutonomyMenu(server: server, runs: [run], failed: failed)
                if gestures.stop {
                    Button(OSDecideText.stop, systemImage: "stop.circle", role: .destructive, action: stop)
                }
            } label: {
                Label(OSDecideText.more, systemImage: "ellipsis.circle")
                    .labelStyle(.iconOnly)
                    .frame(minWidth: ConsolePlatform.minimumTarget, minHeight: ConsolePlatform.minimumTarget)
            }
            .menuIndicator(.hidden)
            .buttonStyle(.borderless)
            .fixedSize()
        }
    }

    private func resume() {
        resuming = true
        Task {
            if await !pause.setPause(paused: false) { failed() }
            resuming = false
        }
    }
}

/// « Restreindre les modules… » : les chemins que la tâche touchera, un par ligne. Des
/// modules plus étroits ne recoupent plus ceux du fil attendu : elle part.
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
