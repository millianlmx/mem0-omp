// Racine de la fenêtre : elle rend l'« OS agentique » (`OSRootView` : le Radar, les fils,
// le centre, « Comprendre ») et porte ce qui vaut pour toute la fenêtre — deux feuilles
// (la préparation des composants, bloquante tant qu'OMP manque, et la configuration du
// serveur de pipelines), les feuilles des gestes sur une feature, le poste et les
// planifications (refus, relance, renversement, arrêt d'urgence, suppression), et le
// socle des écrans partagés avec l'app iOS (`consoleShell` : le rendu Markdown, le direct
// d'une session du Mac et la destination demandée).
//
// Elle ouvre les liens `ompconsole://<section>` — `ompconsole://runs/<id>` ouvre le fil
// d'une feature, `ompconsole://system/<page>` un écran du hub Système, le popup de
// l'extension Chrome ouvre `ompconsole://workstation` — et l'endroit qu'une notification
// touchée désigne (`consoleNotificationRoutes`) : chacun devient une destination demandée
// (`drafts.requestedSection`), que l'OS montre. App en arrière-plan, chaque événement du
// flux qui attend l'humain devient une notification locale (`HarnessNotificationCenter`),
// avec les gestes de l'iPhone.

import AppKit
import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct ConsoleRootView: View {
    /// Le serveur de pipelines du VPS et les brouillons de ses écrans.
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// Le déroulé de la sortie (porté par le délégué) : le bouton « Quitter » de
    /// la feuille de préparation bloquante y passe, comme ⌘Q.
    let quit: QuitFlow
    /// La Mémoire du Mac : portée jusqu'à son écran, sans être observée ici.
    let memory: OSMemoryModels
    /// La présence d'OMP : la feuille de préparation en dépend.
    @ObservedObject var presence: OmpPresenceModel
    @ObservedObject var setup: SetupModel
    /// L'état des composants embarqués (S-1/S-2) : le badge au pied des fils le montre.
    let components: ComponentPresenceModel
    /// Les notifications locales du Mac et la réponse à leurs actions.
    @ObservedObject var notifications: HarnessNotificationCenter

    /// La préparation est due (`SetupSheetPolicy`).
    private var setupShown: Binding<Bool> {
        Binding(
            get: { SetupSheetPolicy.isShown(omp: presence.omp, setup: setup.state, dismissed: setup.dismissed) },
            set: { shown in
                if !shown, presence.canLaunch { setup.dismiss() }
            }
        )
    }

    /// Ouvre un lien `ompconsole://` : une destination, le fil d'une feature, un écran du hub Système.
    private func open(_ url: URL) {
        // Un lien d'appairage (`ompconsole://pair…`, le QR code que ce Mac affiche) ne s'ouvre jamais ici :
        // c'est l'iPhone qui appaire ; le Mac l'ignore.
        guard !HarnessPairLink.isPairLink(url), let section = HarnessWidgetLink.section(of: url) else { return }
        let item = url.pathComponents.dropFirst().first
        switch section {
        case .runs:
            if let item { ConsoleNavigation.openRun(item, drafts: drafts, select: go) }
        case .system:
            if let item, let page = SystemPage(rawValue: item) {
                ConsoleNavigation.open(page, drafts: drafts, select: go)
            } else {
                go(.system)
            }
        default:
            go(section)
        }
    }

    /// Demande une destination à l'OS.
    private func go(_ section: ConsoleSection) {
        drafts.requestedSection = section
    }

    var body: some View {
        OSRootView(server: server, drafts: drafts, memory: memory, components: components, setup: setup)
            .sheet(isPresented: $drafts.serverSheetShown) {
                ServerSheet(server: server, drafts: drafts)
            }
            .sheet(isPresented: setupShown) {
                // OMP absent : la feuille est bloquante — ni « Fermer » ni ⎋ (Doc-1) ;
                // « Quitter » passe par le déroulé de la sortie.
                SetupView(setup: setup, omp: presence.omp, quit: { quit.request() })
                    .interactiveDismissDisabled(!presence.canLaunch)
            }
            // Les feuilles des gestes : refus, relance et renversement d'une feature (carte de
            // « Comprendre »), arrêt d'urgence et envois du poste, suppression d'une planification.
            .harnessGestures(server: server, drafts: drafts)
            .workstationGestures(workstation: server.workstation, drafts: drafts)
            .controlGestures(server: server, drafts: drafts)
            .task {
                notifications.attach(server, postsLocally: { !NSApp.isActive })
                await server.load()
                server.startLive()
            }
            // L'état du poste, Jira, les demandes et la vigie, relus à chaque
            // serveur relié ; le flux de la boîte les tient ensuite à jour. Un serveur relié : la
            // permission de notifier est demandée (le système ne la demande qu'une fois).
            .task(id: server.address) {
                await server.workstation.refresh()
                await server.atlassian.refresh()
                await server.intakes.refresh()
                await server.vigie.refresh()
                if server.isConfigured { _ = await notifications.requestAuthorization() }
            }
            // Le jeton approbateur ou non : les actions d'un envoi du poste agissent ou ouvrent l'app.
            .onReceive(server.$client) { _ in notifications.refreshCategories() }
            .consoleNotificationRoutes(notifications, server: server, drafts: drafts) { go($0) }
            .onOpenURL { open($0) }
            .consoleShell(ConsoleShell(
                markdown: { AnyView(MarkdownBlocksView(blocks: $0)) },
                session: { [server] request in AnyView(HarnessSessionSheet(server: server, request: request)) },
                select: { [drafts] in drafts.requestedSection = $0 }
            ))
            .frame(minWidth: 760, minHeight: 480)
    }
}
