// La section « Projet » de la coque : elle rend EXACTEMENT la surface de la
// fenêtre « Projet » (BR-3) — mêmes composants, mêmes états.

import SwiftUI

struct ProjectView: ConsoleSectionView {
    static let section = ConsoleSection.project

    @ObservedObject var model: ProjectConsoleModel

    var body: some View {
        ProjectConsoleView(model: model)
    }
}
