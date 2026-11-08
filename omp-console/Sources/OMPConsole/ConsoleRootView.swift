// Racine de la fenêtre : `NavigationSplitView` coordonne la sélection de la
// `List` de la colonne latérale avec le panneau de détail (D4) — c'est le
// composant système qui porte déjà le bouton de bascule de la barre latérale et
// qui y pose le verre (Liquid Glass, aucun fond maison).
//
// Organisation : barre latérale groupée « Pilotage » / « Consultation », badge des
// attentes du serveur de pipelines sur l'Accueil, des audits à trier sur Audit et
// des envois à approuver sur Poste, et au PIED de la barre latérale le badge d'état
// des composants embarqués (S-2) ;
// titre de fenêtre = la section courante, jamais le nom de l'app (HIG Toolbars) ;
// TOUT vit dans cette fenêtre. Deux feuilles : la préparation des composants
// (bloquante tant qu'OMP manque) et la configuration du serveur de pipelines.
//
// La sélection est liée par une `Binding(get:set:)` construite à la main : le
// modèle n'expose qu'un `select(_:)` (D3, `@State` interdit).
//
// La racine pose aussi le socle des écrans partagés avec l'app iOS (`consoleShell` :
// le rendu Markdown et le direct d'une session du Mac), la palette ⌘K/⌘F et la
// feuille ⌘N (`consolePalette`), ouvre les liens `ompconsole://<section>` (le
// popup de l'extension Chrome ouvre `ompconsole://workstation` pour approuver) et
// l'endroit qu'une notification touchée désigne (`consoleNotificationRoutes`). App en
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

    /// Le badge d'une section : ce qui attend l'humain sur l'Accueil, les audits à
    /// trier sur Audit, les envois à approuver sur Poste.
    private func badge(for section: ConsoleSection) -> Int {
        if section == .workstation { return workstation.pendingCount }
        // La vigie muette se signale dans la barre latérale.
        if section == .vigie { return server.vigie.isSilent ? 1 : 0 }
        guard let inbox = server.inbox else { return 0 }
        switch section {
        case .home: return inbox.pendingCount
        case .audit: return inbox.auditsProposed.count
        default: return 0
        }
    }

    var body: some View {
        NavigationSplitView {
            List(selection: selection) {
                ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                    Section(group.title) {
                        ForEach(ConsoleSection.visible(group.sections, isAdmin: server.isAdmin)) { section in
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
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 180, ideal: 220)
            .safeAreaInset(edge: .bottom, alignment: .leading) {
                ComponentBadge(status: components.presence.status, open: reopenSetup)
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
            // Le titre de la fenêtre EST la section courante (HIG Toolbars).
            .navigationTitle(model.selection.title)
            .sheet(isPresented: $drafts.serverSheetShown) {
                ServerSheet(server: server, drafts: drafts)
            }
            .consolePalette(server: server, drafts: drafts, sections: ConsoleSection.visible(ConsoleSection.allCases, isAdmin: server.isAdmin), memory: true) { section in
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
        // L'état du poste et ses envois à approuver (badge, Accueil), relus à chaque
        // serveur relié ; le flux de la boîte les tient ensuite à jour. Un serveur relié :
        // la permission de notifier est demandée (le système ne la demande qu'une fois).
        .task(id: server.address) {
            await workstation.refresh()
            await server.vigie.refresh()
            if server.isConfigured { _ = await notifications.requestAuthorization() }
        }
        // Le jeton approbateur ou non : les actions d'un envoi du poste agissent ou ouvrent l'app.
        .onReceive(server.$client) { _ in notifications.refreshCategories() }
        .consoleNotificationRoutes(notifications, server: server, drafts: drafts) { model.select($0) }
        .onOpenURL { url in
            if let section = HarnessWidgetLink.section(of: url) { model.select(section) }
        }
        .consoleShell(ConsoleShell(
            markdown: { AnyView(MarkdownBlocksView(blocks: $0)) },
            session: { [server, drafts] request in AnyView(HarnessSessionSheet(server: server, drafts: drafts, request: request)) }
        ))
        .frame(minWidth: 760, minHeight: 480)
    }
}
