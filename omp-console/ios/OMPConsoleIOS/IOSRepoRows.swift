// Les rangées de dépôts des feuilles « Piloter un projet » et « Lancer une session OMP »
// (feuilles-ios-presentation-et-depots, S-3) : une seule vue pour les deux feuilles.
//
// Chaque rangée montre UN texte, le libellé de `KanbanLaunchRepos.choices` : le nom du
// dossier seul, ou `nom (parent)` pour les homonymes ; aucun chemin. Le texte garde la
// couleur normale (`.tint(.primary)`, pas le bleu lien d'un bouton de `Form`). La
// rangée choisie porte une coche SF Symbol masquée à VoiceOver : la sélection est dite
// par le trait « sélectionné », jamais par la lecture du symbole.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSRepoRows: View {
    let repos: [RemoteRepoRow]
    /// La clé du dépôt choisi, ou aucune.
    let selected: String?
    /// L'identifiant d'accessibilité d'une rangée, à partir de sa `repoKey`.
    let identifier: (String) -> String
    let choose: (RemoteRepoRow) -> Void

    /// `repoKey → libellé`, par `KanbanLaunchRepos.choices` sur les `repoRoot`.
    static func labels(_ repos: [RemoteRepoRow]) -> [String: String] {
        let byRoot = Dictionary(
            KanbanLaunchRepos.choices(repos.map(\.repoRoot)).map { ($0.root, $0.label) },
            uniquingKeysWith: { first, _ in first })
        var labels: [String: String] = [:]
        for repo in repos {
            labels[repo.repoKey] = byRoot[repo.repoRoot] ?? repo.name
        }
        return labels
    }

    var body: some View {
        let labels = Self.labels(repos)
        ForEach(repos, id: \.repoKey) { repo in
            let isSelected = selected == repo.repoKey
            Button { choose(repo) } label: {
                HStack(spacing: 8) {
                    Text(verbatim: labels[repo.repoKey] ?? repo.name)
                    Spacer(minLength: 8)
                    if isSelected {
                        Image(systemName: IOSHomeText.selectedSymbol)
                            .fontWeight(.semibold)
                            .foregroundStyle(Color.accentColor)
                            .accessibilityHidden(true)
                    }
                }
            }
            .tint(.primary)
            .accessibilityAddTraits(isSelected ? .isSelected : [])
            .accessibilityIdentifier(identifier(repo.repoKey))
        }
    }
}
