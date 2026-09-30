// Racine de la fenêtre : `NavigationSplitView` coordonne la sélection de la
// `List` de la colonne latérale avec le panneau de détail (D4) — c'est le
// composant système qui porte déjà le bouton de bascule de la barre latérale.
//
// La sélection est liée par une `Binding(get:set:)` construite à la main : le
// modèle n'expose qu'un `select(_:)` (D3, `@State` interdit).

import SwiftUI

struct ConsoleRootView: View {
    @ObservedObject var model: ConsoleModel
    /// Le modèle de la section « Fichiers » : il vit à l'échelle de l'app, comme les
    /// autres, pour que la cible choisie et l'état de dépliage survivent au passage
    /// d'une section à l'autre.
    @ObservedObject var filesModel: FilesModel
    /// Le modèle de la section « Kanban », même raison : l'ardoise et la sélection
    /// survivent au passage d'une section à l'autre.
    @ObservedObject var kanban: KanbanModel
    /// Le modèle d'alertes : il porte les compteurs de la bande (S-9) et l'état
    /// d'autorisation des notifications. Il vit à l'échelle de l'app (porté par le
    /// délégué), comme les autres.
    @ObservedObject var alerts: AlertsModel
    /// Le modèle d'action du Kanban (S-9) : même raison, l'état des gestes et du
    /// formulaire survit au passage d'une section à l'autre.
    @ObservedObject var actions: ActionsModel
    /// Le modèle de conduite de projet : à l'échelle de l'app, comme les autres,
    /// pour que la session hébergée survive au changement de section.
    @ObservedObject var projectModel: ProjectConsoleModel
    /// Le modèle de la section « Mémoire » : même raison, la portée et la liste
    /// survivent au passage d'une section à l'autre.
    @ObservedObject var memoryModel: MemoryModel

    /// La `List` exige une `Binding<ConsoleSection?>` ; le modèle n'a pas de
    /// `nil`, donc une valeur nulle est simplement ignorée à l'écriture.
    private var selection: Binding<ConsoleSection?> {
        Binding(
            get: { model.selection },
            set: { if let section = $0 { model.select(section) } }
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            // La bande est AU-DESSUS du `NavigationSplitView`, donc visible dans les
            // cinq sections et à l'ouverture de la fenêtre (S-9).
            AlertsStripView(model: alerts)
            NavigationSplitView {
                List(ConsoleSection.allCases, selection: selection) { section in
                    Label(section.title, systemImage: section.systemImage)
                        .tag(section)
                }
                .navigationSplitViewColumnWidth(min: 160, ideal: 200)
            } detail: {
                SectionDetail(
                    section: model.selection,
                    filesModel: filesModel,
                    kanban: kanban,
                    actions: actions,
                    projectModel: projectModel,
                    memoryModel: memoryModel
                )
            }

        }
        .frame(minWidth: 760, minHeight: 480)
    }
}
