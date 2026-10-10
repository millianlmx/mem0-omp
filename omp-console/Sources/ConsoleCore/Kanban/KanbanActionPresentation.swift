// Aiguillage d'un run depuis l'app (S-3) et catalogue des dépôts lançables (S-7) :
// deux fonctions PURES, sans vue et sans E/S, donc vérifiables par un test qui ne
// rend rien.
//
// La règle d'aiguillage est EXHAUSTIVE et ne laisse jamais coexister une réponse à
// une question et un envoi de texte libre (AC-4).
//
// VIT DANS `ConsoleCore` : les deux coques partagent l'aiguillage.

import Foundation

/// Ce qu'une carte offre comme geste. L'ordre d'apparition est celui de
/// `zones(for:)` : question **ou** steer, puis question en texte, puis jalon, puis
/// reprise, puis arrêt.
public enum KanbanActionZone: Sendable, Equatable {
    case pendingQuestion(toolCallId: String, question: String, options: [PanelAskOption])
    case steer
    /// Une question en TEXTE d'un maillon terminé : la réponse part en commande
    /// `reply` (S-10 de omp-console-redesign).
    case textQuestion(slug: String, prompt: String?)
    case milestone(slug: String, kind: LotWaitKind)
    /// Le pilote du lot est mort alors que la feature vit encore : « Reprendre »
    /// fait conduire le dépôt par l'app (S-7, S-10 de omp-console-redesign).
    case resume(repoRoot: String)
    case stopLot(repoRoot: String)
}

public enum KanbanActionPresentation {
    /// Les zones d'une carte. Exhaustif sur `card.action` :
    ///
    /// 1. une question en vol ⇒ `.pendingQuestion` et **jamais** `.steer` ;
    /// 2. sinon un run dont la boîte est publiée ⇒ `.steer`, **jamais** une question ;
    /// 3. `run.inbox == nil` ⇒ ni l'un ni l'autre (le motif est celui de `motif(for:)`) ;
    /// 4. `run == nil` ⇒ ni l'un ni l'autre ;
    /// puis une question en texte (`waiting` + `.answer` sans question `ask` en vol,
    /// donc jamais en même temps qu'une question en vol), un jalon (`waiting` +
    /// `.specs`/`.review`), la reprise (marque `mort` sur une feature vivante) et
    /// l'arrêt (une feature de lot).
    public static func zones(for card: KanbanCard) -> [KanbanActionZone] {
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
           action.waitKind == .answer, action.run?.pendingAsk == nil {
            zones.append(.textQuestion(slug: slug, prompt: action.waitPrompt))
        }
        if let slug = action.slug, action.featureState == .waiting,
           let kind = action.waitKind, kind == .specs || kind == .review {
            zones.append(.milestone(slug: slug, kind: kind))
        }
        if card.marks.contains(.mort), action.slug != nil, let repoRoot = action.repoRoot,
           let state = action.featureState, state == .pending || state == .running || state == .waiting {
            zones.append(.resume(repoRoot: repoRoot))
        }
        // Le canal n'a PAS d'arrêt par run : `stop` est adressé au dépôt, donc le
        // bouton n'est offert que sur une carte portant un LOT (S-8).
        if action.slug != nil, let repoRoot = action.repoRoot {
            zones.append(.stopLot(repoRoot: repoRoot))
        }
        return zones
    }

    /// Le motif à afficher, non nul SEULEMENT quand la carte n'offre aucune zone :
    /// une exécution non armée dit pourquoi, toute autre carte sans geste dit
    /// qu'elle n'en porte aucun.
    public static func motif(for card: KanbanCard) -> String? {
        guard zones(for: card).isEmpty else { return nil }
        if let run = card.action?.run, run.inbox == nil {
            return KanbanText.notArmed
        }
        return KanbanText.noGesture
    }

    /// La carte offre « Reprendre » (S-10) : son pilote est mort alors que la
    /// feature vit encore.
    public static func resumable(_ card: KanbanCard) -> Bool {
        zones(for: card).contains { zone in
            if case .resume = zone { return true }
            return false
        }
    }
}

/// Les dépôts proposés au formulaire de lancement (S-7) : les dépôts RÉELS portés
/// par les cartes de l'ardoise, ∪ le projet ouvert, triés et dédupliqués.
public enum KanbanLaunchRepos {
    public static func options(cards: [KanbanCard], projectRoot: String?) -> [String] {
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
    public static func defaultSelection(
        options: [String],
        selectedRepoRoot: String?,
        projectRoot: String?
    ) -> String? {
        if let selected = selectedRepoRoot.map(realpathOr), options.contains(selected) { return selected }
        if let project = projectRoot.map(realpathOr), options.contains(project) { return project }
        return options.first
    }
}

/// Un dépôt proposé au formulaire de lancement, avec son libellé d'affichage :
/// `root` est le chemin COMPLET (la valeur lancée), `label` ce que l'on montre.
public struct KanbanLaunchRepoChoice: Equatable, Sendable, Identifiable {
    public let root: String
    public let label: String
    public var id: String { root }

    public init(root: String, label: String) {
        self.root = root
        self.label = label
    }
}

extension KanbanLaunchRepos {
    /// Les libellés d'affichage des dépôts : le nom du dossier racine, élargi par
    /// les derniers segments du dossier parent pour les seuls homonymes, jusqu'à
    /// ce que les libellés d'un groupe soient distincts. Dérivation pure : aucune
    /// lecture du disque. L'ordre de l'entrée est conservé, les doublons écartés.
    public static func choices(_ roots: [String]) -> [KanbanLaunchRepoChoice] {
        var seen = Set<String>()
        let unique = roots.filter { seen.insert($0).inserted }
        let segments = unique.map { $0.split(separator: "/", omittingEmptySubsequences: true).map(String.init) }

        var groups: [String: [Int]] = [:]
        for (index, parts) in segments.enumerated() {
            if let name = parts.last { groups[name, default: []].append(index) }
        }

        var labels = unique
        for (name, members) in groups {
            guard members.count > 1 else { labels[members[0]] = name; continue }
            let parents = members.map { Array(segments[$0].dropLast()) }
            func complement(_ parent: [String], _ k: Int) -> String {
                let joined = parent.suffix(min(k, parent.count)).joined(separator: "/")
                return joined.isEmpty ? "/" : joined
            }
            let widest = parents.map(\.count).max() ?? 0
            var k = 1
            while k < widest, Set(parents.map { complement($0, k) }).count < members.count { k += 1 }
            for (offset, index) in members.enumerated() {
                labels[index] = "\(name) (\(complement(parents[offset], k)))"
            }
        }
        return zip(unique, labels).map { KanbanLaunchRepoChoice(root: $0, label: $1) }
    }
}
