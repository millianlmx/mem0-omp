// Transport du process hébergé : le seul endroit qui touche à `Process`, à un
// tube et à un signal (S-1, S-8, D2).
//
// Le host ne connaît QUE ce protocole : c'est ce qui permet aux preuves de
// piloter un transport scripté (S-10, BR-5) sans jamais lancer `omp`, et de
// prouver les états limites (mort, escalade, réponse inversée) sans dépendre de
// la machine.
//
// Le protocole est isolé au `MainActor` : `Process` et `FileHandle` sont pilotés
// depuis le fil principal, et les callbacks sont donc déjà sur le bon acteur —
// pas de saut de fil à écrire dans le host.
//
// Lecture de stdout : un fil détaché bloque sur `FileHandle.availableData`
// (documenté : il débloque dès qu'une donnée est là, et rend 0 octet à la fin du
// flux), découpe en lignes et alimente un `AsyncStream` consommé sur le
// MainActor. C'est le motif compilé en D5 sur ce toolchain (CLT seuls).

import Foundation

/// Sortie du process, dans les deux formes que D2 impose de distinguer : une fin
/// propre (`exited`) n'a pas la même valeur qu'une mort subie (`uncaughtSignal`).
struct ProcessExit: Equatable, Sendable {
    enum Reason: Equatable, Sendable {
        case exited
        case uncaughtSignal
    }

    let status: Int32
    let reason: Reason
}

/// Erreurs de transport, volontairement pauvres : le host les traduit en
/// `SessionHostError` (S-3), il n'expose jamais un `NSError` brut à l'utilisateur.
enum TransportFailure: Error, Equatable {
    case stdinClosed
    case notRunning
}

@MainActor
protocol RpcTransport: AnyObject {
    /// Une ligne JSONL brute, sans le `\n`.
    var onLine: ((String) -> Void)? { get set }
    /// stderr du process, ligne à ligne.
    var onLog: ((String) -> Void)? { get set }
    /// Fin du process.
    var onExit: ((ProcessExit) -> Void)? { get set }

    func start(binary: URL, arguments: [String], cwd: URL) throws
    func write(_ line: String) throws
    func closeStdin()
    func signal(_ number: Int32)

    var isRunning: Bool { get }
    var pid: Int32? { get }
}

@MainActor
final class ProcessTransport: RpcTransport {
    var onLine: ((String) -> Void)?
    var onLog: ((String) -> Void)?
    var onExit: ((ProcessExit) -> Void)?

    // Le `Process` et ses tubes sont recréés à CHAQUE lancement : `Foundation`
    // refuse de relancer un `Process` déjà lancé (« task already launched », mesuré
    // sur la relance réelle de S-7), alors que le host réutilise le même transport
    // pour relancer une session morte (S-1 : un transport injecté une fois).
    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdinHandle: FileHandle?
    private var stdinClosed = false
    private var stdoutTask: Task<Void, Never>?
    private var stderrTask: Task<Void, Never>?

    private(set) var isRunning = false

    /// `processIdentifier` n'a de sens qu'après `run()` : avant, il vaut -1 et le
    /// présenter comme un pid ferait mentir l'état affiché (S-9).
    var pid: Int32? {
        guard isRunning, let process else { return nil }
        let value = process.processIdentifier
        return value > 0 ? value : nil
    }

    func start(binary: URL, arguments: [String], cwd: URL) throws {
        let process = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        self.process = process
        self.stdinPipe = stdinPipe
        stdinClosed = false

        process.executableURL = binary
        process.arguments = arguments
        process.currentDirectoryURL = cwd
        // L'environnement est HÉRITÉ (S-1) : c'est lui qui porte `HOME`, donc la
        // configuration `~/.omp` du process hébergé.
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        stdinHandle = stdinPipe.fileHandleForWriting

        let stdoutStream = AsyncStream<String> { continuation in
            Self.pump(stdoutPipe.fileHandleForReading, into: continuation)
        }
        let stderrStream = AsyncStream<String> { continuation in
            Self.pump(stderrPipe.fileHandleForReading, into: continuation)
        }
        stdoutTask = Task { @MainActor [weak self] in
            for await line in stdoutStream { self?.onLine?(line) }
        }
        stderrTask = Task { @MainActor [weak self] in
            for await line in stderrStream { self?.onLog?(line) }
        }

        process.terminationHandler = { [weak self] proc in
            // `terminationHandler` est appelé HORS du fil principal (D2) : on lit
            // les deux valeurs ici, puis on revient sur le MainActor.
            let reason: ProcessExit.Reason = proc.terminationReason == .uncaughtSignal ? .uncaughtSignal : .exited
            let exit = ProcessExit(status: proc.terminationStatus, reason: reason)
            Task { @MainActor in
                self?.isRunning = false
                self?.onExit?(exit)
            }
        }

        try process.run()
        isRunning = true
    }

    func write(_ line: String) throws {
        guard isRunning else { throw TransportFailure.notRunning }
        guard !stdinClosed, let handle = stdinHandle else { throw TransportFailure.stdinClosed }
        try handle.write(contentsOf: Data(line.utf8))
    }

    /// Fermeture de stdin = fin propre demandée au process (D1 : à la fermeture,
    /// omp draine ses commandes, dispose la session et sort code 0).
    func closeStdin() {
        guard !stdinClosed else { return }
        stdinClosed = true
        try? stdinHandle?.close()
    }

    func signal(_ number: Int32) {
        guard let pid else { return }
        kill(pid, number)
    }

    /// Découpe un tube en lignes dans un fil détaché, puis alimente le flux.
    /// Statique et `nonisolated` : il ne touche aucun état du MainActor.
    private nonisolated static func pump(_ handle: FileHandle, into continuation: AsyncStream<String>.Continuation) {
        Thread.detachNewThread {
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty {
                    if !buffer.isEmpty, let tail = String(data: buffer, encoding: .utf8) {
                        continuation.yield(tail)
                    }
                    continuation.finish()
                    return
                }
                buffer.append(chunk)
                while let index = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer[buffer.startIndex..<index]
                    buffer.removeSubrange(buffer.startIndex...index)
                    var text = String(data: Data(lineData), encoding: .utf8) ?? ""
                    if text.hasSuffix("\r") { text.removeLast() }
                    continuation.yield(text)
                }
            }
        }
    }
}
