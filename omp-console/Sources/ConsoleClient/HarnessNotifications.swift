// Les NOTIFICATIONS actionnables des deux apps, sans dépendre du système : ce qu'une
// notification porte (`omp` : sorte, run, révision, envoi), les gestes que chaque
// catégorie offre, et le routage d'une action vers un geste du client ou une
// destination dans l'app. Le pont vers `UserNotifications` (HarnessNotificationCenter)
// ne fait que traduire.
//
// Le contrat vient du serveur (omp-harness/push-alerts.ts) : catégories `omp.validate`
// (specs, verdict : Valider / Refuser), `omp.approve` (envoi du poste : Approuver /
// Refuser), `omp.answer` (une seule question ouverte, avec sa recommandation : la
// prendre, ou répondre autre chose), `omp.open` ; `rev` est l'If-Match du geste.
// Valider, refuser, approuver ou répondre écrivent : l'appareil doit être déverrouillé
// (`authenticationRequired`). Approuver ou refuser un envoi exige le jeton APPROBATEUR
// déjà au trousseau ; sans lui, ces actions ouvrent le Poste au lieu d'agir. Un refus de
// specs ou de verdict porte sa raison (le serveur l'exige) : sans texte saisi, l'action
// ouvre l'app ; de même une réponse sans texte.

import ConsoleCore
import Foundation

/// Les catégories de notification (`ALERT_CATEGORIES` d'omp-harness/push-alerts.ts).
public enum HarnessNotificationCategory: String, CaseIterable, Sendable {
    case validate = "omp.validate"
    case approve = "omp.approve"
    /// Une question ouverte, une seule, avec sa recommandation : on y répond depuis la notification.
    case answer = "omp.answer"
    case open = "omp.open"
}

/// Les actions qu'une notification offre.
public enum HarnessNotificationAction: String, CaseIterable, Sendable {
    case validate = "omp.action.validate"
    case refuse = "omp.action.refuse"
    case approve = "omp.action.approve"
    case refuseSend = "omp.action.refuseSend"
    /// Répondre à la question par l'option que l'agent recommande.
    case takeRecommended = "omp.action.takeRecommended"
    /// Répondre à la question par un texte saisi.
    case answer = "omp.action.answer"
    case open = "omp.action.open"
}

/// Une action telle que le système la déclare.
public struct HarnessNotificationActionSpec: Equatable, Sendable {
    public var action: HarnessNotificationAction
    public var title: String
    /// L'action demande un texte (la raison d'un refus, une réponse).
    public var textInput: Bool
    /// L'appareil est déverrouillé avant d'agir : un geste d'écriture.
    public var authenticationRequired: Bool
    /// L'action ouvre l'app au lieu d'agir en arrière-plan.
    public var foreground: Bool
    public var destructive: Bool
    /// L'invite du champ d'une action à texte ; `nil` sans champ.
    public var placeholder: String? = nil
}

/// La question qu'une alerte `omp.answer` porte : de quoi y répondre sans ouvrir l'app.
public struct HarnessPushQuestion: Equatable, Sendable {
    /// L'identifiant de l'escalade.
    public var id: Int
    /// L'option que l'agent recommande.
    public var recommended: String
    /// Les options proposées (quatre au plus).
    public var options: [String]

    public init(id: Int, recommended: String, options: [String] = []) {
        self.id = id
        self.recommended = recommended
        self.options = options
    }
}

/// La sorte d'une alerte (`omp.kind`, `AlertKind` du serveur).
public enum HarnessPushKind: String, CaseIterable, Sendable {
    case specs, verdict, escalation, approval
    case runFailed = "run_failed"
    case stalled, budget
    case dailyBudget = "daily_budget"
    case vigieSilent = "vigie_silent"
    case backupFailed = "backup_failed"
    /// Un commentaire Jira proposé par l'agent attend l'approbateur.
    case atlassianComment = "atlassian_comment"
    /// Le plan du jour est prêt.
    case plan
}

/// Ce qu'une notification porte : des identifiants, jamais de contenu.
public struct HarnessPushAlert: Equatable, Sendable {
    public var kind: HarnessPushKind
    public var runId: String?
    /// L'If-Match du geste : la révision du run, ou l'`updatedAt` de l'envoi du poste.
    public var rev: Int?
    /// Le numéro de l'action du poste.
    public var seq: Int?
    /// La question d'une alerte `omp.answer` ; `nil` pour toute autre.
    public var question: HarnessPushQuestion?

    public init(kind: HarnessPushKind, runId: String? = nil, rev: Int? = nil, seq: Int? = nil, question: HarnessPushQuestion? = nil) {
        self.kind = kind
        self.runId = runId
        self.rev = rev
        self.seq = seq
        self.question = question
    }

    /// La charge `omp` d'une notification (APNs ou locale) ; `nil` si elle n'en porte pas.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let omp = userInfo["omp"] as? [String: Any], let raw = omp["kind"] as? String,
              let kind = HarnessPushKind(rawValue: raw)
        else { return nil }
        var question: HarnessPushQuestion?
        if let raw = omp["question"] as? [String: Any], let id = (raw["id"] as? NSNumber)?.intValue,
           let recommended = raw["recommended"] as? String {
            question = HarnessPushQuestion(id: id, recommended: recommended, options: raw["options"] as? [String] ?? [])
        }
        self.init(
            kind: kind,
            runId: omp["runId"] as? String,
            rev: (omp["rev"] as? NSNumber)?.intValue,
            seq: (omp["seq"] as? NSNumber)?.intValue,
            question: question
        )
    }

    /// La charge d'une notification locale : la même forme que celle du serveur.
    public var userInfo: [String: Any] {
        var omp: [String: Any] = ["kind": kind.rawValue]
        if let runId { omp["runId"] = runId }
        if let rev { omp["rev"] = rev }
        if let seq { omp["seq"] = seq }
        if let question {
            omp["question"] = ["id": question.id, "recommended": question.recommended, "options": question.options] as [String: Any]
        }
        return ["omp": omp]
    }

    /// Où mène un toucher : ce qui attend dans « À traiter », le Poste, la page de la
    /// feature, ou la Vigie (Système) pour ce qui touche le serveur lui-même.
    public var destination: HarnessPaletteCommand {
        switch kind {
        case .specs: .inbox(.specs)
        case .verdict: .inbox(.verdicts)
        case .escalation: .inbox(.toDecide)
        case .approval, .atlassianComment, .plan: .section(.workstation)
        case .runFailed, .stalled, .budget: runId.map(HarnessPaletteCommand.run) ?? .section(.inbox)
        case .dailyBudget: .section(.inbox)
        case .vigieSilent, .backupFailed: .system(.vigie)
        }
    }
}

/// Ce qu'une action de notification commande.
public enum HarnessNotificationGesture: Equatable, Sendable {
    /// Valider les specs ou le verdict ; `rev` absent : la révision que l'app connaît.
    case validate(runId: String, rev: Int?)
    /// Les refuser, avec la raison saisie.
    case refuse(runId: String, rev: Int?, reason: String)
    /// Approuver l'envoi du poste à cette révision ; absente : celle de la liste relue.
    case approveSend(seq: Int, revision: Int?)
    case refuseSend(seq: Int, revision: Int?)
    /// Répondre à la seule question ouverte d'une feature (la recommandation, ou un texte saisi).
    case answer(runId: String, rev: Int?, question: Int, answer: String)
    /// Ouvrir l'app à cet endroit.
    case open(HarnessPaletteCommand)
}

/// Une alerte tirée du flux du serveur (Mac, app en arrière-plan) : sa catégorie selon
/// les droits du client, l'événement qui la porte (dédoublonnage) et son dépôt.
public struct HarnessLocalAlert: Equatable, Sendable {
    public var alert: HarnessPushAlert
    public var category: HarnessNotificationCategory
    public var eventId: Int
    public var repo: String?
    /// Le nombre de questions d'une escalade.
    public var questions: Int
    /// Le nombre de preuves du tour de revue d'un verdict ; `nil` pour un serveur qui ne
    /// le dit pas (le corps est alors celui d'avant).
    public var proofs: Int? = nil
    /// La carte de la première question d'un lot (session en graphe) : sa `headline` devient le
    /// titre et son `stake` le corps, comme l'alerte push du serveur ; `nil` sans carte.
    public var headline: String? = nil
    public var stake: String? = nil

    /// Le titre, les mêmes mots que l'alerte push du serveur.
    public var title: String {
        switch alert.kind {
        case .specs: NotificationText.specs
        case .verdict: NotificationText.verdict
        case .escalation: headline ?? NotificationText.questions(questions)
        case .approval: NotificationText.approval
        case .runFailed: NotificationText.failed
        case .stalled: NotificationText.stalled
        case .budget: NotificationText.budget
        case .dailyBudget: NotificationText.dailyBudget
        case .vigieSilent: NotificationText.vigieSilent
        case .backupFailed: NotificationText.backupFailed
        case .atlassianComment: NotificationText.atlassianComment
        case .plan: NotificationText.plan
        }
    }

    /// Le corps : le dépôt et le titre de la feature (`runTitle` : celui que l'app connaît).
    public func body(runTitle: String?) -> String {
        switch alert.kind {
        case .approval: NotificationText.approvalBody
        case .escalation where stake != nil:
            (stake ?? "") + (questions > 1 ? " · " + NotificationText.otherQuestions(questions - 1) : "")
        case .dailyBudget: NotificationText.dailyBudgetBody
        case .vigieSilent: NotificationText.vigieSilentBody
        case .backupFailed: NotificationText.backupFailedBody
        case .atlassianComment: NotificationText.atlassianCommentBody
        case .plan: NotificationText.planBody
        case .verdict:
            NotificationText.runLine(repo: repo ?? "", title: runTitle ?? alert.runId ?? "")
                + (proofs.map { " · " + NotificationText.proofs($0) } ?? "")
        default: NotificationText.runLine(repo: repo ?? "", title: runTitle ?? alert.runId ?? "")
        }
    }

    /// Le regroupement des notifications, comme le `thread-id` du serveur.
    public var thread: String {
        switch alert.kind {
        case .approval: "workstation"
        case .atlassianComment, .plan: "atlassian"
        case .dailyBudget, .vigieSilent, .backupFailed: "server"
        default: alert.runId ?? "server"
        }
    }
}

public enum HarnessNotificationRouting {
    /// Les actions d'une catégorie ; `approver` : ce jeton approuve les envois du poste.
    public static func actions(for category: HarnessNotificationCategory, approver: Bool) -> [HarnessNotificationActionSpec] {
        let open = HarnessNotificationActionSpec(
            action: .open, title: HarnessNotificationAction.open.title, textInput: false, authenticationRequired: false, foreground: true, destructive: false
        )
        switch category {
        case .validate:
            return [
                HarnessNotificationActionSpec(
                    action: .validate, title: HarnessNotificationAction.validate.title, textInput: false,
                    authenticationRequired: true, foreground: false, destructive: false
                ),
                HarnessNotificationActionSpec(
                    action: .refuse, title: HarnessNotificationAction.refuse.title, textInput: true,
                    authenticationRequired: true, foreground: false, destructive: true, placeholder: NotificationText.refusePlaceholder
                ),
                open,
            ]
        case .approve:
            // Sans le jeton approbateur, le serveur refuserait (403) : les actions ouvrent l'app.
            return [
                HarnessNotificationActionSpec(
                    action: .approve, title: HarnessNotificationAction.approve.title, textInput: false,
                    authenticationRequired: approver, foreground: !approver, destructive: false
                ),
                HarnessNotificationActionSpec(
                    action: .refuseSend, title: HarnessNotificationAction.refuseSend.title, textInput: false,
                    authenticationRequired: approver, foreground: !approver, destructive: true
                ),
                open,
            ]
        case .answer:
            return [
                HarnessNotificationActionSpec(
                    action: .takeRecommended, title: HarnessNotificationAction.takeRecommended.title, textInput: false,
                    authenticationRequired: true, foreground: false, destructive: false
                ),
                HarnessNotificationActionSpec(
                    action: .answer, title: HarnessNotificationAction.answer.title, textInput: true,
                    authenticationRequired: true, foreground: false, destructive: false, placeholder: PipelineServerText.answerPlaceholder
                ),
                open,
            ]
        case .open:
            return [open]
        }
    }

    /// Le geste d'une action sur une notification. `action` absent : un toucher sur la
    /// notification. `text` : la saisie d'une action à texte. Une action que la
    /// notification ne permet pas (catégorie, charge incomplète, jeton non approbateur,
    /// refus sans raison, réponse vide) ouvre l'app là où le geste se fait.
    public static func gesture(
        category: String, action: HarnessNotificationAction?, alert: HarnessPushAlert?, text: String?, approver: Bool
    ) -> HarnessNotificationGesture {
        let destination = alert?.destination ?? .section(.inbox)
        guard let action, let alert else { return .open(destination) }
        let reason = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let validates = category == HarnessNotificationCategory.validate.rawValue && (alert.kind == .specs || alert.kind == .verdict)
        let approves = category == HarnessNotificationCategory.approve.rawValue && alert.kind == .approval && approver
        let answers = category == HarnessNotificationCategory.answer.rawValue && alert.kind == .escalation
        switch action {
        case .validate:
            guard validates, let runId = alert.runId else { return .open(destination) }
            return .validate(runId: runId, rev: alert.rev)
        case .refuse:
            guard validates, let runId = alert.runId, !reason.isEmpty else { return .open(destination) }
            return .refuse(runId: runId, rev: alert.rev, reason: reason)
        case .approve:
            guard approves, let seq = alert.seq else { return .open(destination) }
            return .approveSend(seq: seq, revision: alert.rev)
        case .refuseSend:
            guard approves, let seq = alert.seq else { return .open(destination) }
            return .refuseSend(seq: seq, revision: alert.rev)
        case .takeRecommended:
            guard answers, let runId = alert.runId, let question = alert.question, !question.recommended.isEmpty else { return .open(destination) }
            return .answer(runId: runId, rev: alert.rev, question: question.id, answer: question.recommended)
        case .answer:
            guard answers, let runId = alert.runId, let question = alert.question, !reason.isEmpty else { return .open(destination) }
            return .answer(runId: runId, rev: alert.rev, question: question.id, answer: reason)
        case .open:
            return .open(destination)
        }
    }

    /// L'alerte locale d'un événement du flux (Mac), selon les droits du client ; `nil`
    /// si l'événement n'attend personne. Les mêmes sortes et catégories que le serveur.
    public static func localAlert(for event: HarnessStreamEvent, client: HarnessClient?) -> HarnessLocalAlert? {
        guard let row = try? JSONDecoder().decode(StreamRow.self, from: event.data), let id = row.id else { return nil }
        let canAct = client?.canAct ?? true
        let approver = client?.approver ?? false
        var questions = 0
        var card: (headline: String, stake: String)?
        let kind: HarnessPushKind
        switch event.name {
        case "specs_ready": kind = .specs
        case "verdict": kind = .verdict
        case "escalations":
            questions = row.payload?.items?.count ?? 0
            guard questions > 0 else { return nil }
            if let first = row.payload?.items?.first,
               let headline = HarnessQuestion.shown(first.question), let stake = HarnessQuestion.shown(first.stake) {
                card = (headline, stake)
            }
            kind = .escalation
        case "workstation_approval":
            guard approver, row.payload?.seq != nil else { return nil }
            kind = .approval
        case "run_failed": kind = .runFailed
        case "stalled": kind = .stalled
        case "budget_exceeded": kind = .budget
        case "daily_budget_reached": kind = .dailyBudget
        case "vigie_silent": kind = .vigieSilent
        case "backup_failed": kind = .backupFailed
        case "atlassian_write":
            guard approver, row.payload?.state == "proposed", row.payload?.kind == "comment" else { return nil }
            kind = .atlassianComment
        case "atlassian_plan": kind = .plan
        default: return nil
        }
        let category: HarnessNotificationCategory = switch kind {
        case .specs, .verdict: canAct ? .validate : .open
        case .approval: .approve
        default: .open
        }
        let runScoped: Set<HarnessPushKind> = [.specs, .verdict, .escalation, .runFailed, .stalled, .budget]
        if runScoped.contains(kind), row.runId == nil { return nil }
        return HarnessLocalAlert(
            alert: HarnessPushAlert(kind: kind, runId: row.runId, seq: kind == .approval ? row.payload?.seq : nil),
            category: category,
            eventId: id,
            repo: row.repo,
            questions: questions,
            proofs: kind == .verdict ? row.payload?.proofs : nil,
            headline: card?.headline,
            stake: card?.stake
        )
    }
}

extension HarnessNotificationAction {
    /// Le libellé du bouton, pris au vocabulaire partagé. `takeRecommended` emprunte
    /// « Accepter les recommandations » de la boîte : le seul point à changer le jour où la
    /// couche des textes lui donne un libellé propre.
    public var title: String {
        switch self {
        case .validate: NotificationText.validate
        case .refuse, .refuseSend: NotificationText.refuse
        case .approve: NotificationText.approve
        case .takeRecommended: PipelineServerText.acceptRecommended
        case .answer: PipelineServerText.answer
        case .open: NotificationText.open
        }
    }
}

/// Un événement du flux tel que le serveur l'écrit (`data:` d'une trame SSE).
private struct StreamRow: Decodable {
    struct Payload: Decodable {
        /// Une question du lot (événement `escalations`) : sa `headline` et le `stake` de sa carte.
        struct Item: Decodable {
            var question: String?
            var stake: String?
        }
        var seq: Int?
        var items: [Item]?
        /// Les preuves du tour de revue courant (événement `verdict`).
        var proofs: Int?
        /// L'état et la sorte d'une écriture Atlassian (événement `atlassian_write`).
        var state: String?
        var kind: String?
    }

    var id: Int?
    var runId: String?
    var repo: String?
    var payload: Payload?
}

/// La passerelle d'Apple qui sert l'appareil : `sandbox` pour une app signée d'un profil
/// de développement (installée depuis Xcode), `production` pour un profil ad hoc,
/// TestFlight et l'App Store.
public enum HarnessPushEnvironment: String, Sendable {
    case sandbox, production

    /// Le nom de la passerelle pour le push-to-start des Live Activities
    /// (`POST /v1/push/activities/start`) : `development` ou `production`.
    public var apnsName: String { self == .sandbox ? "development" : "production" }

    /// La passerelle de l'app qui tourne : celle de son profil embarqué
    /// (`embedded.mobileprovision`, absent d'une app de l'App Store).
    public static var current: HarnessPushEnvironment {
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
            .map { String(decoding: $0, as: UTF8.self) }
        return HarnessPushEnvironment(provisioningProfile: profile)
    }

    /// La passerelle qu'accorde le profil de provisionnement embarqué de l'app (son texte,
    /// plist signé) : `aps-environment` `development` → `sandbox` ; `production`, ou aucun
    /// profil (App Store), → `production`.
    public init(provisioningProfile: String?) {
        guard let profile = provisioningProfile,
              let key = profile.range(of: "<key>aps-environment</key>"),
              let open = profile.range(of: "<string>", range: key.upperBound..<profile.endIndex),
              let close = profile.range(of: "</string>", range: open.upperBound..<profile.endIndex)
        else {
            self = .production
            return
        }
        self = profile[open.upperBound..<close.lowerBound] == "development" ? .sandbox : .production
    }
}

/// Le jeton APNs de l'appareil et sa passerelle.
struct HarnessPushDevice: Equatable, Sendable {
    var token: String
    var environment: HarnessPushEnvironment
}

extension HarnessModel {
    /// Le geste d'une action de notification que l'humain a touchée (appareil
    /// déverrouillé pour les gestes d'écriture), avec la révision que portait la
    /// notification : un run ou un envoi qui a bougé depuis fait refuser le geste.
    /// `.open` n'est pas un geste : rien ne part.
    @discardableResult
    public func execute(_ gesture: HarnessNotificationGesture) async -> Bool {
        switch gesture {
        case let .validate(runId, rev):
            await validate(runId: runId, approve: true, reason: "", rev: rev)
        case let .refuse(runId, rev, reason):
            await validate(runId: runId, approve: false, reason: reason, rev: rev)
        case let .approveSend(seq, revision):
            await workstation.decideFromNotification(seq: seq, revision: revision, approve: true)
        case let .refuseSend(seq, revision):
            await workstation.decideFromNotification(seq: seq, revision: revision, approve: false)
        case let .answer(runId, rev, question, answer):
            await self.answer(runId: runId, answers: [question: answer], rev: rev)
        case .open:
            false
        }
    }
}
