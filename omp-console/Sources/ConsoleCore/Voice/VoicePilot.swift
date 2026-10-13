// Le pilotage vocal des pipelines (siri-mac-pilotage-pipelines, S-2 à S-4) : les
// features éligibles à un geste, le choix d'une feature par la voix et le
// brouillon d'un lancement dicté. Moteur PUR à ports injectés (`ask`), comme
// `VoiceConversation` : il ne lit rien, n'écrit rien, et ses phrases vivent dans
// `VoiceSpeechText` et `VoiceGestureText`.
//
// L'éligibilité n'a AUCUNE règle propre : elle compose les prédicats de
// `KanbanActionPresentation`, ceux qui décident des boutons de la fenêtre.
//
// VIT DANS `ConsoleCore` : la coque Mac et l'app iOS partagent ces briques.

import Foundation

/// Un geste vocal qui vise une feature existante de l'ardoise.
public enum VoicePilotGesture: String, CaseIterable, Sendable {
    case resume, stop, validateSpecs, acceptReview

    /// La ligne de `VoiceGesturePolicy` qui régit le geste.
    public var voiceGesture: VoiceGesture {
        switch self {
        case .resume: return .resume
        case .stop: return .stopFeature
        case .validateSpecs: return .validateSpecs
        case .acceptReview: return .acceptReview
        }
    }
}

/// Le choix d'une feature : une carte éligible, ou la phrase que Siri dit à la
/// place (aucune feature, annulation, réponse incomprise).
public enum VoicePilotPick: Equatable, Sendable {
    case card(KanbanCard)
    case said(String)
}

/// Un lancement dicté, prêt à confirmer : valeurs épurées de leurs blancs de bord.
public struct VoiceLaunchDraft: Equatable, Sendable {
    public let repo: KanbanLaunchRepoChoice
    public let title: String
    public let need: String

    public init(repo: KanbanLaunchRepoChoice, title: String, need: String) {
        self.repo = repo
        self.title = title
        self.need = need
    }

    /// La question de confirmation, qui relit les trois valeurs.
    public var confirmation: String {
        VoiceGestureText.launchConfirmation(title: title, repo: repo.label, need: need)
    }
}

/// Le champ que `draftLaunch` demande à Siri.
public enum VoiceLaunchField: Sendable, Equatable {
    case repo, title, need
}

/// L'issue du brouillon : prêt, ou la phrase que Siri dit à la place.
public enum VoiceLaunchStep: Equatable, Sendable {
    case draft(VoiceLaunchDraft)
    case said(String)
}

public enum VoicePilot {
    /// Les cartes qui offrent `gesture` dans la fenêtre, dans leur ordre d'entrée.
    public static func eligible(_ gesture: VoicePilotGesture, in cards: [KanbanCard]) -> [KanbanCard] {
        cards.filter { offers(gesture, $0) }
    }

    /// Le prédicat existant de l'app pour chaque geste : les deux « Reprendre » de
    /// la fenêtre (Pipelines et Accueil), l'arrêt du lot, le jalon specs ou revue.
    private static func offers(_ gesture: VoicePilotGesture, _ card: KanbanCard) -> Bool {
        switch gesture {
        case .resume:
            return KanbanActionPresentation.resumable(card) || KanbanActionPresentation.relaunchable(card)
        case .stop:
            return KanbanActionPresentation.zones(for: card).contains { zone in
                if case .stopLot = zone { return true }
                return false
            }
        case .validateSpecs:
            return hasMilestone(card, .specs)
        case .acceptReview:
            return hasMilestone(card, .review)
        }
    }

    private static func hasMilestone(_ card: KanbanCard, _ kind: LotWaitKind) -> Bool {
        KanbanActionPresentation.zones(for: card).contains { zone in
            if case .milestone(_, let k) = zone { return k == kind }
            return false
        }
    }

    /// Désigne la feature visée par `gesture` parmi les cartes éligibles : par le
    /// nom dit, sinon en le demandant, puis en levant une ambiguïté. Au plus
    /// `VoiceConversation.maxAsks` questions en tout ; toute erreur de `ask` vaut
    /// annulation. N'écrit jamais rien, et la carte rendue est toujours éligible.
    @MainActor
    public static func pickFeature(
        _ gesture: VoicePilotGesture,
        spoken: String?,
        cards: [KanbanCard],
        ask: @MainActor (String) async throws -> String
    ) async -> VoicePilotPick {
        let candidates = eligible(gesture, in: cards)
        guard !candidates.isEmpty else { return .said(VoiceSpeechText.pilotNoEligible(gesture)) }

        var asks = 0
        do {
            var query = spoken?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if query.isEmpty {
                asks += 1
                query = try await ask(VoiceSpeechText.pilotWhichFeature(gesture))
            }
            var pool = candidates
            var firstRound = true
            while true {
                switch VoiceFeatureSearch.find(query, among: pool) {
                case let .found(card):
                    return .card(card)
                case let .ambiguous(matches, prompt):
                    guard asks < VoiceConversation.maxAsks else { return .said(VoiceSpeechText.walkNotUnderstood) }
                    asks += 1
                    let answer = try await ask(prompt)
                    let options = matches.map { PanelAskOption(label: $0.title, description: nil) }
                    if case let .option(index, _) = VoiceAnswerMatcher.match(answer, options: options, acceptsFreeText: false) {
                        return .card(matches[index])
                    }
                    pool = matches
                    query = answer
                    firstRound = false
                case .notFound:
                    if firstRound {
                        switch VoiceFeatureSearch.find(query, in: cards) {
                        case .found, .ambiguous:
                            return .said(VoiceSpeechText.pilotNotOffered(gesture))
                        case .notFound:
                            break
                        }
                    }
                    return .said(VoiceSpeechText.featureNotFound)
                }
            }
        } catch {
            return .said(VoiceGestureText.cancelled)
        }
    }

    /// Le brouillon d'un lancement : le dépôt parmi `choices` (sans question s'il
    /// n'y en a qu'un et que rien n'a été dit), puis le titre et le besoin, dictés
    /// s'ils n'ont pas été dits. Un titre vide arrête avant le besoin. Au plus
    /// `VoiceConversation.maxAsks` questions pour le dépôt ; toute erreur de `ask`
    /// vaut annulation.
    @MainActor
    public static func draftLaunch(
        repo spokenRepo: String?,
        title spokenTitle: String?,
        need spokenNeed: String?,
        choices: [KanbanLaunchRepoChoice],
        ask: @MainActor (VoiceLaunchField, String) async throws -> String
    ) async -> VoiceLaunchStep {
        guard !choices.isEmpty else { return .said(VoiceSpeechText.launchNoRepo) }

        do {
            guard let repo = try await pickRepo(spokenRepo, choices: choices, ask: ask) else {
                return .said(VoiceSpeechText.walkNotUnderstood)
            }

            let saidTitle: String
            if let spokenTitle { saidTitle = spokenTitle } else { saidTitle = try await ask(.title, VoiceSpeechText.launchAskTitle) }
            let title = saidTitle.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !title.isEmpty else { return .said(VoiceSpeechText.launchEmptyTitle) }

            let saidNeed: String
            if let spokenNeed { saidNeed = spokenNeed } else { saidNeed = try await ask(.need, VoiceSpeechText.launchAskNeed) }
            let need = saidNeed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !need.isEmpty else { return .said(VoiceSpeechText.launchEmptyNeed) }

            return .draft(VoiceLaunchDraft(repo: repo, title: title, need: need))
        } catch {
            return .said(VoiceGestureText.cancelled)
        }
    }

    /// Le dépôt du lancement, ou `nil` quand aucune réponse n'a désigné un choix
    /// après `VoiceConversation.maxAsks` questions. Un seul choix et rien de dit :
    /// ce choix, sans question.
    @MainActor
    private static func pickRepo(
        _ spokenRepo: String?,
        choices: [KanbanLaunchRepoChoice],
        ask: @MainActor (VoiceLaunchField, String) async throws -> String
    ) async throws -> KanbanLaunchRepoChoice? {
        var query = spokenRepo?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if choices.count == 1, query.isEmpty { return choices[0] }

        let labels = choices.map(\.label)
        let options = labels.map { PanelAskOption(label: $0, description: nil) }
        var asks = 0
        if query.isEmpty {
            asks += 1
            query = try await ask(.repo, VoiceSpeechText.launchWhichRepo(labels: labels))
        }
        while true {
            let retry: String
            switch VoiceAnswerMatcher.match(query, options: options, acceptsFreeText: false) {
            case let .option(index, _):
                return choices[index]
            case let .notFound(prompt):
                retry = prompt
            case .freeText:
                retry = VoiceSpeechText.optionNotFound(labels: labels)
            }
            guard asks < VoiceConversation.maxAsks else { return nil }
            asks += 1
            query = try await ask(.repo, retry)
        }
    }
}
