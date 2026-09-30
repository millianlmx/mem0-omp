// L'exécuteur de process PARTAGÉ (S-1) : un seul lancement, un seul drainage, une
// seule découpe en lignes, une seule escalade — pour les trois appelants qui
// lancent une commande (`GitCLI`, `GhCLI`, `ProcessTransport`).
//
// Ce que ce fichier ne connaît PAS, et ne doit jamais connaître : git, gh, `omp`,
// et tout message destiné à l'utilisateur. La traduction d'un échec en erreur de
// domaine appartient à l'appelant, qui garde ses textes.
//
// Invariant de l'échéance (S-3) : à l'expiration, l'enfant reçoit SIGTERM, puis
// SIGKILL après `killGrace` s'il vit encore, et l'appel ne rend la main qu'une fois
// l'enfant MORT ET RÉCOLLÉ — la fin vient du `terminationHandler` de Foundation,
// jamais d'une intention. C'est le patron de `TerminalHost.kill` et de
// `SessionHost.waitForExit`.
//
// Le PTY de `Terminal/TerminalHost.swift` est HORS périmètre : un `forkpty` n'est
// pas un `Process`, et sa session a sa propre séquence d'arrêt.

import Darwin
import Dispatch
import Foundation

// MARK: - Ce que l'appelant fournit

/// La forme de l'entrée standard de l'enfant : le tube muet (`/dev/null`) d'une
/// commande collectée, ou un tube que l'appelant alimente (la session hébergée).
enum ProcessStdin: Sendable {
    case nullDevice
    case pipe
}

/// Un enfant CONFIGURÉ, pas encore lancé. `@unchecked Sendable` : `Process` n'est
/// pas `Sendable`, mais seules `run`/`terminate`/`isRunning`/`processIdentifier`
/// sont employées, depuis des files sûres.
struct ProcessChild: @unchecked Sendable {
    let process: Process
    /// non nil ⇔ `input == .pipe` ; l'écrivain est `stdin.fileHandleForWriting`.
    let stdin: Pipe?
    let stdout: Pipe
    let stderr: Pipe
}

/// Le résultat d'une commande COLLECTÉE (les deux tubes lus jusqu'à EOF).
struct ProcessRun: Equatable, Sendable {
    var code: Int32
    var stdout: String
    var stderr: String
    var timedOut: Bool
}

/// L'échec du SEUL lancement (binaire absent ou non exécutable) : la traduction en
/// erreur de domaine appartient à l'appelant, qui garde ses messages actuels.
enum ProcessRunnerError: Error, Equatable, Sendable {
    case launchFailed(detail: String)
}

// MARK: - L'exécuteur

enum ProcessRunner {
    /// Grâce accordée à l'enfant entre SIGTERM et SIGKILL : UNE constante, alignée
    /// sur `SessionHost.killGrace` (SessionHost.swift:210) et
    /// `TerminalHost.terminalStopGrace` (TerminalHost.swift:37), toutes deux à 2 s.
    static let killGrace: Duration = .seconds(2)

    /// Configure l'enfant — binaire, argv BRUT, cwd, environnement, les trois tubes,
    /// stdin selon `input`. AUCUN lancement ici, aucun shell, aucun préfixe ajouté :
    /// c'est l'appelant qui décide de son argv exact.
    static func child(
        binary: URL,
        arguments: [String],
        cwd: URL,
        environment: [String: String],
        input: ProcessStdin
    ) -> ProcessChild {
        let process = Process()
        process.executableURL = binary
        process.arguments = arguments
        process.currentDirectoryURL = cwd
        process.environment = environment

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        let stdin: Pipe?
        switch input {
        case .nullDevice:
            process.standardInput = FileHandle.nullDevice
            stdin = nil
        case .pipe:
            let pipe = Pipe()
            process.standardInput = pipe
            stdin = pipe
        }

        return ProcessChild(process: process, stdin: stdin, stdout: stdout, stderr: stderr)
    }

    /// Lance l'enfant, draine les DEUX tubes en parallèle, et ne rend la main que
    /// lorsque l'enfant est MORT ET RÉCOLLÉ. À l'échéance : SIGTERM, puis SIGKILL
    /// après `killGrace` (S-3).
    ///
    /// `ProcessChild.process` n'est pas touché au-delà de ce que `child` a posé,
    /// sauf le `terminationHandler` — que l'appelant direct de `child`
    /// (`ProcessTransport`) pose lui-même puisqu'il ne passe pas par `run`.
    static func run(_ child: ProcessChild, timeout: Double) async throws -> ProcessRun {
        let process = child.process
        let drain = Drain()
        let exit = Exit()
        let control = Control(process: process)
        process.terminationHandler = { finished in
            exit.finish(code: finished.terminationStatus)
        }

        do {
            try process.run()
        } catch {
            throw ProcessRunnerError.launchFailed(detail: error.localizedDescription)
        }

        // Les deux tubes sont drainés EN PARALLÈLE, dans des fils détachés : lire un
        // tube après l'autre bloquerait dès que le premier se remplit, le process
        // attendant alors d'écrire sur le second.
        pumpBytes(child.stdout.fileHandleForReading, into: drain, stderr: false)
        pumpBytes(child.stderr.fileHandleForReading, into: drain, stderr: true)

        // L'échéance : un process qui ne rend pas la main reçoit SIGTERM, puis
        // SIGKILL après la grâce. Le second signal n'est armé que si le premier n'a
        // pas suffi (`isRunning` est l'état RÉEL, pas une intention).
        DispatchQueue.global().asyncAfter(deadline: .now() + timeout) {
            guard control.isRunning else { return }
            control.markTimedOut()
            control.sendTerminate()
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds(of: ProcessRunner.killGrace)) {
                guard control.isRunning else { return }
                control.sendKill()
            }
        }

        // La borne est celle de la spec : délai + deux grâces. Le drainage est borné
        // à part, pour qu'un tube resté ouvert ne prolonge pas l'appel.
        let bound = Duration.seconds(timeout) + ProcessRunner.killGrace + ProcessRunner.killGrace
        let code = await exit.wait(within: bound)
        _ = await drain.awaitEnd(within: ProcessRunner.killGrace)
        let output = drain.output

        return ProcessRun(
            code: code ?? -1,
            stdout: output.stdout,
            stderr: output.stderr,
            timedOut: control.timedOut
        )
    }

    /// Découpe un tube en LIGNES jusqu'à EOF dans un fil détaché (dernière ligne
    /// partielle comprise, `\r` final retiré), puis appelle `finish` une seule fois.
    /// `availableData` rend 0 octet à la fin du flux : c'est la seule condition de
    /// sortie, et elle n'est atteinte que lorsque le process a fermé ses tubes.
    ///
    /// Les deux rappels sont `@Sendable` : ils sont appelés depuis ce fil détaché.
    static func pumpLines(
        _ handle: FileHandle,
        yield: @escaping @Sendable (String) -> Void,
        finish: @escaping @Sendable () -> Void
    ) {
        Thread.detachNewThread {
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty {
                    if !buffer.isEmpty, let tail = String(data: buffer, encoding: .utf8) {
                        yield(tail)
                    }
                    finish()
                    return
                }
                buffer.append(chunk)
                while let index = buffer.firstIndex(of: 0x0A) {
                    let lineData = buffer[buffer.startIndex..<index]
                    buffer.removeSubrange(buffer.startIndex...index)
                    var text = String(data: Data(lineData), encoding: .utf8) ?? ""
                    if text.hasSuffix("\r") { text.removeLast() }
                    yield(text)
                }
            }
        }
    }

    /// Le drainage d'une commande COLLECTÉE : les octets bruts, fil par fil.
    private static func pumpBytes(_ handle: FileHandle, into drain: Drain, stderr: Bool) {
        Thread.detachNewThread {
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                drain.append(chunk, stderr: stderr)
            }
            drain.end()
        }
    }
}

/// `Duration` → secondes, pour les échéances de `DispatchQueue.asyncAfter` (même
/// conversion que `SessionHost.seconds(of:)`).
private func seconds(of duration: Duration) -> Double {
    let components = duration.components
    return Double(components.seconds) + Double(components.attoseconds) * 1e-18
}

// MARK: - Ce que `run` partage avec ses fils

/// Les deux tampons de sortie, gardés par un verrou : les fils de drain écrivent,
/// le fil appelant lit, et personne d'autre n'y touche.
final class Drain: @unchecked Sendable {
    private let lock = NSLock()
    private var stdoutData = Data()
    private var stderrData = Data()
    private var pending = 2
    private var waiters: [CheckedContinuation<Void, Never>] = []
    private var boundedWaiter: CheckedContinuation<Bool, Never>?
    private var boundedWake: DispatchWorkItem?

    func append(_ data: Data, stderr: Bool) {
        lock.lock()
        if stderr { stderrData.append(data) } else { stdoutData.append(data) }
        lock.unlock()
    }

    /// Appelée par chaque fil de drain ; le second réveille les attentes.
    func end() {
        lock.lock()
        pending -= 1
        let done = pending <= 0
        let waiting = done ? waiters : []
        if done { waiters = [] }
        let bounded = done ? boundedWaiter : nil
        let wake = done ? boundedWake : nil
        if done {
            boundedWaiter = nil
            boundedWake = nil
        }
        lock.unlock()
        wake?.cancel()
        for waiter in waiting { waiter.resume() }
        bounded?.resume(returning: true)
    }

    /// Attend que les DEUX tubes aient atteint EOF : sans cela, une sortie encore
    /// en vol serait tronquée au moment où le process rend la main.
    func awaitEnd() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if pending <= 0 {
                lock.unlock()
                continuation.resume()
                return
            }
            waiters.append(continuation)
            lock.unlock()
        }
    }

    /// L'attente BORNÉE : rend `true` si les deux tubes ont atteint EOF dans la
    /// borne, `false` sinon — un tuyau resté ouvert ne peut pas prolonger l'appel.
    func awaitEnd(within duration: Duration) async -> Bool {
        await withCheckedContinuation { continuation in
            let work = DispatchWorkItem { [weak self] in
                guard let self else {
                    continuation.resume(returning: false)
                    return
                }
                self.lock.lock()
                let bounded = self.boundedWaiter
                self.boundedWaiter = nil
                self.boundedWake = nil
                let done = self.pending <= 0
                self.lock.unlock()
                bounded?.resume(returning: done)
            }
            lock.lock()
            if pending <= 0 {
                lock.unlock()
                continuation.resume(returning: true)
                return
            }
            boundedWaiter = continuation
            boundedWake = work
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds(of: duration), execute: work)
        }
    }

    var output: (stdout: String, stderr: String) {
        lock.lock()
        defer { lock.unlock() }
        return (String(decoding: stdoutData, as: UTF8.self), String(decoding: stderrData, as: UTF8.self))
    }
}

/// La fin du process, en attente asynchrone.
final class Exit: @unchecked Sendable {
    private let lock = NSLock()
    private var code: Int32?
    private var waiter: CheckedContinuation<Int32, Never>?
    private var boundedWaiter: CheckedContinuation<Int32?, Never>?
    private var boundedWake: DispatchWorkItem?

    func finish(code: Int32) {
        lock.lock()
        self.code = code
        let waiter = self.waiter
        self.waiter = nil
        let bounded = self.boundedWaiter
        self.boundedWaiter = nil
        let wake = self.boundedWake
        self.boundedWake = nil
        lock.unlock()
        wake?.cancel()
        waiter?.resume(returning: code)
        bounded?.resume(returning: code)
    }

    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let code {
                lock.unlock()
                continuation.resume(returning: code)
                return
            }
            waiter = continuation
            lock.unlock()
        }
    }

    /// L'attente BORNÉE : rend le code si l'enfant est mort dans la borne, `nil`
    /// sinon. La continuation n'est reprise qu'UNE fois : `finish` et le réveil de
    /// borne se disputent le même champ sous verrou, et le perdant ne reprend rien.
    func wait(within duration: Duration) async -> Int32? {
        await withCheckedContinuation { continuation in
            let work = DispatchWorkItem { [weak self] in
                guard let self else {
                    continuation.resume(returning: nil)
                    return
                }
                self.lock.lock()
                let bounded = self.boundedWaiter
                self.boundedWaiter = nil
                self.boundedWake = nil
                let finished = self.code
                self.lock.unlock()
                bounded?.resume(returning: finished)
            }
            lock.lock()
            if let code {
                lock.unlock()
                continuation.resume(returning: code)
                return
            }
            boundedWaiter = continuation
            boundedWake = work
            lock.unlock()
            DispatchQueue.global().asyncAfter(deadline: .now() + seconds(of: duration), execute: work)
        }
    }
}

/// Le process, vu du watchdog. `Process` n'est pas `Sendable`, mais `isRunning`,
/// `processIdentifier`, `terminate` et `kill` sont les seules opérations employées,
/// et elles sont sûres depuis n'importe quelle file.
final class Control: @unchecked Sendable {
    private let lock = NSLock()
    private let process: Process
    private var timedOutFlag = false

    init(process: Process) {
        self.process = process
    }

    func markTimedOut() {
        lock.lock()
        timedOutFlag = true
        lock.unlock()
    }

    var timedOut: Bool {
        lock.lock()
        defer { lock.unlock() }
        return timedOutFlag
    }

    var isRunning: Bool {
        lock.lock()
        defer { lock.unlock() }
        return process.isRunning
    }

    /// `processIdentifier` n'a de sens qu'après `run()` (il vaut 0 avant) : un pid
    /// ≤ 0 n'en est pas un et ne doit JAMAIS être signalé — `kill(0, ·)` frapperait
    /// tout le groupe de l'app.
    var pid: Int32? {
        lock.lock()
        defer { lock.unlock() }
        let value = process.processIdentifier
        return value > 0 ? value : nil
    }

    /// SIGTERM : `terminate()`, qui vise le process ET ses sous-tâches.
    func sendTerminate() {
        lock.lock()
        let process = self.process
        lock.unlock()
        process.terminate()
    }

    /// SIGKILL, au seul pid de l'enfant DIRECT, et seulement si c'en est un.
    func sendKill() {
        guard let pid else { return }
        Darwin.kill(pid, SIGKILL)
    }
}
