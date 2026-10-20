// Les intents Siri du pilotage des pipelines sur le Mac (siri-mac-pilotage-pipelines,
// S-7) : lancer une feature, la reprendre, arrêter les pipelines de son dépôt,
// valider ses specs ou accepter sa revue. Les conversations sont celles de
// `VoicePilot.run` et `VoicePilot.launch` (ConsoleCore), les mêmes que sur
// l'iPhone ; la coque ne fournit que le canal `MacPilotChannel` (l'ardoise et les
// dépôts lus après l'attente bornée de `MacVoiceContext`, l'envoi par les gestes
// typés de `RemoteActions`, les mêmes que les boutons de la fenêtre et que l'API
// distante) et les tours de parole de Siri (`MacSiriDictation`).
//
// Titres, descriptions, modes, politique d'authentification et titre du paramètre
// sont des LITTÉRAUX : l'outillage d'extraction des métadonnées App Intents refuse
// toute valeur calculée.

import AppIntents
import ConsoleCore

// MARK: - Canal et orchestration

/// Le canal de `VoicePilot.run` et `VoicePilot.launch` sur le Mac même. Un geste
/// de commande (lancer, arrêter, valider, accepter) n'est conclu qu'après l'accusé
/// du service : Siri ne dit jamais « fait » pour une commande refusée ensuite.
@MainActor
struct MacPilotChannel: VoicePilotChannel {
    let context: MacVoiceContext

    func cards() async throws -> [KanbanCard] {
        try await context.board()
    }

    func launchRepos() async throws -> [String] {
        try await context.launchRepos()
    }

    /// La SEULE voie d'écriture : UNE méthode typée de `RemoteActions` par
    /// livraison, aucun corps HTTP, aucun appel direct à un modèle.
    func deliver(_ delivery: VoicePilotDelivery) async throws {
        let actions = context.remoteActions
        switch delivery {
        case let .launch(repoRoot, title, need):
            // `nil`/`nil` : les modèles par défaut de la feuille (défaut OMP).
            try await Self.settled(
                try await actions.launch(
                    repoRoot: repoRoot, title: title, description: need, modelReqSpecs: nil, modelImplReview: nil
                ),
                in: actions
            )
        case let .resume(cardId):
            try await actions.resume(cardId: cardId)
        case let .stop(cardId):
            try await Self.settled(try await actions.stop(cardId: cardId), in: actions)
        case let .verdict(cardId, milestone):
            switch milestone {
            case .specs:
                try await Self.settled(try await actions.verdict(cardId: cardId, verdict: .specs), in: actions)
            case .review:
                try await Self.settled(try await actions.verdict(cardId: cardId, verdict: .review), in: actions)
            case .answer, .ci:
                throw GestureRefusal.milestoneNotAwaited
            }
        }
    }

    func issue(of error: Error) -> VoiceIssue {
        MacVoiceRefusal.issue(of: error)
    }

    /// Attend la conclusion de la commande que le geste vient d'écrire ; un geste
    /// qui n'a rien consigné est un échec.
    private static func settled(_ entryId: String?, in actions: RemoteActions) async throws(GestureRefusal) {
        guard let entryId else { throw .nothingRecorded }
        try await actions.settlement(of: entryId)
    }
}

/// L'orchestration des intents de pilotage : la politique littérale de l'intent
/// confrontée à la table pour son geste (dialogue `misconfigured` sans rien lire
/// ni envoyer si elle diverge), puis la conversation de ConsoleCore.
@MainActor
enum MacSiriPilot {
    /// Un geste sur une feature existante.
    static func run<Intent: VoiceGestureIntent & MacSiriDictation>(
        _ gesture: VoicePilotGesture,
        intent: Intent,
        context: MacVoiceContext
    ) async throws -> String {
        guard VoiceGesturePolicy.admits(Intent.authenticationPolicy, for: [Intent.voiceGesture], on: .current) else {
            return VoiceGestureText.misconfigured
        }
        return try await VoicePilot.run(gesture, channel: MacPilotChannel(context: context), conversation: intent)
    }

    /// Le lancement d'une feature.
    static func launch<Intent: VoiceGestureIntent & MacSiriDictation>(
        intent: Intent,
        context: MacVoiceContext
    ) async throws -> String {
        guard VoiceGesturePolicy.admits(Intent.authenticationPolicy, for: [Intent.voiceGesture], on: .current) else {
            return VoiceGestureText.misconfigured
        }
        return try await VoicePilot.launch(channel: MacPilotChannel(context: context), conversation: intent)
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

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    // Type concret, pas `some IntentResult & ProvidesDialog` (voir `MacPendingIntent`).
    // Aucun `MainWindow.reveal()` ni `NSApp.activate` : l'app reste en arrière-plan.
    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: try await MacSiriPilot.launch(intent: self, context: voice)))
    }
}

extension MacLaunchPipelineIntent: MacSiriDictation {
    var answerParameter: IntentParameter<String?> { $answer }
}

/// « Reprendre une pipeline » : sans confirmation, comme le bouton « Reprendre ».
struct MacResumeFeatureIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Reprendre une pipeline"
    static let description = IntentDescription("Remet en route une feature que la fenêtre propose de reprendre.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .alwaysAllowed
    static let voiceGesture: VoiceGesture = .resume

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: try await MacSiriPilot.run(.resume, intent: self, context: voice)))
    }
}

extension MacResumeFeatureIntent: MacSiriDictation {
    var answerParameter: IntentParameter<String?> { $answer }
}

/// « Arrêter une pipeline » : arrête les pipelines du dépôt de la feature, comme
/// le bouton « Arrêter » de sa carte.
struct MacStopFeatureIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Arrêter une pipeline"
    static let description = IntentDescription("Arrête les pipelines du dépôt d’une feature, comme le bouton « Arrêter » de sa carte.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .stopFeature

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: try await MacSiriPilot.run(.stop, intent: self, context: voice)))
    }
}

extension MacStopFeatureIntent: MacSiriDictation {
    var answerParameter: IntentParameter<String?> { $answer }
}

/// « Valider les specs » d'une feature arrivée à ce jalon.
struct MacValidateSpecsIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Valider les specs"
    static let description = IntentDescription("Valide les specs d’une feature arrivée à ce jalon.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .validateSpecs

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: try await MacSiriPilot.run(.validateSpecs, intent: self, context: voice)))
    }
}

extension MacValidateSpecsIntent: MacSiriDictation {
    var answerParameter: IntentParameter<String?> { $answer }
}

/// « Accepter la revue » d'une feature arrivée à ce jalon.
struct MacAcceptReviewIntent: AppIntent, VoiceGestureIntent {
    static let title: LocalizedStringResource = "Accepter la revue"
    static let description = IntentDescription("Accepte la revue d’une feature arrivée à ce jalon.")
    static let supportedModes: IntentModes = .background
    static let authenticationPolicy: IntentAuthenticationPolicy = .requiresLocalDeviceAuthentication
    static let voiceGesture: VoiceGesture = .acceptReview

    /// La réponse dictée, redemandée à chaque tour par `requestValue`.
    @Parameter(title: "Réponse") var answer: String?
    @AppDependency var voice: MacVoiceContext

    init() {}

    /// Pour les tests : résout le contexte dans `dependencies`, jamais dans `.shared`.
    init(dependencies: AppDependencyManager) { _voice = AppDependency(manager: dependencies) }

    @MainActor
    func perform() async throws -> IntentResultContainer<Never, Never, Never, IntentDialog> {
        .result(dialog: IntentDialog(stringLiteral: try await MacSiriPilot.run(.acceptReview, intent: self, context: voice)))
    }
}

extension MacAcceptReviewIntent: MacSiriDictation {
    var answerParameter: IntentParameter<String?> { $answer }
}
