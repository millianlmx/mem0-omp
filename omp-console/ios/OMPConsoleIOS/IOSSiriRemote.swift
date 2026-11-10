// Ce que font et répondent les intents de la télécommande (Siri, Raccourcis, bouton
// Action) : poser une Demande, suspendre ou reprendre tout le serveur, dire les décisions
// en attente. Chaque réponse est une phrase de `IOSSiriText` ; la décision (quoi dire,
// agir ou non) est une table PURE, le reste passe par le modèle de l'app
// (`HarnessModel`), le même que celui des vues.

import ConsoleClient
import ConsoleCore
import Foundation

/// « Demander à l'OS ».
enum IOSSiriRemote {
    /// Pose la demande et dit ce qu'il en est. Relit d'abord le réglage du serveur (un
    /// lancement à froid par Siri ne l'a pas encore lu). Ne lève jamais.
    @MainActor
    static func ask(_ text: String, on server: HarnessModel) async -> String {
        await server.load()
        guard server.isConfigured else { return IOSSiriText.unconfigured }
        let request = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !request.isEmpty else { return IOSSiriText.askEmpty }
        do {
            try await server.intakes.submit(text: request, source: HarnessRemote.voiceSource)
            return IOSSiriText.asked
        } catch let failure as HarnessIntakeFailure {
            return failure.message
        } catch {
            return IOSSiriText.unreachable
        }
    }
}

/// « Tout suspendre » et « Reprendre » : ce que le serveur dit de sa pause, et ce que
/// l'intent en fait.
struct IOSSiriPause: Equatable {
    /// Ce que l'intent fait d'une demande de pause ou de reprise.
    enum Answer: Equatable {
        /// Aucun serveur relié.
        case unconfigured
        /// Le serveur est antérieur à la pause.
        case absent
        /// La pause n'a pas pu être lue, ou le jeton n'y a pas droit.
        case failed(String)
        /// Déjà dans l'état voulu : rien à faire.
        case already(paused: Bool)
        /// Agir (après confirmation pour suspendre).
        case proceed

        /// Ce que l'intent répond sans agir ; `nil` : il agit.
        var phrase: String? {
            switch self {
            case .unconfigured: IOSSiriText.unconfigured
            case .absent: IOSSiriText.pauseAbsent
            case .failed(let message): message
            case .already(let paused): paused ? IOSSiriText.alreadySuspended : IOSSiriText.notSuspended
            case .proceed: nil
            }
        }
    }

    var isConfigured: Bool
    var availability: HarnessFeatureAvailability
    var isPaused: Bool
    var failure: HarnessFailure?

    /// La table : relié, servi, lu, puis déjà fait ou à faire.
    func answer(wanted: Bool) -> Answer {
        guard isConfigured else { return .unconfigured }
        switch availability {
        case .absent: return .absent
        case .forbidden(let motive): return .failed(HarnessFailure.forbidden(motive).message)
        case .unknown: return .failed((failure ?? .unreachable).message)
        case .available: return isPaused == wanted ? .already(paused: wanted) : .proceed
        }
    }

    /// L'état de la pause du serveur relié, relu à l'instant.
    @MainActor
    static func read(_ server: HarnessModel) async -> IOSSiriPause {
        await server.load()
        if server.isConfigured { await server.pause.refresh() }
        return IOSSiriPause(
            isConfigured: server.isConfigured, availability: server.pause.availability,
            isPaused: server.pause.isPaused, failure: server.pause.failure
        )
    }

    /// Suspend (`true`) ou reprend (`false`), et dit ce qu'il en est.
    @MainActor
    static func set(_ paused: Bool, on server: HarnessModel) async -> String {
        guard await server.pause.setPause(paused: paused) else {
            return (server.pause.failure ?? .unreachable).message
        }
        return paused ? IOSSiriText.suspended : IOSSiriText.resumed
    }
}

/// « Décisions en attente ».
enum IOSSiriDecisions {
    /// Les décisions que la phrase détaille ; les autres sont comptées.
    static let detailed = 3

    /// La phrase : rien, ou le compte et les premières décisions.
    static func phrase(_ decisions: [OSDecision]) -> String {
        guard !decisions.isEmpty else { return IOSSiriText.nothingPending }
        var parts = decisions.prefix(detailed).map(item)
        if decisions.count > detailed { parts.append(IOSSiriText.others(decisions.count - detailed)) }
        return IOSSiriText.pending(decisions.count, list: parts.joined(separator: IOSSiriText.separator))
    }

    /// Une décision, en quelques mots.
    static func item(_ decision: OSDecision) -> String {
        switch decision {
        case .questions(let batch):
            let title = OSThreads.clean(batch.run?.title ?? batch.id).title
            return batch.items.count > 1 ? IOSSiriText.questions(batch.items.count, title) : IOSSiriText.question(title)
        case .specs(let run): return IOSSiriText.specs(OSThreads.clean(run.title).title)
        case .verdict(let run): return IOSSiriText.review(OSThreads.clean(run.title).title)
        case .approval: return IOSSiriText.send
        case .intake: return IOSSiriText.intake
        case .audit: return IOSSiriText.audit
        case .jira: return IOSSiriText.jira
        }
    }

    /// Relit ce qui attend l'humain sur le serveur relié (la boîte, le poste, les
    /// demandes, les commentaires Jira) et le dit. Ne lève jamais.
    @MainActor
    static func answer(for server: HarnessModel) async -> String {
        await server.load()
        guard server.isConfigured else { return IOSSiriText.unconfigured }
        await server.refresh()
        guard server.inbox != nil, server.failure == nil else { return IOSSiriText.unreachable }
        await server.workstation.refresh()
        await server.intakes.refresh()
        await server.atlassian.refresh()
        return phrase(OSDecisions.all(server: server))
    }
}
