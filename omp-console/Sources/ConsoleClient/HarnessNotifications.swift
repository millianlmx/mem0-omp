// Les NOTIFICATIONS actionnables des deux apps, sans dépendre du système : ce qu'une
// notification porte (`omp` : sorte, run, révision, envoi), les gestes que chaque
// catégorie offre, et le routage d'une action vers un geste du client ou une
// destination dans l'app. Le pont vers `UserNotifications` (HarnessNotificationCenter)
// ne fait que traduire.
//
// Le contrat vient du serveur (omp-harness/push-alerts.ts) : catégories `omp.validate`
// (specs, verdict : Valider / Refuser), `omp.approve` (envoi du poste : Approuver /
// Refuser), `omp.reply` (réponse « prête » de la veille du poste : Valider, qui confie
// le texte proposé tel quel à l'envoi — `POST /v1/workstation/watch/{watchId}/validate`
// sans corps ni If-Match), `omp.open` ; `rev` est l'If-Match du geste.
// Valider, refuser ou approuver écrivent : l'appareil doit être déverrouillé
// (`authenticationRequired`). Approuver ou refuser un envoi, valider une réponse, exige le
// jeton APPROBATEUR déjà au trousseau ; sans lui, ces actions ouvrent l'app (le Poste, ou
// « À traiter ») au lieu d'agir. Une réponse que le serveur refuse de valider ouvre
// « À traiter ». Un refus de specs ou de verdict porte sa raison (le serveur l'exige) : sans
// texte saisi, l'action ouvre l'app.

import ConsoleCore
import Foundation

/// Les catégories de notification (`ALERT_CATEGORIES` d'omp-harness/push-alerts.ts).
public enum HarnessNotificationCategory: String, CaseIterable, Sendable {
    case validate = "omp.validate"
    case approve = "omp.approve"
    case reply = "omp.reply"
    case open = "omp.open"
}

/// Les actions qu'une notification offre.
public enum HarnessNotificationAction: String, CaseIterable, Sendable {
    case validate = "omp.action.validate"
    case refuse = "omp.action.refuse"
    case approve = "omp.action.approve"
    case refuseSend = "omp.action.refuseSend"
    /// Valider une réponse « prête » de la veille, texte proposé tel quel.
    case validateReply = "omp.action.validateReply"
    case open = "omp.action.open"
}

/// Une action telle que le système la déclare.
public struct HarnessNotificationActionSpec: Equatable, Sendable {
    public var action: HarnessNotificationAction
    public var title: String
    /// L'action demande un texte (la raison d'un refus).
    public var textInput: Bool
    /// L'appareil est déverrouillé avant d'agir : un geste d'écriture.
    public var authenticationRequired: Bool
    /// L'action ouvre l'app au lieu d'agir en arrière-plan.
    public var foreground: Bool
    public var destructive: Bool
}

/// La sorte d'une alerte (`omp.kind`, `AlertKind` du serveur).
public enum HarnessPushKind: String, CaseIterable, Sendable {
    case specs, verdict, escalation, approval
    case runFailed = "run_failed"
    case stalled, budget
    case dailyBudget = "daily_budget"
    case vigieSilent = "vigie_silent"
    case backupFailed = "backup_failed"
    /// Un élément de la veille proactive du poste dans « À traiter ».
    case watch
}

/// Ce qu'une notification porte : des identifiants, jamais de contenu.
public struct HarnessPushAlert: Equatable, Sendable {
    public var kind: HarnessPushKind
    public var runId: String?
    /// L'If-Match du geste : la révision du run, ou l'`updatedAt` de l'envoi du poste.
    public var rev: Int?
    /// Le numéro de l'action du poste.
    public var seq: Int?
    /// L'élément de la veille du poste (`omp.watchId`).
    public var watchId: String?

    public init(kind: HarnessPushKind, runId: String? = nil, rev: Int? = nil, seq: Int? = nil, watchId: String? = nil) {
        self.kind = kind
        self.runId = runId
        self.rev = rev
        self.seq = seq
        self.watchId = watchId
    }

    /// La charge `omp` d'une notification (APNs ou locale) ; `nil` si elle n'en porte pas.
    public init?(userInfo: [AnyHashable: Any]) {
        guard let omp = userInfo["omp"] as? [String: Any], let raw = omp["kind"] as? String,
              let kind = HarnessPushKind(rawValue: raw)
        else { return nil }
        self.init(
            kind: kind,
            runId: omp["runId"] as? String,
            rev: (omp["rev"] as? NSNumber)?.intValue,
            seq: (omp["seq"] as? NSNumber)?.intValue,
            watchId: omp["watchId"] as? String
        )
    }

    /// La charge d'une notification locale : la même forme que celle du serveur.
    public var userInfo: [String: Any] {
        var omp: [String: Any] = ["kind": kind.rawValue]
        if let runId { omp["runId"] = runId }
        if let rev { omp["rev"] = rev }
        if let seq { omp["seq"] = seq }
        if let watchId { omp["watchId"] = watchId }
        return ["omp": omp]
    }

    /// Où mène un toucher : ce qui attend dans « À traiter », le Poste, la page de la
    /// feature, ou la Vigie (Système) pour ce qui touche le serveur lui-même.
    public var destination: HarnessPaletteCommand {
        switch kind {
        case .specs: .inbox(.specs)
        case .verdict: .inbox(.verdicts)
        case .escalation: .inbox(.toDecide)
        case .approval: .section(.workstation)
        case .runFailed, .stalled, .budget: runId.map(HarnessPaletteCommand.run) ?? .section(.inbox)
        case .dailyBudget, .watch: .section(.inbox)
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
    /// Valider la réponse proposée de la veille, texte tel quel (jeton approbateur).
    case validateReply(watchId: String)
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
    /// La sorte d'un élément de la veille (`reply`, `followup`, `prep`, `brief`) et s'il est prêt.
    public var watchKind: String? = nil
    public var watchReady: Bool = false

    /// Le titre, les mêmes mots que l'alerte push du serveur.
    public var title: String {
        switch alert.kind {
        case .specs: NotificationText.specs
        case .verdict: NotificationText.verdict
        case .escalation: NotificationText.questions(questions)
        case .approval: NotificationText.approval
        case .runFailed: NotificationText.failed
        case .stalled: NotificationText.stalled
        case .budget: NotificationText.budget
        case .dailyBudget: NotificationText.dailyBudget
        case .vigieSilent: NotificationText.vigieSilent
        case .backupFailed: NotificationText.backupFailed
        case .watch: NotificationText.watchTitle(kind: watchKind ?? "", ready: watchReady)
        }
    }

    /// Le corps : le dépôt et le titre de la feature (`runTitle` : celui que l'app connaît).
    public func body(runTitle: String?) -> String {
        switch alert.kind {
        case .approval: NotificationText.approvalBody
        case .dailyBudget: NotificationText.dailyBudgetBody
        case .vigieSilent: NotificationText.vigieSilentBody
        case .backupFailed: NotificationText.backupFailedBody
        case .watch: watchKind == "reply" || watchKind == "followup" ? NotificationText.watchSendBody : NotificationText.watchBody
        case .verdict:
            NotificationText.runLine(repo: repo ?? "", title: runTitle ?? alert.runId ?? "")
                + (proofs.map { " · " + NotificationText.proofs($0) } ?? "")
        default: NotificationText.runLine(repo: repo ?? "", title: runTitle ?? alert.runId ?? "")
        }
    }

    /// Le regroupement des notifications, comme le `thread-id` du serveur.
    public var thread: String {
        switch alert.kind {
        case .approval, .watch: "workstation"
        case .dailyBudget, .vigieSilent, .backupFailed: "server"
        default: alert.runId ?? "server"
        }
    }
}

public enum HarnessNotificationRouting {
    /// Les actions d'une catégorie ; `approver` : ce jeton approuve les envois du poste.
    public static func actions(for category: HarnessNotificationCategory, approver: Bool) -> [HarnessNotificationActionSpec] {
        let open = HarnessNotificationActionSpec(
            action: .open, title: NotificationText.open, textInput: false, authenticationRequired: false, foreground: true, destructive: false
        )
        switch category {
        case .validate:
            return [
                HarnessNotificationActionSpec(
                    action: .validate, title: NotificationText.validate, textInput: false,
                    authenticationRequired: true, foreground: false, destructive: false
                ),
                HarnessNotificationActionSpec(
                    action: .refuse, title: NotificationText.refuse, textInput: true,
                    authenticationRequired: true, foreground: false, destructive: true
                ),
                open,
            ]
        case .approve:
            // Sans le jeton approbateur, le serveur refuserait (403) : les actions ouvrent l'app.
            return [
                HarnessNotificationActionSpec(
                    action: .approve, title: NotificationText.approve, textInput: false,
                    authenticationRequired: approver, foreground: !approver, destructive: false
                ),
                HarnessNotificationActionSpec(
                    action: .refuseSend, title: NotificationText.refuse, textInput: false,
                    authenticationRequired: approver, foreground: !approver, destructive: true
                ),
                open,
            ]
        case .reply:
            // Le geste valider de la veille : l'approbateur valide sans ouvrir l'app ; sans
            // son jeton, le serveur refuserait (403) : l'action ouvre « À traiter ».
            return [
                HarnessNotificationActionSpec(
                    action: .validateReply, title: NotificationText.validate, textInput: false,
                    authenticationRequired: approver, foreground: !approver, destructive: false
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
    /// refus sans raison) ouvre l'app là où le geste se fait.
    public static func gesture(
        category: String, action: HarnessNotificationAction?, alert: HarnessPushAlert?, text: String?, approver: Bool
    ) -> HarnessNotificationGesture {
        let destination = alert?.destination ?? .section(.inbox)
        guard let action, let alert else { return .open(destination) }
        let reason = text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let validates = category == HarnessNotificationCategory.validate.rawValue && (alert.kind == .specs || alert.kind == .verdict)
        let approves = category == HarnessNotificationCategory.approve.rawValue && alert.kind == .approval && approver
        let replies = category == HarnessNotificationCategory.reply.rawValue && alert.kind == .watch && approver
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
        case .validateReply:
            guard replies, let watchId = alert.watchId else { return .open(destination) }
            return .validateReply(watchId: watchId)
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
        let kind: HarnessPushKind
        switch event.name {
        case "specs_ready": kind = .specs
        case "verdict": kind = .verdict
        case "escalations":
            questions = row.payload?.items?.count ?? 0
            guard questions > 0 else { return nil }
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
        case "workstation_watch":
            guard approver, let watch = try? JSONDecoder().decode(WatchRow.self, from: event.data).payload,
                  watch.state == "open"
            else { return nil }
            return HarnessLocalAlert(
                alert: HarnessPushAlert(kind: .watch, watchId: watch.id),
                category: watch.kind == "reply" && watch.ready == true ? .reply : .open,
                eventId: id,
                repo: nil,
                questions: 0,
                watchKind: watch.kind,
                watchReady: watch.ready == true
            )
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
            proofs: kind == .verdict ? row.payload?.proofs : nil
        )
    }
}

/// Un événement du flux tel que le serveur l'écrit (`data:` d'une trame SSE).
private struct StreamRow: Decodable {
    struct Payload: Decodable {
        struct Item: Decodable {}
        var seq: Int?
        var items: [Item]?
        /// Les preuves du tour de revue courant (événement `verdict`).
        var proofs: Int?
    }

    var id: Int?
    var runId: String?
    var repo: String?
    var payload: Payload?
}

/// Un événement `workstation_watch` du flux : `{id, kind, state, ready}`, rien d'autre.
private struct WatchRow: Decodable {
    struct Payload: Decodable {
        var id: String?
        var kind: String?
        var state: String?
        var ready: Bool?
    }

    var payload: Payload
}

/// La passerelle d'Apple qui sert l'appareil : `sandbox` pour une app signée d'un profil
/// de développement (installée depuis Xcode), `production` pour un profil ad hoc,
/// TestFlight et l'App Store.
public enum HarnessPushEnvironment: String, Sendable {
    case sandbox, production

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
        case let .validateReply(watchId):
            await watch.validateFromNotification(watchId: watchId)
        case .open:
            false
        }
    }
}
