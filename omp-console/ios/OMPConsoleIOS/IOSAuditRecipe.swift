// Le crochet de RECETTE de l'écran Audit (audit-panel-in-omp-console, S-8, BR-5) :
// il sert l'instantané `AuditParity` (ConsoleCore, le même que les preuves du Mac)
// À LA PLACE de la trame `store`, sans réseau ni appairage, et ouvre UNE fois l'écran
// demandé.
//
//   -audit.recipe liste         : la liste des cinq audits de la fixture, rangés
//                                 « En cours » puis « Terminés » ;
//   -audit.recipe propositions  : le détail de « recette-propositions », les deux
//                                 premières propositions lançables cochées ;
//   -audit.recipe suivi         : le détail de « recette-suivi » — avancement,
//                                 question en attente à deux options, décisions ;
//   -audit.recipe analyse       : le détail de l'audit en cours d'analyse, lancé
//                                 65 s avant l'ouverture de l'app (audit-ui-redesign) ;
//   -audit.recipe echec         : le détail de l'audit en échec (audit-ui-redesign).
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
    case analyse
    case echec

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSAuditRecipe? {
        IOSLaunchRecipe.lastValue(of: IOSAuditRecipeText.flag, in: arguments) { value in
            switch value {
            case IOSAuditRecipeText.list: return .liste
            case IOSAuditRecipeText.proposals: return .propositions
            case IOSAuditRecipeText.followUp: return .suivi
            case IOSAuditRecipeText.analysis: return .analyse
            case IOSAuditRecipeText.failure: return .echec
            default: return nil
            }
        }
    }

    /// L'ardoise servie à l'écran à la place de celle du Mac, l'audit en cours
    /// d'analyse lancé 65 s avant `nowMs` (le lancement de l'app).
    func board(nowMs: Double) -> AuditBoard { AuditParity.board(nowMs: nowMs) }

    /// L'audit ouvert d'emblée ; `nil` pour la liste.
    var openedAudit: String? {
        switch self {
        case .liste: nil
        case .propositions: AuditParity.proposedId
        case .suivi: AuditParity.launchedId
        case .analyse: AuditParity.analysingId
        case .echec: AuditParity.failedId
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
