// « Valider » la revue qui attend, depuis la Live Activity d’une feature (écran
// verrouillé, Dynamic Island). Ce fichier est compilé dans DEUX cibles : l’extension de
// widgets, dont la vue de l’activité porte le bouton, et l’app, dans le processus de
// laquelle le système exécute une `LiveActivityIntent`. Le geste ne dépend donc d’aucun
// état de l’app : il passe par ConsoleClient, avec l’adresse et le jeton du groupe
// d’apps (`HarnessModel.shared`), à la révision que le serveur vient de rendre. Une
// revue qui n’attend plus, ou un refus du serveur, ne tranche rien : l’humain le sait
// par la notification locale « Geste non abouti », et l’activité reprend l’état réel.
//
// Le titre et la description sont des littéraux extraits AU BUILD par l’outillage App
// Intents (scripts/app-intents/attendus.json) ; l’intent n’est pas proposé dans
// Raccourcis.

import AppIntents
import ConsoleClient

struct OMPRunValidateIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Valider la revue"
    static let description: IntentDescription? = IntentDescription("Valide la revue qui attend, depuis l’activité de la feature sur l’écran verrouillé.")
    static let isDiscoverable = false
    /// Valider écrit : l’appareil est déverrouillé d’abord.
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresAuthentication

    @Parameter(title: "Feature")
    var runId: String

    init() {}

    init(runId: String) {
        self.runId = runId
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let model = await HarnessModel.shared()
        var validated = false
        if let model { validated = await HarnessRemote.validateReview(runId: runId, on: model) }
        if !validated { await HarnessNotificationCenter.notifyGestureFailed(HarnessPushAlert(kind: .verdict, runId: runId)) }
        if let model { await HarnessRemote.refreshActivity(runId: runId, from: model) }
        return .result()
    }
}
