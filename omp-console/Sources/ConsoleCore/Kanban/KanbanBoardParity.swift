// LA FIXTURE D'ARDOISE de la recette des voies iPad (feature
// pipelines-ipad-voies-sans-largeur, S-8) : une ardoise construite en mémoire
// qui reproduit les défauts MESURÉS à l'audit de l'écran Pipelines —
//   • une voie « Pas commencées » VIDE (montrée car permanente) ;
//   • trois cartes « En cours », dont un titre de plus de 60 caractères ;
//   • deux cartes « À vous » (jalon specs, jalon revue) ;
//   • une voie « Livrées » d'EXACTEMENT 100 cartes : 50 PR ouvertes, 48 PR
//     fusionnées (98 adresses de PR) et 2 terminées sans PR, aux titres courts
//     et longs en alternance ;
//   • deux cartes « Arrêtées » (échec, bloquée) ;
//   • deux dépôts, dont un nom long : la ligne de dépôt est affichée.
//
// Son contenu est figé par la spec S-8 : `startMs` = 1 700 000 000 000 − rang ×
// 3 600 000, dépôts en alternance selon la parité du rang, aucune marque, aucune
// source, aucun geste (`action` nil) — c'est une ardoise d'AFFICHAGE.
//
// VIT DANS `ConsoleCore` (patron `HomeParity`) : la coque iOS n'a le droit ni
// aux adresses `https://` ni aux instantanés du magasin (garde `coque-ios`).

import Foundation

public enum KanbanBoardParity {
    /// Les deux dépôts de la fixture : rang pair → le premier, impair → le second.
    public static let repos = ["mem0-omp", "omp-console-depot-au-nom-particulierement-long"]

    /// L'ardoise de référence de la recette.
    public static let board = KanbanBoard(cards: cards, anomalies: [])

    /// Une carte de la fixture avant que son rang ne fixe dépôt et début.
    private struct Draft {
        let id: String
        let column: KanbanColumn
        let title: String
        let state: String
        let phase: PipelinePhase
        let prUrl: String?
        let done: Bool
    }

    private static let cards: [KanbanCard] = drafts.enumerated().map { rank, draft in
        let startMs = 1_700_000_000_000 - Double(rank) * 3_600_000
        return KanbanCard(
            id: draft.id,
            column: draft.column,
            repo: repos[rank % 2],
            title: draft.title,
            state: draft.state,
            phase: draft.phase,
            models: nil,
            prUrl: draft.prUrl,
            startMs: startMs,
            endMs: draft.done ? startMs + 1_800_000 : nil,
            marks: [],
            sources: []
        )
    }

    private static var drafts: [Draft] {
        let enCours = [
            "export-csv",
            "pipelines-ipad-voies-sans-largeur-et-cartes-livrees-qui-se-chevauchent",
            "contrat-ios-markdown-brut",
        ].enumerated().map { index, title in
            Draft(id: "parity-en-cours-\(index + 1)", column: .enCours, title: title,
                  state: "running", phase: .impl, prUrl: nil, done: false)
        }
        let aVous = [
            Draft(id: "parity-a-vous-1", column: .jalonSpecs, title: "jalon-specs-a-valider",
                  state: "waiting", phase: .specs, prUrl: nil, done: false),
            Draft(id: "parity-a-vous-2", column: .jalonReview, title: "jalon-revue-a-valider",
                  state: "waiting", phase: .review, prUrl: nil, done: false),
        ]
        let livrees = (1...100).map { index -> Draft in
            let column: KanbanColumn
            let id: String
            switch index {
            case 1...50:
                column = .prOuverte
                id = "parity-pr-ouverte-\(twoDigits(index))"
            case 51...98:
                column = .fusionne
                id = "parity-fusionnee-\(twoDigits(index - 50))"
            default:
                column = .termineeSansPr
                id = "parity-sans-pr-\(index - 98)"
            }
            let short = "livraison-\(twoDigits(index))"
            let title = index % 2 == 1
                ? short
                : "\(short)-au-nom-tres-long-pour-forcer-le-retour-a-la-ligne-de-la-carte"
            return Draft(id: id, column: column, title: title, state: "done", phase: .review,
                         prUrl: index <= 98 ? "https://example.com/pr/\(index)" : nil, done: true)
        }
        let arretees = [
            Draft(id: "parity-arretee-1", column: .echec, title: "arret-sur-echec",
                  state: "failed", phase: .impl, prUrl: nil, done: false),
            Draft(id: "parity-arretee-2", column: .bloquee, title: "arret-bloquee",
                  state: "blocked", phase: .specs, prUrl: nil, done: false),
        ]
        return enCours + aVous + livrees + arretees
    }

    private static func twoDigits(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }
}
