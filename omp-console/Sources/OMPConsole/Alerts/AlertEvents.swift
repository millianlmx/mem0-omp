// Dérivation des évènements d'alerte : six familles, des CLÉS stables, l'identifiant
// de la carte concernée et des textes purs, calculés sur un instantané du magasin et
// sur l'ardoise dérivée de ce MÊME instantané.
//
// Ce fichier ne fait AUCUNE E/S : il lit un `StoreSnapshot` et une `KanbanBoard` et
// rend des valeurs (`AlertEvent`). Toute la logique de décision (registre, premier
// plan, livraison) vit dans `AlertsModel.swift` — ici, seule la vérité du magasin est
// traduite.
//
// Parité avec les conventions du dépôt : `KanbanRepoKey.key(forRoot:)` est la SEULE
// clé de dépôt (jamais une seconde fonction de hachage). Les titres viennent des
// fonctions de l'Accueil (`HomeText.natureText`, `ConsoleStatus.of(column:)`) : aucun
// libellé n'est écrit ici ; le corps est le nom que l'Accueil affiche (`KanbanCard.title`).

import ConsoleCore
import Foundation

/// La nature d'un évènement. L'ORDRE DE DÉCLARATION est l'ordre de livraison exigé
/// par S-7 (`pendingAnswer`, puis `milestoneSpecs`, puis `milestoneReview`, …) : il
/// est porté par `rank`, jamais recopié à l'extérieur.
enum AlertKind: String, Sendable, Equatable {
    case pendingAnswer
    case milestoneSpecs
    case milestoneReview
    case failedLot
    case failedRun
    case mergedPullRequest
    /// La pile de l'app a perdu un port qu'elle tenait (S-5, AC-5). Dernier rang :
    /// une perte d'ownership se livre APRÈS les évènements du magasin.
    case stackOwnershipLost

    /// Le rang de livraison : c'est l'ordre de déclaration ci-dessus.
    var rank: Int {
        switch self {
        case .pendingAnswer: 0
        case .milestoneSpecs: 1
        case .milestoneReview: 2
        case .failedLot: 3
        case .failedRun: 4
        case .mergedPullRequest: 5
        case .stackOwnershipLost: 6
        }
    }
}

/// Un évènement à notifier : sa clé d'identification (stable pour un évènement,
/// c'est elle que le registre S-7 retient), la carte qu'il concerne et le texte
/// affiché.
struct AlertEvent: Sendable, Equatable {
    var key: String
    var kind: AlertKind
    /// L'identifiant `KanbanCard.id` de la carte concernée — jamais vide pour une
    /// famille du magasin, même quand la carte n'est pas (ou plus) sur l'ardoise ;
    /// `nil` pour un évènement sans carte (`stackOwnershipLost`).
    var cardID: String? = nil
    var title: String
    var body: String
}

enum AlertDerivation {
    /// Tous les évènements portés par un instantané, dédupliqués par clé et triés
    /// par `(rang de kind, clé croissante)` — l'ordre déterministe de livraison.
    /// `board` est l'ardoise dérivée du même instantané (`nil` quand il n'y en a
    /// pas : magasin absent ou vide) ; elle fournit la carte et son nom affiché.
    ///
    /// FONCTION PURE : aucune E/S, aucune horloge implicite (la péremption est déjà
    /// portée par l'instantané).
    static func events(from snapshot: StoreSnapshot, board: KanbanBoard?) -> [AlertEvent] {
        let cards = board?.cards ?? []
        var byKey: [String: AlertEvent] = [:]
        // Une clé déjà vue garde sa PREMIÈRE valeur : un doublon d'instantané
        // (deux lots du même dépôt, même slug) n'émet qu'un évènement.
        func keep(key: String, kind: AlertKind, cardID: String, fallbackBody: String) {
            guard byKey[key] == nil, let title = title(of: kind) else { return }
            let card = cards.first { $0.id == cardID }
            byKey[key] = AlertEvent(
                key: key, kind: kind, cardID: cardID,
                title: title, body: card?.title ?? fallbackBody
            )
        }

        // (1) « Question » : une question `ask` EN VOL d'un run vivant. `waiting`
        // sans `pendingAsk` n'est pas une question ; une entrée périmée (propriétaire
        // mort) non plus. La carte est celle du run, ou la feature qui l'absorbe.
        for entry in snapshot.running.entries {
            guard let ask = entry.pendingAsk, !entry.isStale else { continue }
            let card = cards.first { $0.id == "run:\(entry.id)" || $0.action?.run?.id == entry.id }
            keep(
                key: "answer:\(entry.id):\(ask.toolCallId)", kind: .pendingAnswer,
                cardID: card?.id ?? "run:\(entry.id)", fallbackBody: entry.label
            )
        }

        // (2) jalons specs et revue et (3) échec d'une feature : les features de
        // tous les lots.
        for lot in snapshot.lots.lots {
            let repoKey = KanbanRepoKey.key(forRoot: lot.repoRoot)
            for feature in lot.features {
                let cardID = "feature:\(repoKey):\(feature.slug)"
                if feature.state == .waiting {
                    switch feature.waitKind {
                    case .specs:
                        keep(
                            key: "milestone:\(repoKey):\(feature.slug):specs", kind: .milestoneSpecs,
                            cardID: cardID, fallbackBody: feature.slug
                        )
                    case .review:
                        keep(
                            key: "milestone:\(repoKey):\(feature.slug):review", kind: .milestoneReview,
                            cardID: cardID, fallbackBody: feature.slug
                        )
                    // `answer` est hors périmètre : c'est la même attente que la
                    // famille (1), qui la porte déjà.
                    case .answer, .none:
                        break
                    }
                }
                if feature.state == .failed {
                    keep(
                        key: "failed-lot:\(repoKey):\(feature.slug)", kind: .failedLot,
                        cardID: cardID, fallbackBody: feature.slug
                    )
                }
            }
        }

        // (4) échec d'une clôture de run : un rang d'historique en échec. Un run
        // VIVANT mais périmé n'est pas une transition, il n'émet rien.
        for entry in snapshot.history.entries where entry.finalState == .failed {
            keep(
                key: "failed-run:\(entry.id)", kind: .failedRun,
                cardID: "history:\(entry.id)", fallbackBody: entry.label
            )
        }

        // (5) « PR fusionnée » : une feature de projet suivie dont la PR est fusionnée.
        // Appariée à une feature de lot, sa carte est celle de la feature ; sinon,
        // la carte de projet seule.
        for project in snapshot.projects.projects {
            for feature in project.segments.flatMap(\.features) where feature.status == .merged {
                let featureCard = "feature:\(project.repoKey):\(feature.slug)"
                let cardID = cards.contains { $0.id == featureCard }
                    ? featureCard
                    : "project:\(project.repoKey):\(feature.slug)"
                keep(
                    key: "merged-pr:\(project.repoKey):\(feature.slug)", kind: .mergedPullRequest,
                    cardID: cardID, fallbackBody: feature.slug
                )
            }
        }

        return byKey.values.sorted { left, right in
            left.kind.rank == right.kind.rank ? left.key < right.key : left.kind.rank < right.kind.rank
        }
    }

    /// Le titre d'une famille : le libellé d'état de l'Accueil pour la carte notifiée,
    /// sauf les échecs, toujours « Échec » (même quand l'Accueil montre « En pause »).
    /// `nil` pour `stackOwnershipLost`, qui ne vient pas du magasin : son texte est
    /// écrit par `StackOwnershipModel`.
    static func title(of kind: AlertKind) -> String? {
        switch kind {
        case .pendingAnswer: HomeText.natureText(.question)
        case .milestoneSpecs: HomeText.natureText(.milestoneSpecs)
        case .milestoneReview: HomeText.natureText(.milestoneReview)
        case .failedLot, .failedRun: ConsoleStatus.of(column: .echec).text
        case .mergedPullRequest: ConsoleStatus.of(column: .fusionne).text
        case .stackOwnershipLost: nil
        }
    }
}
