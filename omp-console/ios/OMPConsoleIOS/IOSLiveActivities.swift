import ActivityKit
import ConsoleClient
import ConsoleCore
import SwiftUI
import UIKit

// Les Live Activities des features suivies sur l'écran verrouillé et dans la Dynamic
// Island (extension `OMPConsoleWidgets`). Elles démarrent SEULES : dès le lancement,
// l'app enregistre au serveur son jeton push-to-start, et le serveur démarre lui-même
// l'activité d'une feature qui se met au travail ou attend l'humain, app fermée ; l'app
// adopte cette activité (son jeton de mise à jour part au serveur). Quand le serveur ne
// pousse pas (pas de clé APNs, serveur antérieur, simulateur), l'app en démarre une
// elle-même tant qu'elle est au premier plan : une seule à la fois, la plus urgente
// (`HarnessActivityStart`). Le menu contextuel d'une feature en démarre ou en arrête une
// à la main ; une activité arrêtée ou écartée par l'humain ne redémarre pas d'office.
// L'app met chaque activité à jour à chaque boîte relue (et à chaque outil du direct
// suivi) tant qu'elle est ouverte ; le serveur la tient à jour app fermée quand il a une
// clé APNs. Une feature terminée clôt son activité, qui reste une heure sur l'écran
// verrouillé.

@MainActor
final class IOSLiveActivityCenter: ObservableObject {
    /// Les features suivies sur l'écran verrouillé.
    @Published private(set) var followed: Set<String> = []
    /// L'écoute des jetons push et de la fin de chaque activité.
    private var tokenTasks: [String: Task<Void, Never>] = [:]
    /// L'écoute du jeton push-to-start et des activités que le serveur démarre.
    private var startTasks: [Task<Void, Never>] = []
    /// Le dernier jeton push-to-start rendu par le système, en hexadécimal.
    private var startToken: String?
    /// Le serveur relié démarre lui-même les activités : l'app n'en démarre alors aucune d'office.
    private var serverStarts = false
    /// Les features dont l'humain a arrêté ou écarté l'activité : jamais redémarrées d'office.
    private var declined: Set<String> = []

    init() {
        // Les activités démarrées avant un relancement de l'app restent suivies.
        followed = Set(Activity<OMPRunActivityAttributes>.activities.map(\.attributes.runId))
    }

    /// Au lancement (y compris en arrière-plan) : chaque jeton push-to-start part au
    /// serveur relié, et chaque activité que le serveur démarre est adoptée.
    func attach(_ model: HarnessModel) {
        guard startTasks.isEmpty else { return }
        startTasks = [
            Task { [weak self, weak model] in
                for await token in Activity<OMPRunActivityAttributes>.pushToStartTokenUpdates {
                    guard let self, let model else { return }
                    self.startToken = token.hexToken
                    await self.registerStart(with: model)
                }
            },
            Task { [weak self, weak model] in
                for await activity in Activity<OMPRunActivityAttributes>.activityUpdates {
                    guard let self, let model else { return }
                    self.followed.insert(activity.attributes.runId)
                    if self.tokenTasks[activity.attributes.runId] == nil { self.listen(activity, with: model) }
                }
            },
        ]
    }

    /// Un serveur relié, changé ou oublié : le jeton push-to-start le suit (le modèle le
    /// retire de l'ancien), et l'app réapprend si ce serveur-ci démarre les activités.
    func serverChanged(_ model: HarnessModel) async {
        await registerStart(with: model)
        sync(with: model)
    }

    private func registerStart(with model: HarnessModel) async {
        guard let startToken, model.isConfigured else {
            serverStarts = false
            return
        }
        serverStarts = await model.registerActivityStart(token: startToken, environment: .current)
    }

    /// Les Live Activities sont permises par les Réglages de l'iPhone.
    var isAvailable: Bool { ActivityAuthorizationInfo().areActivitiesEnabled }

    func isFollowing(_ runId: String) -> Bool { followed.contains(runId) }

    /// Démarre ou arrête l'activité d'une feature (menu contextuel).
    func toggle(_ run: HarnessRun, with model: HarnessModel) {
        if isFollowing(run.id) {
            declined.insert(run.id)
            stop(run.id)
        } else {
            declined.remove(run.id)
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

    /// Les features dont une activité est en cours (ni close, ni écartée).
    private var running: Set<String> {
        Set(
            Activity<OMPRunActivityAttributes>.activities
                .filter { $0.activityState != .ended && $0.activityState != .dismissed }
                .map(\.attributes.runId)
        )
    }

    /// À défaut de push-to-start : l'app au premier plan démarre l'activité de la feature
    /// la plus urgente, s'il n'y en a aucune en cours.
    private func startMostUrgent(with model: HarnessModel) {
        guard !serverStarts, isAvailable, UIApplication.shared.applicationState == .active,
              let run = HarnessActivityStart.candidate(inbox: model.inbox, running: running, declined: declined)
        else { return }
        start(run, with: model)
    }

    /// Met chaque activité à jour d'après la boîte et le direct suivi ; clôt celles des
    /// features terminées ; démarre celle de la feature la plus urgente s'il n'y en a pas.
    func sync(with model: HarnessModel) {
        guard let inbox = model.inbox else { return }
        defer { startMostUrgent(with: model) }
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

    /// Enregistre au serveur chaque jeton push de l'activité (il change parfois), et
    /// retient qu'une activité écartée par l'humain ne redémarre pas d'office.
    private func listen(_ activity: Activity<OMPRunActivityAttributes>, with model: HarnessModel) {
        let runId = activity.attributes.runId
        tokenTasks[runId]?.cancel()
        let tokens = Task { [weak model] in
            for await token in activity.pushTokenUpdates {
                await model?.registerActivity(runId: runId, token: token.hexToken)
            }
        }
        tokenTasks[runId] = Task { [weak self] in
            await withTaskCancellationHandler {
                for await state in activity.activityStateUpdates where state == .dismissed {
                    self?.declined.insert(runId)
                    self?.followed.remove(runId)
                }
            } onCancel: {
                tokens.cancel()
            }
        }
    }
}

/// Le geste propre à l'iPhone/iPad dans le menu d'une feature (`ConsoleShell.runActions`) :
/// la suivre sur l'écran verrouillé, ou arrêter de la suivre.
struct IOSLiveActivityMenuItem: View {
    @ObservedObject var server: HarnessModel
    @EnvironmentObject private var activities: IOSLiveActivityCenter
    let run: HarnessRun

    var body: some View {
        if activities.isAvailable, run.phase.map({ ![.merged, .failed, .cancelled].contains($0) }) ?? false {
            Button(
                activities.isFollowing(run.id) ? MonitoringText.activityStop : MonitoringText.activityStart,
                systemImage: MonitoringText.activitySymbol
            ) { activities.toggle(run, with: server) }
        }
    }
}
