// La VIVACITÉ d'un propriétaire de pipeline, INJECTÉE dans la dérivation de
// l'ardoise (S-1) : c'est ce qui rend `KanbanBoard.build` une fonction pure des
// deux côtés de la coque.
//
// Le Mac interroge SES processus (`kill(pid, 0)` — `processLocal`) ; l'app iOS,
// qui ne peut pas sonder un pid du Mac, lit la vivacité TRANSPORTÉE par
// l'instantané (`transported(_:)`) : le Mac a déjà calculé `RunningEntry.isStale`
// et `Lot.isStale` au moment de la lecture, et c'est la seule vivacité observable
// à distance. Aucune plateforme ne sonde le pid de l'autre.

import Foundation

/// La règle de vivacité d'un propriétaire de pipeline, portée comme valeur.
///
/// `isAlive(nil)` est toujours faux : un pid ABSENT est mort (parité `asPid`).
public struct PipelineLiveness: Sendable {
    /// Le prédicat : un pid (éventuellement absent) rendu vivant ou non.
    public let isAlive: @Sendable (Int?) -> Bool

    public init(isAlive: @escaping @Sendable (Int?) -> Bool) {
        self.isAlive = isAlive
    }

    /// Le Mac : un pid absent est mort, sinon on interroge le noyau
    /// (`pidAlive`, `StoreModels.swift`).
    public static let processLocal = PipelineLiveness { pid in
        guard let pid else { return false }
        return pidAlive(pid)
    }

    /// iOS : vivant si l'instantané porte un run OU un lot de ce pid dont la
    /// vivacité transportée n'est pas périmée (`isStale == false`). La vivacité
    /// est celle que le Mac a calculée à la lecture — l'app ne sonde rien.
    public static func transported(_ snapshot: StoreSnapshot) -> PipelineLiveness {
        PipelineLiveness { pid in
            guard let pid else { return false }
            if snapshot.running.entries.contains(where: { $0.ownerPid == pid && !$0.isStale }) {
                return true
            }
            if snapshot.lots.lots.contains(where: { $0.owner.pid == pid && !$0.isStale }) {
                return true
            }
            return false
        }
    }
}
