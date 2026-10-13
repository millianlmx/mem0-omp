// Le parcours vocal des demandes en attente (siri-mac-questions-en-attente, S-1 et
// S-3) : annonce du nombre, plus ancienne d'abord, lecture de la question et de ses
// choix, interprétation de la réponse dite, contrôle « question périmée » avant
// envoi, issue, puis la suivante. Moteur PUR à ports injectés (lecture de la liste,
// question posée à Siri, envoi) : la coque macOS et l'app iOS appliquent les MÊMES
// règles sans les recopier. Aucune phrase n'est composée ici : elles vivent dans
// `VoiceSpeechText`.
//
// VIT DANS `ConsoleCore`.

import Foundation

/// La manière de répondre à une demande à la voix.
public enum VoiceAnswerForm: Equatable, Sendable {
    /// Un choix parmi les options (dans leur ordre), plus « autre réponse » pour
    /// dicter un texte libre si `acceptsFreeText`.
    case choice(options: [PanelAskOption], acceptsFreeText: Bool)
    /// Un texte libre dicté.
    case dictation
    /// Non réglable à la voix : à traiter dans l'app.
    case inApp
}

/// La réponse recueillie.
public enum VoiceAnswer: Equatable, Sendable {
    /// `index` à partir de 0 dans les options de la forme.
    case option(index: Int, label: String)
    /// Le texte tel que dit, non rogné.
    case text(String)
}

extension PendingRequest {
    /// La forme de réponse vocale de la demande (table S-1).
    public var voiceForm: VoiceAnswerForm {
        switch reply {
        case .cardAnswer:
            return options.isEmpty ? .dictation : .choice(options: options, acceptsFreeText: true)
        case .cardReply:
            return .dictation
        case .cardVerdict, .resume:
            return .inApp
        case let .conduiteDialog(_, method), let .sessionDialog(_, method):
            return Self.voiceForm(of: method, options: options)
        case let .auditEscalation(_, _, _, kind):
            switch kind {
            case .ask, .question:
                return options.isEmpty ? .dictation : .choice(options: options, acceptsFreeText: true)
            case .specs, .review:
                return .inApp
            }
        }
    }

    /// Le geste vocal de la réponse ; `nil` exactement quand la forme est `.inApp`.
    public var voiceGesture: VoiceGesture? {
        switch reply {
        case .cardAnswer:
            return .answerOption
        case .cardReply:
            return .answerText
        case .cardVerdict, .resume:
            return nil
        case let .conduiteDialog(_, method):
            return Self.answersByVoice(method) ? .answerProjectDialog : nil
        case let .sessionDialog(_, method):
            return Self.answersByVoice(method) ? .answerHostedDialog : nil
        case let .auditEscalation(_, _, _, kind):
            switch kind {
            case .ask, .question:
                return .answerAuditEscalation
            case .specs, .review:
                return nil
            }
        }
    }

    /// L'identité de « la même demande » : la carte, le dialogue ou le couple
    /// (audit, slug) — jamais la question, l'appel d'outil ni la clé d'escalade, si
    /// bien qu'une question remplacée garde la même clé.
    public var voiceKey: String {
        switch reply {
        case let .cardAnswer(cardId, _), let .cardReply(cardId), let .cardVerdict(cardId, _), let .resume(cardId):
            return "card:\(cardId)"
        case let .conduiteDialog(dialogId, _):
            return "conduite:\(dialogId)"
        case let .sessionDialog(dialogId, _):
            return "session:\(dialogId)"
        case let .auditEscalation(auditId, slug, _, _):
            return "audit:\(auditId):\(slug)"
        }
    }

    private static func voiceForm(of method: RpcDialogMethod, options: [PanelAskOption]) -> VoiceAnswerForm {
        switch method {
        case .select:
            return .choice(options: options, acceptsFreeText: false)
        case .input:
            return .dictation
        case .confirm:
            return .choice(options: [
                PanelAskOption(label: VoiceSpeechText.confirmYes, description: nil),
                PanelAskOption(label: VoiceSpeechText.confirmNo, description: nil),
            ], acceptsFreeText: false)
        case .editor:
            return .inApp
        }
    }

    private static func answersByVoice(_ method: RpcDialogMethod) -> Bool {
        switch method {
        case .select, .input, .confirm:
            return true
        case .editor:
            return false
        }
    }
}

/// La liste lue, ou la phrase qui dit pourquoi elle ne l'a pas été.
public enum VoiceReading: Equatable, Sendable {
    case ready([PendingRequest])
    case unavailable(phrase: String)
}

/// Le moteur du parcours. `read` rend la liste triée de la plus ancienne à la plus
/// récente ; `ask` fait dire son texte puis rend l'énoncé de l'utilisateur (toute
/// erreur vaut annulation) ; `send` applique la politique et le geste et rend son
/// issue. `run` rend la DERNIÈRE phrase, que l'intent rend en résultat.
@MainActor
public struct VoiceConversation {
    /// Questions au plus par demande sans envoi : la session termine toujours.
    public static let maxAsks = 3

    private let read: @MainActor () async -> VoiceReading
    private let ask: @MainActor (String) async throws -> String
    private let send: @MainActor (PendingRequest, VoiceAnswer) async -> VoiceIssue

    public init(
        read: @escaping @MainActor () async -> VoiceReading,
        ask: @escaping @MainActor (String) async throws -> String,
        send: @escaping @MainActor (PendingRequest, VoiceAnswer) async -> VoiceIssue
    ) {
        self.read = read
        self.ask = ask
        self.send = send
    }

    public func run(announcing: Bool) async -> String {
        let list: [PendingRequest]
        switch await read() {
        case let .unavailable(phrase):
            return phrase
        case let .ready(requests):
            list = requests
        }
        guard var current = list.first else { return VoiceSpeechText.noPending }

        let walk = Walk(ask: ask)
        if announcing { walk.add(VoiceSpeechText.walkHeader(list.count)) }

        while true {
            if let end = await handle(current, walk) { return end }
            switch await read() {
            case let .unavailable(phrase):
                walk.add(phrase)
                return walk.pending
            case let .ready(requests):
                guard let next = requests.first(where: { !walk.handled.contains($0.voiceKey) }) else {
                    walk.add(VoiceSpeechText.walkNoneLeft)
                    return walk.pending
                }
                walk.add(VoiceSpeechText.walkNext)
                current = next
            }
        }
    }

    /// L'étape 3 sur `request` : `nil` pour passer à la suivante, sinon la phrase
    /// finale de la session.
    private func handle(_ request: PendingRequest, _ walk: Walk) async -> String? {
        var r = request
        while true {
            let k = r.voiceKey
            let form = r.voiceForm
            // a. Non réglable à la voix.
            if form == .inApp {
                walk.add(VoiceSpeechText.walkRequest(r))
                walk.add(VoiceSpeechText.walkInApp)
                walk.handled.insert(k)
                return nil
            }
            // b. Borne des questions.
            if walk.exhausted(k) { return VoiceSpeechText.walkNotUnderstood }
            // c. Lecture de la demande, puis la question.
            walk.add(VoiceSpeechText.walkRequest(r))
            switch form {
            case let .choice(options, acceptsFreeText):
                walk.add(VoiceSpeechText.walkChoices(labels: options.map(\.label), acceptsFreeText: acceptsFreeText))
            case .dictation, .inApp:
                walk.add(VoiceSpeechText.walkDictate)
            }
            guard let said = await walk.askPending(k) else { return VoiceSpeechText.walkStopped }

            // d. Interprétation de l'énoncé.
            let answer: VoiceAnswer
            switch await interpret(said, form: form, key: k, walk) {
            case let .answer(value):
                answer = value
            case .askAgain:
                continue
            case let .end(phrase):
                return phrase
            }

            // e. Contrôle avant envoi : la demande lue est-elle toujours la même ?
            switch await read() {
            case let .unavailable(phrase):
                walk.add(phrase)
                return walk.pending
            case let .ready(requests):
                guard let fresh = requests.first(where: { $0.voiceKey == k }) else {
                    walk.add(VoiceIssue.staleQuestion.phrase)
                    walk.handled.insert(k)
                    return nil
                }
                if Self.changed(fresh, from: r) {
                    walk.add(VoiceIssue.staleQuestion.phrase)
                    r = fresh
                    continue
                }
            }

            // f. Envoi et issue.
            let issue = await send(r, answer)
            switch issue {
            case .sent:
                walk.add(issue.phrase)
                walk.handled.insert(k)
                return nil
            case .staleQuestion:
                switch await read() {
                case let .unavailable(phrase):
                    walk.add(phrase)
                    return walk.pending
                case let .ready(requests):
                    walk.add(issue.phrase)
                    guard let fresh = requests.first(where: { $0.voiceKey == k }), Self.changed(fresh, from: r) else {
                        walk.handled.insert(k)
                        return nil
                    }
                    r = fresh
                    continue
                }
            case .misconfigured:
                walk.add(issue.phrase)
                return walk.pending
            case .cancelled, .invalidOption, .macRefused, .notPaired, .macUnreachable, .incompatibleVersion:
                walk.add(issue.phrase)
                walk.handled.insert(k)
                return nil
            }
        }
    }

    /// L'issue de l'interprétation d'un énoncé.
    private enum Interpretation {
        case answer(VoiceAnswer)
        /// Retour au contrôle de la borne puis à la relecture de la question.
        case askAgain
        /// Fin de la session avec cette phrase.
        case end(String)
    }

    /// L'étape d. : un texte dicté, une option désignée, « autre réponse » suivie
    /// d'un texte, ou les options relues jusqu'à la borne des questions.
    private func interpret(_ spoken: String, form: VoiceAnswerForm, key k: String, _ walk: Walk) async -> Interpretation {
        guard case let .choice(options, acceptsFreeText) = form else {
            guard !spoken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                walk.add(VoiceSpeechText.nothingHeard)
                return .askAgain
            }
            return .answer(.text(spoken))
        }
        var said = spoken
        while true {
            let match = VoiceAnswerMatcher.match(said, options: options, acceptsFreeText: false)
            switch match {
            case let .option(index, label):
                return .answer(.option(index: index, label: label))
            case let .notFound(prompt):
                if acceptsFreeText && VoiceAnswerMatcher.isOtherAnswer(said) {
                    if walk.exhausted(k) { return .end(VoiceSpeechText.walkNotUnderstood) }
                    walk.add(VoiceSpeechText.walkDictate)
                    guard let text = await walk.askPending(k) else { return .end(VoiceSpeechText.walkStopped) }
                    guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                        walk.add(VoiceSpeechText.nothingHeard)
                        return .askAgain
                    }
                    return .answer(.text(text))
                }
                walk.add(prompt)
            case .freeText:
                // Inatteignable : `match` est appelé sans texte libre.
                walk.add(VoiceSpeechText.optionNotFound(labels: options.map(\.label)))
            }
            if acceptsFreeText { walk.add(VoiceSpeechText.walkOtherAnswerHint) }
            if walk.exhausted(k) { return .end(VoiceSpeechText.walkNotUnderstood) }
            guard let again = await walk.askPending(k) else { return .end(VoiceSpeechText.walkStopped) }
            said = again
        }
    }

    /// La question de la demande a changé entre la lecture et l'envoi.
    private static func changed(_ fresh: PendingRequest, from read: PendingRequest) -> Bool {
        fresh.id != read.id || fresh.question != read.question || fresh.voiceForm != read.voiceForm
    }
}

/// L'état d'une session : le texte pas encore dit, les demandes traitées, les
/// questions posées par demande.
@MainActor
private final class Walk {
    private(set) var pending = ""
    var handled: Set<String> = []
    private var asks: [String: Int] = [:]
    private let ask: @MainActor (String) async throws -> String

    init(ask: @escaping @MainActor (String) async throws -> String) {
        self.ask = ask
    }

    /// Accole `text` au texte à dire : directement après une espace finale (en-tête,
    /// « La suivante : »), sinon après une espace.
    func add(_ text: String) {
        pending = pending.isEmpty || pending.hasSuffix(" ") ? pending + text : pending + " " + text
    }

    func exhausted(_ key: String) -> Bool {
        asks[key, default: 0] >= VoiceConversation.maxAsks
    }

    /// Dit le texte en attente, le vide, compte la question et rend l'énoncé ;
    /// `nil` si l'utilisateur annule.
    func askPending(_ key: String) async -> String? {
        let prompt = pending
        pending = ""
        asks[key, default: 0] += 1
        do {
            return try await ask(prompt)
        } catch {
            return nil
        }
    }
}
