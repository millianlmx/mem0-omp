// Aiguillage d'un run depuis l'app (S-3) et catalogue des dépôts lançables (S-7) :
// deux fonctions PURES, sans vue et sans E/S, donc vérifiables par un test qui ne
// rend rien.
//
// La règle d'aiguillage est EXHAUSTIVE et ne laisse jamais coexister une réponse à
// une question et un envoi de texte libre (AC-4).

import Foundation

/// Ce qu'une carte offre comme geste. L'ordre d'apparition est celui de
/// `zones(for:)` : question **ou** steer, puis jalon, puis arrêt.
enum KanbanActionZone: Sendable, Equatable {
    case pendingQuestion(toolCallId: String, question: String, options: [PanelAskOption])
    case steer
    case milestone(slug: String, kind: LotWaitKind)
    case stopLot(repoRoot: String)
}

enum KanbanActionPresentation {
    /// Les zones d'une carte. Exhaustif sur `card.action` :
    ///
    /// 1. une question en vol ⇒ `.pendingQuestion` et **jamais** `.steer` ;
    /// 2. sinon un run dont la boîte est publiée ⇒ `.steer`, **jamais** une question ;
    /// 3. `run.inbox == nil` ⇒ ni l'un ni l'autre (le motif est celui de `motif(for:)`) ;
    /// 4. `run == nil` ⇒ ni l'un ni l'autre ;
    /// puis un jalon (`waiting` + `.specs`/`.review`) et l'arrêt (une feature de lot).
    static func zones(for card: KanbanCard) -> [KanbanActionZone] {
        guard let action = card.action else { return [] }
        var zones: [KanbanActionZone] = []
        if let run = action.run {
            if let ask = run.pendingAsk {
                zones.append(.pendingQuestion(
                    toolCallId: ask.toolCallId,
                    question: ask.question,
                    options: ask.options
                ))
            } else if run.inbox != nil {
                zones.append(.steer)
            }
        }
        if let slug = action.slug, action.featureState == .waiting,
           let kind = action.waitKind, kind == .specs || kind == .review {
            zones.append(.milestone(slug: slug, kind: kind))
        }
        // Le canal n'a PAS d'arrêt par run : `stop` est adressé au dépôt, donc le
        // bouton n'est offert que sur une carte portant un LOT (S-8).
        if action.slug != nil, let repoRoot = action.repoRoot {
            zones.append(.stopLot(repoRoot: repoRoot))
        }
        return zones
    }

    /// Le motif à afficher, non nul SEULEMENT quand la carte n'offre aucune zone :
    /// un run non armé dit pourquoi, toute autre carte sans geste dit qu'elle n'en
    /// porte aucun.
    static func motif(for card: KanbanCard) -> String? {
        guard zones(for: card).isEmpty else { return nil }
        if let run = card.action?.run, run.inbox == nil {
            return ActionsText.notArmed(run.label)
        }
        return ActionsText.noGesture
    }
}

/// Les dépôts proposés au formulaire de lancement (S-7) : les dépôts RÉELS portés
/// par les cartes de l'ardoise, ∪ le projet ouvert, triés et dédupliqués.
enum KanbanLaunchRepos {
    static func options(cards: [KanbanCard], projectRoot: String?) -> [String] {
        var roots = Set<String>()
        for card in cards {
            if let root = card.action?.repoRoot, !root.isEmpty { roots.insert(realpathOr(root)) }
        }
        if let projectRoot, !projectRoot.isEmpty { roots.insert(realpathOr(projectRoot)) }
        return roots.sorted()
    }

    /// Le dépôt sélectionné par défaut : celui de la carte sélectionnée s'il est
    /// dans la liste, sinon le projet ouvert, sinon le premier. `nil` seulement
    /// quand la liste est vide.
    static func defaultSelection(
        options: [String],
        selectedRepoRoot: String?,
        projectRoot: String?
    ) -> String? {
        if let selected = selectedRepoRoot.map(realpathOr), options.contains(selected) { return selected }
        if let project = projectRoot.map(realpathOr), options.contains(project) { return project }
        return options.first
    }
}
