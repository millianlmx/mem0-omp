// L'« OS agentique » sur le Mac : la COQUE de l'app. Le Radar en haut ; les fils à gauche
// (avec « Demander à l'OS… » en tête, l'espace et le lieu, les entrées fixes, et au pied
// le badge des composants quand l'un manque) ; au centre « Maintenant », les Propositions,
// les Automatismes, le Savoir, la Mémoire, le hub Système et ses écrans, la page d'un
// espace ou le fil choisi ; « Comprendre » en inspecteur à droite ; le Tri des décisions
// en feuille (⌘T). Les écrans eux-mêmes sont partagés avec l'iPhone/iPad (`ConsoleUI/OS/`) :
// ce fichier ne porte que ce qui est propre au Mac — colonnes, inspecteur, barre d'outils,
// raccourcis (⌘1…⌘6 destinations, ⌘L composeur, ⌘T tri, ⌘⇧P pause, ⌥⌘I inspecteur, ⌘R
// actualiser), presse-papiers, direct d'une session, variables de recette.

import AppKit
import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

/// Ce que devient une destination nommée (lien, notification, palette, écran partagé) dans
/// l'OS du Mac. Pur : la coque l'applique, les tests le figent.
enum OSMacRoute: Equatable {
    /// Le tri des décisions (ce qui attend l'humain).
    case triage
    /// Une entrée fixe du centre (`OSWorkspace.memory`, `OSWorkspace.system`…).
    case center(String)
    /// Un écran du hub Système.
    case system(OSSystemDestination)
    /// La feuille du serveur.
    case serverSheet
    /// Rien à montrer de plus : le fil d'une feature s'ouvre par `drafts.openedRun`.
    case none

    static func of(_ section: ConsoleSection, page: SystemPage?) -> OSMacRoute {
        switch section {
        case .inbox: .triage
        case .runs: .none
        case .workstation: .system(.workstation)
        case .memory: .center(OSWorkspace.memory)
        case .system:
            switch page {
            case .server: .serverSheet
            case let page?: .system(OSSystemDestination(page))
            case nil: .center(OSWorkspace.system)
            }
        }
    }
}

/// Les entrées fixes du centre, dans l'ordre des raccourcis ⌘1…⌘6 (menu Présentation).
enum OSMacDestinations {
    static let shortcuts: [(selection: String, title: String)] = [
        (OSWorkspace.now, OSText.now),
        (OSWorkspace.proposals, OSWatchText.proposals),
        (OSWorkspace.automations, OSText.automations),
        (OSWorkspace.knowledge, OSWatchText.knowledge),
        (OSWorkspace.memory, OSWatchText.memory),
        (OSWorkspace.system, OSSystemText.title),
    ]
}

struct OSRootView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var spaces: HarnessSpacesModel
    /// Les fils et le compte des décisions, recalculés à part et publiés seulement s'ils
    /// changent : la racine ne les reconstruit pas à chaque rendu.
    @StateObject private var threadStore: OSThreadStore
    @StateObject private var workspace: OSWorkspace
    /// Portés sans être observés ici : leurs écrans les observent eux-mêmes.
    private let intakes: HarnessIntakes
    private let history: HarnessRunsHistory
    private let vigie: HarnessVigie
    private let atlassian: AtlassianModel
    private let localSessions: HarnessLocalSessionsModel
    /// La Mémoire du Mac, et la préparation des composants (badge au pied des fils) :
    /// portées sans être observées ici.
    let memory: OSMemoryModels
    let components: ComponentPresenceModel
    let setup: SetupModel

    /// Recette : `OMP_CONSOLE_OS_LEVEL` nomme un niveau de « Comprendre » par son mot
    /// français, quelle que soit la langue de l'app (ou par son code : `summary`, `story`…).
    private static let recipeLevels: [String: OSLevel] = ["Résumé": .summary, "Récit": .story, "Preuves": .proofs, "Brut": .raw]
    /// Recette : `OMP_CONSOLE_OS_VIEW` nomme l'écran du centre ; `space:<identifiant ou nom>`
    /// ouvre la page d'un espace, `system:<écran>` un écran du hub Système.
    private static let recipeViews = [
        "now": OSWorkspace.now, "proposals": OSWorkspace.proposals, "knowledge": OSWorkspace.knowledge,
        "automations": OSWorkspace.automations, "memory": OSWorkspace.memory, "system": OSWorkspace.system,
    ]
    private static let recipeSpacePrefix = "space:"
    private static let recipeSystemPrefix = "system:"

    init(server: HarnessModel, drafts: HarnessDrafts, memory: OSMemoryModels, components: ComponentPresenceModel, setup: SetupModel) {
        self.server = server
        self.drafts = drafts
        self.memory = memory
        self.components = components
        self.setup = setup
        _workstation = ObservedObject(wrappedValue: server.workstation)
        _spaces = ObservedObject(wrappedValue: server.spaces)
        intakes = server.intakes
        history = server.history
        vigie = server.vigie
        atlassian = server.atlassian
        localSessions = server.localSessions
        _threadStore = StateObject(wrappedValue: OSThreadStore(server: server))
        _workspace = StateObject(wrappedValue: OSWorkspace(server: server))
    }

    /// Le nom de chaque navigateur du poste, par identifiant.
    private var browserNames: [String: String] {
        Dictionary((workstation.status?.browsers ?? []).map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
    }

    var body: some View {
        let threads = threadStore.threads
        let decisions = threadStore.decisionCount
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
                .safeAreaInset(edge: .bottom, alignment: .leading) {
                    ComponentBadge(components: components, setup: setup)
                }
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
        // Les feuilles de création (nouvelle feature ⌘N, projet, audit, planification, Demande)
        // et la palette ⌘K : chaque commande y est montrée dans l'OS.
        .consolePalette(server: server, drafts: drafts, sections: ConsoleSection.allCases, memory: true) { go($0) }
        .sheet(isPresented: $workspace.triage) {
            OSTriageView(server: server, workstation: workstation, intakes: intakes, workspace: workspace)
                .frame(width: 620)
                .frame(minHeight: 360)
        }
        // ⌘R (Présentation ▸ Actualiser) relit ce que l'OS montre ; ⌘1…⌘6 y choisissent l'écran.
        .focusedSceneValue(\.harnessRefresh, HarnessRefreshAction(isEnabled: server.isConfigured && !server.isLoading) { await reload() })
        .focusedSceneObject(workspace)
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
            if let view = environment["OMP_CONSOLE_OS_VIEW"] {
                if let selection = Self.recipeViews[view] {
                    workspace.selection = selection
                } else if view.hasPrefix(Self.recipeSystemPrefix),
                          let destination = OSSystemDestination(rawValue: String(view.dropFirst(Self.recipeSystemPrefix.count))) {
                    workspace.open(destination)
                }
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
        // Une destination demandée par la racine (lien, notification) ou un écran partagé.
        .onChange(of: drafts.requestedSection, initial: true) {
            guard let section = drafts.requestedSection else { return }
            drafts.requestedSection = nil
            go(section)
        }
        // Les liens propres à cette interface : `ompconsole://now`, `ompconsole://decisions`,
        // `ompconsole://threads/<id>` (ceux des destinations passent par la racine).
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

    /// Montre une destination nommée dans l'OS (`OSMacRoute`).
    private func go(_ section: ConsoleSection) {
        let page = drafts.systemPage
        drafts.systemPage = nil
        switch OSMacRoute.of(section, page: page) {
        case .triage: workspace.triage = true
        case let .center(selection):
            workspace.selection = selection
            if selection == OSWorkspace.system { workspace.systemPath = NavigationPath() }
        case let .system(destination): workspace.open(destination)
        case .serverSheet: drafts.serverSheetShown = true
        case .none: break
        }
    }

    /// ⌘R : la boîte, le catalogue et l'historique, puis ce que montre le centre.
    private func reload() async {
        await server.refresh()
        await server.refreshCatalog()
        await history.refresh()
        await workstation.load()
        await vigie.load()
        await intakes.refresh()
        await localSessions.refresh()
        switch workspace.selection {
        case OSWorkspace.automations:
            await server.schedules.refresh()
            await atlassian.refresh()
        case OSWorkspace.knowledge:
            await server.rules.refresh()
            await server.autonomy.refresh()
            await spaces.refresh()
        case OSWorkspace.proposals:
            await server.proposals.refresh()
        case OSWorkspace.memory:
            await memory.model.refresh()
        case OSWorkspace.system:
            await server.schedules.refresh()
            await server.autonomy.refresh()
            if server.isAdmin { await server.admin.refresh() }
        default:
            break
        }
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
        case OSWorkspace.memory: return OSWatchText.memory
        case OSWorkspace.system: return OSSystemText.title
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
                OSKnowledgeView(server: server, workspace: workspace)
            } else if workspace.selection == OSWorkspace.memory {
                OSMemoryScreen(models: memory, drafts: drafts)
            } else if workspace.selection == OSWorkspace.system {
                OSSystemCenter(server: server, drafts: drafts, workspace: workspace)
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
