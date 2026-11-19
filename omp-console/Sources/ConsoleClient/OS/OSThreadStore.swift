// « OS agentique » : les FILS et le compte des DÉCISIONS, tenus à jour à part des écrans.
// Les racines de l'OS les recalculaient à chaque rendu, sur chaque publication d'une dizaine
// de modèles ; ici, chaque entrée (boîte, historique, projets, audits, demandes et envois du
// poste, incidents de la vigie, sessions locales, Demandes ouvertes, commentaires Jira) fait
// replanifier un calcul regroupé (`debounce`), fait hors du fil principal sur une copie des
// entrées, et publié seulement si le résultat a changé.

import Combine
import Foundation

@MainActor
public final class OSThreadStore: ObservableObject {
    /// L'attente après une entrée changée : une rafale ne coûte qu'un calcul.
    public static let debounce: Duration = .milliseconds(250)

    /// Les fils (`OSThreads.build`), publiés seulement s'ils ont changé.
    @Published public private(set) var threads: [OSThread]
    /// Le nombre de décisions en attente (`OSDecisions.all(server:)`), publié seulement s'il a changé.
    @Published public private(set) var decisionCount: Int

    private let server: HarnessModel
    private let delay: Duration
    private var subscriptions: Set<AnyCancellable> = []
    private var task: Task<Void, Never>?
    /// Une entrée a changé depuis le début du calcul en cours : un autre suivra.
    private var dirty = false
    /// Les entrées du dernier calcul : les mêmes ne recalculent rien.
    private var computed: Inputs

    public convenience init(server: HarnessModel) {
        self.init(server: server, debounce: Self.debounce)
    }

    init(server: HarnessModel, debounce: Duration) {
        self.server = server
        delay = debounce
        let inputs = Inputs(server: server)
        computed = inputs
        let result = inputs.result
        threads = result.threads
        decisionCount = result.decisions
        let changes: [AnyPublisher<Void, Never>] = [
            server.$inbox.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.$projects.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.$audits.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.history.$runs.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.workstation.$requests.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.workstation.$approvals.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.vigie.$incidents.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.localSessions.$sessions.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.intakes.$open.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.atlassian.$availability.dropFirst().map { _ in }.eraseToAnyPublisher(),
            server.atlassian.$proposals.dropFirst().map { _ in }.eraseToAnyPublisher(),
        ]
        Publishers.MergeMany(changes)
            .sink { [weak self] in self?.schedule() }
            .store(in: &subscriptions)
    }

    /// Un `@Published` prévient AVANT de changer : le calcul lit les entrées après l'attente.
    private func schedule() {
        guard task == nil else {
            dirty = true
            return
        }
        let delay = delay
        task = Task { [weak self] in
            repeat {
                try? await Task.sleep(for: delay)
                guard !Task.isCancelled, let self else { return }
                self.dirty = false
                let inputs = Inputs(server: self.server)
                if inputs != self.computed {
                    let result = await Task.detached(priority: .userInitiated) { inputs.result }.value
                    guard !Task.isCancelled else { return }
                    self.computed = inputs
                    self.update(\.threads, result.threads)
                    self.update(\.decisionCount, result.decisions)
                }
                if !self.dirty {
                    self.task = nil
                    return
                }
            } while true
        }
    }

    /// Ce dont les fils et les décisions dépendent, copié du serveur relié.
    struct Inputs: Equatable, Sendable {
        var runs: [HarnessRun]
        var inbox: HarnessInbox?
        var projects: [HarnessProject]
        var audits: [HarnessAudit]
        var requests: [WorkstationRequest]
        var approvals: [WorkstationAction]
        var incidents: [VigieIncident]
        var localSessions: [HarnessLocalSession]
        var intakes: [HarnessIntake]
        var writes: [AtlassianWrite]

        @MainActor init(server: HarnessModel) {
            runs = server.history.runs
            inbox = server.inbox
            projects = server.projects
            audits = server.audits
            requests = server.workstation.requests ?? []
            approvals = server.workstation.approvals
            incidents = server.vigie.incidents
            localSessions = server.localSessions.sessions
            intakes = server.intakes.open
            writes = server.atlassian.availability == .available ? server.atlassian.proposals : []
        }

        /// Le calcul, pur : les mêmes fils et le même compte que les racines faisaient à chaque rendu.
        var result: (threads: [OSThread], decisions: Int) {
            let threads = OSThreads.build(
                runs: runs, inbox: inbox, projects: projects, audits: audits,
                requests: requests, incidents: incidents, localSessions: localSessions
            )
            let decisions = OSDecisions.all(inbox: inbox, approvals: approvals, intakes: intakes, writes: writes).count
            return (threads, decisions)
        }
    }
}
