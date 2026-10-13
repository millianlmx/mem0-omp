// Les menus contextuels de l'app iOS (ios-gestes-et-retours-natifs, S-4) : un
// appui long sur une carte Pipelines, une carte ou rangée de l'Accueil, une
// rangée Sessions ou une rangée Mémoire ouvre le menu natif du système.
//
// Le contenu d'un menu est une FONCTION PURE de l'élément et de l'état de la
// surface (connexion, geste en vol) : il ne reprend que les actions déjà offertes
// ailleurs pour cet élément DANS SON ÉTAT COURANT, plus une seule entrée
// « Copier » (le lien de la PR s'il existe, sinon le texte principal). Une action
// indisponible est absente, jamais grisée (HIG Context menus) ; l'action
// destructive « Arrêter… » est toujours la DERNIÈRE. Aucune action nouvelle :
// chaque choix emprunte le chemin du contrôle existant de la même surface.
//
// Aucune phrase n'est composée ici : les libellés sont les constantes des
// contrôles existants, les mots propres aux menus vivent dans `IOSMenuText`.

import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI
import UIKit

/// Une entrée de menu contextuel, dans l'ordre d'affichage du menu.
enum IOSMenuAction: Equatable {
    /// « Répondre… » d'une carte « À vous » (`HomeText.answerEllipsis`).
    case answer
    /// « Valider les specs » (`KanbanText.validateSpecs`).
    case validateSpecs
    /// « Accepter la revue » (`KanbanText.acceptReview`).
    case acceptReview
    /// « Reprendre » (`KanbanText.resume`).
    case resume
    /// « Lancer » d'une carte Pipelines jamais en route (`KanbanText.launch`).
    case launch
    /// « Voir dans Pipelines » (`HomeText.openInPipelines`).
    case showInPipelines
    /// « Lire le contrat » (`ContractText.open`).
    case readContract
    /// « Ouvrir la PR » (`HomeText.openPR`), vers l'adresse donnée.
    case openPR(URL)
    /// « Copier » (`MemoryText.copy`) : le texte copié tel quel.
    case copy(String)
    /// « Arrêter… » (`KanbanText.stop`), destructif, toujours dernier.
    case stop
    /// « Copier le chemin » d'un audit (`AuditText.copyPath`) : le chemin COMPLET du
    /// dépôt, copié tel quel (audit-ui-redesign, S-3).
    case copyPath(String)
    /// « Ouvrir dans Projet » d'un audit (`AuditText.openInProject`, S-12).
    case openInProject
    /// « Arrêter l'audit… » (`AuditText.stopAudit`), destructif, toujours dernier.
    case stopAudit
}

/// Le genre d'une rangée de l'Accueil (hors cartes « À vous »).
enum IOSHomeRowKind: Equatable {
    case running, paused, notStarted, delivered
}

/// Le contenu des menus contextuels, par surface.
enum IOSContextMenu {
    /// Le texte que copie « Copier » sur une carte : le lien de sa PR tel quel
    /// quand il est une adresse http(s), sinon son titre affiché.
    static func copyText(_ card: KanbanCard) -> String {
        if let prUrl = card.prUrl, httpURL(prUrl) != nil { return prUrl }
        return KanbanCardPresentation.title(card)
    }

    /// Une carte Pipelines (voie iPhone et kanban iPad) : les gestes de commande
    /// de la fiche (hors réponses aux questions et « Fusionner », qui restent dans
    /// la fiche), puis « Ouvrir la PR », « Copier », et « Arrêter… » en dernier.
    /// Hors connexion ou pendant l'envoi d'une commande de la carte, seules les
    /// entrées locales restent.
    static func pipelinesCard(_ card: KanbanCard, gesturesEnabled: Bool, sending: Bool) -> [IOSMenuAction] {
        let gestures = PipelinesGesture.gestures(of: card)
        let command = gesturesEnabled && !sending
        var actions: [IOSMenuAction] = []
        if command {
            for gesture in gestures {
                switch gesture {
                case .validateMilestone(kind: .specs): actions.append(.validateSpecs)
                case .validateMilestone(kind: .review): actions.append(.acceptReview)
                case .resume: actions.append(.resume)
                case .launch: actions.append(.launch)
                case .validateMilestone, .answerQuestion, .answerText, .merge, .stop, .openPR: continue
                }
            }
        }
        if gestures.contains(.openPR), let url = httpURL(card.prUrl ?? "") {
            actions.append(.openPR(url))
        }
        if let copy = copy(copyText(card)) { actions.append(copy) }
        if command, gestures.contains(.stop) { actions.append(.stop) }
        return actions
    }

    /// Une carte « À vous » de l'Accueil : le geste principal de la carte dans
    /// son état courant, « Lire le contrat » quand la carte en a un, puis « Copier ».
    static func homeAttention(_ attention: HomeAttention, gesturesEnabled: Bool, sending: Bool) -> [IOSMenuAction] {
        let command = gesturesEnabled && !sending
        var actions: [IOSMenuAction] = []
        switch IOSHomeContent.attentionButton(attention) {
        case .answer: if gesturesEnabled { actions.append(.answer) }
        case .validate: if command { actions.append(.validateSpecs) }
        case .accept: if command { actions.append(.acceptReview) }
        case .relaunch: if command { actions.append(.resume) }
        case .open: actions.append(.showInPipelines)
        }
        if ContractDocument.moment(for: attention.card) != nil, gesturesEnabled {
            actions.append(.readContract)
        }
        if let copy = copy(copyText(attention.card)) { actions.append(copy) }
        return actions
    }

    /// Une rangée « En cours », « À reprendre », « Pas commencées » ou « Livrées
    /// récemment » : « Reprendre » d'une pipeline en pause reprenable, « Ouvrir la
    /// PR » d'une livraison, puis « Copier ».
    static func homeRow(_ card: KanbanCard, kind: IOSHomeRowKind, gesturesEnabled: Bool, sending: Bool) -> [IOSMenuAction] {
        var actions: [IOSMenuAction] = []
        switch kind {
        case .paused:
            if card.action != nil, gesturesEnabled, !sending { actions.append(.resume) }
        case .delivered:
            if let link = IOSHomeContent.deliveredLink(card) { actions.append(.openPR(link)) }
        case .running, .notStarted:
            break
        }
        if let copy = copy(copyText(card)) { actions.append(copy) }
        return actions
    }

    /// Une rangée Sessions : « Copier » le titre de la feature, seul.
    static func session(_ choice: RunChoice) -> [IOSMenuAction] {
        copy(choice.featureTitle).map { [$0] } ?? []
    }

    /// Une rangée d'audit et le menu « ⋯ » de son détail (audit-ui-redesign, S-3,
    /// S-6) : « Copier le chemin » toujours, puis — connecté et sans geste en vol —
    /// « Ouvrir dans Projet » et, pour un audit en cours seulement, « Arrêter
    /// l'audit… » en dernier.
    static func auditRow(_ card: AuditCard, gesturesEnabled: Bool) -> [IOSMenuAction] {
        var actions: [IOSMenuAction] = [.copyPath(card.repoRoot)]
        if gesturesEnabled { actions.append(.openInProject) }
        if gesturesEnabled, AuditPresentation.isRunning(card.status) { actions.append(.stopAudit) }
        return actions
    }

    /// Une rangée Mémoire : « Copier » le texte brut du souvenir, seul.
    static func memory(_ row: RemoteMemoryRow) -> [IOSMenuAction] {
        copy(row.text).map { [$0] } ?? []
    }

    /// Le libellé d'une entrée : la constante du contrôle existant.
    static func label(_ action: IOSMenuAction) -> String {
        switch action {
        case .answer: HomeText.answerEllipsis
        case .validateSpecs: KanbanText.validateSpecs
        case .acceptReview: KanbanText.acceptReview
        case .resume: KanbanText.resume
        case .launch: KanbanText.launch
        case .showInPipelines: HomeText.openInPipelines
        case .readContract: ContractText.open
        case .openPR: HomeText.openPR
        case .copy: MemoryText.copy
        case .stop: KanbanText.stop
        case .copyPath: AuditText.copyPath
        case .openInProject: AuditText.openInProject
        case .stopAudit: AuditText.stopAudit
        }
    }

    /// « Copier » ce texte, tel quel ; aucune entrée pour un texte blanc.
    private static func copy(_ text: String) -> IOSMenuAction? {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : .copy(text)
    }
}

/// Le presse-papiers général du système.
@MainActor
enum IOSPasteboard {
    /// Remplace le contenu du presse-papiers par ce texte (aucune confirmation
    /// visible : comportement système).
    static func copy(_ text: String) {
        UIPasteboard.general.string = text
    }
}

/// L'échec d'une commande lancée d'un menu contextuel des Pipelines : ce qui n'a
/// pas eu lieu, puis la cause et le remède (`IOSMacErrorText`).
struct IOSMenuFailure: Identifiable {
    let id = UUID()
    let title: String
    let message: String
}

/// Les entrées d'un menu contextuel : un `Button` par action, dans l'ordre reçu.
/// « Copier » porte le symbole système de copie ; « Arrêter… » est destructif.
/// Une liste vide ne rend rien : le système n'ouvre alors aucun menu.
struct IOSContextMenuItems: View {
    let actions: [IOSMenuAction]
    let perform: (IOSMenuAction) -> Void

    var body: some View {
        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
            switch action {
            case .copy:
                Button(MemoryText.copy, systemImage: IOSMenuText.copySymbol) { perform(action) }
            case .copyPath:
                Button(AuditText.copyPath, systemImage: IOSMenuText.copySymbol) { perform(action) }
            case .stopAudit:
                Divider()
                Button(IOSContextMenu.label(action), role: .destructive) { perform(action) }
            default:
                Button(IOSContextMenu.label(action), role: action == .stop ? .destructive : nil) { perform(action) }
            }
        }
    }
}
