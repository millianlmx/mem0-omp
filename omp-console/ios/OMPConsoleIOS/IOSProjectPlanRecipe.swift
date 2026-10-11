// La fixture du crochet de RECETTE `-projet.recipe plan` (ios-listes-groupees-natives,
// S-6) : une conduite VIVE et son projet de six étapes, plus haut qu'un écran en
// AX-XL, que `IOSProjectModel` lit À LA PLACE de `client.conduite` et du projet du
// Mac. La connexion reste celle du client réel : sur un simulateur non appairé,
// l'écran est vif sous le bandeau de connexion, gestes désactivés, sans réseau.
//
// Le fichier ne nomme aucun littéral alphabétique : les mots viennent
// d'`IOSLaunchRecipeText`.

import ConsoleClient
import ConsoleCore

enum IOSProjectPlanRecipe {
    /// Ce que l'écran Projet lit sous la recette.
    struct Fixture {
        let conduite: RemoteConduiteStatePayload
        let project: Project
    }

    static let fixture = Fixture(conduite: conduite, project: project)

    /// L'étape courante du plan (la troisième).
    private static let current = 2

    /// Les états des features, étape par étape : deux étapes fusionnées, l'étape
    /// courante (fusionnée, PR ouverte, lancée, prévue), puis trois étapes prévues.
    private static let statuses: [[ProjectFeatureStatus]] = [
        [.merged, .merged, .merged],
        [.merged, .merged, .merged],
        [.merged, .pr, .launched, .planned],
        [.planned, .planned, .planned],
        [.planned, .planned, .planned],
        [.planned, .planned, .planned],
    ]

    private static let project = Project(
        repoKey: IOSLaunchRecipeText.planRepoKey,
        repoRoot: IOSLaunchRecipeText.planRepoRoot,
        relayKey: IOSLaunchRecipeText.planRelayKey,
        purpose: IOSLaunchRecipeText.planPurpose,
        function: IOSLaunchRecipeText.planFunction,
        status: .running,
        segments: segments,
        current: current,
        base: nil,
        hostSession: nil,
        createdAt: 0,
        updatedAt: 0
    )

    /// Les étapes ; une feature fusionnée ou en PR porte l'adresse de sa PR,
    /// numérotée dans l'ordre du plan.
    private static var segments: [ProjectSegment] {
        var number = 0
        return statuses.enumerated().map { segment, row in
            let features = row.enumerated().map { feature, status in
                var prUrl: String?
                if status == .merged || status == .pr {
                    number += 1
                    prUrl = IOSLaunchRecipeText.planPRURL(number)
                }
                return ProjectFeature(
                    slug: IOSLaunchRecipeText.planSlug(segment: segment, feature: feature),
                    intention: IOSLaunchRecipeText.planIntention(segment: segment, feature: feature),
                    model: nil,
                    status: status,
                    prUrl: prUrl,
                    failure: nil,
                    removedReason: nil,
                    updatedAt: 0
                )
            }
            return ProjectSegment(name: IOSLaunchRecipeText.planSegmentName(segment), features: features)
        }
    }

    /// La conduite vive du projet, sans dialogue en attente.
    private static let conduite = RemoteConduiteStatePayload(
        state: ProjectConduiteState.live.rawValue,
        repoKey: IOSLaunchRecipeText.planRepoKey,
        name: IOSLaunchRecipeText.planName,
        repoRoot: IOSLaunchRecipeText.planRepoRoot
    )
}
