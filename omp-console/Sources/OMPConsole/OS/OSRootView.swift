// L'« OS agentique » sur le Mac : la COQUE de l'interface par défaut. Le Radar en haut ;
// les fils à gauche (avec « Demander à l'OS… » en tête, l'espace et le lieu, les entrées
// fixes) ; au centre « Maintenant », les Propositions, le Savoir, les Automatismes, la
// page d'un espace ou le fil choisi ; « Comprendre » en inspecteur à droite ; le Tri des
// décisions en feuille (⌘T). Les écrans eux-mêmes sont partagés avec l'iPhone/iPad
// (`ConsoleUI/OS/`) : ce fichier ne porte que ce qui est propre au Mac — colonnes,
// inspecteur, barre d'outils, raccourcis (⌘L composeur, ⌘T tri, ⌘⇧P pause, ⌥⌘I
// inspecteur), presse-papiers, direct d'une session, variables de recette. L'interface
// classique reste à un geste : Présentation ▸ « Interface classique » (⌘⇧O), préférence
// `ui.os`.

import AppKit
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
    @ObservedObject var spaces: HarnessSpacesModel
    @ObservedObject var localSessions: HarnessLocalSessionsModel
    @StateObject private var workspace: OSWorkspace
    @AppStorage("ui.os") private var osMode = true
    /// Un lien ou une notification demande ce qui attend l'humain : le tri s'ouvre.
    @Binding var triageRequested: Bool
    /// Ouvre une section de l'interface classique (une commande de la palette qui n'a pas d'équivalent ici).
    let select: @MainActor (ConsoleSection) -> Void

    /// Recette : `OMP_CONSOLE_OS_LEVEL` nomme un niveau de « Comprendre » par son mot
    /// français, quelle que soit la langue de l'app (ou par son code : `summary`, `story`…).
    private static let recipeLevels: [String: OSLevel] = ["Résumé": .summary, "Récit": .story, "Preuves": .proofs, "Brut": .raw]
    /// Recette : `OMP_CONSOLE_OS_VIEW` nomme l'écran du centre ; `space:<identifiant ou nom>`
    /// ouvre la page d'un espace.
    private static let recipeViews = ["now": OSWorkspace.now, "proposals": OSWorkspace.proposals, "knowledge": OSWorkspace.knowledge, "automations": OSWorkspace.automations]
    private static let recipeSpacePrefix = "space:"

    init(
        server: HarnessModel, drafts: HarnessDrafts, triageRequested: Binding<Bool>,
        select: @escaping @MainActor (ConsoleSection) -> Void
    ) {
        self.server = server
        self.drafts = drafts
        _triageRequested = triageRequested
        self.select = select
        _workstation = ObservedObject(wrappedValue: server.workstation)
        _intakes = ObservedObject(wrappedValue: server.intakes)
        _history = ObservedObject(wrappedValue: server.history)
        _vigie = ObservedObject(wrappedValue: server.vigie)
        _atlassian = ObservedObject(wrappedValue: server.atlassian)
        _spaces = ObservedObject(wrappedValue: server.spaces)
        _localSessions = ObservedObject(wrappedValue: server.localSessions)
        _workspace = StateObject(wrappedValue: OSWorkspace(server: server))
    }

    private var threads: [OSThread] {
        OSThreads.build(
            runs: history.runs,
            inbox: server.inbox,
            projects: server.projects,
            audits: server.audits,
            requests: workstation.requests ?? [],
            incidents: vigie.incidents,
            localSessions: localSessions.sessions
        )
    }

    /// Le nom de chaque navigateur du poste, par identifiant.
    private var browserNames: [String: String] {
        Dictionary((workstation.status?.browsers ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        let threads = threads
        let decisions = OSDecisions.all(server: server).count
        let space = spaces.spaces.first { $0.id == workspace.spaceId }
        VStack(spacing: 0) {
            OSRadar(server: server, workstation: workstation, vigie: vigie, pulse: workspace.pulse, workspace: workspace, threads: threads)
            Divider()
            NavigationSplitView {
                OSThreadList(
                    server: server, intakes: intakes, pulse: workspace.pulse, workspace: workspace,
                    threads: OSThreadScope.threads(threads, spaceId: workspace.spaceId, place: workspace.place, spaces: spaces.spaces),
                    places: OSThreadScope.places(repos: server.repos.map(\.name), threads: threads, space: space),
                    browsers: browserNames, decisions: decisions
                )
                .listStyle(.sidebar)
                .navigationSplitViewColumnWidth(min: 260, ideal: 320)
            } detail: {
                detail(threads, decisions: decisions)
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
        }
        .navigationTitle(title(threads))
        // Les feuilles de création (nouvelle feature ⌘N, projet, audit, planification, Demande) et la
        // palette ⌘K : celles de l'interface classique. Une commande vers une section classique y bascule.
        .consolePalette(server: server, drafts: drafts, sections: ConsoleSection.allCases, memory: true) { section in
            if section == .runs, drafts.openedRun != nil { return }
            osMode = false
            select(section)
        }
        .sheet(isPresented: $workspace.triage) {
            OSTriageView(server: server, workstation: workstation, intakes: intakes, workspace: workspace)
                .frame(width: 620)
                .frame(minHeight: 360)
        }
        .task(id: server.address) {
            guard server.isConfigured else { return }
            workspace.pulse.start()
            // Recette : ouvrir un fil et « Comprendre » au lancement (captures).
            let environment = ProcessInfo.processInfo.environment
            if let thread = environment["OMP_CONSOLE_OS_THREAD"] { workspace.open(thread) }
            if let run = environment["OMP_CONSOLE_OS_RUN"] { drafts.openedRun = run }
            if environment["OMP_CONSOLE_OS_NEW"] != nil { drafts.launchSheetShown = true }
            if let level = environment["OMP_CONSOLE_OS_LEVEL"].flatMap({ Self.recipeLevels[$0] ?? OSLevel(rawValue: $0) }) {
                workspace.level = level
                workspace.understanding = true
            }
            if environment["OMP_CONSOLE_OS_TRIAGE"] != nil { workspace.triage = true }
            if let view = environment["OMP_CONSOLE_OS_VIEW"].flatMap({ Self.recipeViews[$0] }) { workspace.selection = view }
            await history.refresh()
            await workstation.load()
            await vigie.load()
            await intakes.refresh()
            await atlassian.refresh()
            await localSessions.refresh()
            await spaces.refresh()
            await server.refreshCatalog()
            // Recette : l'espace retenu dans la liste, et la page d'un espace (par identifiant ou par nom).
            if let chosen = recipeSpace(environment["OMP_CONSOLE_OS_SPACE"]) { workspace.choose(space: chosen) }
            if let view = environment["OMP_CONSOLE_OS_VIEW"], view.hasPrefix(Self.recipeSpacePrefix),
               let shown = recipeSpace(String(view.dropFirst(Self.recipeSpacePrefix.count))) {
                workspace.selection = OSWorkspace.space(shown.id)
            }
        }
        // Un lien `ompconsole://runs/<id>`, une notification touchée, une proposition acceptée : le
        // fil de la feature s'ouvre dès qu'il existe.
        .onChange(of: "\(drafts.openedRun ?? "")|\(workspace.pendingRunId ?? "")|\(threads.count)", initial: true) {
            if let runId = drafts.openedRun {
                drafts.openedRun = nil
                workspace.open(runId: runId, in: threads)
            } else {
                workspace.settle(threads)
            }
        }
        .onChange(of: triageRequested, initial: true) {
            guard triageRequested else { return }
            triageRequested = false
            workspace.triage = true
        }
        // Les liens propres à cette interface : `ompconsole://now`, `ompconsole://decisions`,
        // `ompconsole://threads/<id>` (ceux des sections classiques passent par la racine).
        .onOpenURL { url in
            switch url.host {
            case "now": workspace.selection = OSWorkspace.now
            case "decisions": workspace.triage = true
            case "threads":
                if let thread = url.pathComponents.dropFirst().first { workspace.open(thread) }
            default: break
            }
        }
        .onDisappear { workspace.pulse.stop() }
    }

    /// L'espace qu'une variable de recette nomme, par identifiant ou par nom.
    private func recipeSpace(_ name: String?) -> HarnessSpace? {
        guard let name else { return nil }
        return spaces.spaces.first { $0.id == name } ?? spaces.spaces.first { $0.name == name }
    }

    /// Le titre de la fenêtre : ce que montre le centre.
    private func title(_ threads: [OSThread]) -> String {
        switch workspace.selection {
        case OSWorkspace.automations: return OSText.automations
        case OSWorkspace.proposals: return OSWatchText.proposals
        case OSWorkspace.knowledge: return OSWatchText.knowledge
        default: break
        }
        if let id = OSWorkspace.spaceId(of: workspace.selection), let space = spaces.spaces.first(where: { $0.id == id }) {
            return space.name
        }
        return threads.first { $0.id == workspace.selection }?.title ?? OSText.now
    }

    @ViewBuilder
    private func detail(_ threads: [OSThread], decisions: Int) -> some View {
        let thread = threads.first { $0.id == workspace.selection }
        Group {
            if workspace.selection == OSWorkspace.automations {
                OSAutomationsView(server: server, drafts: drafts)
            } else if workspace.selection == OSWorkspace.proposals {
                OSProposalsView(server: server, workspace: workspace, threads: threads)
            } else if workspace.selection == OSWorkspace.knowledge {
                OSKnowledgeView(
                    server: server, workspace: workspace,
                    openMemory: {
                        osMode = false
                        select(.memory)
                    },
                    openClassic: { osMode = false }
                )
            } else if let spaceId = OSWorkspace.spaceId(of: workspace.selection) {
                OSSpacePage(server: server, spaceId: spaceId) { text in
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                }
                .id(spaceId)
            } else if let thread {
                OSThreadView(
                    server: server, workstation: workstation, intakes: intakes, pulse: workspace.pulse, workspace: workspace,
                    thread: thread, browsers: browserNames // drafts: drafts
                )
                .id(thread.id)
            } else {
                OSHomeView(server: server, pulse: workspace.pulse, workspace: workspace, threads: threads, decisions: decisions)
            }
        }
        .inspector(isPresented: $workspace.understanding) {
            Group {
                if let runId = workspace.focusRunId ?? thread?.focusRun?.id {
                    // Le direct d'une session est celui de la coque Mac (`HarnessSessionContent`).
                    OSUnderstandView(server: server, drafts: drafts, workspace: workspace, runId: runId) { [server] runId, pane, followsEnd, focus in
                        AnyView(HarnessSessionContent(server: server, target: .run(runId), pane: pane.macPane, followsEnd: followsEnd, focus: focus))
                    }
                    .id(runId)
                } else {
                    ContentUnavailableView(OSText.noRun, systemImage: "questionmark.circle")
                }
            }
            .inspectorColumnWidth(min: 340, ideal: 460, max: 720)
        }
    }
}

private extension OSSessionPane {
    /// Le panneau du direct de la coque Mac.
    var macPane: HarnessSessionPane {
        switch self {
        case .live: .live
        case .files: .files
        case .tests: .tests
        case .timeline: .timeline
        }
    }
}
