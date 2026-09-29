// Dérivation des évènements d'alerte (BR-1) : six familles, des CLÉS stables et des
// textes purs, calculés sur un instantané du magasin.
//
// Ce fichier ne fait AUCUNE E/S : il lit un `StoreSnapshot` et rend des valeurs
// (`AlertEvent`). Toute la logique de décision (registre, premier plan, livraison)
// vit dans `AlertsModel.swift` — ici, seule la vérité du magasin est traduite.
//
// Parité avec les conventions du dépôt : `KanbanRepoKey.key(forRoot:)` est la SEULE
// clé de dépôt (jamais une seconde fonction de hachage), et les textes sont produits
// par des fonctions pures, comme `liveStateLabel`/`lotWaitLabel` (KanbanBoard.swift).

import Foundation

/// La nature d'un évènement. L'ORDRE DE DÉCLARATION est l'ordre de livraison exigé
/// par S-7 (`pendingAnswer`, puis `milestoneSpecs`, puis `milestoneReview`, …) : il
/// est porté par `rank`, jamais recopié à l'extérieur.
enum AlertKind: Sendable, Equatable {
    case pendingAnswer
    case milestoneSpecs
    case milestoneReview
    case failedLot
    case failedRun
    case mergedPullRequest

    /// Le rang de livraison : c'est l'ordre de déclaration ci-dessus.
    var rank: Int {
        switch self {
        case .pendingAnswer: 0
        case .milestoneSpecs: 1
        case .milestoneReview: 2
        case .failedLot: 3
        case .failedRun: 4
        case .mergedPullRequest: 5
        }
    }
}

/// Un évènement à notifier : sa clé d'identification (stable pour un évènement,
/// c'est elle que le registre S-7 retient) et le texte affiché.
struct AlertEvent: Sendable, Equatable {
    var key: String
    var kind: AlertKind
    var title: String
    var body: String
}

enum AlertDerivation {
    /// Tous les évènements portés par un instantané, dédupliqués par clé et triés
    /// par `(rang de kind, clé croissante)` — l'ordre déterministe de livraison.
    ///
    /// FONCTION PURE : aucune E/S, aucune horloge implicite (la péremption est déjà
    /// portée par l'instantané).
    static func events(from snapshot: StoreSnapshot) -> [AlertEvent] {
        var byKey: [String: AlertEvent] = [:]
        // Une clé déjà vue garde sa PREMIÈRE valeur : un doublon d'instantané
        // (deux lots du même dépôt, même slug) n'émet qu'un évènement.
        func keep(_ event: AlertEvent) {
            if byKey[event.key] == nil { byKey[event.key] = event }
        }

        // (1) « attend une réponse » : une question `ask` EN VOL d'un run vivant.
        // `waiting` sans `pendingAsk` n'est pas une question (S-3) ; une entrée
        // périmée (propriétaire mort) non plus.
        for entry in snapshot.running.entries {
            guard let ask = entry.pendingAsk, !entry.isStale else { continue }
            keep(AlertEvent(
                key: "answer:\(entry.id):\(ask.toolCallId)",
                kind: .pendingAnswer,
                title: "\(entry.label) attend une réponse",
                body: "Une question attend votre réponse."
            ))
        }

        // (2) « attend une validation » (jalon specs ou revue) et (3) « a échoué » :
        // les features de tous les lots.
        for lot in snapshot.lots.lots {
            let repoKey = KanbanRepoKey.key(forRoot: lot.repoRoot)
            for feature in lot.features {
                let name = displayName(feature)
                if feature.state == .waiting {
                    switch feature.waitKind {
                    case .specs:
                        keep(AlertEvent(
                            key: "milestone:\(repoKey):\(feature.slug):specs",
                            kind: .milestoneSpecs,
                            title: "\(name) attend une validation",
                            body: "Jalon specs : validez le contrat pour continuer."
                        ))
                    case .review:
                        keep(AlertEvent(
                            key: "milestone:\(repoKey):\(feature.slug):review",
                            kind: .milestoneReview,
                            title: "\(name) attend une validation",
                            body: "Jalon revue : validez la livraison pour continuer."
                        ))
                    // `answer` est hors périmètre : c'est la même attente que la
                    // famille (1), qui la porte déjà (S-3).
                    case .answer, .none:
                        break
                    }
                }
                if feature.state == .failed {
                    keep(AlertEvent(
                        key: "failed-lot:\(repoKey):\(feature.slug)",
                        kind: .failedLot,
                        title: "\(name) a échoué",
                        body: "La feature \(feature.slug) a échoué."
                    ))
                }
            }
        }

        // (4) « a échoué » d'une clôture de run : un rang d'historique en échec.
        // Un run VIVANT mais périmé n'est pas une transition, il n'émet rien (S-5).
        for entry in snapshot.history.entries where entry.finalState == .failed {
            keep(AlertEvent(
                key: "failed-run:\(entry.id)",
                kind: .failedRun,
                title: "\(entry.label) a échoué",
                body: "Le run a échoué."
            ))
        }

        // (5) « PR fusionnée » : une feature de projet suivie dont la PR est fusionnée.
        for project in snapshot.projects.projects {
            for feature in project.segments.flatMap(\.features) where feature.status == .merged {
                keep(AlertEvent(
                    key: "merged-pr:\(project.repoKey):\(feature.slug)",
                    kind: .mergedPullRequest,
                    title: "PR fusionnée : \(feature.slug)",
                    body: "La PR de \(feature.slug) est fusionnée."
                ))
            }
        }

        return byKey.values.sorted { left, right in
            left.kind.rank == right.kind.rank ? left.key < right.key : left.kind.rank < right.kind.rank
        }
    }

    /// Le nom d'affichage d'une feature de lot : son `name` s'il n'est pas blanc,
    /// sinon son `slug` (S-4) — aucune valeur n'est inventée.
    private static func displayName(_ feature: LotFeature) -> String {
        feature.name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? feature.slug : feature.name
    }
}
