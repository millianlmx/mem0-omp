// Le modèle de l'écran Audit de l'app iOS (audit-panel-in-omp-console, S-8, BR-5) :
// il dérive l'ardoise PARTAGÉE `AuditBoard.of(_:)` (ConsoleCore, la même que le Mac)
// de l'instantané que la coque pousse par la trame `store`, garde en mémoire les
// cases cochées par audit, et porte les gestes vers le Mac par les quatre routes
// d'audit de `ConsoleClientModel` (S-7). Aucune lecture n'a de route : une escalade
// répondue sur le Mac disparaît de l'iPhone à la trame `store` suivante (AC-6).
//
// Les cases cochées ne partent JAMAIS seules : seule « Valider et lancer » poste la
// sélection, avec le brief relu (AC-3). Fermer la feuille du brief n'envoie rien.
//
// Patron `IOSProjectModel` : décisions pures testables sans rendu, statut de
// connexion présenté, gestes coupés hors connexion, erreur conservée montrée
// seulement à `.connected`.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// La surface de l'écran, décidée par le statut de connexion présenté et la
/// présence d'un instantané reçu.
enum AuditSurface: Equatable {
    /// Mac non connecté et aucun instantané reçu : le composant d'état de
    /// connexion partagé, seul, à la place de l'écran.
    case unavailable(IOSConnectionStatus)
    /// La liste (vide ou non), sous le bandeau de connexion hors ligne.
    case content
}

/// Le geste en vol : son bouton est remplacé par un `ProgressView`, et aucun autre
/// geste ne part tant qu'il n'a pas répondu (pas de double envoi).
enum AuditGesture: Hashable {
    case start
    case launch(auditId: String)
    case answer(key: String)
    case stop(auditId: String)
}

@MainActor
final class IOSAuditModel: ObservableObject {
    let client: ConsoleClientModel
    /// La recette `-audit.recipe` : elle remplace l'instantané du Mac par
    /// `AuditParity` et tient lieu de Mac connecté. `nil` hors recette.
    let recipe: IOSAuditRecipe?

    /// L'ardoise dérivée du dernier instantané reçu.
    @Published private(set) var board = AuditBoard(audits: [])
    /// L'audit poussé par programme (recette, audit tout juste créé).
    @Published var opened: String?
    /// Les slugs cochés, par audit — en mémoire seulement.
    @Published private(set) var checked: [String: Set<String>]
    /// L'audit dont la feuille du brief est ouverte (`nil` : feuille fermée).
    @Published var briefAudit: String?
    @Published var briefText = ""
    /// La rubrique manquante ou l'échec du lancement, montré DANS la feuille.
    @Published private(set) var briefError: String?
    /// La saisie « Autre réponse », par clé d'escalade.
    @Published private(set) var drafts: [String: String] = [:]
    /// L'audit dont l'arrêt attend confirmation (`nil` : aucune confirmation).
    @Published var pendingStop: String?
    @Published private(set) var inFlight: AuditGesture?
    /// L'échec du dernier geste du détail (réponse, arrêt), en bandeau.
    @Published private(set) var banner: String?

    /// L'audit dont `briefText` est le brouillon : rouvrir la feuille du même audit
    /// garde les corrections.
    private var briefDraftAudit: String?
    private var subscriptions: Set<AnyCancellable> = []

    init(client: ConsoleClientModel, recipe: IOSAuditRecipe? = nil) {
        self.client = client
        self.recipe = recipe
        opened = recipe?.openedAudit
        checked = recipe?.checked ?? [:]
        if let recipe {
            board = recipe.board
        } else {
            board = client.snapshot.map(AuditBoard.of) ?? AuditBoard(audits: [])
            client.$snapshot
                .dropFirst()
                .sink { [weak self] snapshot in
                    self?.board = snapshot.map(AuditBoard.of) ?? AuditBoard(audits: [])
                }
                .store(in: &subscriptions)
        }
        // Le statut de connexion est lu sur le client : l'écran se redessine avec lui.
        client.objectWillChange
            .sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &subscriptions)
    }

    // MARK: - Décisions PURES (testables sans rendu)

    /// La surface pour un statut de connexion et la présence d'un instantané (S-8) :
    /// un instantané reçu reste affiché hors connexion, sous le bandeau.
    static func surface(connection: IOSConnectionStatus, hasSnapshot: Bool) -> AuditSurface {
        connection != .connected && !hasSnapshot ? .unavailable(connection) : .content
    }

    /// La plus longue orientation acceptée, rognée (S-6, même borne que le Mac et le service).
    static let orientationLimit = 2000

    /// L'orientation est acceptée rognée, de 1 à 2 000 caractères (S-6).
    static func orientationIsValid(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !trimmed.isEmpty && trimmed.count <= orientationLimit
    }

    /// La garde de « Lancer l'audit », que la touche Retour atteint aussi.
    static func mayStart(gesturesEnabled: Bool, repoKey: String?, orientation: String, submitting: Bool) -> Bool {
        gesturesEnabled && repoKey != nil && !submitting && orientationIsValid(orientation)
    }

    /// Une erreur conservée n'est montrée qu'à `.connected` : hors connexion, le
    /// bandeau de connexion est le seul bandeau d'état.
    static func shownFailure(_ failure: String?, connection: IOSConnectionStatus) -> String? {
        connection == .connected ? failure : nil
    }

    /// Le ton de la pastille d'un statut d'audit.
    static func tone(_ status: AuditStatus) -> ConsoleTone {
        switch status {
        case .analysing: .info
        case .proposed: .attention
        case .launched: .success
        case .stopped: .neutral
        case .failed: .danger
        }
    }

    static func isConflict(_ error: Error) -> Bool {
        if case .api(.conflict) = error as? ClientError { return true }
        return false
    }

    // MARK: - Faits dérivés

    /// Le statut présenté : sous la recette, la fixture tient lieu de Mac connecté.
    var connection: IOSConnectionStatus { recipe != nil ? .connected : IOSConnectionStatus.of(client) }
    var surface: AuditSurface {
        Self.surface(connection: connection, hasSnapshot: recipe != nil || client.snapshot != nil)
    }
    /// Les gestes vers le Mac, tels que les vues les présentent : connecté, et
    /// aucun geste en vol. Les gestes du modèle, eux, ne refusent qu'un second
    /// envoi (`isIdle`) : sans Mac connu, le client refuse lui-même
    /// (`ClientError.notConnected`) — patron `IOSProjectModel`.
    var gesturesEnabled: Bool { connection.gesturesEnabled && isIdle }
    /// Aucun geste en vol : pas de double envoi.
    var isIdle: Bool { inFlight == nil }
    var shownBanner: String? { Self.shownFailure(banner, connection: connection) }

    func card(_ id: String) -> AuditCard? { board.card(id: id) }

    func isInFlight(_ gesture: AuditGesture) -> Bool { inFlight == gesture }

    // MARK: - Lancement (feuille)

    /// `POST /v1/audits` : rend `nil` au succès — l'audit créé est poussé — sinon
    /// le message à montrer dans la feuille, qui reste ouverte.
    func start(repoKey: String, orientation: String) async -> String? {
        guard isIdle, Self.orientationIsValid(orientation) else { return AuditText.startFailed }
        inFlight = .start
        defer { inFlight = nil }
        do {
            let created = try await client.startAudit(
                repoKey: repoKey,
                orientation: orientation.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            opened = created.id
            banner = nil
            return nil
        } catch {
            return AuditText.startFailed
        }
    }

    // MARK: - Propositions

    func isChecked(_ slug: String, in auditId: String) -> Bool {
        checked[auditId]?.contains(slug) ?? false
    }

    /// Coche ou décoche ; une proposition `taken`, ou d'un audit qui n'attend plus
    /// de validation, ne se coche pas.
    func toggle(_ slug: String, in auditId: String) {
        guard let card = card(auditId), card.status == .proposed,
              let row = card.proposals.first(where: { $0.slug == slug }), !row.taken else { return }
        var set = checked[auditId] ?? []
        if set.contains(slug) { set.remove(slug) } else { set.insert(slug) }
        checked[auditId] = set
    }

    /// Les slugs cochés et lançables, dans l'ordre de l'analyse.
    func selectedSlugs(of card: AuditCard) -> [String] {
        let set = checked[card.id] ?? []
        return card.proposals.filter { !$0.taken && set.contains($0.slug) }.map(\.slug)
    }

    /// « Relire le brief… » : dès qu'une case est cochée (la vue y ajoute la connexion).
    func canReviewBrief(_ card: AuditCard) -> Bool {
        card.status == .proposed && !selectedSlugs(of: card).isEmpty && isIdle
    }

    // MARK: - Brief (feuille)

    /// Ouvre la feuille sur `briefDraft`, ou sur les corrections en cours du même audit.
    func presentBrief(_ card: AuditCard) {
        guard canReviewBrief(card) else { return }
        if briefDraftAudit != card.id {
            briefText = card.briefDraft ?? ""
            briefDraftAudit = card.id
        }
        briefError = nil
        briefAudit = card.id
    }

    /// Annuler, Échap ou fermeture : la feuille se ferme, RIEN n'est posté (AC-3).
    func cancelBrief() {
        briefAudit = nil
        briefError = nil
    }

    /// « Valider et lancer » : une rubrique manquante est signalée sans envoi ;
    /// sinon la sélection et le brief partent ensemble (AC-8).
    @discardableResult
    func commitBrief() async -> Bool {
        guard let id = briefAudit, let card = card(id), card.status == .proposed, isIdle else { return false }
        if let missing = AuditBrief.missingRubric(briefText) {
            briefError = AuditText.briefIncomplete(rubric: missing)
            return false
        }
        let selected = selectedSlugs(of: card)
        guard !selected.isEmpty else { return false }
        briefError = nil
        inFlight = .launch(auditId: id)
        defer { inFlight = nil }
        do {
            _ = try await client.launchAudit(id: id, selected: selected, brief: briefText)
            briefAudit = nil
            briefDraftAudit = nil
            checked[id] = nil
            banner = nil
            return true
        } catch {
            briefError = Self.isConflict(error) ? AuditText.launchConflict : AuditText.launchFailed
            return false
        }
    }

    // MARK: - Escalades

    func draft(for key: String) -> String { drafts[key] ?? "" }

    func setDraft(_ text: String, for key: String) { drafts[key] = text }

    /// Une option ou « Autre réponse » (sortes `ask`, `question`).
    @discardableResult
    func answer(auditId: String, escalation: AuditEscalationRow, text: String) async -> Bool {
        let answer = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !answer.isEmpty else { return false }
        return await respond(auditId: auditId, escalation: escalation, answer: answer, decision: nil)
    }

    /// Une décision de jalon (sortes `specs`, `review`).
    @discardableResult
    func decide(auditId: String, escalation: AuditEscalationRow, decision: AuditMilestoneDecision) async -> Bool {
        await respond(auditId: auditId, escalation: escalation, answer: nil, decision: decision)
    }

    private func respond(auditId: String, escalation: AuditEscalationRow, answer: String?, decision: AuditMilestoneDecision?) async -> Bool {
        guard isIdle else { return false }
        inFlight = .answer(key: escalation.key)
        defer { inFlight = nil }
        do {
            _ = try await client.answerAuditEscalation(
                id: auditId,
                slug: escalation.slug,
                key: escalation.key,
                answer: answer,
                decision: decision
            )
            drafts[escalation.key] = nil
            banner = nil
            return true
        } catch {
            banner = Self.isConflict(error) ? AuditText.alreadyAnswered : AuditText.answerFailed
            return false
        }
    }

    // MARK: - Arrêt

    /// « Arrêter l'audit… » : ouvre la confirmation ; sans objet pour un audit arrêté.
    func requestStop(_ card: AuditCard) {
        guard card.status != .stopped, isIdle else { return }
        pendingStop = card.id
    }

    @discardableResult
    func confirmStop() async -> Bool {
        guard let id = pendingStop, isIdle else { return false }
        pendingStop = nil
        inFlight = .stop(auditId: id)
        defer { inFlight = nil }
        do {
            _ = try await client.stopAudit(id: id)
            banner = nil
            return true
        } catch {
            banner = AuditText.stopFailed
            return false
        }
    }
}
