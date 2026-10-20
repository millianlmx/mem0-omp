// Racine de la fenêtre : `NavigationSplitView` coordonne la sélection de la
// `List` de la colonne latérale avec le panneau de détail (D4) — c'est le
// composant système qui porte déjà le bouton de bascule de la barre latérale et
// qui y pose le verre (Liquid Glass, aucun fond maison).
//
// Organisation : barre latérale groupée « Pilotage » / « Consultation », badge des
// attentes du serveur de pipelines sur l'Accueil et des audits à trier sur Audit,
// et au PIED de la barre latérale le badge d'état des composants embarqués (S-2) ;
// titre de fenêtre = la section courante, jamais le nom de l'app (HIG Toolbars) ;
// TOUT vit dans cette fenêtre. Deux feuilles : la préparation des composants
// (bloquante tant qu'OMP manque) et la configuration du serveur de pipelines.
//
// La sélection est liée par une `Binding(get:set:)` construite à la main : le
// modèle n'expose qu'un `select(_:)` (D3, `@State` interdit).

import AppKit
import ConsoleClient
import ConsoleCore
import SwiftUI

struct ConsoleRootView: View {
    @ObservedObject var model: ConsoleModel
    /// Le serveur de pipelines du VPS et les brouillons de ses écrans.
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
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
    /// Le service d'API distante (BR-9) : la racine le démarre à l'apparition.
    let remote: RemoteServiceModel
    let terminalModel: TerminalConsoleModel
    let projectChooser: ProjectChooserModel

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
    /// trier sur Audit.
    private func badge(for section: ConsoleSection) -> Int {
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
                        ForEach(group.sections) { section in
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
        }
        .sheet(isPresented: setupShown) {
            // OMP absent : la feuille est bloquante — ni « Fermer » ni ⎋ (Doc-1) ;
            // « Quitter » passe par le déroulé de la sortie.
            SetupView(setup: setup, omp: presence.omp, quit: { quit.request() })
                .interactiveDismissDisabled(!presence.canLaunch)
        }
        .task {
            await server.load()
            server.startLive()
        }
        .onAppear {
            // Le service d'API distante démarre à l'apparition si la préférence
            // l'autorise (BR-9) ; `SetupModel.onReady` le relancera si la
            // préparation n'était pas terminée.
            Task { await remote.startIfEnabled() }
        }
        .frame(minWidth: 760, minHeight: 480)
    }
}
