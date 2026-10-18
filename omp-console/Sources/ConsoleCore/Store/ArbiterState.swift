// L'état d'une feature de lot au regard de l'arbitre (le pilote de lot qui répond
// aux questions et valide les jalons en arrière-plan) : la SEULE dérivation que
// lisent l'ardoise Pipelines, l'Accueil et ses comptes, les zones d'action, les
// notifications, la liste des attentes et la section Audit.
//
// Une feature « chez l'arbitre » n'attend PAS l'utilisateur : elle ne va pas dans
// « À vous », ne compte pas parmi les attentes, n'offre ni Valider, ni Accepter,
// ni Répondre, et ne notifie pas. Seule l'escalade (l'arbitre a rendu la main)
// la remet à l'utilisateur.
//
// FONCTION PURE : aucune E/S. Les mots vivent dans `KanbanText`.
//
// VIT DANS `ConsoleCore` : les deux coques partagent la règle.

import Foundation

public enum ArbiterState: Sendable, Equatable {
    /// L'arbitre ne s'occupe pas de la feature.
    case none
    /// La feature attend son tour chez l'arbitre. `since` : l'instant de mise en
    /// file, `nil` quand la marque n'est pas encore écrite (règle du lot arbitré).
    case queued(since: Double?)
    /// L'arbitre décide depuis `since`.
    case deciding(since: Double)
    /// L'arbitre a rendu la main : l'élément attend l'utilisateur, pour `reason`.
    case escalated(kind: FeatureEscalationKind, reason: String)

    /// L'état de `feature` dans `lot`. `pendingAsk` : le run apparié porte une
    /// question `ask` en vol (elle peut paraître avant la marque d'arbitrage).
    ///
    /// Par priorité : l'escalade ; la marque `arbitration` (son étape, `queued`
    /// quand elle est absente) ; puis, dans un lot piloté par le service
    /// (`lot.arbiter`), une feature d'audit sans escalade qui montre ce qui
    /// demanderait sinon l'utilisateur — elle est en file, la marque s'écrit.
    /// Une feature sans `auditSession` n'est jamais arbitrée.
    public static func of(lot: Lot?, feature: LotFeature, pendingAsk: Bool) -> ArbiterState {
        if let escalation = feature.escalation {
            return .escalated(kind: escalation.kind, reason: escalation.reason)
        }
        if let arbitration = feature.arbitration {
            switch arbitration.status {
            case .deciding: return .deciding(since: arbitration.decidingAt ?? arbitration.startedAt)
            case .queued: return .queued(since: arbitration.startedAt)
            }
        }
        guard lot?.arbiter == true, feature.auditSession != nil,
              wouldAskUser(feature, pendingAsk: pendingAsk) else { return .none }
        return .queued(since: nil)
    }

    /// Ce que l'arbitre prend en charge (`relayItemsOf`, relay.ts) : une question
    /// en vol, une attente nommée, le plafond de revue, un échec ou un blocage qui
    /// n'est ni un quota ni l'héritage d'une dépendance.
    static func wouldAskUser(_ feature: LotFeature, pendingAsk: Bool) -> Bool {
        if pendingAsk { return true }
        switch feature.state {
        case .waiting:
            return feature.waitKind != nil
        case .failed:
            return true
        case .blocked:
            if feature.phase == .review && isReviewCapReason(feature.stopReason) { return true }
            return feature.quotaBlocked != true && !isDependencyStopReason(feature.stopReason)
        case .pending, .running, .done, .cancelled:
            return false
        }
    }

    /// L'arbitre tient l'élément (en file ou en décision) : l'utilisateur
    /// n'agit pas et n'est pas notifié.
    public var isArbitrating: Bool {
        switch self {
        case .queued, .deciding: true
        case .none, .escalated: false
        }
    }

    /// Le motif de l'arbitre quand il a rendu la main, `nil` sinon.
    public var escalationReason: String? {
        if case .escalated(_, let reason) = self { return reason }
        return nil
    }

    /// La sorte de l'escalade, `nil` hors escalade.
    public var escalationKind: FeatureEscalationKind? {
        if case .escalated(let kind, _) = self { return kind }
        return nil
    }

    /// Le libellé court de l'arbitrage (« L’arbitre décide », « En file pour
    /// l’arbitre »), `nil` hors arbitrage.
    public var label: String? {
        switch self {
        case .deciding: KanbanText.arbiterDeciding
        case .queued: KanbanText.arbiterQueued
        case .none, .escalated: nil
        }
    }

    /// Le libellé avec la durée de la décision en cours quand elle est connue
    /// (« L’arbitre décide depuis 1:05 »), le libellé court sinon.
    public func label(nowMs: Double) -> String? {
        if case .deciding(let since) = self {
            return KanbanText.arbiterDeciding(elapsed: elapsedLabel(ms: nowMs - since))
        }
        return label
    }
}

/// `isReviewCapReason` (chain.ts:83) : le motif d'arrêt du plafond de revue.
func isReviewCapReason(_ reason: String?) -> Bool {
    guard let reason else { return false }
    return reason.range(of: #"^plafond de \d+ tours de correction atteint, revue toujours bloquante$"#, options: .regularExpression) != nil
}

/// `dependencyStopReason` (lot.ts:1221) : un blocage hérité d'une dépendance.
func isDependencyStopReason(_ reason: String?) -> Bool {
    guard let reason else { return false }
    return reason.hasPrefix("dépend de ") || reason.hasPrefix("dépendance inconnue : ")
}
