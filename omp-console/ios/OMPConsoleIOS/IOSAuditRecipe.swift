// Le crochet de RECETTE de l'écran Audit (audit-panel-in-omp-console, S-8, BR-5) :
// il sert l'instantané `AuditParity` (ConsoleCore, le même que les preuves du Mac)
// À LA PLACE de la trame `store`, sans réseau ni appairage, et ouvre UNE fois l'écran
// demandé.
//
//   -audit.recipe liste         : la liste des trois audits de la fixture ;
//   -audit.recipe propositions  : le détail de « recette-propositions », les deux
//                                 premières propositions lançables cochées ;
//   -audit.recipe suivi         : le détail de « recette-suivi » — avancement,
//                                 question en attente à deux options, décisions.
//
// Sans l'argument : aucun effet. La DERNIÈRE paire reconnue gagne ; une valeur
// inconnue est ignorée (`IOSLaunchRecipe.lastValue`). Le fichier ne nomme aucun
// littéral alphabétique : les valeurs viennent d'`IOSAuditRecipeText`.

import ConsoleCore
import Foundation

enum IOSAuditRecipe: Equatable {
    case liste
    case propositions
    case suivi

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSAuditRecipe? {
        IOSLaunchRecipe.lastValue(of: IOSAuditRecipeText.flag, in: arguments) { value in
            switch value {
            case IOSAuditRecipeText.list: return .liste
            case IOSAuditRecipeText.proposals: return .propositions
            case IOSAuditRecipeText.followUp: return .suivi
            default: return nil
            }
        }
    }

    /// L'ardoise servie à l'écran à la place de celle du Mac.
    var board: AuditBoard { AuditParity.board }

    /// L'audit ouvert d'emblée ; `nil` pour la liste.
    var openedAudit: String? {
        switch self {
        case .liste: nil
        case .propositions: AuditParity.proposedId
        case .suivi: AuditParity.launchedId
        }
    }

    /// Les cases cochées d'emblée : les deux premières propositions lançables de
    /// l'audit ouvert, sous `propositions` seulement.
    var checked: [String: Set<String>] {
        guard self == .propositions,
              let card = AuditParity.board.card(id: AuditParity.proposedId) else { return [:] }
        let slugs = card.proposals.filter { !$0.taken }.prefix(2).map(\.slug)
        return [card.id: Set(slugs)]
    }
}
