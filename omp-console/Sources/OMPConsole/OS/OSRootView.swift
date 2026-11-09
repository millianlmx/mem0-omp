// PROTOTYPE « OS agentique » (branche proto/os-fils) : la racine du nouveau paradigme.
// Le Radar en haut ; les fils à gauche (avec « Demander à l'OS… » en tête) ; le fil
// choisi au centre ; « Comprendre » en inspecteur à droite ; le Tri des décisions en
// feuille (⌘T). Activée par Présentation ▸ « Nouvelle interface (prototype) » (⌘⇧O),
// préférence `ui.os`.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSRootView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var history: HarnessRunsHistory
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var atlassian: AtlassianModel
    @StateObject private var workspace: OSWorkspace
    @AppStorage("ui.os") private var osMode = false
    /// Ouvre une section de l'interface classique (une commande de la palette qui n'a pas d'équivalent ici).
    let select: @MainActor (ConsoleSection) -> Void

    init(server: HarnessModel, drafts: HarnessDrafts, select: @escaping @MainActor (ConsoleSection) -> Void) {
        self.server = server
        self.drafts = drafts
        self.select = select
        _workstation = ObservedObject(wrappedValue: server.workstation)
        _intakes = ObservedObject(wrappedValue: server.intakes)
        _history = ObservedObject(wrappedValue: server.history)
        _vigie = ObservedObject(wrappedValue: server.vigie)
        _atlassian = ObservedObject(wrappedValue: server.atlassian)
        _workspace = StateObject(wrappedValue: OSWorkspace(server: server))
    }

    private var threads: [OSThread] {
        OSThreads.build(
            runs: history.runs,
            inbox: server.inbox,
            projects: server.projects,
            audits: server.audits,
            requests: workstation.requests ?? [],
            incidents: vigie.incidents
        )
    }

    /// Le nom de chaque navigateur du poste, par identifiant.
    private var browserNames: [String: String] {
        Dictionary((workstation.status?.browsers ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    }

    /// Les lieux où l'OS travaille : les dépôts déclarés (et ceux des fils), puis le Poste.
    private func places(_ threads: [OSThread]) -> [String] {
        let repos = Set(server.repos.map(\.name) + threads.compactMap(\.repo)).sorted()
        return repos + (threads.contains { !$0.requests.isEmpty } ? [OSWorkspace.postePlace] : [])
    }

    /// Les fils du lieu retenu.
    private func filtered(_ threads: [OSThread]) -> [OSThread] {
        guard let place = workspace.place else { return threads }
        if place == OSWorkspace.postePlace { return threads.filter { !$0.requests.isEmpty } }
        return threads.filter { $0.repo == place }
    }

    var body: some View {
        let threads = threads
        let decisions = OSDecision.all(server: server, workstation: workstation)
        VStack(spacing: 0) {
            OSRadar(server: server, workstation: workstation, vigie: vigie, pulse: workspace.pulse, workspace: workspace, threads: threads)
            Divider()
            NavigationSplitView {
                OSSidebar(
                    server: server, intakes: intakes, pulse: workspace.pulse, workspace: workspace,
                    threads: filtered(threads), places: places(threads), browsers: browserNames, decisions: decisions.count
                )
                .navigationSplitViewColumnWidth(min: 260, ideal: 320)
            } detail: {
                detail(threads, decisions: decisions.count)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                // ⌘N (Fichier ▸ Nouvelle feature…) ouvre la même feuille.
                Menu {
                    Button(OSText.newFeature, systemImage: "plus.square") { drafts.launchSheetShown = true }
                    Button(OSText.newProject, systemImage: "square.stack.3d.up") { drafts.projectSheetShown = true }
                    Button(OSText.newAudit, systemImage: "magnifyingglass") { drafts.auditSheetShown = true }
                    Button(OSText.newSchedule, systemImage: "calendar.badge.plus") { drafts.scheduleSheetShown = true }
                } label: {
                    Label(OSText.create, systemImage: "plus")
                }
                .disabled(!server.canAct)
            }
            ToolbarItem(placement: .primaryAction) {
                Button {
                    workspace.understanding.toggle()
                } label: {
                    Label(OSText.understand, systemImage: "sidebar.right")
                }
                .keyboardShortcut("i", modifiers: [.command, .option])
            }
            ToolbarItem(placement: .automatic) {
                Button(OSText.classic) { osMode = false }
            }
        }
        .navigationTitle(workspace.selection == OSWorkspace.automations ? OSText.automations : threads.first { $0.id == workspace.selection }?.title ?? OSText.now)
        // Les feuilles de création (nouvelle feature ⌘N, projet, audit, planification, Demande) et la
        // palette ⌘K : celles de l'interface classique. Une commande vers une section classique y bascule.
        .consolePalette(server: server, drafts: drafts, sections: ConsoleSection.allCases, memory: true) { section in
            if section == .runs, drafts.openedRun != nil { return }
            osMode = false
            select(section)
        }
        .sheet(isPresented: $workspace.triage) {
            OSTriageSheet(server: server, workstation: workstation, intakes: intakes, workspace: workspace)
        }
        .task(id: server.address) {
            guard server.isConfigured else { return }
            workspace.pulse.start()
            // Recette du prototype : ouvrir un fil et « Comprendre » au lancement (captures).
            let environment = ProcessInfo.processInfo.environment
            if let thread = environment["OMP_CONSOLE_OS_THREAD"] { workspace.open(thread) }
            if let run = environment["OMP_CONSOLE_OS_RUN"] { drafts.openedRun = run }
            if environment["OMP_CONSOLE_OS_NEW"] != nil { drafts.launchSheetShown = true }
            if let level = environment["OMP_CONSOLE_OS_LEVEL"].flatMap(OSText.Level.init(rawValue:)) {
                workspace.level = level
                workspace.understanding = true
            }
            if environment["OMP_CONSOLE_OS_TRIAGE"] != nil { workspace.triage = true }
            await history.refresh()
            await workstation.load()
            await vigie.load()
            await intakes.refresh()
            await atlassian.refresh()
            await server.refreshCatalog()
        }
        // Un lien `ompconsole://runs/<id>` ou une notification touchée : le fil de la feature.
        .onChange(of: (drafts.openedRun ?? "") + "|\(history.runs.count)", initial: true) {
            guard let runId = drafts.openedRun,
                  let thread = threads.first(where: { $0.runs.contains { $0.id == runId } }) else { return }
            workspace.open(thread.id)
            drafts.openedRun = nil
        }
        .onDisappear { workspace.pulse.stop() }
    }

    @ViewBuilder
    private func detail(_ threads: [OSThread], decisions: Int) -> some View {
        let thread = threads.first { $0.id == workspace.selection }
        Group {
            if workspace.selection == OSWorkspace.automations {
                OSAutomationsView(server: server, drafts: drafts)
            } else if let thread {
                OSThreadView(
                    server: server, workstation: workstation, intakes: intakes, pulse: workspace.pulse, workspace: workspace,
                    thread: thread, browsers: browserNames
                )
                .id(thread.id)
            } else {
                OSHomeView(server: server, pulse: workspace.pulse, workspace: workspace, threads: threads, decisions: decisions)
            }
        }
        .inspector(isPresented: $workspace.understanding) {
            Group {
                if let runId = workspace.focusRunId ?? thread?.focusRun?.id {
                    OSUnderstandView(server: server, drafts: drafts, workspace: workspace, runId: runId)
                        .id(runId)
                } else {
                    ContentUnavailableView(OSText.noRun, systemImage: "questionmark.circle")
                }
            }
            .inspectorColumnWidth(min: 340, ideal: 460, max: 720)
        }
    }
}

/// Le TRI : les décisions une à une, en grand ; ⏎ prend le geste principal, → passe.
struct OSTriageSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var workspace: OSWorkspace
    @Environment(\.dismiss) private var dismiss
    @State private var skipped: Set<String> = []

    var body: some View {
        let all = OSDecision.all(server: server, workstation: workstation)
        let queue = all.filter { !skipped.contains($0.id) }
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(OSText.triage).font(.title2.weight(.bold))
                Spacer()
                Text(queue.isEmpty ? "" : "1 / \(queue.count)").foregroundStyle(.secondary).monospacedDigit()
            }
            if let current = queue.first {
                OSDecisionCard(server: server, workstation: workstation, intakes: intakes, workspace: workspace, decision: current, large: true)
                    .id(current.id)
                HStack {
                    Button("Passer →") { skipped.insert(current.id) }
                        .keyboardShortcut(.rightArrow, modifiers: [])
                    Spacer()
                    if let runId = current.runId {
                        Button(OSText.understand + " ↑") {
                            dismiss()
                            workspace.understand(runId: runId, level: .summary)
                        }
                        .keyboardShortcut(.upArrow, modifiers: [])
                    }
                }
                .foregroundStyle(.secondary)
            } else {
                ContentUnavailableView(OSText.nothing, systemImage: "checkmark.circle")
            }
            HStack {
                Spacer()
                Button("OK") { dismiss() }.keyboardShortcut(.cancelAction)
            }
        }
        .padding(24)
        .frame(width: 620)
        .frame(minHeight: 360)
    }
}
