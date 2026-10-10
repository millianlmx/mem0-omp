// L'état d'un appel d'outil dans un fil de conversation (S-7 de
// mac-finitions-hig), décidé UNE fois pour les deux coques : un appel sans
// résultat n'est « en cours » que si la session vit encore ; dans une session
// finie, il ne recevra plus rien et se lit « Interrompu ».

import Foundation

public enum ToolCallStatus: Equatable, Sendable {
    case running
    case interrupted
    case done
    case failed

    /// `sessionEnded` est la fin de la session qui porte le fil (fin du run pour
    /// la visionneuse, fin de la session hébergée pour Session OMP et Projet).
    public static func of(_ result: ToolResultRow?, sessionEnded: Bool) -> ToolCallStatus {
        guard let result else { return sessionEnded ? .interrupted : .running }
        return result.isError ? .failed : .done
    }
}
