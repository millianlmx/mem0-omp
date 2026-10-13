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
    static let setupBanner = "ios.home.setupBanner"
    static let launchBanner = "ios.home.launchBanner"
    static let launchBannerDismiss = "ios.home.launchBanner.dismiss"
    static let allPipelines = "ios.home.allPipelines"

    static let answerSheet = "ios.home.answer.sheet"
    /// Le titre de la carte, en tête du formulaire de la feuille « Répondre ».
    static let answerTitle = "ios.home.answer.title"
    static let answerQuestion = "ios.home.answer.question"
    static let answerText = "ios.home.answer.text"
    static let answerCancel = "ios.home.answer.cancel"
    static let answerSubmit = "ios.home.answer.submit"

    static let contractSheet = "ios.home.contract.sheet"
    static let contractBody = "ios.home.contract.body"
    static let contractClose = "ios.home.contract.close"
    static let contractLoading = "ios.home.contract.loading"
    static let contractFeature = "ios.home.contract.feature"

    static let welcomeSheet = "ios.home.welcome.sheet"
    static let welcomeContinue = "ios.home.welcome.continue"

    static func attention(_ id: String) -> String { "ios.home.attention.\(id)" }
    static func attentionAction(_ id: String) -> String { "ios.home.attention.\(id).action" }
    static func attentionContract(_ id: String) -> String { "ios.home.attention.\(id).contract" }
    static func running(_ id: String) -> String { "ios.home.running.\(id)" }
    static func paused(_ id: String) -> String { "ios.home.paused.\(id)" }
    static func notStarted(_ id: String) -> String { "ios.home.notStarted.\(id)" }
    static func resume(_ id: String) -> String { "ios.home.resume.\(id)" }
    static func delivered(_ id: String) -> String { "ios.home.delivered.\(id)" }
    static func deliveredOpen(_ id: String) -> String { "ios.home.delivered.open.\(id)" }
    static func rowTitle(_ id: String) -> String { "ios.home.row.title.\(id)" }
    static func failure(_ cardId: String) -> String { "ios.home.failure.\(cardId)" }
    static func answerOption(_ index: Int) -> String { "ios.home.answer.option.\(index)" }
}

/// L'issue de « Continuer » sur la bienvenue : pousser la Connexion dans la même
/// feuille, ou fermer la feuille.
enum WelcomeContinuation: Equatable {
    case showConnection
    case finish
}

enum IOSHomeContent {
    /// Le badge de la ligne « Accueil » : le compte d'attentes, la MÊME fonction
    /// que macOS (S-12). 0 hors tableau de bord.
    static func badge(omp: OmpStatus, board: KanbanBoardState) -> Int {
        HomePresentation.attentionCount(omp: omp, board: board)
    }

    /// Le badge d'UN onglet (iPhone) ou d'une entrée de barre latérale (iPad) : le
    /// compte d'attentes sur l'Accueil, le nombre d'audits qui attendent
    /// l'utilisateur sur Audit (audit-ui-redesign, S-4), 0 (pas de badge) ailleurs
    /// ou pour un compte nul ou négatif. Indépendant de l'onglet affiché : il ne
    /// reçoit pas la sélection. Alimente le badge ET le libellé d'accessibilité de
    /// l'onglet.
    static func rowBadge(for section: ConsoleSection, attentionCount: Int, auditCount: Int) -> Int {
        let count = switch section {
        case .home: attentionCount
        case .audit: auditCount
        default: 0
        }
        return max(0, count)
    }

    /// La bienvenue est due à la première ouverture de l'Accueil (S-15).
    static func welcomeDue(welcomeSeen: Bool, section: ConsoleSection) -> Bool {
        !welcomeSeen && section == .home
    }

    /// Ce que fait « Continuer » de la bienvenue (S-2 d'ios-onboarding-et-connexion) :
    /// un appareil appairé n'a rien à connecter, la feuille se ferme ; sinon
    /// (lecture du trousseau, sans jeton, jeton refusé) la Connexion est poussée
    /// dans la même feuille.
    static func welcomeContinuation(pairing: ClientPairingStatus) -> WelcomeContinuation {
        switch pairing {
        case .paired:
            return .finish
        case .restoring, .unpaired, .refused:
            return .showConnection
        }
    }

    /// Le geste principal d'une carte d'attente (S-11).
    static func attentionButton(_ attention: HomeAttention) -> HomeCardAction {
        HomePresentation.cardAction(attention)
    }

    /// La clé du geste qu'envoie le bouton d'une carte « À vous », ou aucune :
    /// « Répondre… » ouvre une feuille, « Voir dans Pipelines » change de section.
    /// « Reprendre » d'une pipeline en échec ou bloquée emprunte la route de
    /// reprise de la carte, que le Mac traduit en relance (`relaunch`).
    static func attentionGestureKey(_ attention: HomeAttention) -> IOSHomeGestureKey? {
        let gesture: IOSHomeGesture
        switch attentionButton(attention) {
        case .validate: gesture = .validateSpecs
        case .accept: gesture = .acceptReview
        case .relaunch: gesture = .resume
        case .answer, .open: return nil
        }
        return IOSHomeGestureKey(cardId: attention.card.id, gesture: gesture)
    }

    /// Le geste d'attente exige-t-il le Mac ? Seul « Voir dans Pipelines » reste
    /// local et tapable hors connexion (etats-non-connecte-heterogenes-ios, S-5).
    static func attentionNeedsMac(_ action: HomeCardAction) -> Bool {
        switch action {
        case .answer, .validate, .accept, .relaunch: true
        case .open: false
        }
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

    /// Les blocs Markdown du CORPS d'une section : la première ligne du texte (la
    /// ligne « ## <titre> », que `ContractDocument.section` inclut) est retirée.
    /// nil ⇔ section absente (`section.text == nil`).
    static func contractBlocks(_ section: ContractSection) -> [MarkdownBlock]? {
        guard let text = section.text else { return nil }
        // La fin de la première ligne : `isNewline` couvre aussi « \r\n », qui
        // forme UN seul caractère Swift.
        let rest = text.firstIndex(where: \.isNewline).map { String(text[text.index(after: $0)...]) } ?? ""
        if rest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return [] }
        return MarkdownDocument.blocks(rest)
    }

    /// Un message court rendu en Markdown EN LIGNE : le code en ligne passe en
    /// chasse fixe, sans accents graves ; les espaces et retours restent tels quels.
    static func inlineMarkdown(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(text)
    }

    /// Le message d'un échec de geste : celui du traducteur partagé (ce qui s'est
    /// passé, puis ce qu'il faut faire), jamais le détail brut du Mac. Un 401 rend
    /// « Jeton révoqué » (le parcours de jeton révoqué parle seul).
    static func failure(_ error: Error) -> String {
        IOSMacErrorText.message(for: error) ?? ConnectionText.revoked
    }
}

/// La disposition d'une rangée « titre | puce | bouton » : une ligne, deux lignes
/// (titre, puis les contrôles côte à côte), ou empilée (chacun sur sa ligne).
enum IOSHomeRowAxis: Equatable { case horizontal, twoLine, stacked }

extension IOSHomeContent {
    /// L'axe d'une rangée selon son CONTENU seul (ios-dynamic-type-ax-residuel,
    /// S-3), jamais selon la taille de texte ni la classe de largeur : tout sur une
    /// ligne si tout y tient ; sinon le titre sur sa ligne et les contrôles ensemble
    /// sur la suivante s'ils y tiennent ; sinon chacun sur sa ligne.
    ///
    /// `title` : largeur IDÉALE (sur une ligne) du bloc titre ; `controls` : largeurs
    /// idéales des contrôles (pastille, bouton…) dans l'ordre ; `available` : largeur
    /// proposée (`nil` = idéale demandée) ; `spacing` : espacement horizontal. Une
    /// égalité exacte tient.
    static func rowAxis(title: CGFloat, controls: [CGFloat], available: CGFloat?, spacing: CGFloat) -> IOSHomeRowAxis {
        guard let available else { return .horizontal }
        guard available > 0 else { return .stacked }
        let together = controls.isEmpty ? 0 : controls.reduce(0, +) + spacing * CGFloat(controls.count - 1)
        if title + (controls.isEmpty ? 0 : spacing + together) <= available { return .horizontal }
        if !controls.isEmpty, together <= available { return .twoLine }
        return .stacked
    }
}

extension IOSHomeContent {
    /// Les rangées du tableau de bord, dans l'ordre de l'écran : « En cours »,
    /// « À reprendre », « Pas commencées », puis « Livrées récemment ».
    static func rows(_ dashboard: HomeDashboard) -> [KanbanCard] {
        dashboard.running + dashboard.paused + dashboard.notStarted + dashboard.delivered
    }

    /// L'identifiant de carte de la rangée d'index `index` dans `rows(_:)`, ou nil
    /// hors bornes.
    static func recipeRowID(_ dashboard: HomeDashboard, index: Int) -> String? {
        let cards = rows(dashboard)
        guard cards.indices.contains(index) else { return nil }
        return cards[index].id
    }
}

extension IOSHomeContent {
    /// Le message d'échec d'un geste de l'Accueil, affiché sur sa carte : ce qui
    /// n'a pas eu lieu, puis la cause et le remède du traducteur partagé
    /// `IOSMacErrorText` (un motif du Mac n'y passe que s'il ne laisse fuir ni URL,
    /// ni JSON, ni code HTTP). `nil` pour une révocation (401) : l'Accueil passe
    /// alors à l'état déconnecté, aucun message n'est affiché sur la carte.
    static func gestureFailure(_ gesture: IOSHomeGesture, error: Error) -> String? {
        guard let cause = IOSMacErrorText.message(for: error) else { return nil }
        let headline: String
        switch gesture {
        case .validateSpecs: headline = IOSHomeText.specsFailed
        case .acceptReview: headline = IOSHomeText.reviewFailed
        case .resume: headline = IOSHomeText.resumeFailed
        }
        return IOSHomeText.gestureFailure(headline, cause: cause)
    }

    /// Les gestes que le tableau de bord offre : « Valider les specs », « Accepter
    /// la revue » et « Reprendre » (échec ou blocage) des cartes « À vous »,
    /// « Reprendre » des rangées « À reprendre ». Un échec ou une confirmation dont
    /// la clé n'y figure plus est effacé.
    static func offeredGestures(_ dashboard: HomeDashboard) -> Set<IOSHomeGestureKey> {
        var offered = Set(dashboard.attention.compactMap(attentionGestureKey))
        for card in dashboard.paused where card.action != nil {
            offered.insert(IOSHomeGestureKey(cardId: card.id, gesture: .resume))
        }
        return offered
    }
}
