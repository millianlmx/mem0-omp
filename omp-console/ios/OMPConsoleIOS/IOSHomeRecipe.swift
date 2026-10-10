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
    /// Le tableau de bord dont chaque rangée « En cours » et « Livrées récemment »
    /// porte un titre long (captures des rangées en largeur compacte).
    case longTitles
    /// Le tableau de bord dont l'envoi des gestes de carte n'aboutit jamais : un Mac
    /// qui tarde, pour les captures de l'état « Envoi en cours ».
    case slowMac

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
        let omp = OmpStatus.available(URL(fileURLWithPath: ""))
        let connected = ClientState.connected(endpoint: .manual(host: "", port: 0))
        switch self {
        case .dashboard, .answer, .contract, .slowMac:
            return IOSHomeState.resolve(state: connected, board: Self.board, omp: omp)
        case .longTitles:
            return IOSHomeState.resolve(state: connected, board: Self.longTitlesBoard, omp: omp)
        case .loading:
            return IOSHomeState.resolve(state: connected, board: .loading, omp: omp)
        case .firstRun:
            return IOSHomeState.resolve(state: connected, board: .storeEmpty(dir: ""), omp: omp)
        case .ompMissing:
            return IOSHomeState.resolve(state: connected, board: Self.board, omp: .missing)
        case .degraded:
            return IOSHomeState.resolve(state: .unpaired, board: Self.board, omp: omp)
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
        default:
            return nil
        }
    }

    /// L'envoi des gestes de carte qui remplace celui du client, ou aucun : sous
    /// `slowMac`, une attente qui ne rend jamais (le Mac tarde à répondre).
    var gestureSend: IOSHomeGestureModel.Send? {
        guard self == .slowMac else { return nil }
        return { _ in try await Task.sleep(for: .seconds(3600)) }
    }

    /// La charge utile de contrat de recette : le markdown de la fixture partagée,
    /// pour que la feuille montre de vraies sections sans réseau.
    var contractPayload: RemoteContractPayload? {
        guard self == .contract else { return nil }
        return RemoteContractPayload(document: RemoteDocument(
            name: IOSHomeText.contractName,
            state: IOSHomeText.documentText,
            content: HomeParity.contractMarkdown,
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

    /// L'ardoise de la fixture où les cartes des rangées « En cours » et « Livrées
    /// récemment » prennent `IOSHomeText.recipeLongTitle` ; les cartes « À vous »
    /// gardent leur titre.
    private static var longTitlesBoard: KanbanBoardState {
        guard case .board(var board) = Self.board else { return Self.board }
        let dashboard = HomePresentation.dashboard(board)
        let rowIDs = Set((dashboard.running + dashboard.delivered).map(\.id))
        for index in board.cards.indices where rowIDs.contains(board.cards[index].id) {
            board.cards[index].title = IOSHomeText.recipeLongTitle
        }
        return .board(board)
    }

    /// Les faits d'attention de la fixture.
    private static var attention: [HomeAttention] {
        guard case .board(let board) = Self.board else { return [] }
        return HomePresentation.dashboard(board).attention
    }
}
