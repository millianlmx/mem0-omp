import ConsoleClient
import ConsoleCore
import SwiftUI

/// La racine UNIQUE de l'app iOS : une barre d'onglets native (`TabView`, style
/// `.sidebarAdaptable`) porte les deux tailles d'écran. En largeur compacte
/// (iPhone) elle montre cinq onglets en bas — Accueil, Pipelines, Sessions,
/// Mémoire, « Plus » — et « Plus » pousse Projet, Session OMP et Statistiques
/// dans sa propre pile ; en largeur régulière (iPad) elle s'ouvre en barre
/// latérale groupée (Pilotage, Consultation), la barre d'onglets du haut
/// n'apparaissant que lorsque l'utilisateur masque la barre latérale. Chaque
/// onglet a sa `NavigationStack` : changer d'onglet conserve écran poussé et
/// défilement. Le routage onglet ↔ section est pur (`IOSTabs`).
///
/// Elle porte le crochet de recette de l'état d'écran (S-3). La rotation, elle,
/// n'est PAS pilotée par l'app : `simctl` n'a aucune sous-commande pour tourner
/// un appareil, l'app déclare simplement portrait + paysages pour rester
/// utilisable en paysage sur un vrai iPad (S-5).
///
/// La racine POSSÈDE aussi le modèle du client distant (`ConsoleClientModel.live()`,
/// créé UNE fois) : elle démarre la découverte et la connexion, présente la
/// feuille de bienvenue (S-15, avant la connexion), puis ouvre d'elle-même la
/// feuille de connexion SEULEMENT quand l'appareil n'a pas de jeton ou que le Mac
/// l'a refusé (`ConnectionSheetMode.autoPresents`) et qu'aucune section n'a été
/// demandée par `-section` ; un Mac injoignable laisse l'Accueil dans son état
/// dégradé. Le bouton antenne `connectionToolbarItem` la rouvre à la demande :
/// posé une fois sur l'écran de section (`sectionScreen`, contenu de chaque
/// onglet ET destination de « Plus ») et une fois sur la liste « Plus » —
/// exactement un bouton par écran. L'onglet Accueil porte le badge du nombre
/// d'attentes (S-12), quel que soit l'onglet affiché.
struct RootView: View {
    @State private var route: IOSTabRoute
    @State private var state: IOSScreenState
    @StateObject private var client = ConsoleClientModel.live()
    /// Les gestes de carte de l'Accueil : l'état en vol survit à une sortie puis un
    /// retour sur l'Accueil.
    @StateObject private var homeGestures = IOSHomeGestureModel()
    @State private var showConnection: Bool
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showWelcome = false
    /// La demande d'ouvrir « Nouvelle feature » (⌘N), consommée par Pipelines : la
    /// feuille y reste un état privé, la racine ne fait que la demander.
    @State private var newFeatureRequested = false

    /// Le crochet de recette `-home.recipe`, quand il est donné.
    private let recipe: IOSHomeRecipe?
    /// Le crochet de recette `-home.row`, quand il est donné.
    private let recipeRow: Int?
    /// Le crochet de recette `-sessions.recipe`, quand il est donné.
    private let sessionRecipe: IOSSessionsRecipe?
    /// Le crochet de recette `-memoire.recipe`, quand il est donné.
    private let memoryRecipe: IOSMemoryGraphRecipe?
    /// Le crochet de recette `-pipelines.recipe`, quand il est donné.
    private let pipelinesRecipe: IOSPipelinesRecipe?
    /// Le crochet de recette de la fiche d'une carte (`-pipelines.recipe <fiche|actions|arret>`).
    private let cardRecipe: PipelinesCardRecipe?
    /// Le crochet de recette `-stats.recipe`, quand il est donné.
    private let statsRecipe: IOSStatsRecipe?
    /// Le crochet de recette `-pipelines.board`, quand il est donné.
    private let pipelinesBoardRecipe: IOSPipelinesBoardRecipe?
    /// Le crochet de recette `-projet.recipe`, quand il est donné.
    private let projectRecipe: IOSProjectRecipe?
    /// Le crochet de recette `-sessionomp.recipe`, quand il est donné.
    private let sessionOmpRecipe: IOSSessionOmpRecipe?
    /// Vrai quand `-section` n'a pas été fourni : les captures pilotées gardent
    /// ainsi leur écran, sans feuille par-dessus.
    private let autoPresentConnection: Bool

    init(
        selection: ConsoleSection = .home,
        state: IOSScreenState = .ready,
        recipe: IOSHomeRecipe? = nil,
        recipeRow: Int? = nil,
        sessionRecipe: IOSSessionsRecipe? = nil,
        memoryRecipe: IOSMemoryGraphRecipe? = nil,
        pipelinesRecipe: IOSPipelinesRecipe? = nil,
        cardRecipe: PipelinesCardRecipe? = nil,
        statsRecipe: IOSStatsRecipe? = nil,
        pipelinesBoardRecipe: IOSPipelinesBoardRecipe? = nil,
        projectRecipe: IOSProjectRecipe? = nil,
        sessionOmpRecipe: IOSSessionOmpRecipe? = nil,
        autoPresentConnection: Bool = true
    ) {
        _route = State(initialValue: IOSTabRoute(tab: .section(selection), plusPath: []))
        _state = State(initialValue: state)
        self.recipe = recipe
        self.recipeRow = recipeRow
        self.sessionRecipe = sessionRecipe
        self.memoryRecipe = memoryRecipe
        self.pipelinesRecipe = pipelinesRecipe
        self.cardRecipe = cardRecipe
        self.statsRecipe = statsRecipe
        self.pipelinesBoardRecipe = pipelinesBoardRecipe
        self.projectRecipe = projectRecipe
        self.sessionOmpRecipe = sessionOmpRecipe
        self.autoPresentConnection = autoPresentConnection
        _showConnection = State(initialValue: false)
    }

    var body: some View {
        TabView(selection: shownRoute.tab) {
            ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                TabSection(group.title) {
                    ForEach(IOSSection.sections(of: group)) { section in
                        let badge = IOSHomeContent.rowBadge(
                            for: section, attentionCount: attentionCount)
                        Tab(section.title, systemImage: IOSSection.systemImage(of: section), value: IOSTab.section(section)) {
                            NavigationStack { sectionScreen(section) }
                        }
                        .badge(badge)
                        .hidden(IOSTabs.isHidden(.section(section), compact: isCompact))
                        .accessibilityLabel(IOSHomeText.sectionRowLabel(section.title, badge: badge))
                        .accessibilityIdentifier("ios.tab." + section.rawValue)
                    }
                }
            }
            Tab(IOSHomeText.plusTitle, systemImage: IOSHomeText.plusSymbol, value: IOSTab.plus) {
                NavigationStack(path: shownRoute.plusPath) {
                    plusList.navigationDestination(for: ConsoleSection.self) { sectionScreen($0) }
                }
            }
            .hidden(IOSTabs.isHidden(.plus, compact: isCompact))
            .accessibilityIdentifier("ios.tab.plus")
        }
        .tabViewStyle(.sidebarAdaptable)
        .defaultAdaptableTabBarPlacement(.sidebar)
        .tabViewSidebarHeader {
            Text(IOSHomeText.rootTitle)
                .font(.title.bold())
                .accessibilityAddTraits(.isHeader)
        }
        .onChange(of: sizeClass, initial: true) { _, size in
            route = IOSTabs.adapt(route, compact: size == .compact)
        }
        .focusedSceneValue(\.iosSelectSection, IOSSectionSelector(current: IOSTabs.shown(currentRoute)) { select($0) })
        .focusedSceneValue(\.iosNewFeature, IOSCommandAction(owner: .kanban, isEnabled: true) {
            select(.kanban)
            newFeatureRequested = true
        })
        .sheet(isPresented: $showWelcome, onDismiss: welcomeDismissed) {
            HomeWelcomeSheet(client: client)
        }
        .sheet(isPresented: $showConnection) {
            ConnectionSheet(model: client)
        }
        .onAppear {
            client.start()
            presentInitialSheets()
        }
        .onChange(of: client.pairing) { _, _ in
            // Un statut qui VIENT d'être atteint ; pendant la bienvenue, c'est sa
            // fermeture qui réévalue (`onDismiss`).
            if !showWelcome { presentConnectionIfNeeded() }
        }
    }

    /// Vrai en largeur compacte (iPhone, iPad en Split View étroit) : la barre
    /// d'onglets range alors Projet, Session OMP et Statistiques sous « Plus ».
    private var isCompact: Bool { sizeClass == .compact }

    /// La route ramenée à la classe de taille COURANTE. `route` peut la précéder
    /// d'une passe : au lancement (`-section stats` sur iPhone) et à chaque
    /// changement de largeur, `.onChange(of: sizeClass)` ne l'adapte qu'APRÈS le
    /// rendu, alors que `.hidden(_:)` suit déjà la nouvelle taille — et UIKit
    /// interrompt l'app si la sélection désigne un onglet masqué. Sélection et
    /// masquage se lisent donc tous deux depuis `isCompact`, dans la même passe.
    private var currentRoute: IOSTabRoute { IOSTabs.adapt(route, compact: isCompact) }

    /// Les liaisons de la barre d'onglets et de la pile de « Plus » : elles lisent
    /// `currentRoute` et écrivent dans `route`.
    private var shownRoute: Binding<IOSTabRoute> {
        Binding(get: { currentRoute }, set: { route = $0 })
    }

    /// L'écran d'une section, avec son bouton antenne. Fonction UNIQUE : elle sert
    /// au contenu de chaque onglet de section ET à la destination de « Plus »,
    /// donc chaque écran porte le bouton exactement une fois.
    @ViewBuilder
    private func sectionScreen(_ section: ConsoleSection) -> some View {
        Group {
            if section == .home {
                HomeView(
                    client: client,
                    gestures: homeGestures,
                    recipe: recipe,
                    recipeRow: recipeRow,
                    showConnection: $showConnection,
                    onSelectSection: { select($0) }
                )
            } else {
                IOSSectionView(
                    section: section,
                    state: state,
                    client: client,
                    recipe: sessionRecipe,
                    memoryRecipe: memoryRecipe,
                    pipelinesRecipe: pipelinesRecipe,
                    cardRecipe: cardRecipe,
                    statsRecipe: statsRecipe,
                    pipelinesBoardRecipe: pipelinesBoardRecipe,
                    projectRecipe: projectRecipe,
                    sessionOmpRecipe: sessionOmpRecipe,
                    showConnection: $showConnection,
                    newFeatureRequested: $newFeatureRequested
                )
            }
        }
        .toolbar { connectionToolbarItem }
    }

    /// La liste de l'onglet « Plus » (iPhone) : des rangées système qui poussent
    /// Projet, Session OMP et Statistiques dans la pile de l'onglet.
    private var plusList: some View {
        List(IOSTabs.plusSections) { section in
            NavigationLink(value: section) {
                Label(section.title, systemImage: IOSSection.systemImage(of: section))
            }
            .accessibilityIdentifier("ios.plus." + section.rawValue)
        }
        .navigationTitle(IOSHomeText.plusTitle)
        .toolbar { connectionToolbarItem }
    }

    /// Affiche une section (⌘<n>, ⌘N, « Tout afficher ») par le routage pur.
    private func select(_ section: ConsoleSection) {
        route = IOSTabs.route(from: currentRoute, to: section, compact: isCompact)
    }

    /// Le bouton antenne (« Connexion ») : rouvre la feuille de connexion, sans
    /// condition. Il est posé sur l'écran de section et sur la liste « Plus » —
    /// jamais sur le `TabView` lui-même.
    @ToolbarContentBuilder
    private var connectionToolbarItem: some ToolbarContent {
        ToolbarItem(placement: .topBarTrailing) {
            Button {
                showConnection = true
            } label: {
                Label(ConnectionText.title, systemImage: "antenna.radiowaves.left.and.right")
            }
            .accessibilityIdentifier(ConnectionAccessibility.open)
        }
    }

    /// Le compte d'attentes de l'onglet Accueil : celui de la recette quand
    /// `-home.recipe` est donné, sinon le compte en direct (S-12).
    private var attentionCount: Int {
        recipe?.badge ?? IOSHomeContent.badge(omp: client.omp, board: client.board)
    }

    /// L'ordre de S-15 : la bienvenue d'abord, la connexion ensuite.
    private func presentInitialSheets() {
        if welcomeDue {
            showWelcome = true
        } else {
            presentConnectionIfNeeded()
        }
    }

    /// Toute fermeture de la bienvenue (bouton « Continuer » ou balayage) l'enregistre
    /// comme vue (`closeWelcome()` est idempotent), puis la connexion suit si besoin.
    private func welcomeDismissed() {
        client.closeWelcome()
        presentConnectionIfNeeded()
    }

    private var welcomeDue: Bool {
        IOSHomeContent.welcomeDue(welcomeSeen: client.welcomeSeen, section: IOSTabs.shown(currentRoute) ?? .home)
    }

    /// La feuille s'ouvre d'elle-même sans jeton ou sur un jeton refusé, jamais
    /// pendant la lecture du trousseau ni pour un appareil appairé (S-2).
    private func presentConnectionIfNeeded() {
        if autoPresentConnection, ConnectionSheetMode.autoPresents(client.pairing) {
            showConnection = true
        }
    }
}
