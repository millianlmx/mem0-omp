// Le pilotage vocal des pipelines (siri-iphone-pilotage-pipelines, S-3, S-5, S-6) :
// lancer une feature, reprendre ou relancer, arrêter, valider les specs et accepter
// la revue. L'éligibilité d'une feature à un geste est composée des SEULS prédicats
// qui décident des boutons de l'app (`KanbanActionPresentation`) ; la désignation
// passe par `VoiceFeatureSearch`, la confirmation par la porte
// `VoiceGesturePolicy.apply`. Les coques ne fournissent qu'un canal (l'ardoise, les
// dépôts lançables, une requête par livraison, l'issue d'un échec) et un
// adaptateur de dialogue.
//
// Aucune phrase n'est composée ici : elles vivent dans `VoiceSpeechText` et
// `VoiceGestureText`.
//
// VIT DANS `ConsoleCore`.

import Foundation

/// Un geste vocal sur une feature existante.
public enum VoicePilotGesture: String, CaseIterable, Sendable {
    case resume
    case stop
    case validateSpecs
    case acceptReview

    /// La ligne de la politique vocale qui régit ce geste.
    public var voiceGesture: VoiceGesture {
        switch self {
        case .resume:
            return .resume
        case .stop:
            return .stopFeature
        case .validateSpecs:
            return .validateSpecs
        case .acceptReview:
            return .acceptReview
        }
    }
}

/// Une livraison : UNE requête vers le Mac, par les routes existantes
/// (`feature.launch`, `card.resume`, `card.stop`, `card.verdict`). Aucun cas ne
/// porte un refus ni une demande de corrections.
public enum VoicePilotDelivery: Equatable, Sendable {
    case launch(repoRoot: String, title: String, need: String)
    case resume(cardId: String)
    case stop(cardId: String)
    /// `milestone` vaut `.specs` ou `.review`.
    case verdict(cardId: String, milestone: LotWaitKind)
}

/// Le canal vers le Mac, fourni par la coque.
@MainActor public protocol VoicePilotChannel {
    /// L'ardoise courante, dérivée comme celle de l'écran Pipelines.
    func cards() async throws -> [KanbanCard]
    /// Les dépôts proposés au lancement, chemins complets, comme ceux de la
    /// feuille « Nouvelle feature ».
    func launchRepos() async throws -> [String]
    /// UNE requête vers le Mac.
    func deliver(_ delivery: VoicePilotDelivery) async throws
    /// L'issue d'un échec de lecture ou de livraison.
    func issue(of error: Error) -> VoiceIssue
}

public enum VoicePilot {
    /// L'app affiche le geste sur cette carte : composé EXCLUSIVEMENT des
    /// prédicats de `KanbanActionPresentation`, sans recopier de règle.
    public static func shows(_ gesture: VoicePilotGesture, on card: KanbanCard) -> Bool {
        switch gesture {
        case .resume:
            return KanbanActionPresentation.resumable(card) || KanbanActionPresentation.relaunchable(card)
        case .stop:
            return KanbanActionPresentation.zones(for: card).contains { zone in
                if case .stopLot = zone { return true }
                return false
            }
        case .validateSpecs:
            return showsMilestone(.specs, on: card)
        case .acceptReview:
            return showsMilestone(.review, on: card)
        }
    }

    /// Les cartes où l'app affiche le geste, ordonnées comme les correspondances
    /// de `VoiceFeatureSearch` : titre normalisé, puis identité.
    public static func eligible(_ gesture: VoicePilotGesture, in cards: [KanbanCard]) -> [KanbanCard] {
        cards
            .filter { shows(gesture, on: $0) }
            .map { (key: VoiceSpeech.normalized($0.title), card: $0) }
            .sorted { a, b in
                if a.key != b.key { return a.key.utf8.lexicographicallyPrecedes(b.key.utf8) }
                return a.card.id.utf8.lexicographicallyPrecedes(b.card.id.utf8)
            }
            .map(\.card)
    }

    /// Un geste sur une feature : lecture de l'ardoise, désignation parmi les
    /// éligibles, porte de confirmation, AU PLUS une livraison. Rend la phrase
    /// finale de Siri. Ne lève que si `conversation.ask` lève ou sur
    /// `CancellationError` ; rien n'est alors envoyé.
    @MainActor
    public static func run(
        _ gesture: VoicePilotGesture,
        channel: some VoicePilotChannel,
        conversation: some VoiceConversation
    ) async throws -> String {
        let cards: [KanbanCard]
        do {
            cards = try await channel.cards()
        } catch {
            try rethrowCancellation(error)
            return channel.issue(of: error).phrase
        }

        let candidates = eligible(gesture, in: cards)
        guard !candidates.isEmpty else { return VoiceSpeechText.pilotNone(gesture) }

        let ask = VoiceSpeechText.pilotAsk(
            gesture,
            titles: candidates.prefix(3).map(\.title),
            more: max(candidates.count - 3, 0)
        )
        var question = ask
        var designated: KanbanCard?
        designation: for _ in 0..<VoicePendingWalk.maxAttempts {
            let spoken = try await conversation.ask(question)
            guard !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                question = VoiceSpeechText.joined([VoiceSpeechText.nothingHeard, ask])
                continue
            }
            switch VoiceFeatureSearch.find(spoken, among: candidates) {
            case let .found(card):
                designated = card
                break designation
            case let .ambiguous(_, prompt):
                question = prompt
            case let .notFound(prompt):
                return prompt
            }
        }
        guard let card = designated else { return VoiceGestureText.cancelled }

        let delivery: VoicePilotDelivery
        let prompt: String?
        switch gesture {
        case .resume:
            delivery = .resume(cardId: card.id)
            prompt = nil
        case .stop:
            delivery = .stop(cardId: card.id)
            prompt = VoiceGestureText.stopConfirmation(repo: card.repo, feature: card.title)
        case .validateSpecs:
            delivery = .verdict(cardId: card.id, milestone: .specs)
            prompt = nil
        case .acceptReview:
            delivery = .verdict(cardId: card.id, milestone: .review)
            prompt = nil
        }

        // L'arrêt vise tout le dépôt (`card.stop`) : son issue nomme le dépôt.
        let target = gesture == .stop ? card.repo : card.title
        return try await pass(gesture.voiceGesture, target: target, prompt: prompt,
                              delivery: delivery, channel: channel, conversation: conversation)
    }

    /// Le lancement d'une feature : dépôt parmi ceux du Mac, titre et besoin
    /// dictés, modèles par défaut (aucune question), confirmation qui relit le
    /// tout, AU PLUS une livraison. Rend la phrase finale de Siri. Ne lève que si
    /// `conversation.ask` lève ou sur `CancellationError` ; rien n'est alors envoyé.
    @MainActor
    public static func launch(
        channel: some VoicePilotChannel,
        conversation: some VoiceConversation
    ) async throws -> String {
        let roots: [String]
        do {
            roots = try await channel.launchRepos()
        } catch {
            try rethrowCancellation(error)
            return channel.issue(of: error).phrase
        }
        guard !roots.isEmpty else { return VoiceSpeechText.launchNoRepo }

        guard let choice = try await chooseRepo(KanbanLaunchRepos.choices(roots), conversation: conversation),
              let title = try await dictate(VoiceSpeechText.launchTitleAsk, conversation: conversation),
              let need = try await dictate(VoiceSpeechText.launchNeedAsk, conversation: conversation)
        else { return VoiceGestureText.cancelled }

        return try await pass(
            .launchPipeline,
            target: title,
            prompt: VoiceGestureText.launchConfirmation(title: title, repo: choice.label, need: need),
            delivery: .launch(repoRoot: choice.root, title: title, need: need),
            channel: channel,
            conversation: conversation
        )
    }

    // MARK: - Étapes

    private static func showsMilestone(_ kind: LotWaitKind, on card: KanbanCard) -> Bool {
        KanbanActionPresentation.zones(for: card).contains { zone in
            if case let .milestone(_, k) = zone { return k == kind }
            return false
        }
    }

    /// Le dépôt du lancement : retenu sans question s'il est seul, sinon choisi
    /// parmi TOUS les libellés, dits avec leur rang ; `nil` après `maxAttempts`
    /// réponses non reconnues. Un dépôt non reconnu rappelle les rangs, pas les
    /// seuls noms : Siri transcrit mal un nom de dépôt, jamais un numéro.
    @MainActor
    private static func chooseRepo(
        _ choices: [KanbanLaunchRepoChoice],
        conversation: some VoiceConversation
    ) async throws -> KanbanLaunchRepoChoice? {
        if choices.count == 1 { return choices[0] }
        let labels = choices.map(\.label)
        let options = labels.map { PanelAskOption(label: $0, description: nil) }
        let ask = VoiceSpeechText.launchRepoAsk(labels: labels)
        var question = ask
        for _ in 0..<VoicePendingWalk.maxAttempts {
            let spoken = try await conversation.ask(question)
            switch VoiceAnswerMatcher.match(spoken, options: options, acceptsFreeText: false) {
            case let .option(index, _):
                return choices[index]
            case let .notFound(prompt):
                question = prompt == VoiceSpeechText.nothingHeard
                    ? VoiceSpeechText.joined([VoiceSpeechText.nothingHeard, ask])
                    : VoiceSpeechText.launchRepoNotFound(labels: labels)
            case .freeText:
                // Inatteignable sans texte libre : le rappel des rangs, comme `.notFound`.
                question = VoiceSpeechText.launchRepoNotFound(labels: labels)
            }
        }
        return nil
    }

    /// Une dictée épurée de ses blancs ; `nil` après `maxAttempts` réponses vides.
    @MainActor
    private static func dictate(_ ask: String, conversation: some VoiceConversation) async throws -> String? {
        var question = ask
        for _ in 0..<VoicePendingWalk.maxAttempts {
            let text = try await conversation.ask(question).trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { return text }
            question = VoiceSpeechText.joined([VoiceSpeechText.nothingHeard, ask])
        }
        return nil
    }

    /// La porte puis l'issue : `.sent` nomme le geste et sa cible, une annulation
    /// ou une mauvaise configuration rend son dialogue, un échec de livraison rend
    /// la cause du canal (le refus du Mac fait foi, aucune relecture).
    @MainActor
    private static func pass(
        _ gesture: VoiceGesture,
        target: String,
        prompt: String?,
        delivery: VoicePilotDelivery,
        channel: some VoicePilotChannel,
        conversation: some VoiceConversation
    ) async throws -> String {
        let outcome: VoiceGestureOutcome
        do {
            outcome = try await VoiceGesturePolicy.apply(
                gesture,
                target: target,
                prompt: prompt,
                on: .current,
                confirm: { try await conversation.confirm($0) },
                send: { try await channel.deliver(delivery) }
            )
        } catch {
            try rethrowCancellation(error)
            return channel.issue(of: error).phrase
        }
        switch outcome {
        case .sent:
            return VoiceIssue.sent(gesture, target: target).phrase
        case let .cancelled(dialog), let .misconfigured(dialog):
            return dialog
        }
    }

    private static func rethrowCancellation(_ error: Error) throws {
        if error is CancellationError { throw error }
    }
}
