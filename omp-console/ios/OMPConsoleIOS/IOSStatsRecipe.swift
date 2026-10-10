// Le crochet de RECETTE `-stats.recipe <vide|chargement|bascule>` (S-6 de
// statistiques-etat-vide-et-non-defilables) : il ouvre la section Statistiques sur
// le VRAI `IOSStatsModel` et le VRAI écran, nourris par une lecture en mémoire et
// un client forcé `.connected` — sans réseau et sans appairage. Un crochet de
// recette, pas une fonctionnalité.
//
// Sans l'argument : aucun effet. Comme `IOSMemoryGraphRecipe`, la DERNIÈRE paire
// reconnue gagne ; une valeur inconnue est ignorée.
//
// Une lecture « en cours » attend sur un `AsyncStream` dont la continuation est
// conservée et jamais nourrie : elle ne rend la main qu'à son annulation (aucune
// minuterie, aucune scrutation). Aucun littéral alphabétique ici : les mots
// viennent d'`IOSStatsText`.

import ConsoleClient
import Foundation

/// Le crochet lu dans les arguments de lancement.
enum IOSStatsRecipe: Equatable {
    /// `recette-vide` servi ; choisir `recette-pleine` sert son tableau.
    case vide
    /// La première lecture reste en cours : l'écran reste en chargement.
    case chargement
    /// `recette-pleine` servi, puis la bascule vers `recette-vide`, dont la lecture
    /// reste en cours : l'écran reste en bascule.
    case bascule

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSStatsRecipe? {
        var resolved: IOSStatsRecipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == IOSStatsText.recipeFlag,
               index + 1 < arguments.count,
               let recipe = named(arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }

    /// Les valeurs reconnues, lues dans le vocabulaire de l'app (aucun littéral ici).
    private static func named(_ value: String) -> IOSStatsRecipe? {
        switch value {
        case IOSStatsText.recipeEmpty: return .vide
        case IOSStatsText.recipeLoading: return .chargement
        case IOSStatsText.recipeSwitch: return .bascule
        default: return nil
        }
    }

    /// L'état forcé du client : connecté, à l'adresse de recette habituelle.
    static let state = ClientState.connected(endpoint: .manual(host: "127.0.0.1", port: 8787))

    /// Le modèle RÉEL de la section, nourri par la lecture de la recette.
    @MainActor func model() -> IOSStatsModel {
        IOSStatsModel(load: load(), state: { Self.state })
    }

    /// La lecture servie pour une clé demandée (`nil` : le Mac choisit, donc le
    /// premier projet de la recette).
    @MainActor private func load() -> IOSStatsModel.Load {
        let gate = IOSStatsRecipeGate()
        let recipe = self
        return { key in
            switch recipe {
            case .vide:
                return key == IOSStatsText.recipeFullProject ? Self.full : Self.empty
            case .chargement:
                return try await gate.hold()
            case .bascule:
                if key == IOSStatsText.recipeEmptyProject { return try await gate.hold() }
                return Self.full
            }
        }
    }

    /// Le pas suivant de la recette, appelé quand l'écran reçoit un relevé : la
    /// bascule choisit `recette-vide` dès que le tableau de `recette-pleine` est
    /// affiché, une seule fois (l'écran passe alors en bascule).
    @MainActor func advance(_ model: IOSStatsModel) {
        guard self == .bascule, model.surface(connection: .connected) == .board else { return }
        model.select(project: IOSStatsText.recipeEmptyProject)
    }

    // MARK: - Fixture

    private static let projects = [
        RemoteStatsProject(key: IOSStatsText.recipeEmptyProject, label: IOSStatsText.recipeEmptyProject),
        RemoteStatsProject(key: IOSStatsText.recipeFullProject, label: IOSStatsText.recipeFullProject),
    ]

    /// `recette-vide` : aucune feature listée, deux features du plan masquées.
    private static let empty = RemoteStatsPayload(
        projectKey: IOSStatsText.recipeEmptyProject,
        project: IOSStatsText.recipeEmptyProject,
        projects: projects,
        features: [],
        hiddenPlanFeatures: 2
    )

    /// `recette-pleine` : deux features, la seconde avec un run vivant.
    private static let full = RemoteStatsPayload(
        projectKey: IOSStatsText.recipeFullProject,
        project: IOSStatsText.recipeFullProject,
        projects: projects,
        features: [
            RemoteStatsFeature(
                slug: IOSStatsText.recipeFeatures[0],
                input: 182_400,
                output: 9_310,
                turns: 14,
                durationMs: 754_000,
                liveRuns: 0,
                model: IOSStatsText.recipeModel
            ),
            RemoteStatsFeature(
                slug: IOSStatsText.recipeFeatures[1],
                input: 96_050,
                output: 4_120,
                turns: 6,
                durationMs: 211_000,
                liveRuns: 1,
                model: IOSStatsText.recipeModel
            ),
        ],
        hiddenPlanFeatures: 0
    )
}

/// Les lectures « en cours » de la recette : chacune attend sur son propre
/// `AsyncStream` (un flux n'a qu'un lecteur), dont la continuation est gardée ici
/// et jamais nourrie — la lecture ne finit qu'à l'annulation de sa tâche.
@MainActor
private final class IOSStatsRecipeGate {
    private var held: [AsyncStream<Never>.Continuation] = []

    func hold() async throws -> RemoteStatsPayload {
        let (stream, continuation) = AsyncStream<Never>.makeStream()
        held.append(continuation)
        for await _ in stream {}
        throw CancellationError()
    }
}
