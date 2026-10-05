// Racine de la fenêtre : `NavigationSplitView` coordonne la sélection de la
// `List` de la colonne latérale avec le panneau de détail (D4) — c'est le
// composant système qui porte déjà le bouton de bascule de la barre latérale et
// qui y pose le verre (Liquid Glass, aucun fond maison).
//
// Organisation (S-4 de omp-console-redesign) : barre latérale groupée
// « Pilotage » / « Consultation », badge des attentes sur l'Accueil, et au PIED
// de la barre latérale le badge d'état des composants embarqués (S-2) — aucune
// autre décoration (HIG Sidebars : l'état des notifications vit dans l'Accueil) ;
// titre de fenêtre = la section courante, jamais le nom de l'app
// (HIG Toolbars) ; barre d'outils PERSONNALISABLE « Nouvelle feature… » ; TOUT
// vit dans cette fenêtre (plein écran) ; UNE feuille à la fois (« OMP est
// requis », « Bienvenue », « Nouvelle feature », « Répondre », « Contrat »),
// déduite par `MainSheetPolicy` (S-5).
//
// La sélection est liée par une `Binding(get:set:)` construite à la main : le
// modèle n'expose qu'un `select(_:)` (D3, `@State` interdit).

import AppKit
import SwiftUI

struct ConsoleRootView: View {
    @ObservedObject var model: ConsoleModel
    /// Le modèle de la section « Fichiers » : il vit à l'échelle de l'app, comme les
    /// autres, pour que la cible choisie et l'état de dépliage survivent au passage
    /// d'une section à l'autre.
    @ObservedObject var filesModel: FilesModel
    /// Le tableau des pipelines, lu par l'Accueil ET par Pipelines : la racine en
    /// tient l'abonnement, pour qu'aucune des deux sections ne le coupe à l'autre.
    @ObservedObject var kanban: KanbanModel
    /// Le modèle d'alertes : l'Accueil y lit l'état d'autorisation des
    /// notifications. Il vit à l'échelle de l'app (porté par le délégué), comme les
    /// autres.
    @ObservedObject var alerts: AlertsModel
    /// Le modèle d'action : l'état des gestes et de la feuille de lancement survit
    /// au passage d'une section à l'autre.
    @ObservedObject var actions: ActionsModel
    /// Le modèle de pilotage de projet : à l'échelle de l'app, comme les autres,
    /// pour que la session hébergée survive au changement de section.
    @ObservedObject var projectModel: ProjectConsoleModel
    /// Le modèle de la section « Mémoire » : même raison, la portée et la liste
    /// survivent au passage d'une section à l'autre.
    @ObservedObject var memoryModel: MemoryModel
    /// Le modèle de la feuille Contrat (S-7) : la feuille est présentée par la
    /// racine, comme les autres — une seule à la fois.
    @ObservedObject var contract: ContractModel
    /// L'état de l'Accueil : la disponibilité d'OMP commande aussi la barre
    /// d'outils et la feuille.
    @ObservedObject var home: HomeModel
    /// La préparation de l'app (S-5) : la feuille `.setup` et le bandeau de
    /// l'Accueil en dépendent.
    @ObservedObject var setup: SetupModel
    /// L'état des composants embarqués (S-1/S-2) : le badge du pied de la barre
    /// latérale le montre et se recalcule sans redémarrage.
    @ObservedObject var components: ComponentPresenceModel

    /// Les modèles des sections Session OMP, Terminal et Statistiques : à
    /// l'échelle de l'app (`OMPConsoleApp`), comme les autres.
    let sessionModel: SessionConsoleModel
    let terminalModel: TerminalConsoleModel
    let statsModel: StatsModel

    /// La `List` exige une `Binding<ConsoleSection?>` ; le modèle n'a pas de
    /// `nil`, donc une valeur nulle est simplement ignorée à l'écriture.
    private var selection: Binding<ConsoleSection?> {
        Binding(
            get: { model.selection },
            set: { if let section = $0 { model.select(section) } }
        )
    }

    /// La feuille due, selon l'ordre des règles de `MainSheetPolicy` — aucune une
    /// fois « Quitter » demandé (la feuille doit se fermer pour que l'app quitte).
    private var currentSheet: MainSheet? {
        if home.quitRequested { return nil }
        return MainSheetPolicy.sheet(
            omp: home.omp,
            setup: setup.state,
            setupDismissed: setup.dismissed,
            board: kanban.state,
            welcomeSeen: home.welcomeSeen,
            welcomeRequested: home.welcomeRequested,
            launchFormShown: actions.launchFormShown,
            answerCardID: home.answerCardID,
            contract: contract.sheet
        )
    }

    /// Le système n'écrit que `nil` (Échap, fermeture) : l'état qui a fait
    /// apparaître la feuille courante est remis à zéro. « OMP est requis » ne se
    /// ferme jamais ainsi.
    private var mainSheet: Binding<MainSheet?> {
        Binding(
            get: { currentSheet },
            set: { newValue in
                guard newValue == nil else { return }
                switch currentSheet {
                case .setup: setup.dismiss()
                case .welcome: home.closeWelcome()
                case .newFeature: actions.launchFormShown = false
                case .answer: home.dismissAnswer(actions: actions)
                case .contract: contract.close()
                case nil: break
                }
            }
        )
    }

    var body: some View {
        let attentionCount = HomePresentation.attentionCount(omp: home.omp, board: kanban.state)
        NavigationSplitView {
            List(selection: selection) {
                ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                    Section(group.title) {
                        ForEach(group.sections) { section in
                            if section == .home && attentionCount > 0 {
                                Label(section.title, systemImage: section.systemImage)
                                    .badge(attentionCount)
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
            // Le badge d'état des composants, ancré au pied de la barre latérale
            // et aligné sur son bord gauche (S-2) : la `List` est rentrée de sa
            // hauteur et garde ses dernières lignes lisibles. Replier la barre
            // latérale masque le badge avec elle — c'est le coin gauche de la
            // fenêtre, comportement assumé.
            .safeAreaInset(edge: .bottom, alignment: .leading) {
                ComponentBadge(status: components.presence.status)
            }
        } detail: {
            SectionDetail(
                section: model.selection,
                home: home,
                console: model,
                filesModel: filesModel,
                kanban: kanban,
                actions: actions,
                projectModel: projectModel,
                memoryModel: memoryModel,
                contract: contract,
                alerts: alerts,
                setup: setup,
                sessionModel: sessionModel,
                terminalModel: terminalModel,
                statsModel: statsModel
            )
            // Le titre de la fenêtre EST la section courante (HIG Toolbars : ne
            // pas titrer une fenêtre du nom de l'app). Aucune vue de section ne
            // pose de titre à son tour.
            .navigationTitle(model.selection.title)
        }
        // Personnalisable (clic droit ▸ « Personnaliser la barre d'outils… ») : un
        // identifiant stable par article, que le système mémorise.
        //
        // Les quatre articles partagent le MÊME placement automatique et aucun
        // `.buttonStyle` : le « + » avait seul `.primaryAction`, et c'est lui seul
        // qui sortait en pastille bleue quand une section (Pipelines et son
        // inspecteur) scindait la barre en plusieurs groupes de verre. Même
        // placement, même rendu, dans toutes les sections.
        // Personnalisable (clic droit ▸ « Personnaliser la barre d'outils… ») :
        // l'action principale de l'app. Terminal, Session OMP et Statistiques
        // sont des sections de la barre latérale, plus des fenêtres annexes : en
        // plein écran, une fenêtre annexe partait dans son propre espace.
        .toolbar(id: "main") {
            ToolbarItem(id: "newFeature") {
                Button {
                    actions.launchFormShown = true
                } label: {
                    Label(HomeText.newFeature, systemImage: "plus")
                }
                .disabled(!home.canLaunch)
                .help(home.canLaunch ? HomeText.newFeature : SetupText.homeMissingTitle)
                .accessibilityIdentifier("toolbar.newFeature")
            }
            // L'action principale se déplace, mais ne se retire pas.
            .customizationBehavior(.reorderable)
        }
        .sheet(item: mainSheet, onDismiss: {
            if home.quitRequested { NSApp.terminate(nil) }
        }) { sheet in
            switch sheet {
            case .setup:
                SetupView(setup: setup)
            case .welcome:
                WelcomeSheet(home: home)
            case .newFeature:
                NewFeatureSheet(actions: actions, kanban: kanban, home: home, console: model)
            case .answer(let cardID):
                if let card = kanban.state.card(cardID) {
                    AnswerSheet(card: card, home: home, actions: actions)
                }
            case .contract(let sheet):
                ContractSheetView(sheet: sheet)
            }
        }
        // L'Accueil et Pipelines lisent le même tableau : l'abonnement est ouvert
        // une fois, par la racine, et n'est plus lié à l'apparition d'une section.
        .onAppear {
            kanban.start()
            actions.loadModelCatalog()
        }
        .frame(minWidth: 760, minHeight: 480)
    }
}
