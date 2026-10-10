// Le modèle de l'écran Projet de l'app iOS (BR-4) : il porte le client partagé,
// déclenche les lectures de S-2 (document) et S-3 (PR), et compose le plan par
// `projectPlanSections(of:)` du noyau. Aucune règle n'est recalculée, aucun état
// de la file d'escalades n'est reconstitué : la file est EXCLUSIVEMENT celle que
// la coque pousse (`client.conduite?.dialogs`, S-6).

import Combine
import ConsoleClient
import ConsoleCore
import Foundation

/// Un brouillon de démarrage : le dépôt choisi et le nom soumis (S-9).
struct LaunchDraft: Equatable {
    let repoKey: String
    let name: String
}

/// La surface que l'écran doit montrer, décidée par le statut de connexion
/// présenté et l'état de la conduite (S-7, S-11 ; etats-non-connecte-heterogenes-ios, S-4).
enum ProjectSurface: Equatable {
    /// Mac non connecté et aucune conduite reçue : le composant d'état de
    /// connexion partagé, seul, à la place de l'écran.
    case unavailable(IOSConnectionStatus)
    /// Aucune conduite vive (connecté, ou conduite reçue conservée hors connexion).
    case empty
    /// Conduite en démarrage ou en arrêt.
    case starting
    /// Conduite vive.
    case live
}

/// L'état du volet Document (S-2).
enum ProjectDocState: Equatable {
    case idle
    case loading
    case blocks([MarkdownBlock])
    /// Un message servi : document absent, non lisible, ou échec de lecture.
    case message(String)
}

@MainActor
final class IOSProjectModel: ObservableObject {
    let client: ConsoleClientModel

    @Published var expanded: Set<Int> = []
    @Published var docState: ProjectDocState = .idle
    @Published var prRows: [ProjectPRRow] = []
    @Published var prFailure: String?
    @Published var prStale = false
    @Published var isRefreshingPRs = false
    @Published var banner: String?
    @Published var draft: LaunchDraft?

    private var docTask: Task<Void, Never>?
    private var prTask: Task<Void, Never>?
    private var lastDocTrigger: DocTrigger?
    private var lastPRTrigger: [String]?

    init(client: ConsoleClientModel) {
        self.client = client
    }

    // MARK: - Décisions PURES (testables sans render)

    /// Seul `.connected` ouvre les gestes (S-7).
    static func gesturesEnabled(_ state: ClientState) -> Bool {
        if case .connected = state { return true }
        return false
    }

    /// La surface choisie pour un statut de connexion et un état de conduite (S-7,
    /// S-11). Une conduite reçue (`conduiteState != nil`) est conservée hors
    /// connexion : sa surface reste calculée sur elle, sous le bandeau (S-4).
    static func surface(connection: IOSConnectionStatus, conduiteState: String?) -> ProjectSurface {
        if connection != .connected && conduiteState == nil { return .unavailable(connection) }
        switch ProjectConduiteState(rawValue: conduiteState ?? "") {
        case .starting, .closing: return .starting
        case .live: return .live
        default: return .empty
        }
    }

    /// L'état du volet Document, depuis la forme servie (S-2).
    static func documentState(state: String?, content: String?, reason: String?) -> ProjectDocState {
        guard let state else { return .message(ProjectViewText.docMissing) }
        switch state {
        case ProjectDocumentWire.text:
            return .blocks(MarkdownDocument.blocks(content ?? ""))
        case ProjectDocumentWire.missing:
            return .message(ProjectViewText.docMissing)
        default:
            return .message(reason ?? ProjectViewText.docMissing)
        }
    }

    /// Une erreur conservée (geste, relevé des PR) n'est montrée qu'à `.connected` :
    /// hors connexion, le bandeau de connexion est le seul bandeau d'état (S-4).
    static func shownFailure(_ failure: String?, connection: IOSConnectionStatus) -> String? {
        connection == .connected ? failure : nil
    }

    // MARK: - Faits dérivés du client

    var repoKey: String? { client.conduite?.repoKey }
    var project: Project? { repoKey.flatMap { client.project(repoKey: $0) } }
    var planSections: [ProjectPlanSection] { project.map(projectPlanSections(of:)) ?? [] }
    var pendingDialog: RpcDialogRequest? { client.conduite?.dialogs.first }
    var waitingCount: Int { client.conduite?.dialogs.count ?? 0 }
    /// Le statut de connexion présenté par l'écran (S-1).
    var connection: IOSConnectionStatus { IOSConnectionStatus.of(client) }
    var surface: ProjectSurface { Self.surface(connection: connection, conduiteState: client.conduite?.state) }
    var isConduiteLive: Bool {
        (ProjectConduiteState(rawValue: client.conduite?.state ?? "") ?? .none).isLive
    }
    var canStop: Bool { Self.gesturesEnabled(client.state) && repoKey != nil }
    var canStart: Bool { Self.gesturesEnabled(client.state) && !isConduiteLive }

    // MARK: - Cycle de vie

    /// À l'apparition de l'écran : déplie le segment courant.
    func appeared() {
        if expanded.isEmpty, let current = project?.current {
            expanded = [current]
        }
    }

    func toggle(_ index: Int) {
        if expanded.contains(index) { expanded.remove(index) } else { expanded.insert(index) }
    }

    // MARK: - S-2 : le document

    private struct DocTrigger: Equatable {
        let repoKey: String?
        let updatedAt: Double?
    }

    /// Relit le document quand le `repoKey` de la conduite change ou quand le
    /// plan a été republié (`updatedAt`), jamais deux lectures empilées.
    func reloadDocumentIfNeeded() {
        guard Self.gesturesEnabled(client.state) else {
            docState = .idle
            return
        }
        let trigger = DocTrigger(repoKey: repoKey, updatedAt: project?.updatedAt)
        guard trigger != lastDocTrigger else { return }
        lastDocTrigger = trigger
        docTask?.cancel()
        docTask = Task { await loadDocument() }
    }

    /// La relecture est explicite pour le geste de la feuille « Réessayer ».
    func reloadDocument() {
        lastDocTrigger = nil
        reloadDocumentIfNeeded()
    }

    private func loadDocument() async {
        guard let repoKey else {
            docState = .message(ProjectViewText.projectMissing)
            return
        }
        docState = .loading
        do {
            let payload = try await client.documents(repoKey: repoKey)
            if Task.isCancelled { return }
            let document = payload.documents.first { $0.name == ProjectViewText.docFileName }
            docState = Self.documentState(
                state: document?.state,
                content: document?.content,
                reason: document?.reason
            )
        } catch {
            docState = .message(ProjectText.failure(error, state: client.state))
        }
    }

    // MARK: - S-3 : les PR

    /// Relit les statuts quand la liste suivie change (le couple slug|prUrl du plan
    /// est le déclencheur), ou sur le geste explicite « Relire les statuts ».
    func reloadPRsIfNeeded() {
        guard Self.gesturesEnabled(client.state) else { return }
        let trigger = prTrigger
        guard trigger != lastPRTrigger else { return }
        lastPRTrigger = trigger
        reloadPRs()
    }

    func reloadPRs() {
        guard let repoKey, Self.gesturesEnabled(client.state) else { return }
        prTask?.cancel()
        isRefreshingPRs = true
        prTask = Task { await loadPRs(repoKey: repoKey) }
    }

    private func loadPRs(repoKey: String) async {
        do {
            let payload = try await client.pullRequests(repoKey: repoKey)
            if Task.isCancelled { return }
            prRows = payload.rows
            prFailure = payload.failure
            prStale = payload.stale
        } catch {
            prRows = []
            prFailure = ProjectText.failure(error, state: client.state)
            prStale = false
        }
        isRefreshingPRs = false
    }

    private var prTrigger: [String] {
        guard let project else { return [] }
        return project.segments.flatMap(\.features).map { $0.slug + ($0.prUrl ?? "") }
    }

    // MARK: - Gestes

    func start(repoKey: String, name: String) async -> String? {
        do {
            _ = try await client.startConduite(repoKey: repoKey, name: name)
            draft = LaunchDraft(repoKey: repoKey, name: name)
            banner = nil
            return nil
        } catch {
            return ProjectText.failure(error, state: client.state)
        }
    }

    func stop() async {
        guard let repoKey else { return }
        banner = nil
        do {
            _ = try await client.closeConduite(repoKey: repoKey)
            draft = nil
        } catch {
            banner = ProjectText.failure(error, state: client.state)
        }
    }

    /// Envoie la réponse d'une escalade ; rend le message servi en cas d'échec, la
    /// feuille restant ouverte.
    func send(_ request: RemoteDialogAnswerRequest) async -> String? {
        guard let dialog = pendingDialog else { return nil }
        do {
            _ = try await client.answerProjectDialog(
                id: dialog.id,
                kind: request.kind,
                value: request.value,
                confirmed: request.confirmed
            )
            return nil
        } catch {
            return ProjectText.failure(error, state: client.state)
        }
    }

    /// Le texte initial d'une escalade qui apparaît (« prefill » d'un `editor`).
    static func initialText(dialog: RpcDialogRequest) -> String {
        IOSDialogGating.initialText(dialog: dialog)
    }
}
