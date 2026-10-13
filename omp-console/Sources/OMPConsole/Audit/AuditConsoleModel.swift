// Le modèle de la section « Audit » (audit-panel-in-omp-console S-6, BR-3) : il
// lit les audits dans le magasin (`StoreHub.snapshots()`, ardoise `AuditBoard`) et
// porte les quatre gestes vers le service OMP — démarrer, lancer (sélection +
// brief validé), répondre à une escalade, arrêter.
//
// Règles de forme :
//   — l'app n'ÉCRIT jamais un audit : le service seul tient `audits/<id>.json` ;
//     l'écran relit le magasin, et un geste réussi se voit à l'instantané suivant ;
//   — les cases cochées vivent ICI, par audit, en mémoire : elles ne partent qu'avec
//     le brief validé (« Valider et lancer »), jamais seules ;
//   — fermer la feuille du brief (Annuler, Échap, fermeture) ne poste RIEN (AC-3) ;
//   — aucune accroche de sortie : quitter l'app n'appelle aucune route d'audit
//     (AC-9), l'audit vit dans le service.
//
// Les gestes « bruts » (`startAudit`, `launchAudit`, `answerEscalation`,
// `stopAudit`) lèvent : l'API distante (BR-4) les réemploie telle quelle. Les
// enveloppes d'interface (`submit…`, `commitBrief`, `confirmStop`) posent `busy`
// et `failure`. Aucun `@State` dans les vues : brouillons, feuilles et
// confirmations vivent ici.

import AppKit
import ConsoleCore
import Foundation

/// Ce que le détail rend pour un audit, selon son statut : la vue lit cette
/// dérivation pure (ses preuves aussi, sans rendre de SwiftUI).
enum AuditDetailContent: Equatable {
    /// `analysing` : un indicateur et « Analyse en cours… ».
    case analysing
    /// `proposed` : les cases, faiblesses puis features.
    case proposals(weaknesses: [AuditProposalRow], features: [AuditProposalRow])
    /// `launched` et `stopped` : avancement, questions en attente, décisions.
    case followUp
    /// `failed` : la phrase lisible, `failure` en diagnostic.
    case failed(ReadableFailure)

    static func of(_ card: AuditCard) -> AuditDetailContent {
        switch card.status {
        case .analysing:
            return .analysing
        case .proposed:
            return .proposals(
                weaknesses: card.proposals.filter { $0.kind == .weakness },
                features: card.proposals.filter { $0.kind == .feature }
            )
        case .launched, .stopped:
            return .followUp
        case .failed:
            return .failed(ReadableFailure(message: AuditText.analysisFailed, diagnostic: card.failure ?? ""))
        }
    }
}

@MainActor
final class AuditConsoleModel: ObservableObject {
    typealias ClientFactory = ServiceSessionModel.ClientFactory
    /// Une source d'instantanés injectée (preuves) ; `nil` : le `StoreHub` du
    /// magasin de l'app, créé au premier `start()`.
    typealias SnapshotSource = @MainActor () -> AsyncStream<StoreSnapshot>

    /// La plus longue orientation acceptée, rognée (S-6).
    static let orientationLimit = 2000

    // MARK: - Lecture

    @Published private(set) var board = AuditBoard(audits: [])
    /// Le magasin a été lu au moins une fois : avant, la section montre un
    /// indicateur de chargement.
    @Published private(set) var isLoaded = false
    /// L'audit affiché dans le détail.
    @Published var selection: String?

    // MARK: - Propositions et brief

    /// Les slugs cochés, par audit — en mémoire seulement.
    @Published private(set) var checked: [String: Set<String>] = [:]
    @Published var briefText = ""
    @Published var isBriefSheetPresented = false
    /// La rubrique manquante, signalée dans la feuille AVANT tout envoi.
    @Published private(set) var briefError: String?

    // MARK: - Feuille de lancement

    @Published var isLaunchSheetPresented = false
    @Published var draftRepository: URL?
    @Published var draftOrientation = ""

    // MARK: - Escalades et arrêt

    /// La saisie « Autre réponse », par clé d'escalade.
    @Published private(set) var escalationDrafts: [String: String] = [:]
    /// L'audit dont l'arrêt attend confirmation (`nil` : aucune confirmation).
    @Published var pendingStop: String?

    // MARK: - Gestes

    /// L'échec du dernier geste, en bandeau ; effacé au geste suivant réussi.
    @Published private(set) var failure: ReadableFailure?
    /// Le dernier geste a échoué faute de service : bandeau « service arrêté »
    /// et « Réessayer » ; la lecture du magasin reste affichée.
    @Published private(set) var serviceDown = false
    /// Un geste est en vol : les boutons sont désactivés.
    @Published private(set) var busy = false

    // MARK: - Dépendances

    private let makeClient: ClientFactory
    private let makeSnapshots: SnapshotSource?
    private let stateDir: String
    private let urlOpener: any URLOpening
    private let defaults: UserDefaults
    private let fileManager: FileManager

    private var hub: StoreHub?
    private var task: Task<Void, Never>?
    /// L'audit pour lequel `briefText` a été préparé : rouvrir la feuille du même
    /// audit garde les corrections en cours.
    private var briefAuditId: String?
    /// L'audit tout juste créé : il reste sélectionné tant que le magasin ne l'a
    /// pas encore rendu.
    private var startedId: String?
    /// Le geste à rejouer par « Réessayer » quand le service était arrêté.
    private var retryGesture: (() async -> Void)?

    init(
        stateDir: String = PipelineStore.stateDir(),
        snapshots: SnapshotSource? = nil,
        makeClient: @escaping ClientFactory = { ServiceClient(endpoint: try ServiceLocator.locate()) },
        urlOpener: any URLOpening = SystemURLOpener(),
        defaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) {
        self.stateDir = stateDir
        self.makeSnapshots = snapshots
        self.makeClient = makeClient
        self.urlOpener = urlOpener
        self.defaults = defaults
        self.fileManager = fileManager
    }

    // MARK: - Abonnement au magasin

    /// S'abonne aux instantanés du magasin. Idempotent.
    func start() {
        guard task == nil else { return }
        let stream: AsyncStream<StoreSnapshot>
        if let makeSnapshots {
            stream = makeSnapshots()
        } else {
            let hub = StoreHub(stateDir: stateDir)
            self.hub = hub
            stream = hub.snapshots()
        }
        task = Task { [weak self] in
            for await snapshot in stream {
                guard let self else { return }
                self.apply(snapshot)
            }
        }
    }

    /// Annule l'abonnement et arrête le hub : aucune scrutation ne prend le relais.
    func stop() {
        task?.cancel()
        task = nil
        hub?.stop()
        hub = nil
    }

    /// Range un instantané : ardoise, sélection et saisies encore valables.
    func apply(_ snapshot: StoreSnapshot) {
        let next = AuditBoard.of(snapshot)
        board = next
        isLoaded = true
        if let started = startedId, next.card(id: started) != nil {
            startedId = nil
        }
        if let current = selection, next.card(id: current) == nil, current != startedId {
            selection = nil
        }
        if selection == nil {
            selection = next.audits.first?.id
        }
        // Les cases d'un audit qui n'attend plus de validation n'ont plus d'objet.
        checked = checked.filter { next.card(id: $0.key)?.status == .proposed }
        if let id = pendingStop, next.card(id: id).map({ $0.status == .stopped }) ?? true {
            pendingStop = nil
        }
        let liveKeys = Set(next.audits.flatMap { $0.escalations.map(\.key) })
        escalationDrafts = escalationDrafts.filter { liveKeys.contains($0.key) }
    }

    var selectedCard: AuditCard? { board.card(id: selection) }

    // MARK: - Gestes bruts (réemployés par l'API distante)

    /// `POST /v1/audits` : rend l'identifiant de l'audit créé.
    func startAudit(repoRoot: String, orientation: String) async throws -> String {
        let client = try makeClient()
        return try await client.startAudit(repoRoot: repoRoot, orientation: orientation).id
    }

    /// `POST /v1/audits/{id}/launch` : la sélection et le brief, tels quels.
    func launchAudit(id: String, selected: [String], brief: String) async throws -> [AuditLaunchOutcome] {
        let client = try makeClient()
        return try await client.launchAudit(id: id, selected: selected, brief: brief)
    }

    /// `POST /v1/audits/{id}/escalations` : une réponse (`ask`, `question`) ou une
    /// décision de jalon (`specs`, `review`).
    func answerEscalation(auditId: String, slug: String, key: String, answer: String?, decision: AuditMilestoneDecision?) async throws {
        let client = try makeClient()
        try await client.answerAuditEscalation(
            id: auditId,
            body: ServiceAuditAnswer(slug: slug, key: key, answer: answer, decision: decision)
        )
    }

    /// `DELETE /v1/audits/{id}`.
    func stopAudit(id: String) async throws -> ServiceAuditStopOutcome {
        let client = try makeClient()
        return try await client.stopAudit(id: id)
    }

    // MARK: - Feuille de lancement

    /// Ouvre la feuille ; le dépôt est prérempli par le projet choisi de l'app.
    func presentLaunchSheet() {
        if draftRepository == nil {
            draftRepository = ProjectRoot.resolve(defaults: defaults, fileManager: fileManager)
        }
        isLaunchSheetPresented = true
    }

    func chooseDraftRepository() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = false
        panel.prompt = AuditText.choosePanelPrompt
        panel.message = AuditText.choosePanelMessage
        if let start = draftRepository { panel.directoryURL = start }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        draftRepository = url
    }

    var trimmedOrientation: String {
        draftOrientation.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Le dossier choisi porte `.git` — le même contrôle que la conduite de projet.
    var draftIsGitRepository: Bool {
        guard let repo = draftRepository else { return false }
        return ProjectConsoleModel.isGitRepository(repo)
    }

    /// Le message de champ de la feuille, ou `nil`.
    var launchFieldMessage: String? {
        if draftRepository != nil, !draftIsGitRepository { return AuditText.notGitRepository }
        if trimmedOrientation.count > Self.orientationLimit { return AuditText.orientationTooLong }
        return nil
    }

    var canCommitLaunch: Bool {
        !busy && draftIsGitRepository && (1...Self.orientationLimit).contains(trimmedOrientation.count)
    }

    func cancelLaunch() {
        isLaunchSheetPresented = false
    }

    /// « Lancer l'audit » : ferme la feuille puis démarre.
    func commitLaunch() {
        guard canCommitLaunch, let repo = draftRepository else { return }
        let orientation = trimmedOrientation
        isLaunchSheetPresented = false
        Task { @MainActor in await submitStart(repoRoot: repo.path, orientation: orientation) }
    }

    /// Démarre un audit ; au succès, il est sélectionné et le brouillon vidé.
    @discardableResult
    func submitStart(repoRoot: String, orientation: String) async -> Bool {
        var id: String?
        let ok = await perform(
            failure: { _ in AuditText.startFailed },
            retry: { [weak self] in _ = await self?.submitStart(repoRoot: repoRoot, orientation: orientation) }
        ) {
            id = try await self.startAudit(repoRoot: repoRoot, orientation: orientation)
        }
        if ok, let id {
            startedId = id
            selection = id
            draftOrientation = ""
        }
        return ok
    }

    // MARK: - Propositions

    func isChecked(_ slug: String, in auditId: String) -> Bool {
        checked[auditId]?.contains(slug) ?? false
    }

    /// Coche ou décoche une proposition ; une proposition `taken` ne se coche pas.
    func setChecked(_ slug: String, in auditId: String, _ on: Bool) {
        guard let card = board.card(id: auditId), card.status == .proposed,
              let row = card.proposals.first(where: { $0.slug == slug }), !row.taken else { return }
        var set = checked[auditId] ?? []
        if on { set.insert(slug) } else { set.remove(slug) }
        checked[auditId] = set.isEmpty ? nil : set
    }

    /// Les slugs cochés et lançables de `card`, dans l'ordre de l'analyse.
    func selectedSlugs(of card: AuditCard) -> [String] {
        let set = checked[card.id] ?? []
        return card.proposals.filter { !$0.taken && set.contains($0.slug) }.map(\.slug)
    }

    func checkedCount(of card: AuditCard) -> Int {
        selectedSlugs(of: card).count
    }

    /// « Relire le brief… » est actif dès qu'une case est cochée.
    func canReviewBrief(_ card: AuditCard) -> Bool {
        card.status == .proposed && !selectedSlugs(of: card).isEmpty && !busy
    }

    // MARK: - Brief

    /// Ouvre la feuille du brief de l'audit sélectionné, sur son `briefDraft`.
    func presentBrief() {
        guard let card = selectedCard, canReviewBrief(card) else { return }
        if briefAuditId != card.id {
            briefText = card.briefDraft ?? ""
            briefAuditId = card.id
        }
        briefError = nil
        isBriefSheetPresented = true
    }

    /// Annuler, Échap ou fermeture : la feuille se ferme, RIEN n'est posté.
    func cancelBrief() {
        isBriefSheetPresented = false
        briefError = nil
    }

    /// « Valider et lancer » : rubriques contrôlées avant tout envoi, puis
    /// `selected` (exactement les cases cochées) et le texte.
    @discardableResult
    func commitBrief() async -> Bool {
        guard !busy, let card = selectedCard, card.status == .proposed else { return false }
        if let missing = AuditBrief.missingRubric(briefText) {
            briefError = AuditText.briefIncomplete(rubric: missing)
            return false
        }
        briefError = nil
        return await submitLaunch(id: card.id, selected: selectedSlugs(of: card), brief: briefText)
    }

    /// Le lancement d'un brief VALIDÉ. `id`, `selected` et `brief` sont figés au
    /// clic sur « Valider et lancer » : « Réessayer » rejoue exactement ceux-là,
    /// jamais la sélection ni le texte du moment (B-2). Au succès, ou si l'audit
    /// n'attend plus de validation (409), ses cases se vident et sa feuille se
    /// ferme — celle d'un autre audit ouverte entre-temps reste intacte.
    private func submitLaunch(id: String, selected: [String], brief: String) async -> Bool {
        var conflict = false
        let ok = await perform(
            failure: { error in
                conflict = Self.isConflict(error)
                return conflict ? AuditText.launchConflict : AuditText.launchFailed
            },
            retry: { [weak self] in _ = await self?.submitLaunch(id: id, selected: selected, brief: brief) }
        ) {
            _ = try await self.launchAudit(id: id, selected: selected, brief: brief)
        }
        if ok || conflict {
            checked[id] = nil
            if briefAuditId == id {
                isBriefSheetPresented = false
                briefAuditId = nil
                briefText = ""
            }
        }
        return ok
    }

    // MARK: - Escalades

    /// Répond par une option ou par la saisie « Autre réponse ».
    @discardableResult
    func submitAnswer(auditId: String, escalation: AuditEscalationRow, answer: String) async -> Bool {
        let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return false }
        let ok = await perform(
            failure: { Self.isConflict($0) ? AuditText.alreadyAnswered : AuditText.answerFailed },
            retry: { [weak self] in _ = await self?.submitAnswer(auditId: auditId, escalation: escalation, answer: answer) }
        ) {
            try await self.answerEscalation(auditId: auditId, slug: escalation.slug, key: escalation.key, answer: text, decision: nil)
        }
        if ok { escalationDrafts[escalation.key] = nil }
        return ok
    }

    /// Valide ou abandonne un jalon escaladé (`specs`, `review`).
    @discardableResult
    func submitDecision(auditId: String, escalation: AuditEscalationRow, decision: AuditMilestoneDecision) async -> Bool {
        await perform(
            failure: { Self.isConflict($0) ? AuditText.alreadyAnswered : AuditText.answerFailed },
            retry: { [weak self] in _ = await self?.submitDecision(auditId: auditId, escalation: escalation, decision: decision) }
        ) {
            try await self.answerEscalation(auditId: auditId, slug: escalation.slug, key: escalation.key, answer: nil, decision: decision)
        }
    }

    func draft(for key: String) -> String {
        escalationDrafts[key] ?? ""
    }

    func setDraft(_ text: String, for key: String) {
        escalationDrafts[key] = text
    }

    // MARK: - Arrêt

    /// « Arrêter l'audit… » : ouvre la confirmation ; sans objet pour un audit arrêté.
    func requestStop() {
        guard let card = selectedCard, card.status != .stopped else { return }
        pendingStop = card.id
    }

    func cancelStop() {
        pendingStop = nil
    }

    /// Le bouton destructif de la confirmation : `DELETE /v1/audits/{id}`.
    @discardableResult
    func confirmStop() async -> Bool {
        guard let id = pendingStop else { return false }
        pendingStop = nil
        return await perform(
            failure: { _ in AuditText.stopFailed },
            retry: { [weak self] in
                self?.pendingStop = id
                _ = await self?.confirmStop()
            }
        ) {
            _ = try await self.stopAudit(id: id)
        }
    }

    // MARK: - PR

    /// « Ouvrir la PR » : le navigateur par défaut, par l'ouvreur injecté.
    func openPR(_ row: AuditFeatureRow) {
        guard let text = row.prUrl, let url = URL(string: text),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        _ = urlOpener.open(url)
    }

    // MARK: - Échecs

    /// « Réessayer » du bandeau « service arrêté » : rejoue le dernier geste.
    func retry() async {
        guard let gesture = retryGesture else { return }
        await gesture()
    }

    /// Enveloppe d'un geste : `busy` pendant le vol, `failure` posé à l'échec et
    /// effacé au succès.
    private func perform(
        failure message: (Error) -> String,
        retry: @escaping () async -> Void,
        _ body: () async throws -> Void
    ) async -> Bool {
        guard !busy else { return false }
        busy = true
        defer { busy = false }
        do {
            try await body()
            failure = nil
            serviceDown = false
            retryGesture = nil
            return true
        } catch {
            failure = ReadableFailure(message: message(error), diagnostic: ServiceSessionModel.userMessage(of: error))
            serviceDown = Self.isServiceDown(error)
            retryGesture = serviceDown ? retry : nil
            return false
        }
    }

    static func isConflict(_ error: Error) -> Bool {
        if case .conflict = error as? ServiceClientError { return true }
        return false
    }

    static func isServiceDown(_ error: Error) -> Bool {
        error is ServiceUnavailable || (error as? ServiceClientError) == .unavailable
    }
}
