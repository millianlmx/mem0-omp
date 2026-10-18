// La présentation PURE de la section Audit (audit-ui-redesign S-1) : sections de
// la liste, frise des quatre étapes d'un audit, étapes d'une feature lancée,
// légendes, menus, phrase d'échec et diagnostic, blocs du corps des pipelines.
//
// Même patron que `AuditBoard` : la coque macOS et l'app iOS rendent les MÊMES
// dérivations, prouvées sans vue. Aucun mot ici : les libellés sont `AuditText`
// (et `KanbanText.progressSteps` pour les étapes d'une feature).
//
// VIT DANS `ConsoleCore`.

import Foundation

/// Les quatre étapes d'un audit, dans l'ordre de la frise.
public enum AuditStep: Int, CaseIterable, Sendable {
    case analysis, proposals, brief, pipelines
}

/// Ce dont la frise d'un audit dépend : son statut, et selon lui la relecture
/// du brief (état client), l'achèvement des pipelines ou l'étape atteinte.
public enum AuditProgressInput: Equatable, Sendable {
    case analysing
    case proposed(briefReviewOpen: Bool)
    case launched(pipelinesFinished: Bool)
    case failed(at: AuditStep)
    /// `nil` : arrêté après l'achèvement de toutes les étapes.
    case stopped(during: AuditStep?)
}

public enum AuditListSectionKind: Sendable, Equatable {
    case running, finished
}

/// Une section de la liste des audits : « En cours » ou « Terminés ».
public struct AuditListSection: Sendable, Equatable, Identifiable {
    public var kind: AuditListSectionKind
    public var title: String
    public var cards: [AuditCard]

    public var id: AuditListSectionKind { kind }

    public init(kind: AuditListSectionKind, title: String, cards: [AuditCard]) {
        self.kind = kind
        self.title = title
        self.cards = cards
    }
}

/// Une entrée du menu contextuel d'une rangée et du menu « ⋯ » de l'en-tête.
public enum AuditMenuItem: Sendable, Equatable {
    /// Le chemin COMPLET du dépôt, jamais abrégé.
    case copyPath(String)
    case openInProject
    case stop
}

/// L'issue de « Ouvrir dans Projet » : montrer le dépôt déjà piloté, proposer
/// de piloter ce dépôt, ou refuser parce qu'un autre dépôt est piloté.
public enum AuditProjectOpening: Sendable, Equatable {
    case show, proposeLaunch, refuse
}

/// Un bloc du corps de l'étape Pipelines, dans l'ordre d'affichage.
public enum AuditFollowUpBlock: Sendable, Equatable {
    case escalations, progress, notLaunched, decisions, stoppedBeforeLaunch
}

public enum AuditPresentation {
    // MARK: - Statut

    /// « En cours » : analysing, proposed, launched ; « Terminés » : stopped, failed.
    public static func isRunning(_ status: AuditStatus) -> Bool {
        switch status {
        case .analysing, .proposed, .launched: true
        case .stopped, .failed: false
        }
    }

    /// Le ton de la pastille d'un statut.
    public static func tone(_ status: AuditStatus) -> ConsoleTone {
        switch status {
        case .analysing: .info
        case .proposed: .attention
        case .launched: .success
        case .stopped: .neutral
        case .failed: .danger
        }
    }

    // MARK: - Liste

    /// « En cours » puis « Terminés », chacune dans l'ordre de l'ardoise (le plus
    /// récent d'abord) ; une section vide est omise.
    public static func sections(_ board: AuditBoard) -> [AuditListSection] {
        let running = board.audits.filter { isRunning($0.status) }
        let finished = board.audits.filter { !isRunning($0.status) }
        var sections: [AuditListSection] = []
        if !running.isEmpty {
            sections.append(AuditListSection(kind: .running, title: AuditText.sectionRunning, cards: running))
        }
        if !finished.isEmpty {
            sections.append(AuditListSection(kind: .finished, title: AuditText.sectionFinished, cards: finished))
        }
        return sections
    }

    /// La légende d'une rangée : « dépôt · étape · âge ». Le dépôt n'est écrit
    /// qu'ici dans la rangée.
    public static func rowCaption(_ card: AuditCard, briefReviewOpen: Bool, nowMs: Double) -> String {
        AuditText.rowCaption(
            repo: card.repoName,
            step: focusTitle(steps(progressInput(card, briefReviewOpen: briefReviewOpen))),
            age: ConsoleFormat.relative(ms: card.createdAt, nowMs: nowMs)
        )
    }

    /// La légende de l'en-tête du détail : « dépôt · lancé à HH:MM ».
    public static func headerCaption(_ card: AuditCard) -> String {
        AuditText.headerCaption(repo: card.repoName, time: ConsoleFormat.time(ms: card.createdAt))
    }

    // MARK: - Frise

    /// L'étape la plus avancée qu'un audit a atteinte, d'après ses données.
    public static func reachedStep(_ card: AuditCard) -> AuditStep {
        if card.briefDraft == nil { return .analysis }
        if card.features.isEmpty && card.launches.isEmpty { return .proposals }
        return .pipelines
    }

    /// Une feature lancée est terminée quand sa PR est créée, ou qu'elle est
    /// livrée ou annulée ; l'échec et le blocage attendent encore une reprise.
    public static func isFinished(_ waiting: AuditWaiting) -> Bool {
        switch waiting {
        case .prCreated, .done, .cancelled: true
        case .escalated, .arbiterQueued, .arbiterDeciding, .notStarted, .running, .waiting, .blocked, .failed: false
        }
    }

    /// Toutes les pipelines lancées sont terminées (vrai sans feature lancée).
    public static func pipelinesFinished(_ card: AuditCard) -> Bool {
        card.features.allSatisfy { isFinished($0.waiting) }
    }

    public static func progressInput(_ card: AuditCard, briefReviewOpen: Bool) -> AuditProgressInput {
        switch card.status {
        case .analysing:
            return .analysing
        case .proposed:
            return .proposed(briefReviewOpen: briefReviewOpen)
        case .launched:
            return .launched(pipelinesFinished: pipelinesFinished(card))
        case .failed:
            return .failed(at: reachedStep(card))
        case .stopped:
            let reached = reachedStep(card)
            return reached == .pipelines && pipelinesFinished(card) ? .stopped(during: nil) : .stopped(during: reached)
        }
    }

    /// Les quatre étapes (`AuditText.stepTitles`) de la frise.
    public static func steps(_ input: AuditProgressInput) -> [PipelineStep] {
        let titles = AuditText.stepTitles
        func all(_ state: (AuditStep) -> PipelineStepState) -> [PipelineStep] {
            AuditStep.allCases.map { PipelineStep(title: titles[$0.rawValue], state: state($0)) }
        }
        func current(_ step: AuditStep) -> [PipelineStep] {
            all { $0.rawValue < step.rawValue ? .done : $0 == step ? .current : .upcoming }
        }
        switch input {
        case .analysing:
            return current(.analysis)
        case .proposed(let briefReviewOpen):
            return current(briefReviewOpen ? .brief : .proposals)
        case .launched(let pipelinesFinished):
            return pipelinesFinished ? all { _ in .done } : current(.pipelines)
        case .failed(let step):
            return all { $0.rawValue < step.rawValue ? .done : $0 == step ? .failed : .upcoming }
        case .stopped(let step?):
            return all { $0.rawValue < step.rawValue ? .done : .upcoming }
        case .stopped(nil):
            return all { _ in .done }
        }
    }

    /// Le titre de l'étape qui résume la frise : la première en cours ou en
    /// échec, sinon la première à venir, sinon (tout est fait) la dernière.
    public static func focusTitle(_ steps: [PipelineStep]) -> String {
        if let step = steps.first(where: { $0.state == .current || $0.state == .failed }) { return step.title }
        if let step = steps.first(where: { $0.state == .upcoming }) { return step.title }
        return steps.last?.title ?? ""
    }

    /// Les cinq étapes (`KanbanText.progressSteps`) d'une feature lancée.
    public static func featureSteps(_ row: AuditFeatureRow) -> [PipelineStep] {
        let titles = KanbanText.progressSteps
        func all(_ state: (Int) -> PipelineStepState) -> [PipelineStep] {
            titles.indices.map { PipelineStep(title: titles[$0], state: state($0)) }
        }
        switch row.waiting {
        case .prCreated:
            return all { $0 < 4 ? .done : .current }
        case .done:
            return all { $0 < 4 ? .done : .upcoming }
        default:
            break
        }
        guard let index = row.phase.map(phaseIndex) else {
            return all { _ in .upcoming }
        }
        switch row.waiting {
        case .cancelled:
            return all { $0 < index ? .done : .upcoming }
        case .failed, .blocked:
            return all { $0 < index ? .done : $0 == index ? .failed : .upcoming }
        default:
            return all { $0 < index ? .done : $0 == index ? .current : .upcoming }
        }
    }

    private static func phaseIndex(_ phase: PipelinePhase) -> Int {
        switch phase {
        case .req: 0
        case .specs: 1
        case .impl: 2
        case .review: 3
        case .release: 4
        }
    }

    /// La durée écoulée d'une analyse : « 0:00 », « 1:05 », « 59:59 », puis
    /// « 1:02:05 ». Une durée négative ou non finie vaut zéro.
    public static func elapsed(ms: Double) -> String {
        // Borné à ~31 000 ans : la conversion en `Int` ne peut pas déborder.
        let seconds = ms.isFinite ? Int(min(max(0, ms), 1e15) / 1000) : 0
        if seconds < 3_600 {
            return String(format: "%d:%02d", seconds / 60, seconds % 60)
        }
        return String(format: "%d:%02d:%02d", seconds / 3_600, seconds % 3_600 / 60, seconds % 60)
    }

    // MARK: - Échec

    /// La phrase d'échec lisible : rognée, première lettre capitale, point final
    /// ajouté au besoin ; `AuditText.failureUnknown` sans phrase.
    public static func failureSentence(_ failure: String?) -> String {
        guard let text = trimmed(failure) else { return AuditText.failureUnknown }
        let sentence = text.prefix(1).uppercased() + text.dropFirst()
        guard let last = sentence.last, !".!?…".contains(last) else { return sentence }
        return sentence + "."
    }

    /// Le diagnostic copié d'un audit (identifiant, dépôt, orientation, échec brut).
    public static func diagnostic(_ card: AuditCard) -> String {
        AuditText.diagnostic(
            id: card.id,
            repoRoot: card.repoRoot,
            orientation: card.orientation,
            failure: trimmed(card.failure) ?? AuditText.failureUnknown
        )
    }

    private static func trimmed(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return nil }
        return text
    }

    // MARK: - Menus

    /// Copier le chemin, Ouvrir dans Projet, puis Arrêter (en cours seulement, en dernier).
    public static func menu(for card: AuditCard) -> [AuditMenuItem] {
        [.copyPath(card.repoRoot), .openInProject] + (isRunning(card.status) ? [.stop] : [])
    }

    public static func projectOpening(auditRepoKey: String, pilotedRepoKey: String?, pilotActive: Bool) -> AuditProjectOpening {
        if pilotActive && pilotedRepoKey == auditRepoKey { return .show }
        if pilotActive { return .refuse }
        return .proposeLaunch
    }

    // MARK: - Corps de l'étape Pipelines

    /// Les blocs d'un audit launched ou stopped, dans l'ordre d'affichage ; un
    /// audit arrêté avant tout lancement n'a que `.stoppedBeforeLaunch`.
    public static func followUpBlocks(_ card: AuditCard) -> [AuditFollowUpBlock] {
        if card.status == .stopped && card.features.isEmpty && card.launches.isEmpty {
            return [.stoppedBeforeLaunch]
        }
        var blocks: [AuditFollowUpBlock] = []
        if !card.escalations.isEmpty { blocks.append(.escalations) }
        if !card.features.isEmpty { blocks.append(.progress) }
        if !card.launches.isEmpty { blocks.append(.notLaunched) }
        if !card.decisions.isEmpty { blocks.append(.decisions) }
        return blocks
    }
}
