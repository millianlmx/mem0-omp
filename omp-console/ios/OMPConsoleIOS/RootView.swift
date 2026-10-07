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
/// feuille de bienvenue (S-15, avant la connexion) puis la feuille de connexion
/// au lancement quand aucune section n'a été demandée par `-section`, et la
/// rouvre par une `ToolbarItem`. La ligne « Accueil » porte le badge du nombre
/// d'attentes (S-12) quand l'Accueil est la section affichée.
struct RootView: View {
    @State private var selection: ConsoleSection?
    @State private var state: IOSScreenState
    @StateObject private var client = ConsoleClientModel.live()
    @State private var showConnection: Bool
    @State private var showWelcome = false

    /// Le crochet de recette `-home.recipe`, quand il est donné.
    private let recipe: IOSHomeRecipe?
    /// Vrai quand `-section` n'a pas été fourni : les captures pilotées gardent
    /// ainsi leur écran, sans feuille par-dessus.
    private let autoPresentConnection: Bool

    init(
        selection: ConsoleSection = .home,
        state: IOSScreenState = .ready,
        recipe: IOSHomeRecipe? = nil,
        autoPresentConnection: Bool = true
    ) {
        _selection = State(initialValue: selection)
        _state = State(initialValue: state)
        self.recipe = recipe
        self.autoPresentConnection = autoPresentConnection
        _showConnection = State(initialValue: false)
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                    Section(group.title) {
                        ForEach(IOSSection.sections(of: group)) { section in
                            if section == .home, selection == .home, attentionCount > 0 {
                                Label(section.title, systemImage: section.systemImage)
                                    .badge(attentionCount)
                                    .tag(section)
                                    .accessibilityIdentifier("ios.section." + section.rawValue)
                            } else {
                                Label(section.title, systemImage: section.systemImage)
                                    .tag(section)
                                    .accessibilityIdentifier("ios.section." + section.rawValue)
                            }
                        }
                    }
                }
            }
        } detail: {
            if selection == .home {
                HomeView(
                    client: client,
                    recipe: recipe,
                    showConnection: $showConnection,
                    onSelectSection: { selection = $0 }
                )
            } else {
                IOSSectionView(section: selection ?? .home, state: state, client: client)
            }
        }
        .sheet(isPresented: $showWelcome, onDismiss: presentConnectionIfNeeded) {
            HomeWelcomeSheet(client: client)
        }
        .sheet(isPresented: $showConnection) {
            ConnectionSheet(model: client)
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showConnection = true
                } label: {
                    Label(ConnectionText.title, systemImage: "antenna.radiowaves.left.and.right")
                }
            }
        }
        .onAppear {
            client.start()
            presentInitialSheets()
        }
    }

    /// Le badge d'une ligne : le compte d'attentes seulement sur la ligne
    /// « Accueil » quand elle est la section affichée (S-12).
    private var attentionCount: Int {
        IOSHomeContent.badge(omp: client.omp, board: client.board)
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

    private func presentConnectionIfNeeded() {
        if autoPresentConnection, !isConnected {
            showConnection = true
        }
    }

    /// L'app est-elle connectée ? Au lancement elle ne l'est jamais : la feuille
    /// de connexion s'ouvre donc d'elle-même quand aucune section n'est demandée.
    private var isConnected: Bool {
        if case .connected = client.state { return true }
        return false
    }
}
