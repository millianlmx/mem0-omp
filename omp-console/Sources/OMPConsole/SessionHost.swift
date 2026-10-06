// Le host d'une session OMP hébergée : poignée de main, corrélation, délais
// bornés, dialogues, mort, relance et arrêt propre (S-1 à S-8).
//
// Trois décisions structurent ce fichier :
//
//   1. L'état vit dans un `ObservableObject` à point de mutation unique (`state`),
//      comme `ConsoleModel` (BR-2 step 1). Tout le reste — transcription, journal,
//      file de dialogues — est publié pour être affiché tel quel par la fenêtre, et
//      jamais retraduit : le host ne COMPOSE PAS de message utilisateur, il lève des
//      `SessionHostError` dont `userMessage` est l'unique table de correspondance.
//   2. Aucune attente ne bloque le MainActor : les commandes attendent une réponse
//      par continuation, avec un `Task` de garde-fou par délai (S-3). C'est ce qui
//      permet d'attendre un `ready` pendant 30 s sans figer la fenêtre.
//   3. Il n'existe AUCUN minuteur de relance, ni sur `onExit`, ni sur une réponse en
//      échec (S-7) : la relance est un geste de l'utilisateur, et rien d'autre.
//
// Le host est isolé au MainActor, comme le transport (S-1) : les callbacks entrent
// déjà sur le bon acteur.

import Combine
import Foundation
import os

/// Les échecs du host, en liste close (S-3). `userMessage` est l'UNIQUE table de
/// traduction vers le texte affiché (S-9) ; le host ne compose jamais une phrase
/// ailleurs.
enum SessionHostError: Error, Equatable, Sendable {
    case alreadyRunning
    case notRunning
    case emptyPrompt
    case binaryNotFound(searched: [String], override: String?)
    case incompatibleProtocol(announced: [Int])
    case readyFrameMissing
    case negotiationRefused(String)
    case requestTimedOut(command: String, seconds: Double)
    case processDied(command: String)
    case writeFailed(String)
    case dialogNotPending
    case commandFailed(command: String, error: String?, code: String?)
    case processDiedBeforeHandshake(exit: ProcessExit)

    var userMessage: String {
        switch self {
        case .alreadyRunning:
            return "Une session est déjà ouverte : arrêtez-la avant d'en lancer une autre."
        case .notRunning:
            return "Aucune session vivante."
        case .emptyPrompt:
            return "Le prompt est vide."
        case .binaryNotFound(let searched, let override):
            // S-4 : il n'existe qu'un emplacement — le composant que l'app
            // installe. Le message le nomme, jamais un chemin système.
            var message = "Binaire `omp` introuvable (cherché : \(searched.joined(separator: ", ")))."
            if let override { message += " Chemin demandé : \(override)" }
            return message
        case .incompatibleProtocol(let announced):
            let list = announced.map(String.init).joined(separator: ", ")
            return "Version de protocole RPC incompatible : l'app exige la version 2, le process a annoncé [\(list)]. Aucune commande n'a été envoyée."
        case .readyFrameMissing:
            return "Aucune trame `ready` reçue du process : la session ne peut pas démarrer."
        case .negotiationRefused(let error):
            return "Négociation de protocole refusée par le process : \(error)"
        case .requestTimedOut(let command, let seconds):
            return "Aucune réponse à « \(command) » après \(Self.secondsText(seconds)) s : la session reste vivante."
        case .processDied(let command):
            return "Le process est mort avant de répondre à « \(command) »."
        case .writeFailed(let reason):
            return "Écriture impossible vers la session : \(reason)."
        case .dialogNotPending:
            return "Aucun dialogue en attente."
        case .commandFailed(let command, let error, let code):
            var message = "La commande « \(command) » a échoué"
            if let error { message += " : \(error)" }
            if let code { message += " (code \(code))" }
            return message + "."
        case .processDiedBeforeHandshake(let exit):
            return "Le process s'est terminé avant la poignée de main (\(Self.exitLabel(exit)))."
        }
    }

    /// Traduction d'un échec d'écriture du transport, en liste close (S-2) : un
    /// `SessionHostError` passe tel quel, un `TransportFailure` devient
    /// `.writeFailed(userReason)`, tout le reste garde le comportement actuel.
    static func writeFailure(_ error: Error) -> SessionHostError {
        if let hostError = error as? SessionHostError { return hostError }
        if let transportError = error as? TransportFailure { return .writeFailed(transportError.userReason) }
        return .writeFailed(String(describing: error))
    }

    /// `<n> s` des messages littéraux : entier quand c'est un entier.
    static func secondsText(_ seconds: Double) -> String {
        if seconds == seconds.rounded() { return String(Int(seconds)) }
        return String(format: "%.1f", seconds)
    }

    /// Forme `<exited|signal> <n>` des messages de S-2 et du journal de S-7.
    static func exitLabel(_ exit: ProcessExit) -> String {
        switch exit.reason {
        case .exited: "code \(exit.status)"
        case .uncaughtSignal: "signal \(exit.status)"
        }
    }
}

/// Une ligne de la transcription brute (S-5) : la ligne JSONL reçue telle quelle,
/// la commande émise, ou une erreur locale. `id` est strictement croissant sur la
/// vie du host.
struct TranscriptLine: Identifiable, Equatable, Sendable, Codable {
    enum Kind: String, Equatable, Sendable, Codable {
        case inbound
        case outbound
        case clientError
    }

    let id: Int
    let kind: Kind
    let text: String
}

/// Une entrée du journal (S-4, S-6, S-8) : ce que l'app a absorbé sans le montrer
/// brut à l'utilisateur, et ce qu'elle a dû escalader.
struct JournalEntry: Identifiable, Equatable, Sendable {
    enum Kind: String, Equatable, Sendable {
        case `protocol` = "protocol"
        case ignoredFrame = "ignoredFrame"
        case clientError = "clientError"
        case presentation = "presentation"
        case processExit = "processExit"
        case processLog = "processLog"
    }

    let id: Int
    let kind: Kind
    let message: String
}

/// Résultat de fin de tour, posé à la réception de `prompt_result` (D1, S-5).
struct TurnOutcome: Equatable, Sendable {
    let status: String
    let agentInvoked: Bool
    let sessionSettled: Bool
}

/// Alias du nom employé par BR-2, pour que les deux appellations du contrat
/// désignent le même type.
typealias SessionHostState = SessionHost.State

@MainActor
final class SessionHost: ObservableObject {
    enum State: Equatable, Sendable {
        case idle
        case launching
        case running
        case stopping
        case stopped
        case dead(exit: ProcessExit)
        case failed(message: String)
    }

    typealias BinaryResolver = ([String: String]) -> Result<URL, SessionHostError>

    // MARK: - État observé

    @Published private(set) var state: State = .idle
    @Published private(set) var transcript: [TranscriptLine] = []
    @Published private(set) var journal: [JournalEntry] = []
    @Published private(set) var dialogQueue: [RpcDialogRequest] = []
    @Published private(set) var sessionFile: String?
    @Published private(set) var sessionId: String?
    @Published private(set) var turnOutcome: TurnOutcome?
    @Published private(set) var protocolVersion: Int?

    /// Bornes de S-5 : la transcription perd ses plus anciennes lignes, le journal
    /// ses plus anciennes entrées. Sans borne, une session longue tiendrait la
    /// mémoire de l'app.
    static let transcriptCeiling = 5_000
    static let journalCeiling = 500
    static let transcriptLineLimit = 4_096
    static let presentationSummaryLimit = 200

    // MARK: - Dépendances

    private let transport: RpcTransport
    private let resolveBinary: BinaryResolver
    private let requestTimeout: Duration
    private let readyTimeout: Duration
    private let stopGrace: Duration
    private let killGrace: Duration
    private let environment: [String: String]

    private static let logger = Logger(subsystem: "com.omp.console", category: "session")

    // MARK: - État interne

    private struct PendingRequest {
        let command: String
        let continuation: CheckedContinuation<RpcResponse, Error>
        var timeout: Task<Void, Never>?
    }

    private var pending: [String: PendingRequest] = [:]
    private var readyContinuation: CheckedContinuation<RpcReady, Error>?
    private var readyTimeoutTask: Task<Void, Never>?
    private var decoder: RpcChunkDecoder
    private var idCounter = 0
    private var transcriptCounter = 0
    private var journalCounter = 0
    private var exitHandled = false
    private var stopRequested = false
    private var stopping = false
    private var currentMode: RpcMode?
    private var currentProjectRoot: URL?

    init(
        transport: RpcTransport = ProcessTransport(),
        resolveBinary: @escaping BinaryResolver = { OmpBinaryResolver.resolve(environment: $0) },
        environment: [String: String] = ProcessInfo.processInfo.environment,
        requestTimeout: Duration = .seconds(30),
        readyTimeout: Duration = .seconds(30),
        stopGrace: Duration = .seconds(5),
        killGrace: Duration = .seconds(2)
    ) {
        self.transport = transport
        self.resolveBinary = resolveBinary
        self.environment = environment
        self.requestTimeout = requestTimeout
        self.readyTimeout = readyTimeout
        self.stopGrace = stopGrace
        self.killGrace = killGrace
        self.decoder = RpcChunkDecoder(ceilingBytes: RpcFrames.defaultMaxReassembledFrameBytes)
    }

    /// pid du process hébergé, pour l'affichage du statut (S-9). `nil` avant le
    /// lancement et après la sortie.
    var pid: Int32? { transport.pid }

    // MARK: - Démarrage

    func start(mode: RpcMode, projectRoot: URL, resume: Bool) async throws {
        try await begin(mode: mode, projectRoot: projectRoot, resume: resume)
    }

    private func begin(mode: RpcMode, projectRoot: URL, resume: Bool) async throws {
        switch state {
        case .launching, .running, .stopping:
            throw SessionHostError.alreadyRunning
        default:
            break
        }

        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: projectRoot.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            // Le dossier disparu n'est pas un cas de la liste close de S-3 : l'état
            // porte le message, et l'appel rend la main sans lancer de process.
            let message = "Le dossier du projet n'existe plus : \(projectRoot.path)."
            fail(message: message)
            return
        }

        if !resume {
            sessionFile = nil
            sessionId = nil
            protocolVersion = nil
        }
        turnOutcome = nil
        exitHandled = false
        stopRequested = false
        currentMode = mode
        currentProjectRoot = projectRoot

        let binary: URL
        switch resolveBinary(environment) {
        case .success(let url):
            binary = url
        case .failure(let error):
            fail(message: error.userMessage)
            throw error
        }

        var arguments = ["--mode", mode.rawValue, "--cwd", projectRoot.path]
        if resume, let file = sessionFile {
            arguments += ["--resume", file]
        }

        state = .launching
        // Les callbacks sont posés AVANT le lancement : une trame émise pendant
        // `start` (transport scripté) ne peut pas être perdue.
        transport.onLine = { [weak self] line in self?.handleLine(line) }
        transport.onLog = { [weak self] line in self?.journal(.processLog, line) }
        transport.onExit = { [weak self] exit in self?.handleExit(exit) }

        do {
            let ready = try await waitForReady(binary: binary, arguments: arguments, cwd: projectRoot)
            for note in ready.notes { journal(.protocol, note) }

            guard ready.supportedProtocolVersions.contains(2) else {
                throw SessionHostError.incompatibleProtocol(announced: ready.supportedProtocolVersions)
            }
            // Le plafond de réassemblage vient du `ready`, jamais d'une constante
            // recopiée (S-2).
            decoder = RpcChunkDecoder(ceilingBytes: ready.maxReassembledFrameBytes)

            let response = try await perform(.negotiateProtocol(id: mintId()))
            let negotiated = response.data?["protocolVersion"]?.numberValue.map { Int($0) }
            guard negotiated == 2 else {
                throw SessionHostError.negotiationRefused(response.error ?? "le process a annoncé une autre version")
            }
            protocolVersion = 2
            state = .running
        } catch {
            let hostError = SessionHostError.writeFailure(error)
            fail(message: hostError.userMessage)
            await shutdownAfterFailure()
            throw hostError
        }

        // get_state de confort : il ne doit JAMAIS faire échouer une session déjà
        // vivante (S-2) — un délai dépassé ici laisse l'état `running`.
        await refreshState()
    }

    /// Attend la trame `ready` en lançant le process : le lancement est fait DANS
    /// la continuation pour qu'une émission synchrone ne soit pas perdue.
    private func waitForReady(binary: URL, arguments: [String], cwd: URL) async throws -> RpcReady {
        let timeout = readyTimeout
        return try await withCheckedThrowingContinuation { continuation in
            readyContinuation = continuation
            readyTimeoutTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: timeout)
                guard !Task.isCancelled else { return }
                self?.resolveReady(.failure(SessionHostError.readyFrameMissing))
            }
            do {
                try transport.start(binary: binary, arguments: arguments, cwd: cwd)
            } catch {
                resolveReady(.failure(SessionHostError.binaryNotFound(searched: [binary.path], override: nil)))
            }
        }
    }

    private func resolveReady(_ result: Result<RpcReady, Error>) {
        guard let continuation = readyContinuation else { return }
        readyContinuation = nil
        readyTimeoutTask?.cancel()
        readyTimeoutTask = nil
        continuation.resume(with: result)
    }

    // MARK: - Commandes corrélées

    /// Identifiants mintés par le host : `app-1`, `app-2`, … (S-3), jamais
    /// réutilisés dans une session.
    private func mintId() -> String {
        idCounter += 1
        return "app-\(idCounter)"
    }

    @discardableResult
    func getState() async throws -> RpcResponse {
        let response = try await perform(.getState(id: mintId()))
        applyState(response)
        return response
    }

    /// Interrogation de confort : les échecs sont déjà journalisés par `perform`,
    /// l'état n'est jamais changé ici (S-2 : un `get_state` sans réponse laisse la
    /// session `running` et un `get_state` ultérieur peut réussir).
    func refreshState() async {
        _ = try? await getState()
    }

    func send(prompt: String) async throws {
        guard !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw SessionHostError.emptyPrompt
        }
        turnOutcome = nil
        _ = try await perform(.prompt(id: mintId(), message: prompt))
    }

    /// Une commande attend sa réponse corrélée par `id`, sous peine de
    /// `requestTimedOut` (S-3). La requête est enregistrée AVANT l'écriture : une
    /// réponse qui arrive pendant l'écriture ne peut pas être perdue.
    private func perform(_ command: RpcCommand) async throws -> RpcResponse {
        switch state {
        case .running, .launching:
            break
        default:
            // Rien n'est écrit quand aucune session n'est vivante (S-3).
            throw SessionHostError.notRunning
        }

        let id = command.id
        let line = command.encodedLine()
        let timeoutSeconds = Self.seconds(of: requestTimeout)
        let commandName = command.name

        return try await withCheckedThrowingContinuation { continuation in
            pending[id] = PendingRequest(command: commandName, continuation: continuation, timeout: nil)

            do {
                try transport.write(line)
            } catch {
                resolveFailure(
                    id: id,
                    error: SessionHostError.writeFailure(error)
                )
                return
            }
            appendTranscript(.outbound, "→ " + line.trimmingCharacters(in: .newlines))

            // La réponse a pu arriver pendant l'écriture : dans ce cas la requête
            // est déjà soldée et il n'y a pas de garde-fou à poser.
            guard pending[id] != nil else { return }

            let timeout = Task { @MainActor [weak self] in
                try? await Task.sleep(for: self?.requestTimeout ?? .seconds(30))
                guard !Task.isCancelled else { return }
                self?.resolveFailure(
                    id: id,
                    error: .requestTimedOut(command: commandName, seconds: timeoutSeconds)
                )
            }
            pending[id]?.timeout = timeout
        }
    }

    /// Résout une requête en échec : journal + transcription AVANT de rendre la
    /// main, pour qu'une expiration soit visible même si l'appelant ignore l'erreur
    /// (AC-13).
    private func resolveFailure(id: String, error: SessionHostError) {
        guard let entry = pending.removeValue(forKey: id) else { return }
        entry.timeout?.cancel()
        recordFailure(error)
        entry.continuation.resume(throwing: error)
    }

    private func recordFailure(_ error: SessionHostError) {
        appendTranscript(.clientError, "! \(error.userMessage)")
        journal(.clientError, error.userMessage)
    }

    private func applyState(_ response: RpcResponse) {
        guard let data = response.data else { return }
        if let file = data["sessionFile"]?.stringValue { sessionFile = file }
        if let session = data["sessionId"]?.stringValue { sessionId = session }
    }

    // MARK: - Aiguillage des trames

    private func handleLine(_ line: String) {
        switch decoder.push(line: line) {
        case .incomplete:
            return
        case .invalid(let reason):
            journal(.ignoredFrame, "trame JSONL illisible ignorée : \(reason)")
        case .frame(let logical):
            dispatch(logical)
        }
    }

    private func dispatch(_ line: String) {
        let inbound = RpcFrames.parse(line: line)

        // Avant la poignée de main, seule la trame `ready` est interprétée ; toute
        // autre est journalisée sans être interprétée et l'attente continue (S-2).
        if readyContinuation != nil {
            if case .ready(let ready) = inbound {
                resolveReady(.success(ready))
            } else {
                journal(.protocol, "trame reçue avant la poignée de main : \(RpcFrames.shortDescription(inbound))")
            }
            return
        }

        switch inbound {
        case .ready:
            journal(.protocol, "trame ready reçue hors poignée de main : ignorée")

        case .response(let response):
            handleResponse(response, raw: line)

        case .promptResult(let result):
            appendTranscript(.inbound, display(line))
            turnOutcome = TurnOutcome(
                status: result.status ?? "",
                agentInvoked: result.agentInvoked,
                sessionSettled: result.sessionSettled
            )

        case .dialog(let dialog):
            appendTranscript(.inbound, display(line))
            dialogQueue.append(dialog)

        case .dialogCancelled(let targetId):
            appendTranscript(.inbound, display(line))
            cancelDialog(targetId: targetId)

        case .presentation(let method, let summary):
            appendTranscript(.inbound, display(line))
            journal(.presentation, "présentation \(method) : \(truncate(summary, to: Self.presentationSummaryLimit))")

        case .sessionSettled, .event:
            appendTranscript(.inbound, display(line))

        case .unknown(let type):
            appendTranscript(.inbound, display(line))
            journal(.protocol, "trame de type inconnu : \(type)")

        case .unparsable(let raw):
            // AC-12 : la trame illisible est ignorée et journalisée, la session
            // reste vivante et la trame suivante est traitée normalement.
            let prefix = String(raw.prefix(200))
            journal(
                .ignoredFrame,
                "trame JSONL illisible ignorée (\(raw.utf8.count) octets) : \(prefix)"
            )
        }
    }

    private func handleResponse(_ response: RpcResponse, raw: String) {
        appendTranscript(.inbound, display(raw))

        if response.success, let error = response.error {
            journal(.protocol, "réponse « \(response.command) » porte error sans success:false : traitée comme un succès (\(error))")
        }

        guard let id = response.id else {
            journal(.protocol, "réponse sans identifiant (\(response.command)) : journalisée, jamais rattachée")
            return
        }
        guard let entry = pending.removeValue(forKey: id) else {
            journal(.protocol, "réponse ignorée : aucune requête en attente pour « \(id) »")
            return
        }
        entry.timeout?.cancel()

        if response.success {
            entry.continuation.resume(returning: response)
            return
        }
        // La négociation refusée a son propre cas (S-2) ; toute autre commande en
        // échec est rapportée avec son `command` et son `error`.
        let error: SessionHostError = response.command == "negotiate_protocol"
            ? .negotiationRefused(response.error ?? "refus sans message")
            : .commandFailed(command: response.command, error: response.error, code: response.code)
        recordFailure(error)
        entry.continuation.resume(throwing: error)
    }

    // MARK: - Dialogues

    func answer(_ response: RpcDialogResponse) throws {
        guard dialogQueue.contains(where: { $0.id == response.id }) else {
            // Rien n'est écrit quand aucun dialogue ne correspond (S-6).
            throw SessionHostError.dialogNotPending
        }
        let line = response.encodedLine()
        do {
            try transport.write(line)
        } catch {
            throw SessionHostError.writeFailure(error)
        }
        appendTranscript(.outbound, "→ " + line.trimmingCharacters(in: .newlines))
        dialogQueue.removeAll { $0.id == response.id }
    }

    /// `cancel` venu de la session (S-6) : le dialogue quitte la file, on ne
    /// répond JAMAIS — c'est la session qui a tranché.
    private func cancelDialog(targetId: String) {
        journal(.protocol, "dialogue \(targetId) annulé par la session")
        dialogQueue.removeAll { $0.id == targetId }
    }

    private func abandonDialogs(_ reason: String) {
        for dialog in dialogQueue {
            journal(.protocol, "dialogue \(dialog.id) abandonné : \(reason)")
        }
        dialogQueue.removeAll()
    }

    // MARK: - Mort et relance

    private func handleExit(_ exit: ProcessExit) {
        guard !exitHandled else {
            journal(.processExit, "seconde fin de process ignorée (\(SessionHostError.exitLabel(exit)))")
            return
        }
        exitHandled = true
        settlePendingWithProcessDied()

        // Mort pendant la poignée de main : la session n'a jamais existé, donc
        // `failed`, jamais `dead` (S-7).
        if readyContinuation != nil {
            let error = SessionHostError.processDiedBeforeHandshake(exit: exit)
            journal(.processExit, error.userMessage)
            abandonDialogs("le process est mort")
            state = .failed(message: error.userMessage)
            appendTranscript(.clientError, "! \(error.userMessage)")
            resolveReady(.failure(error))
            return
        }

        abandonDialogs(stopRequested ? "session arrêtée" : "le process est mort")

        if stopRequested {
            state = .stopped
            journal(.processExit, "session arrêtée : stdin fermé, sortie \(SessionHostError.exitLabel(exit))")
        } else if case .failed = state {
            journal(.processExit, "process terminé après un échec (\(SessionHostError.exitLabel(exit)))")
        } else {
            state = .dead(exit: exit)
            journal(.processExit, "process terminé sans arrêt demandé (\(SessionHostError.exitLabel(exit)))")
        }
    }

    private func settlePendingWithProcessDied() {
        let entries = pending
        pending.removeAll()
        for (_, entry) in entries {
            entry.timeout?.cancel()
            let error = SessionHostError.processDied(command: entry.command)
            recordFailure(error)
            entry.continuation.resume(throwing: error)
        }
    }

    /// Relance MANUELLE, uniquement depuis `dead` (S-7). Aucun chemin de code ne
    /// l'appelle tout seul.
    func relaunch() async throws {
        switch state {
        case .dead:
            break
        case .idle, .stopped, .failed:
            throw SessionHostError.notRunning
        case .launching, .running, .stopping:
            throw SessionHostError.alreadyRunning
        }
        guard let mode = currentMode, let projectRoot = currentProjectRoot else {
            throw SessionHostError.notRunning
        }
        let resuming = sessionFile != nil
        if !resuming {
            journal(.protocol, "aucun fichier de session connu : relance à neuf")
        }
        try await begin(mode: mode, projectRoot: projectRoot, resume: resuming)
    }

    // MARK: - Arrêt propre

    func stop() async {
        await shutdown()
    }

    /// Fermeture de l'app : c'est l'UNIQUE entrée de sortie, et elle partage son
    /// implémentation avec le bouton (S-8), pour qu'il n'existe pas deux séquences
    /// d'arrêt à tenir synchronisées.
    func terminateForQuit() async {
        await shutdown()
    }

    private func shutdown() async {
        switch state {
        case .idle, .stopped, .failed:
            return
        default:
            break
        }
        guard !stopping else { return }
        stopping = true
        defer { stopping = false }

        stopRequested = true
        state = .stopping
        settlePendingWithProcessDied()
        abandonDialogs("session arrêtée")

        // 1) fin propre : fermeture de stdin, le process draine et sort.
        transport.closeStdin()
        if await waitForExit(within: stopGrace) {
            if case .stopped = state {} else { state = .stopped }
            return
        }

        // 2) escalade : le process n'a pas rendu la main.
        journal(
            .processExit,
            "arrêt forcé (SIGTERM) : le process n'a pas rendu la main en \(SessionHostError.secondsText(Self.seconds(of: stopGrace))) s"
        )
        transport.signal(SIGTERM)
        if await waitForExit(within: killGrace) {
            if case .stopped = state {} else { state = .stopped }
            return
        }

        journal(
            .processExit,
            "arrêt forcé (SIGKILL) : le process n'a pas rendu la main en \(SessionHostError.secondsText(Self.seconds(of: killGrace))) s"
        )
        transport.signal(SIGKILL)
        _ = await waitForExit(within: .seconds(1))
        if case .stopped = state {} else { state = .stopped }
    }

    /// Attente bornée de la sortie EFFECTIVE du process. La sortie met `isRunning`
    /// à `false` via le transport, donc la boucle observe le vrai état, pas une
    /// intention.
    private func waitForExit(within duration: Duration) async -> Bool {
        let deadline = ContinuousClock.now + duration
        while ContinuousClock.now < deadline {
            if !transport.isRunning { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return !transport.isRunning
    }

    /// Arrêt technique après un échec de démarrage (S-2 : « le process est
    /// terminé »). Le `.jsonl` n'est jamais touché.
    ///
    /// Il ne pose PAS `stopRequested` : cet indicateur veut dire « un arrêt a été
    /// demandé par l'utilisateur (bouton ou fermeture de l'app) », et un démontage
    /// technique n'en est pas un. S'il le posait, la sortie du process — qui suit
    /// toujours, puisque c'est le but de ce démontage — passerait par la branche
    /// `stopRequested` de `handleExit` et remplacerait l'échec de démarrage par
    /// `stopped` : la fenêtre afficherait « Session arrêtée » au lieu du message
    /// d'erreur, alors que S-2 exige que l'état reste `failed(...)`.
    private func shutdownAfterFailure() async {
        transport.closeStdin()
        guard transport.isRunning else { return }
        _ = await waitForExit(within: .milliseconds(300))
        if transport.isRunning { transport.signal(SIGTERM) }
        _ = await waitForExit(within: .milliseconds(300))
        if transport.isRunning { transport.signal(SIGKILL) }
    }

    // MARK: - Écritures bornées

    private func fail(message: String) {
        state = .failed(message: message)
        appendTranscript(.clientError, "! \(message)")
    }

    private func appendTranscript(_ kind: TranscriptLine.Kind, _ text: String) {
        transcriptCounter += 1
        transcript.append(TranscriptLine(id: transcriptCounter, kind: kind, text: text))
        if transcript.count > Self.transcriptCeiling {
            transcript.removeFirst(transcript.count - Self.transcriptCeiling)
        }
    }

    private func journal(_ kind: JournalEntry.Kind, _ message: String) {
        journalCounter += 1
        journal.append(JournalEntry(id: journalCounter, kind: kind, message: message))
        if journal.count > Self.journalCeiling {
            journal.removeFirst(journal.count - Self.journalCeiling)
        }
        Self.logger.log("\(message, privacy: .public)")
    }

    /// Toute trame non reconnue est affichée telle quelle, tronquée à 4 096
    /// caractères (S-5).
    private func display(_ line: String) -> String {
        guard line.count > Self.transcriptLineLimit else { return line }
        let head = String(line.prefix(Self.transcriptLineLimit))
        let dropped = line.utf8.count - head.utf8.count
        return head + "…[\(dropped) octets tronqués]"
    }

    private func truncate(_ text: String, to limit: Int) -> String {
        guard text.count > limit else { return text }
        return String(text.prefix(limit)) + "…"
    }

    static func seconds(of duration: Duration) -> Double {
        let components = duration.components
        return Double(components.seconds) + Double(components.attoseconds) * 1e-18
    }
}
