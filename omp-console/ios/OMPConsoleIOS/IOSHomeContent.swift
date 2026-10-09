// Le contenu PUR de l'Accueil iOS (S-11) : les décisions que la vue rend, mais
// que le test éprouve SANS rendre de vue. Aucune phrase n'est composée ici : les
// libellés de fait viennent du noyau partagé, les mots iOS de `IOSHomeText`.
//
// La vue ne dérive rien : elle appelle ces fonctions.

import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI

/// Ce que le découpage du contrat a rendu (S-14) : une section par titre requis,
/// un fichier absent, ou un fichier illisible avec la raison du Mac.
enum IOSContractContent: Equatable {
    case sections([ContractSection])
    case missing
    case unreadable(String)
}

/// Les identifiants d'accessibilité de l'Accueil (tous préfixés `ios.home.`).
enum IOSHomeAccessibility {
    static let dashboard = "ios.home.dashboard"
    static let loading = "ios.home.loading"
    static let firstRun = "ios.home.firstRun"
    static let macMissingOMP = "ios.home.macMissingOMP"
    static let disconnected = "ios.home.disconnected"
    static let connect = "ios.home.connect"
    static let setupBanner = "ios.home.setupBanner"
    static let launchBanner = "ios.home.launchBanner"
    static let launchBannerDismiss = "ios.home.launchBanner.dismiss"
    static let allPipelines = "ios.home.allPipelines"

    static let answerSheet = "ios.home.answer.sheet"
    static let answerQuestion = "ios.home.answer.question"
    static let answerText = "ios.home.answer.text"
    static let answerCancel = "ios.home.answer.cancel"
    static let answerSubmit = "ios.home.answer.submit"

    static let contractSheet = "ios.home.contract.sheet"
    static let contractBody = "ios.home.contract.body"
    static let contractClose = "ios.home.contract.close"
    static let contractLoading = "ios.home.contract.loading"

    static let welcomeSheet = "ios.home.welcome.sheet"
    static let welcomeContinue = "ios.home.welcome.continue"

    static func attention(_ id: String) -> String { "ios.home.attention.\(id)" }
    static func attentionAction(_ id: String) -> String { "ios.home.attention.\(id).action" }
    static func attentionContract(_ id: String) -> String { "ios.home.attention.\(id).contract" }
    static func running(_ id: String) -> String { "ios.home.running.\(id)" }
    static func resume(_ id: String) -> String { "ios.home.resume.\(id)" }
    static func delivered(_ id: String) -> String { "ios.home.delivered.\(id)" }
    static func deliveredOpen(_ id: String) -> String { "ios.home.delivered.open.\(id)" }
    static func answerOption(_ index: Int) -> String { "ios.home.answer.option.\(index)" }
}

enum IOSHomeContent {
    /// Le badge de la ligne « Accueil » : le compte d'attentes, la MÊME fonction
    /// que macOS (S-12). 0 hors tableau de bord.
    static func badge(omp: OmpStatus, board: KanbanBoardState) -> Int {
        HomePresentation.attentionCount(omp: omp, board: board)
    }

    /// La bienvenue est due à la première ouverture de l'Accueil (S-15).
    static func welcomeDue(welcomeSeen: Bool, section: ConsoleSection) -> Bool {
        !welcomeSeen && section == .home
    }

    /// Le geste principal d'une carte d'attente (S-11).
    static func attentionButton(_ attention: HomeAttention) -> HomeCardAction {
        HomePresentation.cardAction(attention)
    }

    /// La zone à laquelle la feuille « Répondre » répond (S-13), ou aucune.
    static func answerZone(_ card: KanbanCard) -> KanbanActionZone? {
        MainSheetPolicy.answerZone(for: card)
    }

    /// Le bandeau de préparation, quand le Mac en rapporte un (S-11, AC-12).
    static func setupBanner(components: RemoteComponentsPayload?) -> String? {
        components?.setupBanner
    }

    /// L'entrée de l'accusé de commande à montrer, ou aucune (S-11, AC-13).
    static func launchBanner(journal: [ActionJournalEntry], dismissedID: String?) -> ActionJournalEntry? {
        HomePresentation.launchBannerEntry(journal: journal, dismissedID: dismissedID)
    }

    /// Le ton du bandeau d'accusé, selon l'état de l'entrée.
    static func launchTone(_ state: ActionJournalState) -> ConsoleTone {
        switch state {
        case .awaitingAck, .taken, .delivered: .info
        case .refused, .failed, .unacknowledged: .danger
        }
    }

    /// La section sélectionnée par le lien « Tout afficher » (S-11, AC-14).
    static let allPipelinesSection: ConsoleSection = .kanban

    /// L'URL de la PR d'une livraison, quand elle est exploitable (S-11, AC-11).
    static func deliveredLink(_ card: KanbanCard) -> URL? {
        card.prUrl.flatMap { URL(string: $0) }
    }

    /// Le découpage du contrat d'une carte (S-14) : les titres requis du moment,
    /// découpés par les fonctions partagées — mêmes sections que macOS.
    static func contract(with payload: RemoteContractPayload, moment: ContractMoment) -> IOSContractContent {
        let document = payload.document
        if document.state == IOSHomeText.documentText {
            let markdown = document.content ?? ""
            return .sections(
                ContractDocument.titles(for: moment).map { ContractDocument.section(in: markdown, title: $0) }
            )
        }
        if document.state == IOSHomeText.documentMissing {
            return .missing
        }
        return .unreadable(document.reason ?? "")
    }

    /// Le « slug » du titre de la feuille Contrat : le dernier segment `:` de
    /// l'identifiant de la carte, sinon son titre.
    static func contractSlug(_ card: KanbanCard) -> String {
        card.id.split(separator: ":").last.map(String.init) ?? card.title
    }

    /// Le message EXACT d'un échec de geste (S-9) : le message de l'API, jamais
    /// recomposé. Les causes locales ont un mot iOS.
    static func failure(_ error: Error) -> String {
        guard let error = error as? ClientError else { return IOSHomeText.decodingFailure }
        switch error {
        case .api(let api): return api.message ?? api.code
        case .transport(let failure): return failure.reason
        case .decoding(let reason): return reason
        case .notConnected: return IOSHomeText.notConnected
        case .incompatibleProtocol: return IOSHomeText.incompatibleProtocol
        }
    }
}

/// La disposition d'une rangée « titre | puce | bouton » de l'Accueil.
enum IOSHomeRowAxis: Equatable { case horizontal, stacked }

extension IOSHomeContent {
    /// `.stacked` si et seulement si `size.isAccessibilitySize`, sinon `.horizontal`.
    static func rowAxis(_ size: DynamicTypeSize) -> IOSHomeRowAxis {
        size.isAccessibilitySize ? .stacked : .horizontal
    }

    /// La plus grande taille de texte des boutons de rangée : au-delà, « Reprendre »
    /// deviendrait un disque et « Ouvrir la PR » ne tiendrait plus.
    static let rowButtonMaximumSize: DynamicTypeSize = .accessibility3

    /// La plus grande taille de texte d'une rangée (titre, sous-titre, puce) : mesuré
    /// en capture (feature ios-accueil-dynamic-type-casse), à `.accessibility5` le
    /// sous-titre « Implémentation » ne tient plus sur la largeur d'un iPhone et le
    /// système le coupe au milieu du mot.
    static let rowTextMaximumSize: DynamicTypeSize = .accessibility4
}

extension IOSHomeContent {
    /// L'identifiant de carte de la rangée d'index `index` dans
    /// `dashboard.running + dashboard.delivered` (cet ordre), ou nil hors bornes.
    static func recipeRowID(_ dashboard: HomeDashboard, index: Int) -> String? {
        let rows = dashboard.running + dashboard.delivered
        guard rows.indices.contains(index) else { return nil }
        return rows[index].id
    }
}
