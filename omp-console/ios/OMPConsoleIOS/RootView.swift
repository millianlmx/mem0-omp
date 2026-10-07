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
struct RootView: View {
    @State private var selection: ConsoleSection?
    @State private var state: IOSScreenState

    init(selection: ConsoleSection = .home, state: IOSScreenState = .ready) {
        _selection = State(initialValue: selection)
        _state = State(initialValue: state)
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                ForEach(ConsoleSectionGroup.allCases, id: \.self) { group in
                    Section(group.title) {
                        ForEach(IOSSection.sections(of: group)) { section in
                            Label(section.title, systemImage: section.systemImage)
                                .tag(section)
                                .accessibilityIdentifier("ios.section." + section.rawValue)
                        }
                    }
                }
            }
        } detail: {
            IOSSectionView(section: selection ?? .home, state: state)
        }
    }
}
