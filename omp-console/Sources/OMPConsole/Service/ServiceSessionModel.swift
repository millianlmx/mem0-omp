// La session servie par l'API du service (S-6, S-10) : ce que l'app appelle
// « Session OMP » ou « conduite de projet ».
//
// Aucun process n'est lancé : la session est créée par `POST /v1/sessions`, nourrie
// par `POST …/prompt`, ses dialogues répondus par `POST …/dialogs/{id}` et elle est
// fermée par `DELETE` à l'arrêt. Son flux d'évènements vient de `ServiceEvents`
// (SSE), et un service absent rend l'erreur typée « service arrêté ».
//
// L'état vit à point de mutation unique (`state`), comme les autres modèles de
// l'app ; le reste (dialogues, journal, fichier de session, notice) est publié pour
// être affiché tel quel.

import Combine
import Foundation
import os

/// Une entrée du journal d'une session : ce que l'app a absorbé sans le montrer
/// brut à l'utilisateur.
struct JournalEntry: Identifiable, Equatable, Sendable {
    enum Kind: String, Equatable, Sendable {
        case notice
        case clientError
        case connection
        case session
    }

    let id: Int
    let kind: Kind
    let message: String
}

/// Alias des deux appellations du contrat, pour que « Session OMP » et
/// « conduite » désignent le même état.
typealias SessionRunStatus = ServiceSessionModel.State

@MainActor
final class ServiceSessionModel: ObservableObject {
    enum State: Equatable, Sendable {
        case idle
        case launching
        case running
        case stopping
        case stopped
        case dead
        case failed(message: String)
    }

    /// Fabrique du client, injectable : les preuves substituent un transport
    /// scripté ; l'app localise le service à chaque tentative.
    typealias ClientFactory = @Sendable () throws -> ServiceClient

    @Published private(set) var state: State = .idle
    @Published private(set) var journal: [JournalEntry] = []
    @Published private(set) var dialogQueue: [RpcDialogRequest] = []
    @Published private(set) var sessionFile: String?
    @Published private(set) var sessionId: String?
    /// La dernière notice publiée par le service (`{level,message}`), affichée par
    /// la conduite de projet.
    @Published private(set) var lastNotice: String?

    static let journalCeiling = 500

    /// `purpose` de la session : « session » (fenêtre « Session OMP ») ou
    /// « project » (conduite de projet).
    let purpose: String

    private let makeClient: ClientFactory
    private let maxAttempts: Int
    private let retryDelay: @Sendable (Int) -> Duration

    private static let logger = Logger(subsystem: "com.omp.console", category: "service")

    private var client: ServiceClient?
    private var eventsTask: Task<Void, Never>?
    private var projectRoot: URL?
    private var journalCounter = 0
    private var stopping = false

    init(
        purpose: String = "session",
        makeClient: @escaping ClientFactory = { ServiceClient(endpoint: try ServiceLocator.locate()) },
        maxAttempts: Int = 5,
        retryDelay: @escaping @Sendable (Int) -> Duration = { attempt in .milliseconds(min(2_000, 250 * attempt)) }
    ) {
        self.purpose = purpose
        self.makeClient = makeClient
        self.maxAttempts = maxAttempts
        self.retryDelay = retryDelay
    }

    /// Le pid du service, pour l'affichage du statut (S-9).
    var pid: Int32? { client?.endpoint.pid }

    // MARK: - Démarrage

    /// Crée (ou reprend) une session servie, puis s'abonne à son flux (S-6).
    /// `resumeFile` est le CHEMIN du fichier de session à continuer (la seule
    /// forme que le service accepte — S-6) ; `nil` ouvre une session neuve.
    func start(projectRoot: URL, resumeFile: String? = nil) async throws {
        switch state {
        case .launching, .running, .stopping:
            throw ServiceSessionError.alreadyRunning
        default:
            break
        }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: projectRoot.path, isDirectory: &isDirectory),
              isDirectory.boolValue else {
            let message = "Le dossier du projet n'existe plus : \(projectRoot.path)."
            fail(message: message)
            return
        }
        self.projectRoot = projectRoot
        state = .launching
        let client: ServiceClient
        do {
            client = try makeClient()
        } catch {
            fail(message: Self.userMessage(of: error))
            throw error
        }
        self.client = client
        do {
            let info = try await client.createSession(cwd: projectRoot.path, resume: resumeFile, purpose: purpose)
            adopt(info, client: client, journalMessage: "session ouverte \(info.id)")
        } catch {
            fail(message: Self.userMessage(of: error))
            throw error
        }
    }

    /// Démarre (ou retrouve) la conduite d'un projet par le service (S-7) : le
    /// service crée la session, lui envoie `/project <nom>` et refuse en 409 avec
    /// son texte exact (dépôt non git, sans distant GitHub, conduite déjà vivante).
    /// Une conduite DÉJÀ vivante n'est pas un échec : l'app s'y rattache.
    func startConduite(repoRoot: URL, name: String) async throws {
        switch state {
        case .launching, .running, .stopping:
            throw ServiceSessionError.alreadyRunning
        default:
            break
        }
        self.projectRoot = repoRoot
        state = .launching
        let client: ServiceClient
        do {
            client = try makeClient()
        } catch {
            fail(message: Self.userMessage(of: error))
            throw error
        }
        self.client = client
        do {
            let info = try await client.startConduite(repo: repoRoot.path, name: name)
            adopt(info, client: client, journalMessage: "conduite ouverte \(info.id)")
        } catch let error as ServiceClientError {
            // S-7 : quand un 409 dit qu'une conduite VIT DÉJÀ pour ce dépôt — le
            // cas après un redémarrage de machine, un crash de l'app ou une
            // seconde instance, où le service l'a reprise seul (`resumeConduites`)
            // — l'app s'y RATTACHE : c'est elle que « rouvrir l'app retrouve »,
            // questions en attente comprises (l'instantané du flux les rejoue).
            // Sans session vivante à retrouver (dépôt sans distant GitHub), le
            // refus du service reste affiché tel quel.
            if case .conflict = error, let live = await liveConduite(client: client, repoRoot: repoRoot) {
                adopt(live, client: client, journalMessage: "conduite retrouvée \(live.id)")
                await refreshState()
                return
            }
            fail(message: Self.userMessage(of: error))
            throw error
        } catch {
            fail(message: Self.userMessage(of: error))
            throw error
        }
    }

    /// L'identité de la conduite VIVANTE d'un dépôt, telle que `GET /v1/sessions`
    /// la publie (S-2) : `nil` quand aucune ne vit — le 409 venait alors d'un
    /// autre refus (dépôt non git, sans distant GitHub).
    private func liveConduite(client: ServiceClient, repoRoot: URL) async -> ServiceSessionInfo? {
        guard let sessions = try? await client.sessions() else { return nil }
        return sessions.first { $0.purpose == "project" && Self.isSameRepo($0.cwd, as: repoRoot) }
    }

    /// Le MÊME dépôt sous deux écritures de son chemin. Le service publie le chemin
    /// RÉEL (`realpathOr` de `requireRepo` — mesuré sur le service réel : un dépôt
    /// ouvert sous `/var/…` y devient `/private/var/…`), l'app tient le chemin
    /// choisi par l'utilisateur (qui peut passer par un lien symbolique) : les deux
    /// formes sont comparées, littérale puis résolue, pour ne pas croire à une
    /// absence de conduite quand seul le lien diffère.
    static func isSameRepo(_ candidate: String, as repoRoot: URL) -> Bool {
        let candidateURL = URL(fileURLWithPath: candidate)
        if candidateURL.standardizedFileURL.path == repoRoot.standardizedFileURL.path { return true }
        return candidateURL.resolvingSymlinksInPath().path == repoRoot.resolvingSymlinksInPath().path
    }

    /// Adopte une session déjà vivante dans le service : son identité, l'état
    /// `running` et l'abonnement au flux — dont l'instantané rejoue l'état et les
    /// dialogues en vol (S-6), ce qui rend une question en attente atteignable
    /// sans geste.
    private func adopt(_ info: ServiceSessionInfo, client: ServiceClient, journalMessage: String) {
        sessionId = info.id
        sessionFile = info.sessionFile
        journal(.session, journalMessage)
        state = .running
        subscribe(client: client, sessionID: info.id)
    }

    /// Relance MANUELLE depuis un état arrêté : nouvelle session pour le même
    /// projet, en reprenant la dernière conversation (S-6).
    func relaunch() async throws {
        switch state {
        case .dead, .stopped, .failed:
            break
        case .idle:
            throw ServiceSessionError.notRunning
        case .launching, .running, .stopping:
            throw ServiceSessionError.alreadyRunning
        }
        guard let projectRoot else { throw ServiceSessionError.notRunning }
        // La reprise porte le CHEMIN connu du fichier de session (S-6) : sans lui
        // (session jamais ouverte sur disque, ou arrêtée par l'utilisateur), la
        // relance repart d'une session neuve.
        try await start(projectRoot: projectRoot, resumeFile: sessionFile)
    }

    // MARK: - Commandes

    func send(prompt: String) async throws {
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ServiceSessionError.emptyPrompt
        }
        guard let client, let sessionId, isLive else { throw ServiceSessionError.notRunning }
        do {
            try await client.prompt(id: sessionId, text: prompt)
        } catch {
            handleCommandFailure(error)
            throw error
        }
    }

    /// Répond à un dialogue en vol : la réponse part, puis le dialogue quitte la
    /// file (S-6).
    func answer(_ response: RpcDialogResponse) async throws {
        guard dialogQueue.contains(where: { $0.id == response.id }) else {
            throw ServiceSessionError.dialogNotPending
        }
        guard let client, let sessionId else { throw ServiceSessionError.notRunning }
        do {
            try await client.answerDialog(id: sessionId, dialogId: response.id, answer: response)
        } catch {
            handleCommandFailure(error)
            throw error
        }
        dialogQueue.removeAll { $0.id == response.id }
    }

    /// Interroge la session : le fichier de session peut avoir changé côté service.
    func refreshState() async {
        guard let client, let sessionId else { return }
        guard let info = try? await client.session(id: sessionId) else { return }
        if info.sessionFile != sessionFile { sessionFile = info.sessionFile }
    }

    // MARK: - Arrêt

    func stop() async {
        await shutdown()
    }

    /// La fermeture de l'app (S-6, S-7). Une session `session` est LIBÉRÉE — S-6 :
    /// « libérées à la fermeture de leur client » — mais une conduite de projet est
    /// seulement QUITTÉE : elle reste vivante dans le service, ses segments
    /// continuent et ses questions attendent la réouverture (S-7). Le `DELETE`
    /// d'une conduite appartient au geste explicite « Arrêter le pilotage ».
    func terminateForQuit() async {
        if purpose == "project" {
            detach()
            return
        }
        await shutdown()
    }

    /// Quitte une session SANS aucun effet sur le service : le flux se coupe,
    /// l'identité locale s'oublie, la session continue de vivre.
    private func detach() {
        guard isLive else { return }
        eventsTask?.cancel()
        eventsTask = nil
        // Une question en vol N'EST PAS annulée côté service : elle attend la
        // réouverture, qui la rejouera par l'instantané de son flux (S-6, S-7).
        dialogQueue.removeAll()
        sessionId = nil
        sessionFile = nil
        client = nil
        state = .stopped
    }

    private func shutdown() async {
        switch state {
        case .idle, .stopped:
            return
        default:
            break
        }
        guard !stopping else { return }
        stopping = true
        defer { stopping = false }
        state = .stopping
        eventsTask?.cancel()
        eventsTask = nil
        if let client, let sessionId {
            if purpose == "project", let projectRoot {
                try? await client.stopConduite(repo: projectRoot.path)
            } else {
                try? await client.closeSession(id: sessionId)
            }
        }
        dialogQueue.removeAll()
        sessionId = nil
        sessionFile = nil
        client = nil
        state = .stopped
    }

    // MARK: - Flux d'évènements

    private func subscribe(client: ServiceClient, sessionID: String) {
        eventsTask?.cancel()
        let events = ServiceEvents(client: client, maxAttempts: maxAttempts, retryDelay: retryDelay)
        let stream = events.stream(sessionID: sessionID)
        eventsTask = Task { @MainActor [weak self] in
            do {
                for try await frame in stream {
                    guard let self, !Task.isCancelled else { break }
                    self.apply(frame)
                }
            } catch is CancellationError {
                return
            } catch {
                guard let self, !Task.isCancelled else { return }
                self.connectionLost(error)
            }
        }
    }

    private func apply(_ frame: ServiceFrame) {
        switch frame {
        case .state:
            // L'état suivi par la fenêtre est la VIE de la session : un tour qui
            // se termine ne ferme pas la session (S-6).
            break
        case .dialog(let dialog):
            if !dialogQueue.contains(where: { $0.id == dialog.id }) {
                dialogQueue.append(dialog)
            }
        case .dialogCancelled(let id):
            dialogQueue.removeAll { $0.id == id }
        case .notice(let level, let message):
            lastNotice = message
            journal(.notice, "[\(level)] \(message)")
        case .promptEnd(let status):
            journal(.session, "tour \(status)")
        }
    }

    /// La connexion au flux est perdue : la session passe `dead` avec le motif
    /// (S-10), sans tuer quoi que ce soit.
    private func connectionLost(_ error: Error) {
        guard isLive else { return }
        let message = Self.userMessage(of: error)
        journal(.connection, message)
        abandonDialogs(reason: "connexion perdue")
        state = .dead
    }

    private var isLive: Bool {
        switch state {
        case .launching, .running, .stopping: return true
        default: return false
        }
    }

    private func handleCommandFailure(_ error: Error) {
        if let clientError = error as? ServiceClientError {
            switch clientError {
            case .unavailable, .unauthorized, .notFound:
                journal(.connection, Self.userMessage(of: error))
                abandonDialogs(reason: "service arrêté")
                state = .dead
            default:
                break
            }
        } else if error is ServiceUnavailable {
            journal(.connection, Self.userMessage(of: error))
            abandonDialogs(reason: "service arrêté")
            state = .dead
        }
    }

    // MARK: - Écritures bornées

    private func fail(message: String) {
        state = .failed(message: message)
        journal(.clientError, message)
    }

    private func journal(_ kind: JournalEntry.Kind, _ message: String) {
        journalCounter += 1
        journal.append(JournalEntry(id: journalCounter, kind: kind, message: message))
        if journal.count > Self.journalCeiling {
            journal.removeFirst(journal.count - Self.journalCeiling)
        }
        Self.logger.log("\(message, privacy: .public)")
    }

    private func abandonDialogs(reason: String) {
        for dialog in dialogQueue {
            journal(.session, "dialogue \(dialog.id) abandonné : \(reason)")
        }
        dialogQueue.removeAll()
    }

    /// Le texte affiché d'une erreur : sa `userMessage` quand elle en porte une.
    static func userMessage(of error: Error) -> String {
        (error as? UserFacingError)?.userMessage ?? String(describing: error)
    }
}
