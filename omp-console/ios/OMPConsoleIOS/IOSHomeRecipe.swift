// Le crochet de RECETTE `-home.recipe <état>` (BR-4, BR-5) : il force l'Accueil
// dans l'un de ses cinq états depuis la fixture partagée `HomeParity`, et ouvre
// la feuille « Répondre » ou « Contrat » sur la carte de la fixture, pour que les
// captures montrent un chemin de code RÉEL — jamais un écran fabriqué.
//
// Sans l'argument : aucun effet (la vue résout son état normalement). Comme
// `IOSSection.resolve`, la DERNIÈRE paire reconnue gagne ; une valeur inconnue est
// ignorée.
//
// `-home.row <n>` (feature ios-accueil-dynamic-type-casse) amène le HAUT de la
// rangée d'index `n` — « En cours » puis « Livrées récemment » — en haut de la
// zone de défilement du tableau de bord, pour les captures de rangées. Même
// règle : la DERNIÈRE paire reconnue gagne ; `n` doit être un entier ≥ 0, sinon la
// paire est ignorée. Ce n'est pas une fonctionnalité, comme `-home.recipe`.
//
// Le fichier ne nomme PAS le type de l'instantané (jeton interdit dans les
// sources de l'app) : il consomme `HomeParity.snapshot`, la fixture partagée.

import ConsoleClient
import ConsoleCore
import Foundation

enum IOSHomeRecipe: String, Equatable {
    case dashboard
    case firstRun
    case loading
    case ompMissing
    case degraded
    /// Le tableau de bord avec la feuille « Répondre » ouverte (capture S-13).
    case answer
    /// Le tableau de bord avec la feuille Contrat ouverte (capture S-14).
    case contract
    /// Le tableau de bord avec la feuille Contrat ouverte sur un nom de feature
    /// LONG et un contrat LONG (`IOSHomeRecipeText`, preuves de
    /// contrat-ios-markdown-brut, S-4).
    case contractLong

    /// La recette lue dans les arguments de lancement, ou aucune.
    static func resolve(_ arguments: [String]) -> IOSHomeRecipe? {
        var resolved: IOSHomeRecipe?
        var index = 0
        while index < arguments.count {
            if arguments[index] == "-home.recipe",
               index + 1 < arguments.count,
               let recipe = IOSHomeRecipe(rawValue: arguments[index + 1]) {
                resolved = recipe
            }
            index += 1
        }
        return resolved
    }

    /// La rangée à amener en haut de l'écran : la DERNIÈRE paire `-home.row <n>`
    /// reconnue gagne ; `n` doit être un entier ≥ 0, sinon la paire est ignorée.
    static func row(_ arguments: [String]) -> Int? {
        var resolved: Int?
        var index = 0
        while index < arguments.count {
            if arguments[index] == "-home.row",
               index + 1 < arguments.count,
               let row = Int(arguments[index + 1]),
               row >= 0 {
                resolved = row
            }
            index += 1
        }
        return resolved
    }

    /// L'état de l'Accueil forcé, dérivé de la fixture partagée.
    var homeState: IOSHomeState {
        let inputs = self.inputs
        return IOSHomeState.resolve(state: inputs.state, board: inputs.board, omp: inputs.omp)
    }

    /// Le badge de la ligne « Accueil » : le compte d'attentes du MÊME couple
    /// (omp, board) que l'Accueil forcé, comme en direct (il ignore la connexion).
    var badge: Int {
        let inputs = self.inputs
        return IOSHomeContent.badge(omp: inputs.omp, board: inputs.board)
    }

    /// La SEULE source du couple (omp, board) — et de l'état de connexion — de
    /// chaque cas : `homeState` et `badge` ne peuvent pas diverger.
    private var inputs: (state: ClientState, omp: OmpStatus, board: KanbanBoardState) {
        let omp = OmpStatus.available(URL(fileURLWithPath: ""))
        let connected = ClientState.connected(endpoint: .manual(host: "", port: 0))
        switch self {
        case .dashboard, .answer, .contract, .contractLong:
            return (connected, omp, Self.board)
        case .loading:
            return (connected, omp, .loading)
        case .firstRun:
            return (connected, omp, .storeEmpty(dir: ""))
        case .ompMissing:
            return (connected, .missing, Self.board)
        case .degraded:
            return (.unpaired, omp, Self.board)
        }
    }

    /// La carte dont une feuille est ouverte par la recette, ou aucune.
    var sheetCard: KanbanCard? {
        let attention = Self.attention
        switch self {
        case .answer:
            return attention.first { IOSHomeContent.attentionButton($0) == .answer }?.card
        case .contract:
            return attention.first { ContractDocument.moment(for: $0.card) != nil }?.card
        case .contractLong:
            // La carte de `contract`, dont seul le DERNIER segment de l'identifiant
            // (le nom de la feature, `IOSHomeContent.contractSlug`) est remplacé.
            guard var card = Self.contract.sheetCard else { return nil }
            if let colon = card.id.lastIndex(of: ":") {
                card.id = String(card.id[...colon]) + IOSHomeRecipeText.longSlug
            } else {
                card.id = IOSHomeRecipeText.longSlug
            }
            return card
        default:
            return nil
        }
    }

    /// La charge utile de contrat de recette : le markdown de la fixture partagée,
    /// pour que la feuille montre de vraies sections sans réseau. `contractLong`
    /// sert le contrat long de `IOSHomeRecipeText`.
    var contractPayload: RemoteContractPayload? {
        let content: String
        switch self {
        case .contract: content = HomeParity.contractMarkdown
        case .contractLong: content = IOSHomeRecipeText.longContract
        default: return nil
        }
        return RemoteContractPayload(document: RemoteDocument(
            name: IOSHomeText.contractName,
            state: IOSHomeText.documentText,
            content: content,
            reason: nil
        ))
    }

    /// L'ardoise de la fixture, horloge fixe.
    private static let board: KanbanBoardState = KanbanBoardState.derive(
        snapshot: HomeParity.snapshot,
        nowMs: 1_700_000_000_000,
        stateDir: "",
        isAlive: .transported(HomeParity.snapshot)
    )

    /// Les faits d'attention de la fixture.
    private static var attention: [HomeAttention] {
        guard case .board(let board) = Self.board else { return [] }
        return HomePresentation.dashboard(board).attention
    }
}
