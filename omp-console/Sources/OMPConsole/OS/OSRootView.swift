// L'« OS agentique » sur le Mac : la COQUE de l'interface. Le Radar en haut ; les fils à
// gauche (avec « Demander à l'OS… » en tête, l'espace et le lieu, les entrées fixes, et
// « Outils » au pied) ; au centre « Maintenant », les Propositions, le Savoir, les
// Automatismes, la page d'un espace, le fil choisi ou un outil (un écran classique, ouvert
// ici : `OSToolDetail`) ; « Comprendre » en panneau à droite du détail quand la fenêtre est
// assez large, en FEUILLE sinon (`OSShellLayout` : la colonne d'un inspecteur natif
// plantait l'app dans une fenêtre étroite) ; le Tri des décisions en feuille (⌘T). Les écrans eux-mêmes sont partagés
// avec l'iPhone/iPad (`ConsoleUI/OS/`) : ce fichier ne porte que ce qui est propre au Mac —
// colonnes, inspecteur, barre d'outils, raccourcis (⌘L composeur, ⌘T tri, ⌘⇧P pause, ⌥⌘I
// « Comprendre »), presse-papiers, direct d'une session, variables de recette. Rien ici
// n'écrit la préférence d'interface : ce qui visait une section classique (palette, lien,
// notification, ⌘1…⌘5) arrive par `ConsoleModel.osRoute` et ouvre un écran d'ici.

import AppKit
import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct OSRootView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// L'état de la coque à l'échelle de l'app : l'écran qu'un raccourci, un lien ou une notification demande.
    @ObservedObject var console: ConsoleModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var intakes: HarnessIntakes
    @ObservedObject var history: HarnessRunsHistory
    @ObservedObject var vigie: HarnessVigie
    @ObservedObject var atlassian: AtlassianModel
    @ObservedObject var spaces: HarnessSpacesModel
    @ObservedObject var localSessions: HarnessLocalSessionsModel
    @ObservedObject var proposals: HarnessProposalsModel
    @StateObject private var workspace: OSWorkspace
    /// Où « Comprendre » se présente et la largeur de son panneau, selon la fenêtre ; `nil`
    /// tant qu'elle n'est pas mesurée (rien ne s'ouvre avant).
    @State private var layout: OSShellLayout?
    /// L'écran classique d'un outil, rendu par la racine (elle tient les modèles locaux).
    let tool: @MainActor (OSTool) -> AnyView

    /// Recette : `OMP_CONSOLE_OS_VIEW` nomme l'écran du centre ; `space:<identifiant ou nom>`
    /// ouvre la page d'un espace, `tool:<outil>` un outil (`memory`, `workstation`, `health`,
    /// `admin`, `server`, `terminal`, `files`).
    private static let recipeViews = ["now": OSWorkspace.now, "proposals": OSWorkspace.proposals, "knowledge": OSWorkspace.knowledge, "automations": OSWorkspace.automations]
    private static let recipeSpacePrefix = "space:"

    init(server: HarnessModel, drafts: HarnessDrafts, console: ConsoleModel, tool: @escaping @MainActor (OSTool) -> AnyView) {
        self.server = server
        self.drafts = drafts
        self.console = console
        self.tool = tool
        _workstation = ObservedObject(wrappedValue: server.workstation)
        _intakes = ObservedObject(wrappedValue: server.intakes)
        _history = ObservedObject(wrappedValue: server.history)
        _vigie = ObservedObject(wrappedValue: server.vigie)
        _atlassian = ObservedObject(wrappedValue: server.atlassian)
        _spaces = ObservedObject(wrappedValue: server.spaces)
        _localSessions = ObservedObject(wrappedValue: server.localSessions)
        _proposals = ObservedObject(wrappedValue: server.proposals)
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
                    browsers: browserNames, decisions: decisions, tools: OSTool.available(isAdmin: server.isAdmin)
                )
                .listStyle(.sidebar)
                .navigationSplitViewColumnWidth(min: OSShellLayout.sidebarMin, ideal: OSShellLayout.sidebarIdeal, max: OSShellLayout.sidebarMax)
            } detail: {
                detailAndInspector(threads, decisions: decisions)
            }
        }
        // La largeur de la fenêtre décide d'où « Comprendre » se présente ; l'état ne change
        // qu'au franchissement d'un seuil, pas à chaque point d'un redimensionnement.
        .onGeometryChange(for: OSShellLayout.self) { proxy in
            OSShellLayout(width: proxy.size.width)
        } action: { measured in
            layout = measured
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                // ⌘N (Fichier ▸ Nouveau fil…) ouvre la même feuille.
                Menu {
                    Button(OSText.newThread, systemImage: "plus.square") { drafts.launchSheetShown = true }
                    Button(OSText.newProject, systemImage: "square.stack.3d.up") { drafts.projectSheetShown = true }
                    Button(OSText.newAudit, systemImage: "magnifyingglass") { drafts.auditSheetShown = true }
                    Button(OSText.newSchedule, systemImage: "calendar.badge.plus") { drafts.scheduleSheetShown = true }
                } label: {
                    Label(OSText.create, systemImage: "plus")
                }
                .disabled(!server.canAct)
            }
            // « Comprendre » regarde une tâche : pas devant un outil.
            if OSTool(selection: workspace.selection) == nil {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        workspace.understanding.toggle()
                    } label: {
                        Label(OSText.understand, systemImage: "sidebar.right")
                    }
                    .keyboardShortcut("i", modifiers: [.command, .option])
                }
            }
        }
        .navigationTitle(title(threads))
        // Les feuilles de création (nouveau fil ⌘N, projet, audit, planification, Demande) et la
        // palette ⌘K : elle propose les écrans d'ici ; une commande qui nomme encore une section
        // classique (une feature, la mémoire à chercher, l'arrêt du poste) ouvre l'écran d'ici.
        .consolePalette(
            server: server, drafts: drafts, sections: ConsoleSection.allCases, memory: true,
            screens: paletteScreens, openScreen: { open(screen: $0) }
        ) { section in
            let route = OSRouter.route(section: section, page: drafts.systemPage, opensRun: drafts.openedRun != nil)
            if section == .system { drafts.systemPage = nil }
            if let route { apply(route) }
        }
        .sheet(isPresented: $workspace.triage) {
            OSTriageView(server: server, workstation: workstation, intakes: intakes, workspace: workspace)
                .frame(width: 620)
                .frame(minHeight: 360)
        }
        // « Comprendre » en feuille : la fenêtre est trop étroite pour un inspecteur.
        .sheet(isPresented: understandSheetShown) {
            NavigationStack {
                understand(threads)
                    .navigationTitle(OSText.understand)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button(PipelineServerText.close) { workspace.understanding = false }
                                .keyboardShortcut(.cancelAction)
                        }
                    }
            }
            .frame(minWidth: 560, idealWidth: 640, minHeight: 520, idealHeight: 680)
        }
        // La connexion au serveur (palette, « Relier » d'un outil, lien `ompconsole://system/server`).
        .sheet(isPresented: $drafts.serverSheetShown) {
            ServerSheet(server: server, drafts: drafts)
        }
        .task(id: server.address) {
            guard server.isConfigured else { return }
            workspace.pulse.start()
            // Recette : ouvrir un fil et « Comprendre » au lancement (captures).
            let environment = ProcessInfo.processInfo.environment
            if let thread = environment["OMP_CONSOLE_OS_THREAD"] { workspace.open(thread) }
            if let run = environment["OMP_CONSOLE_OS_RUN"] { drafts.openedRun = run }
            if environment["OMP_CONSOLE_OS_NEW"] != nil { drafts.launchSheetShown = true }
            if let level = environment["OMP_CONSOLE_OS_LEVEL"].flatMap({ OSLevel(recipe: $0) }) {
                workspace.level = level
                workspace.understanding = true
            }
            if environment["OMP_CONSOLE_OS_TRIAGE"] != nil { workspace.triage = true }
            if let view = environment["OMP_CONSOLE_OS_VIEW"] {
                if let screen = Self.recipeViews[view] { workspace.selection = screen }
                if let shown = OSTool(selection: view) { workspace.selection = shown.selection }
            }
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
        // Ce qu'un raccourci (⌘1…⌘5), un lien d'une section classique ou une notification demande.
        .onChange(of: console.osRoute, initial: true) {
            guard let route = console.osRoute else { return }
            console.osRoute = nil
            apply(route)
        }
        // Les liens propres à cette interface : `ompconsole://now`, `ompconsole://decisions`,
        // `ompconsole://threads/<id>` (ceux des sections classiques passent par la racine).
        .onOpenURL { url in
            if let route = OSRouter.route(host: url.host) {
                apply(route)
            } else if url.host == "threads", let thread = url.pathComponents.dropFirst().first {
                workspace.open(thread)
            }
        }
        .onDisappear { workspace.pulse.stop() }
    }

    /// Montre ce qu'une route désigne ; un écran que ce serveur ne sert pas retombe sur « Maintenant ».
    private func apply(_ route: OSRoute) {
        switch OSRouter.resolve(route, proposalsServed: proposals.isServed, isAdmin: server.isAdmin) {
        case let .screen(selection): workspace.selection = selection
        case .triage: workspace.triage = true
        }
    }

    /// Les écrans que la palette propose : ceux de ⌘1…⌘5, puis les outils.
    private var paletteScreens: [ConsolePaletteScreen] {
        let screens = OSScreen.allCases.filter { $0 != .proposals || proposals.isServed }
        return screens.map { ConsolePaletteScreen(id: $0.rawValue, title: $0.title, symbol: $0.symbol) }
            + OSTool.available(isAdmin: server.isAdmin).map {
                ConsolePaletteScreen(id: $0.selection, title: $0.title, subtitle: ConsoleSectionGroup.tools.title, symbol: $0.symbol)
            }
    }

    /// Ouvre l'écran qu'une entrée de la palette nomme : un écran de ⌘1…⌘5, ou un outil.
    private func open(screen id: String) {
        if let screen = OSScreen(rawValue: id) {
            apply(screen.route)
        } else if let shown = OSTool(selection: id) {
            apply(.screen(shown.selection))
        }
    }

    /// « Comprendre » est demandé, et le détail montre de quoi comprendre (pas un outil).
    private var understandingShown: Bool {
        workspace.understanding && OSTool(selection: workspace.selection) == nil
    }

    /// « Comprendre » est demandé et la fenêtre le veut en feuille ; le tri, lui aussi en
    /// feuille, passe d'abord.
    private var understandSheetShown: Binding<Bool> {
        Binding(
            get: { understandingShown && layout?.placement == .sheet && !workspace.triage },
            set: { shown in
                if !shown { workspace.understanding = false }
            }
        )
    }

    /// « Comprendre » sur la tâche regardée : celle qu'un geste a désignée, sinon celle du fil ouvert.
    @ViewBuilder
    private func understand(_ threads: [OSThread]) -> some View {
        if let runId = workspace.focusRunId ?? threads.first(where: { $0.id == workspace.selection })?.focusRun?.id {
            // Le direct d'une session est celui de la coque Mac (`HarnessSessionContent`) ; la
            // frise se lit seule, sans l'état du direct.
            OSUnderstandView(server: server, drafts: drafts, workspace: workspace, runId: runId) { [server] runId, pane, followsEnd, focus in
                if pane == .timeline { return AnyView(HarnessTimelinePane(server: server, runId: runId, refreshKey: 0)) }
                return AnyView(HarnessSessionContent(server: server, target: .run(runId), pane: pane.macPane, followsEnd: followsEnd, focus: focus))
            }
            .id(runId)
        } else {
            ContentUnavailableView(OSText.noRun, systemImage: "questionmark.circle")
        }
    }

    /// L'espace qu'une variable de recette nomme, par identifiant ou par nom.
    private func recipeSpace(_ name: String?) -> HarnessSpace? {
        guard let name else { return nil }
        return spaces.spaces.first { $0.id == name } ?? spaces.spaces.first { $0.name == name }
    }

    /// Le titre de la fenêtre : ce que montre le centre.
    private func title(_ threads: [OSThread]) -> String {
        if let shown = OSTool(selection: workspace.selection) { return shown.title }
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
            if let shown = OSTool(selection: workspace.selection) {
                tool(shown)
                    .id(shown)
            } else if workspace.selection == OSWorkspace.automations {
                OSAutomationsView(server: server, drafts: drafts)
            } else if workspace.selection == OSWorkspace.proposals {
                OSProposalsView(server: server, workspace: workspace, threads: threads)
            } else if workspace.selection == OSWorkspace.knowledge {
                OSKnowledgeView(server: server, workspace: workspace, openMemory: { apply(.screen(OSTool.memory.selection)) })
            } else if let spaceId = OSWorkspace.spaceId(of: workspace.selection) {
                OSSpacePage(server: server, spaceId: spaceId) { text in
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(text, forType: .string)
                }
                .id(spaceId)
            } else if let thread {
                OSThreadView(
                    server: server, workstation: workstation, intakes: intakes, pulse: workspace.pulse, workspace: workspace,
                    thread: thread, browsers: browserNames, drafts: drafts
                )
                .id(thread.id)
            } else {
                OSHomeView(server: server, pulse: workspace.pulse, workspace: workspace, threads: threads, decisions: decisions)
            }
        }
    }

    /// Le détail et, quand la fenêtre en a la place, « Comprendre » en panneau à sa droite.
    /// Ce n'est PAS l'inspecteur natif : sa colonne, ajoutée à la vue scindée de la fenêtre,
    /// plantait l'app quand les trois colonnes ne tenaient pas (`OSShellLayout`).
    private func detailAndInspector(_ threads: [OSThread], decisions: Int) -> some View {
        HStack(spacing: 0) {
            detail(threads, decisions: decisions)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            if let layout, layout.placement == .inspector, understandingShown {
                Divider()
                understand(threads)
                    .frame(width: layout.inspectorWidth)
                    .frame(maxHeight: .infinity)
                    .accessibilityIdentifier("os.understand")
            }
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
