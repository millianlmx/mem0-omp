// La section « Projet » de la coque : le pilotage d'un projet, dans la fenêtre
// principale (plus de fenêtre « Projet » annexe depuis le 2026-10-02 : l'app
// doit rester utilisable en plein écran). Le titre de la fenêtre reste celui de
// la section ; le nom du projet est son sous-titre.

import SwiftUI

struct ProjectView: ConsoleSectionView {
    static let section = ConsoleSection.project

    @ObservedObject var model: ProjectConsoleModel

    var body: some View {
        ProjectConsoleView(model: model)
    }
}
