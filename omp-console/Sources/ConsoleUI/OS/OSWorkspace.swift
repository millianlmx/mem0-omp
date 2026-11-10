// L'« OS agentique », partagé par le Mac et l'iPhone/iPad : l'état de l'espace de travail
// (ce que montre le détail — Maintenant, Propositions, Savoir, Automatismes, un espace ou
// un fil —, feature comprise, niveau de zoom, tri, espace et lieu retenus) et le tri pur
// des fils par espace et par lieu (`OSThreadScope`). La coque de chaque app tient UN
// `OSWorkspace` et le passe aux écrans de ce dossier.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Le niveau de zoom de « Comprendre », du plus court au plus brut.
public enum OSLevel: String, CaseIterable, Identifiable, Sendable {
    case summary, story, proofs, raw

    public var id: String { rawValue }
}

/// Ce que montre le niveau Preuves de « Comprendre ».
public enum OSProofPane: String, CaseIterable, Identifiable, Sendable {
    case captures, files, tests

    public var id: String { rawValue }
}

/// Le tri des fils par espace puis par lieu. Pur : les coques et la liste des fils le lisent.
public enum OSThreadScope {
    /// Les fils de l'espace retenu (`spaceId` ; `nil` ou inconnu : tous) et du lieu retenu
    /// (`place` : un dépôt, le Poste, ou `nil` pour tous).
    public static func threads(_ threads: [OSThread], spaceId: String?, place: String?, spaces: [HarnessSpace]) -> [OSThread] {
        let space = spaces.first { $0.id == spaceId }
        return threads.filter { thread in
            if let space, OSThreads.space(of: thread, spaces: spaces)?.id != space.id { return false }
            guard let place else { return true }
            return place == OSWorkspace.postePlace ? !thread.requests.isEmpty : thread.repo == place
        }
    }

    /// Les lieux proposés : les dépôts (déclarés, et ceux des fils), puis le Poste quand un fil
    /// y vit. Avec un espace : ses seuls dépôts, et le Poste s'il le porte.
    public static func places(repos: [String], threads: [OSThread], space: HarnessSpace?) -> [String] {
        let hasPoste = threads.contains { !$0.requests.isEmpty }
        guard let space else {
            return Set(repos + threads.compactMap(\.repo)).sorted() + (hasPoste ? [OSWorkspace.postePlace] : [])
        }
        return space.repos.sorted() + (space.poste && hasPoste ? [OSWorkspace.postePlace] : [])
    }
}

@MainActor
public final class OSWorkspace: ObservableObject {
    /// La sélection de « Maintenant » (l'accueil), à la place d'un fil.
    public static let now = "now"
    /// La sélection des « Automatismes » : ce que l'OS lance seul, et quand.
    public static let automations = "automations"
    /// La sélection des « Propositions » : le travail que les agents proposent.
    public static let proposals = "proposals"
    /// La sélection du « Savoir » : consignes permanentes, paliers d'autonomie, espaces.
    public static let knowledge = "knowledge"
    /// Le filtre de lieu « le Poste » (sinon un nom de dépôt).
    public nonisolated static let postePlace = "@poste"
    private static let spacePrefix = "space:"

    /// La sélection de la page d'un espace.
    public static func space(_ id: String) -> String {
        spacePrefix + id
    }

    /// L'espace dont une sélection montre la page, ou `nil` (autre écran, fil).
    public static func spaceId(of selection: String?) -> String? {
        guard let selection, selection.hasPrefix(spacePrefix) else { return nil }
        return String(selection.dropFirst(spacePrefix.count))
    }

    @Published public var selection: String? = OSWorkspace.now
    /// La feature que montre « Comprendre » (sinon celle du fil choisi).
    @Published public var focusRunId: String?
    @Published public var understanding = false
    @Published public var level: OSLevel = .summary
    @Published public var triage = false
    /// L'espace retenu dans la liste des fils (son identifiant), ou tous (`nil`).
    @Published public var spaceId: String?
    /// Le lieu retenu dans la liste des fils : un dépôt, le Poste (`postePlace`), ou tous (`nil`).
    @Published public var place: String?
    /// La feature dont le fil s'ouvrira dès qu'il existe (une proposition acceptée vient de la créer).
    @Published public private(set) var pendingRunId: String?
    /// ⌘⇧P : le Radar demande la confirmation de la pause, ou reprend si tout est suspendu.
    @Published public var pauseRequested = false
    public let pulse: OSPulse

    public init(server: HarnessModel) {
        pulse = OSPulse(harness: server)
    }

    public func open(_ threadId: String) {
        selection = threadId
        focusRunId = nil
        pendingRunId = nil
    }

    /// Ouvre le fil d'une feature ; s'il n'est pas encore parmi `threads`, il s'ouvrira au
    /// prochain `settle` (la coque l'appelle quand ses fils changent).
    public func open(runId: String, in threads: [OSThread]) {
        pendingRunId = runId
        settle(threads)
    }

    /// Ouvre le fil de la feature attendue, s'il existe maintenant.
    public func settle(_ threads: [OSThread]) {
        guard let runId = pendingRunId,
              let thread = threads.first(where: { thread in thread.runs.contains { $0.id == runId } }) else { return }
        pendingRunId = nil
        open(thread.id)
    }

    /// Retient un espace (`nil` : tous) ; un lieu hors de cet espace est oublié.
    public func choose(space: HarnessSpace?) {
        spaceId = space?.id
        guard let space, let place else { return }
        let kept = place == OSWorkspace.postePlace ? space.poste : space.repos.contains(place)
        if !kept { self.place = nil }
    }

    public func understand(runId: String, level: OSLevel) {
        focusRunId = runId
        self.level = level
        understanding = true
    }
}

/// Une décision qui attend l'humain, d'où qu'elle vienne.
public enum OSDecision: Identifiable {
    case questions(HarnessEscalationBatch)
    case specs(HarnessRun)
    case verdict(HarnessRun)
    case approval(WorkstationAction)
    case intake(HarnessIntake)
    case audit(HarnessAudit)
    /// Un commentaire Jira proposé par l'agent.
    case jira(AtlassianWrite)

    public var id: String {
        switch self {
        case let .questions(batch): "q:" + batch.id
        case let .specs(run): "s:" + run.id
        case let .verdict(run): "v:" + run.id
        case let .approval(action): "w:\(action.seq)"
        case let .intake(intake): "i:" + intake.id
        case let .audit(audit): "a:" + audit.id
        case let .jira(write): "j:" + write.id
        }
    }

    /// La feature que la décision concerne, quand elle en concerne une.
    public var runId: String? {
        switch self {
        case let .questions(batch): batch.id
        case let .specs(run), let .verdict(run): run.id
        default: nil
        }
    }

    /// Toutes les décisions en attente, les plus anciennes d'abord dans chaque sorte.
    @MainActor
    public static func all(server: HarnessModel, workstation: WorkstationModel) -> [OSDecision] {
        var items: [OSDecision] = []
        if let inbox = server.inbox {
            items += inbox.openBatches.map(OSDecision.questions)
            items += inbox.awaiting.map { $0.awaitsSpecs ? .specs($0) : .verdict($0) }
            items += inbox.auditsProposed.map(OSDecision.audit)
        }
        items += workstation.approvals.map(OSDecision.approval)
        items += server.intakes.open.filter { $0.isPlanned || $0.isClarifying }.map(OSDecision.intake)
        if server.atlassian.availability == .available {
            items += server.atlassian.proposals.map(OSDecision.jira)
        }
        return items
    }

    /// Les décisions d'une feature.
    @MainActor
    public static func of(runId: String, server: HarnessModel) -> [OSDecision] {
        guard let inbox = server.inbox else { return [] }
        var items: [OSDecision] = inbox.openBatches.filter { $0.id == runId }.map(OSDecision.questions)
        items += inbox.awaiting.filter { $0.id == runId }.map { $0.awaitsSpecs ? .specs($0) : .verdict($0) }
        return items
    }
}
