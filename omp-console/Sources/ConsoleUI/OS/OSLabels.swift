// L'« OS agentique » : l'aiguillage d'un type du client (section, origine, phase,
// feature, décision, niveau de zoom) vers son mot (`OSText`, ConsoleCore) et son symbole
// SF. Les mots vivent dans le vocabulaire ; ce fichier ne porte que des codes du serveur
// et des noms de symboles.

import ConsoleClient
import ConsoleCore
import SwiftUI

extension OSThreadSection {
    /// Le titre de la section dans la liste des fils.
    public var title: String {
        switch self {
        case .yours: OSText.yours
        case .working: OSText.sectionWorking
        case .queued: OSText.sectionQueued
        case .today: OSText.sectionToday
        case .yesterday: OSText.sectionYesterday
        case .week: OSText.sectionWeek
        case .earlier: OSText.sectionEarlier
        case .stopped: OSText.sectionStopped
        }
    }
}

extension OSOrigin {
    /// Qui a ouvert le fil : « Vous », « Issue #412 », « Vigie · issue #412 », « Audit »…
    public var label: String {
        switch self {
        // Les clients de l'humain (le jeton d'administration, une app appairée) sont « Vous ».
        case let .person(name): name.map { $0 == "admin" || $0.hasPrefix("app") ? OSText.originYou : $0 } ?? OSText.originServer
        case let .issue(number): OSText.originIssue(number)
        case let .vigie(number): number.map { OSText.originVigie(issue: $0) } ?? OSText.vigie
        case .audit: OSText.originAudit
        case .factory: OSText.originFactory
        }
    }

    public var symbol: String {
        switch self {
        case .person: "person.fill"
        case .issue: "exclamationmark.bubble"
        case .vigie: "binoculars.fill"
        case .audit: "magnifyingglass"
        case .factory: "gearshape.2.fill"
        }
    }
}

extension OSPhase {
    /// L'état d'un fil, en minuscules : « à vous », « au travail », « livré »…
    public var label: String {
        switch self {
        case .yours: OSText.phaseYours
        case .working: OSText.phaseWorking
        case .queued: OSText.phaseQueued
        case .done: OSText.phaseDone
        case .failed: OSText.phaseFailed
        case .stopped: OSText.stopped
        }
    }

    /// Une couleur = un sens : orange à vous, accent au travail, vert livré, rouge échec, gris file ou arrêt.
    public var color: Color {
        switch self {
        case .yours: .orange
        case .working: .accentColor
        case .queued: .secondary
        case .done: .green
        case .failed: .red
        case .stopped: .secondary
        }
    }

    public var symbol: String {
        switch self {
        case .yours: "hand.raised.circle.fill"
        case .working: "circle.dotted.circle"
        case .queued: "circle.dashed"
        case .done: "checkmark.circle.fill"
        case .failed: "xmark.octagon.fill"
        case .stopped: "minus.circle"
        }
    }
}

extension HarnessRun {
    /// Où en est la feature, en un mot : son étape quand elle travaille, sinon son état.
    public var osState: String {
        switch phase {
        case .queued: OSText.phaseQueued
        case .running: OSText.steps[OSThreads.stepIndex(of: self)]
        case .escalated: OSText.runQuestion
        case .awaitingHuman: awaitsSpecs ? OSText.runAwaitsSpecs : OSText.runAwaitsVerdict
        case .merging: OSText.runMerging
        case .merged: OSText.runMerged
        case .failed: OSText.runFailed
        case .cancelled: OSText.runStopped
        case nil: state
        }
    }

    /// Le modèle sans son fournisseur : « anthropic/claude-opus » → « claude-opus ».
    public var osModel: String? {
        guard let model, !model.isEmpty else { return nil }
        return model.split(separator: "/").last.map(String.init) ?? model
    }

    /// « PR #438 », d'après l'adresse de la PR.
    public var osPR: String? {
        prUrl.map { url in url.split(separator: "/").last.map { OSText.pr(String($0)) } ?? OSText.openPR }
    }
}

extension HarnessScheduleTarget {
    /// Ce que lance une planification, et où : « Une feature · mem0-omp ».
    public var osPlace: String {
        ControlText.scheduleKind(kind) + (repo.isEmpty ? "" : " · " + repo)
    }
}

extension OSLevel {
    public var title: String {
        switch self {
        case .summary: OSText.levelSummary
        case .story: OSText.levelStory
        case .proofs: OSText.levelProofs
        case .raw: OSText.levelRaw
        }
    }
}

extension OSProofPane {
    public var title: String {
        switch self {
        case .captures: OSText.paneCaptures
        case .files: OSText.paneFiles
        case .tests: OSText.paneTests
        }
    }
}

extension OSDecision {
    /// La sorte de décision, en tête de sa carte.
    public var kind: String {
        switch self {
        case .questions: OSText.kindQuestion
        case .specs: OSText.kindSpecs
        case .verdict: OSText.kindVerdict
        case .approval: OSText.kindSend
        case let .intake(intake): intake.isClarifying ? OSText.kindClarify : OSText.kindPlan
        case .audit: OSText.kindProposals
        case .jira: OSText.kindJira
        }
    }

    public var symbol: String {
        switch self {
        case .questions: "questionmark.bubble.fill"
        case .specs: "doc.text.fill"
        case .verdict: "checkmark.seal.fill"
        case .approval: "paperplane.fill"
        case .intake: "sparkles"
        case .audit: "list.bullet.rectangle"
        case .jira: "text.bubble.fill"
        }
    }
}

extension Double {
    /// Un instant du serveur (millisecondes), relatif à maintenant : « il y a 4 minutes », « hier ».
    var osRelative: String {
        ConsoleFormat.relative(ms: self, nowMs: Date().timeIntervalSince1970 * 1000)
    }
}
