// Racine de la fenêtre : `NavigationSplitView` coordonne la sélection de la
// `List` de la colonne latérale avec le panneau de détail (D4) — c'est le
// composant système qui porte déjà le bouton de bascule de la barre latérale et
// qui y pose le verre (Liquid Glass, aucun fond maison).
//
// Organisation : barre latérale en trois temps — le travail (« À traiter », Features,
// Poste), les « Outils » (Mémoire, Terminal, Fichiers), puis Système seul en bas.
// Badges : ce qui attend l'humain sur « À traiter » (boîte et envois du poste), les
// envois à approuver sur Poste, la vigie muette sur Système. Au PIED de la barre
// latérale, une seule ligne de connexion (point du direct et hôte du serveur, qui
// ouvre la feuille Serveur) au-dessus du badge d'état des composants embarqués (S-2) ;
// titre de fenêtre = la section courante (ou la feature, la page de Système montrée),
// jamais le nom de l'app (HIG Toolbars) ; TOUT vit dans cette fenêtre. Deux feuilles :
// la préparation des composants (bloquante tant qu'OMP manque) et la configuration du
// serveur de pipelines.
//
// La sélection est liée par une `Binding(get:set:)` construite à la main : le
// modèle n'expose qu'un `select(_:)`.
//
// La racine pose aussi le socle des écrans partagés avec l'app iOS (`consoleShell` :
// le rendu Markdown, le direct d'une session du Mac et la sélection de section), la
// palette ⌘K/⌘F et la feuille ⌘N (`consolePalette`), ouvre les liens
// `ompconsole://<section>` — `ompconsole://runs/<id>` ouvre la page d'une feature,
// `ompconsole://system/<page>` une page de Système ; le popup de l'extension Chrome
// ouvre `ompconsole://workstation` pour approuver — et l'endroit qu'une notification
// touchée désigne (`consoleNotificationRoutes`). App en
// arrière-plan, chaque événement du flux qui attend l'humain devient une notification
// locale (`HarnessNotificationCenter`), avec les gestes de l'iPhone.

import AppKit
import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct ConsoleRootView: View {
    @ObservedObject var model: ConsoleModel
    /// Le serveur de pipelines du VPS et les brouillons de ses écrans.
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// Le poste de travail du même serveur (`server.workstation`) : son badge.
    @ObservedObject var workstation: WorkstationModel
    /// Les propositions des signalements de collègues (`server.signals`) : badge d'« À traiter ».
    @ObservedObject var signals: CorporateSignalsModel
    @ObservedObject var filesModel: FilesModel
    /// Le déroulé de la sortie (porté par le délégué) : le bouton « Quitter » de
    /// la feuille de préparation bloquante y passe, comme ⌘Q.
    let quit: QuitFlow
    @ObservedObject var memoryModel: MemoryModel
    @ObservedObject var memoryGraph: MemoryGraphModel
    @ObservedObject var podmanCleanup: PodmanCleanupModel
    /// La présence d'OMP : la feuille de préparation en dépend.
    @ObservedObject var presence: OmpPresenceModel
    @ObservedObject var setup: SetupModel
    /// L'état des composants embarqués (S-1/S-2) : le badge du pied de la barre
    /// latérale le montre et se recalcule sans redémarrage.
    @ObservedObject var components: ComponentPresenceModel
    let terminalModel: TerminalConsoleModel
    let projectChooser: ProjectChooserModel
    /// Les notifications locales du Mac et la réponse à leurs actions.
    @ObservedObject var notifications: HarnessNotificationCenter

    /// La `List` exige une `Binding<ConsoleSection?>` ; le modèle n'a pas de
    /// `nil`, donc une valeur nulle est simplement ignorée à l'écriture.
    private var selection: Binding<ConsoleSection?> {
        Binding(
            get: { model.selection },
            set: { if let section = $0 { model.select(section) } }
        )
    }

    /// La préparation est due (`SetupSheetPolicy`).
    private var setupShown: Binding<Bool> {
        Binding(
            get: { SetupSheetPolicy.isShown(omp: presence.omp, setup: setup.state, dismissed: setup.dismissed) },
            set: { shown in
                if !shown, presence.canLaunch { setup.dismiss() }
            }
        )
    }

    /// Le geste du badge des composants (S-3) : rouvrir la feuille de
    /// préparation quand un composant manque ; aucun quand tout est installé.
    private var reopenSetup: (@MainActor () -> Void)? {
        if components.presence.allInstalled { return nil }
        return { setup.reopen() }
    }

    /// Le badge d'une section : ce qui attend l'humain (boîte, envois du poste et
    /// propositions des signalements) sur « À traiter », les envois à approuver sur Poste,
    /// la vigie muette sur Système.
    private func badge(for section: ConsoleSection) -> Int {
        switch section {
        case .inbox: (server.inbox?.pendingCount ?? 0) + workstation.pendingCount + signals.pendingCount
        case .workstation: workstation.pendingCount
        case .system: server.vigie.isSilent ? 1 : 0
        default: 0
        }
    }

    /// Le titre de la fenêtre : la feature ou la page de Système montrée, sinon la section.
    private var windowTitle: String {
        switch model.selection {
        case .runs where drafts.runsScope == .features:
            if let id = drafts.openedRun, let run = server.knownRun(id) { return run.title }
        case .system:
            if let page = drafts.systemPage, page != .server { return page.title }
        default:
            break
        }
        return model.selection.title
    }

    @ViewBuilder
    private func row(_ section: ConsoleSection) -> some View {
        let count = badge(for: section)
        if count > 0 {
            Label(section.title, systemImage: section.systemImage)
                .badge(count)
                .tag(section)
        } else {
            Label(section.title, systemImage: section.systemImage)
                .tag(section)
        }
    }

    /// Ouvre un lien `ompconsole://` : une section, la page d'une feature, une page de Système.
    private func open(_ url: URL) {
        guard let section = HarnessWidgetLink.section(of: url) else { return }
        let item = url.pathComponents.dropFirst().first
        switch section {
        case .runs:
            if let item {
                ConsoleNavigation.openRun(item, drafts: drafts, select: model.select)
            } else {
                model.select(.runs)
            }
        case .system:
            if let item, let page = SystemPage(rawValue: item) {
                ConsoleNavigation.open(page, drafts: drafts, select: model.select)
            } else {
                model.select(.system)
            }
        default:
            model.select(section)
        }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                Section {
                    ForEach(ConsoleSectionGroup.work.sections) { row($0) }
                }
                Section(ConsoleSectionGroup.tools.title) {
                    ForEach(ConsoleSectionGroup.tools.sections) { row($0) }
                }
                Section {
                    ForEach(ConsoleSectionGroup.system.sections) { row($0) }
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 220)
            .safeAreaInset(edge: .bottom, alignment: .leading) {
                VStack(alignment: .leading, spacing: 6) {
                    ServerConnectionLine(server: server) { drafts.serverSheetShown = true }
                        .padding(.leading, 14)
                    ComponentBadge(status: components.presence.status, open: reopenSetup)
                }
            }
        } detail: {
            SectionDetail(
                section: model.selection,
                server: server,
                drafts: drafts,
                filesModel: filesModel,
                memoryModel: memoryModel,
                memoryGraph: memoryGraph,
                podmanCleanup: podmanCleanup,
                terminalModel: terminalModel,
                projectChooser: projectChooser
            )
            // Le titre de la fenêtre EST ce qu'elle montre (HIG Toolbars).
            .navigationTitle(windowTitle)
            .navigationSubtitle(windowTitle == model.selection.title ? "" : model.selection.title)
            .sheet(isPresented: $drafts.serverSheetShown) {
                ServerSheet(server: server, drafts: drafts)
            }
            .consolePalette(server: server, drafts: drafts, sections: ConsoleSection.allCases, memory: true) { section in
                model.select(section)
            }
        }
        .sheet(isPresented: setupShown) {
            // OMP absent : la feuille est bloquante — ni « Fermer » ni ⎋ (Doc-1) ;
            // « Quitter » passe par le déroulé de la sortie.
            SetupView(setup: setup, omp: presence.omp, quit: { quit.request() })
                .interactiveDismissDisabled(!presence.canLaunch)
        }
        .task {
            notifications.attach(server, postsLocally: { !NSApp.isActive })
            await server.load()
            server.startLive()
        }
        // L'état du poste et ses envois à approuver, les propositions des signalements
        // (badges, « À traiter »), relus à chaque serveur relié, et la vigie (badge de
        // Système) ; le flux de la boîte les tient ensuite à jour. Un serveur relié : la
        // permission de notifier est demandée (le système ne la demande qu'une fois).
        .task(id: server.address) {
            await workstation.refresh()
            await signals.refresh()
            await server.watch.refresh()
            await server.intakes.refresh()
            await server.vigie.refresh()
            if server.isConfigured { _ = await notifications.requestAuthorization() }
        }
        // Le jeton approbateur ou non : les actions d'un envoi du poste agissent ou ouvrent l'app.
        .onReceive(server.$client) { _ in notifications.refreshCategories() }
        .consoleNotificationRoutes(notifications, server: server, drafts: drafts) { model.select($0) }
        .onOpenURL { open($0) }
        .consoleShell(ConsoleShell(
            markdown: { AnyView(MarkdownBlocksView(blocks: $0)) },
            session: { [server] request in AnyView(HarnessSessionSheet(server: server, request: request)) },
            select: { [model] in model.select($0) }
        ))
        .frame(minWidth: 760, minHeight: 480)
    }
}

/// Le pied de la barre latérale : le direct (point vert) et l'hôte du serveur relié, ou
/// l'invitation à le relier. Un clic ouvre la feuille Serveur.
struct ServerConnectionLine: View {
    @ObservedObject var server: HarnessModel
    let open: @MainActor () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                Circle()
                    .fill(server.isLive ? Color.green : Color.secondary)
                    .frame(width: 7, height: 7)
                    .accessibilityHidden(true)
                Text(host)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(PipelineServerText.open)
        .accessibilityLabel((server.isLive ? ShellText.live : ShellText.offline) + ", " + host)
        .accessibilityIdentifier("server.open")
    }

    private var host: String {
        guard let address = server.address else { return PipelineServerText.configure }
        return URL(string: address)?.host ?? address
    }
}
