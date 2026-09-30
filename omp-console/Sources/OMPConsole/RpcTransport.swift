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

import Darwin
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
    /// `write(2)` a échoué sur un `errno` autre que `EINTR`/`EAGAIN` (EPIPE = 32
    /// quand plus personne ne lit l'entrée du process).
    case writeFailed(Int32)
    /// L'échéance d'écriture est tombée sans que le process accepte les octets.
    case writeTimedOut(milliseconds: Int)

    /// L'UNIQUE table de texte du transport : le host ne compose pas le message,
    /// il traduit cette raison (S-2).
    var userReason: String {
        switch self {
        case .stdinClosed:
            return "l'entrée de la session est fermée"
        case .notRunning:
            return "aucun process n'est lancé"
        case .writeFailed(32):
            return "le process ne lit plus son entrée (EPIPE)"
        case .writeFailed(let code):
            return "erreur \(code)"
        case .writeTimedOut(let milliseconds):
            return "le process n'accepte plus d'octets (délai de \(milliseconds) ms dépassé)"
        }
    }
}

/// Échéance d'une écriture sur le tube d'entrée du transport RPC : même forme et
/// même valeur que `terminalWriteGrace` (S-1). Une échéance par appel, jamais
/// partagée ni prolongée.
private let rpcWriteGrace: Duration = .milliseconds(500)

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
        // Le lancement et le découpage en lignes sont partagés (`ProcessRunner`) ;
        // le transport garde ce qui lui est propre : son `Process` recréé à chaque
        // lancement, son stdin alimenté, son `terminationHandler`, ses signaux et
        // sa séquence d'arrêt (S-5, aucune escalade ici).
        let child = ProcessRunner.child(
            binary: binary,
            arguments: arguments,
            cwd: cwd,
            // L'environnement est HÉRITÉ (S-1) : c'est lui qui porte `HOME`, donc la
            // configuration `~/.omp` du process hébergé.
            environment: ProcessInfo.processInfo.environment,
            input: .pipe
        )
        let process = child.process
        self.process = process
        self.stdinPipe = child.stdin
        stdinClosed = false
        stdinHandle = child.stdin?.fileHandleForWriting
        // Le tube stdin est recréé à chaque `start`, donc les drapeaux le sont
        // aussi. Sur le fd d'écriture du tube stdin et sur lui seul : jamais de
        // SIGPIPE (drapeau par fd, jamais `signal(SIGPIPE, …)` global), puis fd non
        // bloquant pour que la boucle d'écriture borne son attente (S-1).
        if let stdinFD = child.stdin?.fileHandleForWriting.fileDescriptor {
            _ = fcntl(stdinFD, F_SETNOSIGPIPE, 1)
            _ = fcntl(stdinFD, F_SETFL, O_NONBLOCK)
        }

        let stdoutStream = AsyncStream<String> { continuation in
            ProcessRunner.pumpLines(
                child.stdout.fileHandleForReading,
                yield: { continuation.yield($0) },
                finish: { continuation.finish() }
            )
        }
        let stderrStream = AsyncStream<String> { continuation in
            ProcessRunner.pumpLines(
                child.stderr.fileHandleForReading,
                yield: { continuation.yield($0) },
                finish: { continuation.finish() }
            )
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

        // Boucle bornée, sur les octets et dans l'ordre : `EINTR` relance sans
        // consommer l'échéance, `EAGAIN` attend un `POLLOUT` de 20 ms, tout autre
        // `errno` est un échec nommé — jamais un blocage du MainActor, jamais une
        // perte silencieuse (S-1).
        let bytes = Array(line.utf8)
        let fd = handle.fileDescriptor
        var offset = 0
        let deadline = ContinuousClock.now + rpcWriteGrace
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes { buffer in
                Darwin.write(fd, buffer.baseAddress! + offset, bytes.count - offset)
            }
            if written > 0 {
                offset += written
                continue
            }
            if written < 0, errno == EINTR { continue }
            if written < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                guard ContinuousClock.now < deadline else {
                    let milliseconds = Int(rpcWriteGrace / .milliseconds(1))
                    throw TransportFailure.writeTimedOut(milliseconds: milliseconds)
                }
                var descriptor = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
                _ = Darwin.poll(&descriptor, 1, 20)
                continue
            }
            throw TransportFailure.writeFailed(errno)
        }
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
}
