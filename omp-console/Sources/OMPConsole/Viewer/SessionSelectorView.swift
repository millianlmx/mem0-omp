// La section « Sessions » : le sélecteur de runs (S-6 de la feature
// `visionneuse-de-session`).
//
// Choisir = un GESTE : chaque run est un `Button` pleine largeur, et le clic (ou
// la touche Entrée une fois la ligne focalisée) ouvre la fenêtre de SA session.
// C'est `openWindow(id:value:)` qui porte la règle « une fenêtre par session » :
// une valeur déjà présentée ramène sa fenêtre au premier plan, une autre valeur
// ouvre une seconde fenêtre (Documentation §1).
//
// Les `Binding` sont construits à la main quand il en faut : aucun attribut macro
// SwiftUI dans ce dépôt (Documentation §3).

import SwiftUI

struct SessionSelectorView: View {
    @StateObject private var selector = SessionSelectorModel()
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Sessions")
                .font(.largeTitle)
            if selector.storeAbsent {
                notice("Magasin d'état absent — aucun run à afficher.")
            } else if selector.choices.isEmpty {
                notice("Aucun run avec un fichier de session.")
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(selector.choices) { choice in
                            row(choice)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            Spacer(minLength: 0)
            Text(footer)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("viewer.selector.footer")
        }
        .padding(12)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Le libellé de la ligne EST le titre du run ; la seconde ligne donne de quoi
    /// choisir sans ouvrir (phase, état, étiquette de session, péremption).
    private func row(_ choice: RunChoice) -> some View {
        Button {
            openWindow(id: "viewer", value: choice.target)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.label)
                    .font(.callout)
                Text(detail(choice))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("viewer.selector.open.\(choice.sessionFile)")
    }

    private func notice(_ text: String) -> some View {
        Text(text)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func detail(_ choice: RunChoice) -> String {
        let state: String = switch choice.state {
        case .live(let runState): runState.rawValue
        case .ended(let finalState): finalState.rawValue
        }
        var parts = [choice.phase.rawValue, state, choice.sessionTag]
        if choice.isStale { parts.append("périmé") }
        return parts.joined(separator: " · ")
    }

    private var footer: String {
        var parts = ["\(selector.choices.count) runs"]
        let stale = selector.choices.filter(\.isStale).count
        if stale > 0 { parts.append("\(stale) périmés") }
        if selector.discarded > 0 { parts.append("\(selector.discarded) entrées illisibles écartées") }
        return parts.joined(separator: " · ")
    }
}
