// Les intents Siri du pilotage des pipelines sur le Mac (siri-mac-pilotage-pipelines,
// S-7) : lancer une feature, la reprendre, arrêter les pipelines de son dépôt,
// valider ses specs ou accepter sa revue. Le choix de la feature, le brouillon du
// lancement et l'éligibilité sont ceux de `VoicePilot` (ConsoleCore) ; la coque ne
// fournit que la lecture de l'ardoise, la question posée à Siri et l'envoi par les
// gestes typés de `RemoteActions`, les mêmes que les boutons de la fenêtre et
// que l'API distante.
//
// Titres, descriptions, modes, politique d'authentification et titres des
// paramètres sont des LITTÉRAUX : l'outillage d'extraction des métadonnées App
// Intents refuse toute valeur calculée.

import AppIntents
import ConsoleCore

// MARK: - Session

/// Une session de pilotage : le moteur de ConsoleCore branché sur le contexte du
/// Mac. L'envoi applique la politique vocale de l'intent, puis le geste typé ; un
/// geste de commande n'est dit « fait » qu'après la conclusion de sa commande.
@MainActor
struct MacPilotSession {
    typealias Policy = @MainActor (
        _ target: String,
        _ prompt: String?,
        _ send: @escaping @MainActor () async throws -> Void
    ) async throws -> VoiceGestureOutcome

    private let context: MacVoiceContext
    private let policy: Policy

    init(context: MacVoiceContext, policy: @escaping Policy) {
        self.context = context
        self.policy = policy
    }

    /// Désigne la feature visée par `gesture` puis lui applique le geste ; rend la
    /// phrase que Siri dit en résultat.
    func pilot(
        _ gesture: VoicePilotGesture,
        spoken: String?,
        ask: @escaping @MainActor (String) async throws -> String
    ) async -> String {
        guard let cards = await context.board() else { return VoiceSpeechText.stateUnreadable }
        let card: KanbanCard
        switch await VoicePilot.pickFeature(gesture, spoken: spoken, cards: cards, ask: ask) {
        case let .said(phrase):
            return phrase
        case let .card(picked):
            card = picked
        }

        let actions = context.remoteActions
        let cardId = card.id
        switch gesture {
        case .resume:
            return await conclude(.resume, target: card.title, prompt: nil) {
                try await actions.resume(cardId: cardId)
            }
        case .stop:
            return await conclude(
                .stopFeature,
                target: card.repo,
                prompt: VoiceGestureText.stopConfirmation(repo: card.repo, feature: card.title)
            ) {
                try await Self.settled(try await actions.stop(cardId: cardId), in: actions)
            }
        case .validateSpecs:
            return await conclude(.validateSpecs, target: card.title, prompt: nil) {
                try await Self.settled(try await actions.verdict(cardId: cardId, verdict: .specs), in: actions)
            }
        case .acceptReview:
            return await conclude(.acceptReview, target: card.title, prompt: nil) {
                try await Self.settled(try await actions.verdict(cardId: cardId, verdict: .review), in: actions)
            }
        }
    }

    /// Fait dicter le dépôt, le titre et le besoin d'une nouvelle feature, puis la
    /// lance avec les modèles par défaut, comme la feuille « Nouvelle feature ».
    func launch(
        repo: String?,
        title: String?,
        need: String?,
        ask: @escaping @MainActor (VoiceLaunchField, String) async throws -> String
    ) async -> String {
        guard let choices = await context.launchRepos() else { return VoiceSpeechText.stateUnreadable }
        let draft: VoiceLaunchDraft
        switch await VoicePilot.draftLaunch(repo: repo, title: title, need: need, choices: choices, ask: ask) {
        case let .said(phrase):
            return phrase
        case let .draft(drafted):
            draft = drafted
        }

        let actions = context.remoteActions
        return await conclude(.launchPipeline, target: draft.title, prompt: draft.confirmation) {
            // `nil`/`nil` : les modèles par défaut de la feuille (défaut OMP).
            try await Self.settled(
                try await actions.launch(
                    repoRoot: draft.repo.root,
                    title: draft.title,
                    description: draft.need,
                    modelReqSpecs: nil,
                    modelImplReview: nil
                ),
                in: actions
            )
        }
    }

    /// Les titres que Siri et Raccourcis proposent pour `gesture` : ceux des seules
    /// cartes éligibles, dans l'ordre de l'ardoise.
    static func featureTitles(_ gesture: VoicePilotGesture, in cards: [KanbanCard]) -> [String] {
        VoicePilot.eligible(gesture, in: cards).map(\.title)
    }

    /// Applique la politique puis traduit l'issue ; un refus du Mac est dit par la
    /// table de `MacVoiceSession`, la seule.
    private func conclude(
        _ gesture: VoiceGesture,
        target: String,
        prompt: String?,
        send: @escaping @MainActor () async throws -> Void
    ) async -> String {
        do {
            return VoiceIssue(try await policy(target, prompt, send), gesture: gesture, target: target).phrase
        } catch let refusal as GestureRefusal {
            return MacVoiceSession.issue(for: refusal).phrase
        } catch {
            return VoiceIssue.macRefused(motive: "").phrase
        }
    }

    /// Attend la conclusion de la commande que le geste vient d'écrire ; un geste
    /// qui n'a rien consigné est un échec.
    private static func settled(_ entryId: String?, in actions: RemoteActions) async throws(GestureRefusal) {
        guard let entryId else { throw .nothingRecorded }
        try await actions.settlement(of: entryId)
    }
}

// MARK: - Fournisseurs d'options

/// Les dépôts où lancer une pipeline : ceux de la feuille « Nouvelle feature ».
struct LaunchRepoOptions: DynamicOptionsProvider {
    @AppDependency var voice: MacVoiceContext

    @MainActor
    func results() async throws -> [String] {
        (await voice.launchRepos() ?? []).map(\.label)
    }
}

/// Les features que la fenêtre propose de reprendre.
struct ResumableFeatureOptions: DynamicOptionsProvider {
    @AppDependency var voice: MacVoiceContext

    @MainActor
    func results() async throws -> [String] {
        MacPilotSession.featureTitles(.resume, in: await voice.board() ?? [])
    }
}

/// Les features dont la carte propose « Arrêter ».
struct StoppableFeatureOptions: DynamicOptionsProvider {
    @AppDependency var voice: MacVoiceContext

    @MainActor
    func results() async throws -> [String] {
        MacPilotSession.featureTitles(.stop, in: await voice.board() ?? [])
    }
}

/// Les features arrivées au jalon specs.
struct SpecsMilestoneOptions: DynamicOptionsProvider {
    @AppDependency var voice: MacVoiceContext

    @MainActor
    func results() async throws -> [String] {
        MacPilotSession.featureTitles(.validateSpecs, in: await voice.board() ?? [])
    }
}

/// Les features arrivées au jalon de revue.
struct ReviewMilestoneOptions: DynamicOptionsProvider {
    @AppDependency var voice: MacVoiceContext

    @MainActor
    func results() async throws -> [String] {
        MacPilotSession.featureTitles(.acceptReview, in: await voice.board() ?? [])
    }
}

// MARK: - Intents

/// « Lancer une pipeline » : crée une feature sur un dépôt connu, titre et besoin dictés.
struct MacLaunchPipelineIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Lancer une pipeline"
    static let description = IntentDescription("Crée une nouvelle feature sur un dépôt connu de ce Mac, avec le titre et le besoin dictés, comme la feuille « Nouvelle feature ».")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .launchPipeline

    @Parameter(title: "Dépôt", optionsProvider: LaunchRepoOptions()) var repo: String?
    @Parameter(title: "Titre") var featureTitle: String?
    @Parameter(title: "Besoin") var need: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    // Type concret, pas `some IntentResult & ProvidesDialog` (voir `MacPendingIntent`).
    // Aucun `MainWindow.reveal()` ni `NSApp.activate` : l'app reste en arrière-plan.
    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        let phrase = await MacPilotSession(context: voice, policy: { target, prompt, send in
            try await self.applyVoicePolicy(target: target, prompt: prompt, send: send)
        }).launch(repo: repo, title: featureTitle, need: need, ask: { field, prompt in
            let dialog = IntentDialog(stringLiteral: prompt)
            switch field {
            case .repo: return try await $repo.requestValue(dialog)
            case .title: return try await $featureTitle.requestValue(dialog)
            case .need: return try await $need.requestValue(dialog)
            }
        })
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}

/// « Reprendre une pipeline » : sans confirmation, comme le bouton « Reprendre ».
struct MacResumeFeatureIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Reprendre une pipeline"
    static let description = IntentDescription("Remet en route une feature que la fenêtre propose de reprendre.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGesture: VoiceGesture = .resume

    @Parameter(title: "Feature", optionsProvider: ResumableFeatureOptions()) var feature: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        let phrase = await MacPilotSession(context: voice, policy: { target, prompt, send in
            try await self.applyVoicePolicy(target: target, prompt: prompt, send: send)
        }).pilot(.resume, spoken: feature, ask: { prompt in
            try await $feature.requestValue(IntentDialog(stringLiteral: prompt))
        })
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}

/// « Arrêter une pipeline » : arrête les pipelines du dépôt de la feature, comme
/// le bouton « Arrêter » de sa carte.
struct MacStopFeatureIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Arrêter une pipeline"
    static let description = IntentDescription("Arrête les pipelines du dépôt d’une feature, comme le bouton « Arrêter » de sa carte.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .stopFeature

    @Parameter(title: "Feature", optionsProvider: StoppableFeatureOptions()) var feature: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        let phrase = await MacPilotSession(context: voice, policy: { target, prompt, send in
            try await self.applyVoicePolicy(target: target, prompt: prompt, send: send)
        }).pilot(.stop, spoken: feature, ask: { prompt in
            try await $feature.requestValue(IntentDialog(stringLiteral: prompt))
        })
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}

/// « Valider les specs » d'une feature arrivée à ce jalon.
struct MacValidateSpecsIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Valider les specs"
    static let description = IntentDescription("Valide les specs d’une feature arrivée à ce jalon.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .validateSpecs

    @Parameter(title: "Feature", optionsProvider: SpecsMilestoneOptions()) var feature: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        let phrase = await MacPilotSession(context: voice, policy: { target, prompt, send in
            try await self.applyVoicePolicy(target: target, prompt: prompt, send: send)
        }).pilot(.validateSpecs, spoken: feature, ask: { prompt in
            try await $feature.requestValue(IntentDialog(stringLiteral: prompt))
        })
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}

/// « Accepter la revue » d'une feature arrivée à ce jalon.
struct MacAcceptReviewIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Accepter la revue"
    static let description = IntentDescription("Accepte la revue d’une feature arrivée à ce jalon.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .acceptReview

    @Parameter(title: "Feature", optionsProvider: ReviewMilestoneOptions()) var feature: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        let phrase = await MacPilotSession(context: voice, policy: { target, prompt, send in
            try await self.applyVoicePolicy(target: target, prompt: prompt, send: send)
        }).pilot(.acceptReview, spoken: feature, ask: { prompt in
            try await $feature.requestValue(IntentDialog(stringLiteral: prompt))
        })
        return .result(dialog: IntentDialog(stringLiteral: phrase))
    }
}
