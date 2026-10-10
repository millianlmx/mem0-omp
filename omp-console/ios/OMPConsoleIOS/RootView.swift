import ConsoleClient
import ConsoleCore
import SwiftUI

/// La racine UNIQUE de l'app iOS : un seul `NavigationSplitView` porte les deux
/// tailles d'écran. En largeur régulière (iPad) il montre la barre latérale
/// groupée et le détail côte à côte ; en largeur compacte (iPhone) il replie la
/// barre latérale en pile racine et pousse le détail — un appui sur une ligne
/// pousse l'écran de la section, et le bouton retour du système revient à la
/// liste. Aucune barre d'onglets, aucun `NavigationStack` racine.
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
/// sur la liste des sections en largeur compacte, et sur la colonne détail
/// toujours — exactement un bouton à l'écran. La ligne « Accueil » porte le badge
/// du nombre d'attentes (S-12), quelle que soit la section affichée.
struct RootView: View {
    @State private var selection: ConsoleSection?
    @State private var state: IOSScreenState
    @StateObject private var client = ConsoleClientModel.live()
    /// Les gestes de carte de l'Accueil : l'état en vol survit à une sortie puis un
    /// retour sur l'Accueil.
    @StateObject private var homeGestures = IOSHomeGestureModel()
    @State private var showConnection: Bool
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var showWelcome = false

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
        autoPresentConnection: Bool = true
    ) {
        _selection = State(initialValue: selection)
        _state = State(initialValue: state)
        self.recipe = recipe
        self.recipeRow = recipeRow
        self.sessionRecipe = sessionRecipe
        self.memoryRecipe = memoryRecipe
        self.pipelinesRecipe = pipelinesRecipe
        self.cardRecipe = cardRecipe
        self.statsRecipe = statsRecipe
        self.pipelinesBoardRecipe = pipelinesBoardRecipe
        self.autoPresentConnection = autoPresentConnection
        _showConnection = State(initialValue: false)
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                    Section(group.title) {
                        ForEach(IOSSection.sections(of: group)) { section in
                            let badge = IOSHomeContent.rowBadge(
                                for: section, attentionCount: attentionCount)
                            Label(section.title, systemImage: IOSSection.systemImage(of: section))
                                .badge(badge)
                                .tag(section)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(IOSHomeText.sectionRowLabel(section.title, badge: badge))
                                .accessibilityAddTraits(.isButton)
                                .accessibilityIdentifier("ios.section." + section.rawValue)
                        }
                    }
                }
            }
            .toolbar {
                if sizeClass == .compact {
                    connectionToolbarItem
                }
            }
        } detail: {
            Group {
                if selection == .home {
                    HomeView(
                        client: client,
                        gestures: homeGestures,
                        recipe: recipe,
                        recipeRow: recipeRow,
                        showConnection: $showConnection,
                        onSelectSection: { selection = $0 }
                    )
                } else {
                    IOSSectionView(
                        section: selection ?? .home,
                        state: state,
                        client: client,
                        recipe: sessionRecipe,
                        memoryRecipe: memoryRecipe,
                        pipelinesRecipe: pipelinesRecipe,
                        cardRecipe: cardRecipe,
                        statsRecipe: statsRecipe,
                        pipelinesBoardRecipe: pipelinesBoardRecipe
                    )
                }
            }
            .toolbar { connectionToolbarItem }
        }
        .sheet(isPresented: $showWelcome, onDismiss: presentConnectionIfNeeded) {
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

    /// Le bouton antenne (« Connexion ») : rouvre la feuille de connexion, sans
    /// condition. Il est posé sur CHAQUE colonne qui porte une barre — jamais sur
    /// le `NavigationSplitView` lui-même, dont la barre n'est affichée nulle part.
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

    /// Le compte d'attentes de la ligne « Accueil » : celui de la recette quand
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

    private var welcomeDue: Bool {
        IOSHomeContent.welcomeDue(welcomeSeen: client.welcomeSeen, section: selection ?? .home)
    }

    /// La feuille s'ouvre d'elle-même sans jeton ou sur un jeton refusé, jamais
    /// pendant la lecture du trousseau ni pour un appareil appairé (S-2).
    private func presentConnectionIfNeeded() {
        if autoPresentConnection, ConnectionSheetMode.autoPresents(client.pairing) {
            showConnection = true
        }
    }
}
