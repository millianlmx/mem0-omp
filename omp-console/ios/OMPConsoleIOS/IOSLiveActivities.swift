import ActivityKit
import ConsoleClient
import ConsoleCore
import SwiftUI

// Les Live Activities des features suivies sur l'écran verrouillé et dans la Dynamic
// Island (extension `OMPConsoleWidgets`). Le menu contextuel d'une feature en démarre
// ou en arrête une ; l'app la met à jour à chaque boîte relue (et à chaque outil du
// direct suivi) tant qu'elle est ouverte, et enregistre son jeton push au serveur, qui
// la tient à jour app fermée quand il a une clé APNs. Une feature terminée clôt son
// activité, qui reste une heure sur l'écran verrouillé.

@MainActor
final class IOSLiveActivityCenter: ObservableObject {
    /// Les features suivies sur l'écran verrouillé.
    @Published private(set) var followed: Set<String> = []
    /// L'écoute des jetons push de chaque activité.
    private var tokenTasks: [String: Task<Void, Never>] = [:]

    init() {
        // Les activités démarrées avant un relancement de l'app restent suivies.
        followed = Set(Activity<OMPRunActivityAttributes>.activities.map(\.attributes.runId))
    }

    /// Les Live Activities sont permises par les Réglages de l'iPhone.
    var isAvailable: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func isFollowing(_ runId: String) -> Bool { followed.contains(runId) }

    /// Démarre ou arrête l'activité d'une feature (menu contextuel).
    func toggle(_ run: HarnessRun, with model: HarnessModel) {
        if isFollowing(run.id) {
            stop(run.id)
        } else {
            start(run, with: model)
        }
    }

    func start(_ run: HarnessRun, with model: HarnessModel) {
        guard isAvailable, !isFollowing(run.id) else { return }
        let attributes = OMPRunActivityAttributes(runId: run.id, title: run.title, repo: run.repo)
        let state = HarnessActivityState(run: run, inbox: model.inbox)
        let content = ActivityContent(state: state, staleDate: nil)
        // Avec un jeton push, le serveur la tient à jour app fermée ; sans la capacité
        // « Push Notifications » (compte Apple gratuit, app re-signée), iOS refuse le
        // jeton : l'activité démarre quand même, mise à jour par l'app ouverte.
        if let activity = try? Activity.request(attributes: attributes, content: content, pushType: .token) {
            followed.insert(run.id)
            listen(activity, with: model)
        } else if (try? Activity.request(attributes: attributes, content: content, pushType: nil)) != nil {
            followed.insert(run.id)
        }
    }

    func stop(_ runId: String) {
        followed.remove(runId)
        tokenTasks.removeValue(forKey: runId)?.cancel()
        for activity in Activity<OMPRunActivityAttributes>.activities where activity.attributes.runId == runId {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// Met chaque activité à jour d'après la boîte et le direct suivi ; clôt celles des features terminées.
    func sync(with model: HarnessModel) {
        guard let inbox = model.inbox else { return }
        for activity in Activity<OMPRunActivityAttributes>.activities {
            let runId = activity.attributes.runId
            if tokenTasks[runId] == nil { listen(activity, with: model) }
            guard let run = inbox.run(runId) else { continue }
            let tool = model.session?.target == .run(runId) ? model.session?.current?.tool : nil
            let state = HarnessActivityState(run: run, inbox: inbox, tool: tool ?? activity.content.state.tool)
            guard state != activity.content.state else { continue }
            if state.isFinal {
                followed.remove(runId)
                tokenTasks.removeValue(forKey: runId)?.cancel()
                Task { await activity.end(ActivityContent(state: state, staleDate: nil), dismissalPolicy: .default) }
            } else {
                Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
            }
        }
    }

    /// Enregistre au serveur chaque jeton push de l'activité (il change parfois).
    private func listen(_ activity: Activity<OMPRunActivityAttributes>, with model: HarnessModel) {
        let runId = activity.attributes.runId
        tokenTasks[runId]?.cancel()
        tokenTasks[runId] = Task { [weak model] in
            for await token in activity.pushTokenUpdates {
                await model?.registerActivity(runId: runId, token: token.hexToken)
            }
        }
    }
}
