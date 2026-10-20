// L'ardoise UNIFIÉE des deux machines (S-6 de orchestrator-living-in-a-vps) : les
// cartes du Mac et du VPS dans une même ardoise, sans que les vues, les gestes ni
// la dérivation ne changent de forme.
//
// Pas de VPS configuré : l'ardoise du Mac, telle quelle (aucun badge, aucun
// identifiant modifié). VPS configuré : les cartes du VPS reçoivent l'identifiant
// `vps:<id>` — l'identifiant de carte DE CETTE MACHINE reste ce qui suit le
// préfixe, et c'est lui que le geste envoie à la machine de la carte. Une machine
// injoignable n'apporte aucune carte : un bandeau le dit.

import Foundation

/// L'identifiant de carte d'une ardoise unifiée.
public enum MachineCardID {
    public static let vpsPrefix = "vps:"

    /// La machine d'une carte de l'ardoise unifiée.
    public static func machine(of id: String) -> RepoMachine {
        id.hasPrefix(vpsPrefix) ? .vps : .mac
    }

    /// L'identifiant tel que la machine de la carte le connaît.
    public static func raw(_ id: String) -> String {
        id.hasPrefix(vpsPrefix) ? String(id.dropFirst(vpsPrefix.count)) : id
    }

    /// L'identifiant d'une carte de `machine` dans l'ardoise unifiée.
    public static func namespaced(_ id: String, on machine: RepoMachine) -> String {
        machine == .vps ? vpsPrefix + id : id
    }
}

/// Ce que l'on sait de l'ardoise d'une machine.
public enum MachineBoard: Equatable, Sendable {
    case notConfigured
    case unreachable
    case state(KanbanBoardState)
}

public struct UnifiedBoard: Equatable, Sendable {
    public var state: KanbanBoardState
    /// Les machines configurées mais injoignables : un bandeau chacune.
    public var unreachable: [RepoMachine]
    /// Vrai quand un VPS est configuré : chaque carte porte alors son badge.
    public var showsBadges: Bool

    public init(state: KanbanBoardState, unreachable: [RepoMachine], showsBadges: Bool) {
        self.state = state
        self.unreachable = unreachable
        self.showsBadges = showsBadges
    }

    public static func merge(mac: MachineBoard, vps: MachineBoard) -> UnifiedBoard {
        guard vps != .notConfigured else {
            switch mac {
            case .state(let state):
                return UnifiedBoard(state: state, unreachable: [], showsBadges: false)
            case .notConfigured, .unreachable:
                return UnifiedBoard(state: .loading, unreachable: [], showsBadges: false)
            }
        }
        var cards: [KanbanCard] = []
        var anomalies: [KanbanAnomaly] = []
        var fallback: KanbanBoardState?
        var unreachable: [RepoMachine] = []
        var anyBoard = false
        for (machine, entry) in [(RepoMachine.mac, mac), (RepoMachine.vps, vps)] {
            switch entry {
            case .notConfigured:
                continue
            case .unreachable:
                unreachable.append(machine)
            case .state(.board(let board)):
                anyBoard = true
                for var card in board.cards {
                    card.id = MachineCardID.namespaced(card.id, on: machine)
                    cards.append(card)
                }
                anomalies.append(contentsOf: board.anomalies)
            case .state(let other):
                fallback = fallback ?? other
            }
        }
        if anyBoard {
            return UnifiedBoard(
                state: .board(KanbanBoard(cards: cards, anomalies: anomalies)),
                unreachable: unreachable,
                showsBadges: true
            )
        }
        return UnifiedBoard(state: fallback ?? .loading, unreachable: unreachable, showsBadges: true)
    }
}
