import ConsoleCore
import SwiftUI

/// La racine UNIQUE de l'app iOS : un seul `NavigationSplitView` porte les deux
/// tailles d'écran. En largeur régulière (iPad) il montre la barre latérale
/// groupée et le détail côte à côte ; en largeur compacte (iPhone) il replie la
/// barre latérale en pile racine et pousse le détail — un appui sur une ligne
/// pousse l'écran de la section, et le bouton retour du système revient à la
/// liste. Aucune barre d'onglets, aucun `NavigationStack` racine.
struct RootView: View {
    @State private var selection: ConsoleSection?

    init(selection: ConsoleSection = .home) {
        _selection = State(initialValue: selection)
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
            SectionPlaceholderView(section: selection ?? .home)
        }
    }
}
