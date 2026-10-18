// La liste des attentes (attentes-dispersees-entre-sources, S-3 à S-6) : toutes
// les demandes qui posent une question à l'utilisateur, toutes sources confondues
// — questions et jalons de l'ardoise, dialogues de la conduite de projet et de la
// session hébergée, escalades d'audit —, de la plus ancienne à la plus récente.
//
// Dérivation PURE au patron de `HomePresentation.dashboard` et `AuditBoard.of` :
// aucune E/S, aucune horloge, aucun accès au système de fichiers. La coque macOS
// et l'app iOS la calculent à partir des MÊMES données transportées, donc
// produisent la même liste : mêmes identités, même ordre.
//
// Le geste de réponse est une DONNÉE (`PendingReply`) : rien n'est exécuté ici.
// Aucun mot neuf : les seuls libellés repris sont ceux de `HomeText`.
//
// VIT DANS `ConsoleCore`.

import Foundation

/// La nature d'une attente.
public enum PendingNature: String, Sendable, Equatable {
    /// Une question en vol (`ask`) ou une question en texte d'une carte.
    case question
    case milestoneSpecs
    case milestoneReview
    case conduiteDialog
    case sessionDialog
    case auditEscalation
}

/// Le geste de réponse d'une attente, sous forme de données : la route que la
/// coque appellera, avec ses paramètres.
public enum PendingReply: Sendable, Equatable {
    /// `POST /v1/cards/{id}/answer`.
    case cardAnswer(cardId: String, toolCallId: String)
    /// `POST /v1/cards/{id}/reply`.
    case cardReply(cardId: String)
    /// `POST /v1/cards/{id}/verdict` ; `milestone` vaut `.specs` ou `.review`,
    /// jamais `.answer`.
    case cardVerdict(cardId: String, milestone: LotWaitKind)
    /// `POST /v1/cards/{id}/resume` : le pilote est arrêté, la question attend
    /// d'abord d'être reprise.
    case resume(cardId: String)
    /// `POST /v1/conduite/dialogs/{id}`.
    case conduiteDialog(dialogId: String, method: RpcDialogMethod)
    /// `POST /v1/session/dialogs/{id}`.
    case sessionDialog(dialogId: String, method: RpcDialogMethod)
    /// `POST /v1/audits/{id}/escalations`.
    case auditEscalation(auditId: String, slug: String, key: String, kind: AuditEscalationKind)

    /// Le geste répond directement à la question ; seule la reprise ne le fait pas.
    public var isDirectAnswer: Bool {
        if case .resume = self { return false }
        return true
    }
}

/// Une attente : une demande qui pose une question à l'utilisateur.
public struct PendingRequest: Identifiable, Sendable, Equatable {
    /// L'identité stable, unique par question (S-5).
    public var id: String
    public var nature: PendingNature
    /// L'ancienneté, en ms epoch (S-6).
    public var at: Double
    /// Le titre de la carte, le slug d'une escalade d'audit, `nil` pour un dialogue.
    public var subject: String?
    public var question: String
    /// Le message d'un dialogue, `nil` ailleurs.
    public var detail: String?
    public var options: [PanelAskOption]
    /// Le pilote est arrêté (carte « En pause ») : le geste est alors la reprise.
    public var paused: Bool
    public var reply: PendingReply

    public init(
        id: String,
        nature: PendingNature,
        at: Double,
        subject: String?,
        question: String,
        detail: String?,
        options: [PanelAskOption],
        paused: Bool,
        reply: PendingReply
    ) {
        self.id = id
        self.nature = nature
        self.at = at
        self.subject = subject
        self.question = question
        self.detail = detail
        self.options = options
        self.paused = paused
        self.reply = reply
    }
}

/// Les données dont la liste est calculée.
///
/// Invariant : `board` est dérivé de CE `snapshot` (`KanbanBoardState.derive`).
public struct PendingSources: Sendable, Equatable {
    public var snapshot: StoreSnapshot
    public var board: KanbanBoardState
    public var conduiteDialogs: [RpcDialogRequest]
    public var sessionDialogs: [RpcDialogRequest]

    public init(
        snapshot: StoreSnapshot,
        board: KanbanBoardState,
        conduiteDialogs: [RpcDialogRequest],
        sessionDialogs: [RpcDialogRequest]
    ) {
        self.snapshot = snapshot
        self.board = board
        self.conduiteDialogs = conduiteDialogs
        self.sessionDialogs = sessionDialogs
    }
}

public enum PendingRequests {
    /// La liste des attentes : les quatre familles concaténées, puis triées par
    /// ancienneté croissante, à ancienneté égale par identité (octets UTF-8). Vide,
    /// jamais `nil`, quand aucune source n'a de demande. Aucune déduplication.
    public static func list(_ sources: PendingSources) -> [PendingRequest] {
        var pending = cardRequests(snapshot: sources.snapshot, board: sources.board)
        pending += dialogRequests(sources.conduiteDialogs, nature: .conduiteDialog, prefix: "conduite") {
            .conduiteDialog(dialogId: $0.id, method: $0.method)
        }
        pending += dialogRequests(sources.sessionDialogs, nature: .sessionDialog, prefix: "session") {
            .sessionDialog(dialogId: $0.id, method: $0.method)
        }
        pending += auditRequests(snapshot: sources.snapshot)
        return pending.sorted { a, b in
            if a.at != b.at { return a.at < b.at }
            return a.id.utf8.lexicographicallyPrecedes(b.id.utf8)
        }
    }

    // MARK: - (1) Cartes de l'ardoise

    /// Les questions et jalons de l'ardoise ; échecs et blocages n'en sont pas.
    private static func cardRequests(snapshot: StoreSnapshot, board: KanbanBoardState) -> [PendingRequest] {
        guard case .board(let board) = board else { return [] }
        let auditKeys = Set(snapshot.audits.records.map(\.key))
        return board.cards.compactMap { card in
            guard let kind = waitingKind(card.column) else { return nil }
            // L'arbitre tient l'élément (`ArbiterState`, la règle de l'ardoise) :
            // rien n'est demandé à l'utilisateur.
            if card.action?.arbiter.isArbitrating == true { return nil }
            let feature = associatedFeature(of: card, in: snapshot)
            if let feature, isExcluded(feature, auditKeys: auditKeys) { return nil }
            let paused = KanbanActionPresentation.resumable(card)
            let featureAt = feature?.sinceAt ?? card.startMs
            let request: (id: String, nature: PendingNature, at: Double, question: String, options: [PanelAskOption], reply: PendingReply)
            switch kind {
            case .answer:
                if let ask = card.action?.run?.pendingAsk {
                    let runId = card.action?.run?.id
                    let at = snapshot.running.entries.first { $0.id == runId }?.updatedAt ?? card.startMs
                    request = (
                        "ask:\(card.id):\(ask.toolCallId)", .question, at, ask.question, ask.options,
                        .cardAnswer(cardId: card.id, toolCallId: ask.toolCallId)
                    )
                } else {
                    request = (
                        "reply:\(card.id):\(ms(featureAt))", .question, featureAt,
                        card.action?.waitPrompt ?? HomeText.questionWithoutText, [],
                        .cardReply(cardId: card.id)
                    )
                }
            case .specs:
                request = (
                    "specs:\(card.id):\(ms(featureAt))", .milestoneSpecs, featureAt, HomeText.specsPrompt, [],
                    .cardVerdict(cardId: card.id, milestone: .specs)
                )
            case .review:
                request = (
                    "review:\(card.id):\(ms(featureAt))", .milestoneReview, featureAt, HomeText.reviewPrompt, [],
                    .cardVerdict(cardId: card.id, milestone: .review)
                )
            }
            return PendingRequest(
                id: request.id,
                nature: request.nature,
                at: request.at,
                subject: card.title,
                question: request.question,
                detail: nil,
                options: request.options,
                paused: paused,
                reply: paused ? .resume(cardId: card.id) : request.reply
            )
        }
    }

    /// L'attente que porte une colonne : la question en vol (ou en texte), le
    /// jalon specs, le jalon revue ; aucune pour les autres colonnes, notamment
    /// `.echec` et `.bloquee`, même relançables.
    private static func waitingKind(_ column: KanbanColumn) -> LotWaitKind? {
        switch column {
        case .questionEnVol: return .answer
        case .jalonSpecs: return .specs
        case .jalonReview: return .review
        case .enAttente, .enCours, .prOuverte, .prCreee, .fusionne, .prFermee,
             .echec, .bloquee, .termineeSansPr, .annuleeRetiree:
            return nil
        }
    }

    /// La feature de lot de la carte : même `repoRoot` de lot, même slug. Absente
    /// pour une carte `run:`.
    private static func associatedFeature(of card: KanbanCard, in snapshot: StoreSnapshot) -> LotFeature? {
        guard let repoRoot = card.action?.repoRoot, let slug = card.action?.slug else { return nil }
        for lot in snapshot.lots.lots where lot.repoRoot == repoRoot {
            if let feature = lot.features.first(where: { $0.slug == slug }) { return feature }
        }
        return nil
    }

    /// La question figure déjà comme escalade d'audit — une question, une
    /// attente. (L'arbitrage en vol est écarté plus haut, par la carte.)
    private static func isExcluded(_ feature: LotFeature, auditKeys: Set<String>) -> Bool {
        if let escalation = feature.escalation, AuditEscalationKind(key: escalation.key) != nil,
           let session = feature.auditSession, auditKeys.contains(session) {
            return true
        }
        return false
    }

    // MARK: - (2) et (3) Dialogues de conduite et de session

    private static func dialogRequests(
        _ dialogs: [RpcDialogRequest],
        nature: PendingNature,
        prefix: String,
        reply: (RpcDialogRequest) -> PendingReply
    ) -> [PendingRequest] {
        dialogs.map { dialog in
            // Un service antérieur, sans horodatage, range ses dialogues en tête.
            let at = dialog.at ?? 0
            let options = dialog.options.enumerated().map { index, label in
                PanelAskOption(
                    label: label,
                    description: dialog.optionDescriptions.indices.contains(index) ? dialog.optionDescriptions[index] : nil
                )
            }
            return PendingRequest(
                id: "\(prefix):\(dialog.id):\(ms(at))",
                nature: nature,
                at: at,
                subject: nil,
                question: dialog.title,
                detail: dialog.message,
                options: options,
                paused: false,
                reply: reply(dialog)
            )
        }
    }

    // MARK: - (4) Escalades d'audit

    private static func auditRequests(snapshot: StoreSnapshot) -> [PendingRequest] {
        AuditBoard.of(snapshot).audits.flatMap { card in
            card.escalations.map { row in
                PendingRequest(
                    id: "audit:\(card.id):\(row.key)",
                    nature: .auditEscalation,
                    at: row.at,
                    subject: row.slug,
                    question: row.question,
                    detail: nil,
                    options: row.options.map { PanelAskOption(label: $0, description: nil) },
                    paused: false,
                    reply: .auditEscalation(auditId: card.id, slug: row.slug, key: row.key, kind: row.kind)
                )
            }
        }
    }

    /// Un instant en ms, rendu entier : jamais de plantage sur une valeur non
    /// finie ou hors bornes, contrairement à `Int64(_:)`.
    private static func ms(_ value: Double) -> String {
        String(format: "%.0f", value)
    }
}
