// L'hôte du PTY : le seul fichier qui ouvre un pseudo-terminal et qui possède le
// cycle de vie du programme interactif — le shell de connexion de l'utilisateur
// depuis S-18 R6 (BR-1 ; AC-1, AC-3, AC-7, AC-8, AC-9).
//
// Cinq décisions, mesurées sur ce poste (Doc-3) ou imposées par Doc-5 :
//
//   1. `forkpty` fait tout : `openpty`, `fork` et `login_tty`. `winp` non nul fixe
//      la taille de la réplique AVANT que l'enfant ne s'exécute (la taille initiale
//      est donc déjà la bonne quand le shell démarre), et `login_tty` fait du fils
//      un chef de session dont le groupe de process vaut son pid : `kill(-pid)`
//      atteint le shell et ses descendants de même groupe ; un job au premier plan
//      (omp lancé depuis le shell) reçoit `SIGHUP` du noyau quand le chef de session
//      meurt — c'est ce qui garantit AC-8/AC-9.
//   2. `termp` est NUL : la réplique naît avec les réglages par défaut du noyau
//      (`ICANON`, `ECHO`, `ISIG`, `OPOST|ONLCR`), ceux d'un vrai terminal. Mesuré
//      (S-18) : un mode brut posé ici était hérité par zsh, qui le rendait à ses
//      commandes — Ctrl-C n'interrompait plus `sleep`. Une TUI (omp) pose elle-même
//      son mode brut ; Ctrl-C lui arrive alors comme l'octet 0x03.
//   3. Dans le fils il n'y a QUE des appels C async-signal-safe (`close`, `chdir`,
//      `execve`, `_exit`) : pas de runtime Swift, pas d'Objective-C, pas d'`atexit`.
//      Tout ce qui s'alloue (`argv`, `envp`, le cwd) est construit AVANT le fork.
//      Le fils ferme en outre TOUT descripteur ≥ 3 — borné par `getdtablesize()` lu
//      AVANT le fork (`closefrom(3)` n'est pas déclaré par le SDK macOS, Doc-5, et
//      `getdtablesize` ne figure pas dans la liste async-signal-safe, Doc-3) : le
//      shell démarre avec 0, 1 et 2 seuls, sans liste blanche.
//   4. Le maître est NON BLOQUANT et le lecteur attend dans `poll(2)` : une écriture
//      qui ne passe pas ne fige pas le MainActor, et le lecteur rend la main sur
//      demande — donc personne ne ferme un descripteur pendant qu'un fil y est
//      bloqué.
//   5. La sortie passe par une file PLAFONNÉE (Doc-5) : au-delà du plafond le
//      lecteur PAUSE jusqu'à la vidange du MainActor. Sans ce plafond, une TUI
//      bavarde remplirait la mémoire sans borne.

import Darwin
import Dispatch
import Foundation

/// La fin du process hébergé a EXACTEMENT la forme de celle du transport RPC (S-1) :
/// une fin propre n'a pas la valeur d'une mort subie, et les deux fenêtres en
/// parlent donc de la même façon.
typealias TerminalExit = ProcessExit

/// Réglages du PTY, au niveau du fichier pour que la boucle de lecture (hors
/// MainActor) les lise sans traverser l'isolation de l'acteur.
private let terminalStopGrace: Duration = .seconds(2)
private let terminalKillGrace: Duration = .seconds(2)
private let terminalLastBytesGrace: Duration = .milliseconds(150)
private let terminalReadChunk = 64 * 1024
private let terminalPendingCeiling = 1 << 20
private let terminalWriteGrace: Duration = .milliseconds(500)

// Non `final` pour une seule raison : une doublure de test sous-classe `start` afin
// de rendre un échec `forkpty` (jargon-technique-expose-mac-et-ios, S-7 AC-7).
@MainActor
class TerminalHost {
    // MARK: - Interface

    var onOutput: (([UInt8]) -> Void)?
    var onExit: ((TerminalExit) -> Void)?

    /// Pid du fils DIRECT de l'app : celui que `forkpty` a rendu (le shell), sans
    /// intermédiaire. `nil` hors exécution, et dès que l'enfant a été récolté.
    var pid: Int32? { childPID }

    /// « Enfant vivant ET non récolté » : la mort du fils rend donc faux AVANT même
    /// le rappel `onExit` — l'état affiché ne ment jamais sur la vie du process.
    var isRunning: Bool { childPID != nil }

    // MARK: - État

    private var childPID: Int32?
    /// Groupe de process de la session (`login_tty` garantit `pgid == pid`). Il
    /// survit à la récolte du fils pour que `kill()` balaie encore les orphelins.
    private var groupPID: Int32?
    private var pty: PTYMaster?
    private var buffer: PTYBuffer?
    private var lifespan: PTYLifespan?
    private var exitSource: DispatchSourceProcess?
    private var exit: TerminalExit?
    private var exitDelivered = false
    private var streamEnded = false
    private var deliveryScheduled = false
    private var killTask: Task<Void, Never>?
    /// Taille demandée alors qu'aucun process ne tourne : appliquée au prochain
    /// `start` (S-6, cas limite « redimensionnement après la mort du process »).
    private var memorizedSize: (columns: Int, rows: Int)?

    init() {}

    // MARK: - Lancement (BR-1 étape 2)

    /// Lance UN programme dans un PTY neuf : `argv` = le chemin de l'exécutable puis
    /// `arguments` (le `-l` du shell de connexion, `TerminalShell.command`).
    func start(executable: URL, arguments: [String] = [], cwd: URL, columns: Int, rows: Int) throws {
        // C'est le fichier EXÉCUTABLE qui gagne, jamais le seul fait d'exister.
        guard FileManager.default.isExecutableFile(atPath: executable.path) else {
            throw TerminalHostError.executableNotFound(executable.path)
        }

        teardownFinishedRun()

        let requested = memorizedSize ?? (max(1, columns), max(1, rows))
        memorizedSize = nil

        // `termp` reste NUL (décision 2) : seuls la taille et le chemin sont posés.
        var windowSize = winsize(
            ws_row: UInt16(clamping: requested.1),
            ws_col: UInt16(clamping: requested.0),
            ws_xpixel: 0,
            ws_ypixel: 0
        )

        let environment = TerminalEnvironment.child(
            base: ProcessInfo.processInfo.environment,
            executable: executable
        )

        // TOUT ce qui s'alloue est construit AVANT le fork : après, l'enfant ne peut
        // plus exécuter de code Swift (ni `String`, ni ARC, ni `autoreleasepool`).
        var argv = Self.cStrings([executable.path] + arguments)
        var variables = Self.cStrings(
            environment.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }
        )
        let workingDirectory = strdup(cwd.path)
        defer {
            Self.freeCStrings(argv)
            Self.freeCStrings(variables)
            free(workingDirectory)
        }

        // La borne de la fermeture est lue AVANT le fork : `getdtablesize()` ne figure
        // pas dans la liste des appels async-signal-safe (Doc-3), il n'a donc rien à
        // faire dans le fils. Sa valeur est la borne EXACTE de la table, soit
        // min(`RLIMIT_NOFILE` souple, `kern.maxfilesperproc`) — 184320 sur ce poste,
        // donc 184319 = plus grand numéro qu'un `dup2` accepte (mesuré, Doc-4).
        // Borner par `rlim_cur` ferait ≈ 860 000 `close` inutiles au-dessus de ce
        // plafond réel.
        let descriptorTableSize = getdtablesize()

        var master: Int32 = -1
        let child = forkpty(&master, nil, nil, &windowSize)

        if child == 0 {
            // Fil enfant : appels C seulement, et `_exit` (jamais `exit`, qui
            // déroulerait les `atexit` hérités du parent).
            // Aucun descripteur hérité ne passe dans le shell : l'enfant ne garde que 0, 1 et 2.
            // (Le primaire du PTY n'est pas hérité au-delà de 2 — Doc-1 ; `close` d'un
            // descripteur déjà fermé rend `EBADF`, c'est le cas NORMAL, jamais une erreur.)
            var descriptor: Int32 = 3
            while descriptor < descriptorTableSize {
                close(descriptor)
                descriptor += 1
            }
            if chdir(workingDirectory) != 0 { _exit(127) }
            execve(argv[0], &argv, &variables)
            _exit(127)
        }

        if child < 0 {
            throw TerminalHostError.ptyUnavailable(errno)
        }

        // Le non-blocage est posé sur la DESCRIPTION de fichier du maître : celle de
        // la réplique (donc celle de l'enfant) n'est pas touchée.
        _ = fcntl(master, F_SETFL, O_NONBLOCK)

        let pty = PTYMaster(fd: master)
        let buffer = PTYBuffer(ceiling: terminalPendingCeiling)
        let lifespan = PTYLifespan()
        self.childPID = child
        self.groupPID = child
        self.pty = pty
        self.buffer = buffer
        self.lifespan = lifespan
        self.exit = nil
        self.exitDelivered = false
        self.streamEnded = false
        self.deliveryScheduled = false

        // Lecteur sur un fil détaché, comme `ProcessTransport.pump` (BR-1 étape 3).
        // Les deux rappels ne touchent que des types `Sendable` et re-entrent sur le
        // MainActor par un `Task`.
        let onData: @Sendable () -> Void = { [weak self] in
            Task { @MainActor in self?.scheduleDelivery() }
        }
        let onEnd: @Sendable () -> Void = { [weak self] in
            Task { @MainActor in self?.handleStreamEnd() }
        }
        Thread.detachNewThread {
            Self.readLoop(pty: pty, buffer: buffer, lifespan: lifespan, onData: onData, onEnd: onEnd)
        }

        // Source d'exit : c'est elle qui récolte et qui annonce la mort. `resume()`
        // est OBLIGATOIRE — une source `DispatchSource.make…` naît suspendue (mesuré :
        // sans `resume()`, le gestionnaire ne se déclenche jamais).
        let source = DispatchSource.makeProcessSource(identifier: child, eventMask: .exit, queue: .main)
        source.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.reapIfNeeded() }
        }
        source.resume()
        exitSource = source

        // Filet de sécurité : si le fils meurt avant que la source ne soit armée,
        // `NOTE_EXIT` peut ne jamais se déclencher et la récolte resterait due.
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(300))
            self.reapIfNeeded()
        }
    }

    // MARK: - Écriture (BR-1 étape 3)

    /// Écriture brute sur le maître, dans l'ORDRE des octets fournis : c'est la
    /// frappe clavier qui part dans le shell (ou dans la TUI qu'il a lancée).
    func write(_ bytes: [UInt8]) throws {
        guard childPID != nil, let pty else { throw TerminalHostError.notRunning }
        guard !bytes.isEmpty else { return }
        try Self.writeAll(bytes, to: pty)
    }

    /// Le maître est non bloquant : un tampon plein rend `EAGAIN` au lieu de figer
    /// le MainActor pour toujours. L'attente est donc bornée, et son dépassement est
    /// un échec d'écriture — jamais une perte silencieuse d'octets.
    private nonisolated static func writeAll(_ bytes: [UInt8], to pty: PTYMaster) throws {
        var offset = 0
        let deadline = ContinuousClock.now + terminalWriteGrace
        while offset < bytes.count {
            let written = bytes.withUnsafeBytes {
                Darwin.write(pty.fd, $0.baseAddress! + offset, bytes.count - offset)
            }
            if written > 0 {
                offset += written
                continue
            }
            if written < 0, errno == EINTR { continue }
            if written < 0, errno == EAGAIN || errno == EWOULDBLOCK {
                guard ContinuousClock.now < deadline else {
                    throw TerminalHostError.writeFailed(errno)
                }
                var descriptor = pollfd(fd: pty.fd, events: Int16(POLLOUT), revents: 0)
                _ = Darwin.poll(&descriptor, 1, 20)
                continue
            }
            throw TerminalHostError.writeFailed(errno)
        }
    }

    // MARK: - Taille (BR-1 étape 4, AC-7)

    /// `TIOCSWINSZ` sur le maître met à jour la réplique ET fait délivrer `SIGWINCH`
    /// au groupe au premier plan (Doc-3) : aucun signal n'est envoyé à la main.
    /// Hors exécution la demande est MÉMORISÉE et s'applique au prochain `start`.
    func resize(columns: Int, rows: Int) {
        let requested = (max(1, columns), max(1, rows))
        guard childPID != nil, let pty else {
            memorizedSize = requested
            return
        }
        var windowSize = winsize(
            ws_row: UInt16(clamping: requested.1),
            ws_col: UInt16(clamping: requested.0),
            ws_xpixel: 0,
            ws_ypixel: 0
        )
        _ = ioctl(pty.fd, TIOCSWINSZ, &windowSize)
    }

    // MARK: - Arrêt (BR-1 étape 5, AC-8, AC-9)

    /// Arrêt du process, REJOUABLE : un appel pendant que le premier escalade ne
    /// relance rien, il attend la même fin. La séquence est celle de
    /// `ServiceSessionModel.shutdown` : `SIGTERM` au GROUPE, attente bornée,
    /// `SIGKILL` au groupe, récolte — l'attente porte sur la mort EFFECTIVE, jamais
    /// sur une intention.
    func kill() async {
        if let killTask {
            await killTask.value
            return
        }
        guard let group = groupPID else { return }
        let task = Task { @MainActor in await self.escalate(group: group) }
        killTask = task
        await task.value
        killTask = nil
    }

    private func escalate(group: Int32) async {
        defer { groupPID = nil }

        guard childPID != nil else {
            // Le fils a déjà été récolté : le groupe peut encore porter des
            // descendants (arrière-plan d'une commande du shell). Un `SIGKILL` de
            // groupe, sans grâce — il n'y a plus de propriétaire direct à ménager.
            Darwin.kill(-group, SIGKILL)
            return
        }

        Darwin.kill(-group, SIGTERM)
        if await waitForExit(within: terminalStopGrace) { return }

        Darwin.kill(-group, SIGKILL)
        _ = await waitForExit(within: terminalKillGrace)
    }

    /// Attente bornée de la disparition EFFECTIVE du fils : on observe `childPID`,
    /// que seule la récolte met à `nil`.
    private func waitForExit(within duration: Duration) async -> Bool {
        let deadline = ContinuousClock.now + duration
        while ContinuousClock.now < deadline {
            reapIfNeeded()
            if childPID == nil { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        reapIfNeeded()
        return childPID == nil
    }

    // MARK: - Sortie (BR-1 étapes 3 et 6)

    /// Réveille la livraison sur le MainActor, en COALESCANT : une seule livraison
    /// en attente, quel que soit le nombre de lectures déjà en file.
    private func scheduleDelivery() {
        guard !deliveryScheduled else { return }
        deliveryScheduled = true
        Task { @MainActor in self.deliverOutput() }
    }

    /// Vide la file et livre son contenu d'un bloc, DANS L'ORDRE reçu. Le drapeau est
    /// baissé AVANT la vidange : une lecture qui remplit la file pendant la livraison
    /// programme ainsi la suivante au lieu de la perdre.
    private func deliverOutput() {
        deliveryScheduled = false
        guard let buffer else { return }
        let bytes = buffer.drain()
        guard !bytes.isEmpty else { return }
        onOutput?(bytes)
    }

    /// Le lecteur a vu la fin du flux (`0`/`EIO`, Doc-3) : les derniers octets sont
    /// livrés, puis la mort du fils est constatée — `reapIfNeeded` est idempotent, la
    /// source d'exit a donc le droit de le faire aussi.
    private func handleStreamEnd() {
        streamEnded = true
        scheduleDelivery()
        reapIfNeeded()
        finishPendingExit()
    }

    /// POINT UNIQUE de `waitpid` : la source d'exit et la boucle d'attente de
    /// `kill()` l'appellent toutes deux, et la seconde ne fait rien si l'enfant a
    /// déjà été récolté (jamais deux récoltes, jamais de zombie).
    private func reapIfNeeded() {
        guard let target = childPID else { return }
        var status: Int32 = 0
        guard waitpid(target, &status, WNOHANG) == target else { return }

        childPID = nil
        exitSource?.cancel()
        exitSource = nil
        lifespan?.stop()  // le lecteur rend la main en moins de 200 ms
        pty = nil          // il fermera lui-même son descripteur, une seule fois
        exit = Self.exit(from: status)

        guard !streamEnded else {
            finishPendingExit()
            return
        }
        // Le noyau garde les octets déjà écrits par le fils : on laisse au lecteur un
        // délai BORNÉ avant d'annoncer la mort, sinon l'écran se figerait tronqué.
        Task { @MainActor in
            try? await Task.sleep(for: terminalLastBytesGrace)
            self.finishPendingExit()
        }
    }

    private func finishPendingExit() {
        guard let exit, !exitDelivered else { return }
        exitDelivered = true
        self.exit = nil
        deliverOutput()
        buffer = nil
        onExit?(exit)
    }

    /// `WIFEXITED`/`WIFSIGNALED` n'existent pas en Swift (macros indisponibles) : la
    /// formule de `sys/wait.h` est donc écrite ici, sur `WSTATUS(x) = x & 0177`.
    private static func exit(from status: Int32) -> TerminalExit {
        let reason = status & 0x7F
        if reason == 0 {
            return TerminalExit(status: (status >> 8) & 0xFF, reason: .exited)
        }
        return TerminalExit(status: reason, reason: .uncaughtSignal)
    }

    // MARK: - Remise à zéro

    /// Le modèle garantit un seul lancement à la fois (S-1) ; cette voie n'existe que
    /// pour qu'un `start` rappelé ne laisse JAMAIS un process sans propriétaire.
    private func teardownFinishedRun() {
        if let target = childPID {
            Darwin.kill(-target, SIGKILL)
            var status: Int32 = 0
            _ = waitpid(target, &status, 0)
        } else if let group = groupPID {
            Darwin.kill(-group, SIGKILL)
        }
        childPID = nil
        groupPID = nil
        exitSource?.cancel()
        exitSource = nil
        lifespan?.stop()
        lifespan = nil
        pty = nil
        buffer = nil
        exit = nil
        exitDelivered = false
        streamEnded = false
        deliveryScheduled = false
    }

    // MARK: - Boucle de lecture (BR-1 étape 3)

    /// `poll` (avec délai) puis `read` borné à 64 Kio. Elle ne touche AUCUN état du
    /// MainActor : elle ne partage que `PTYMaster` (descripteur fermé une seule fois),
    /// `PTYBuffer` (file verrouillée et plafonnée) et `PTYLifespan` (drapeau d'arrêt).
    private nonisolated static func readLoop(
        pty: PTYMaster,
        buffer: PTYBuffer,
        lifespan: PTYLifespan,
        onData: @Sendable () -> Void,
        onEnd: @Sendable () -> Void
    ) {
        var chunk = [UInt8](repeating: 0, count: terminalReadChunk)
        var descriptor = pollfd(fd: pty.fd, events: Int16(POLLIN), revents: 0)

        loop: while !lifespan.isStopped {
            descriptor.revents = 0
            let ready = Darwin.poll(&descriptor, 1, 200)
            if ready < 0 {
                if errno == EINTR { continue }
                break
            }
            if ready == 0 { continue }  // délai écoulé : on revérifie l'arrêt demandé
            guard descriptor.revents & Int16(POLLIN | POLLHUP | POLLERR | POLLNVAL) != 0 else {
                continue
            }

            let count = chunk.withUnsafeMutableBytes {
                Darwin.read(pty.fd, $0.baseAddress, $0.count)
            }
            if count > 0 {
                buffer.append(Array(chunk[0..<count]))
                onData()
            } else if count == 0 {
                break  // fin de flux
            } else if errno == EINTR {
                continue
            } else if errno == EAGAIN || errno == EWOULDBLOCK {
                // Rien à lire malgré l'événement. Sur `POLLHUP` la réplique est
                // fermée : il n'y aura plus jamais d'octet.
                if descriptor.revents & Int16(POLLHUP) != 0 { break }
                continue
            } else {
                break  // EIO et le reste : le fils est mort (Doc-3)
            }
        }

        buffer.close()
        pty.close()
        onEnd()
    }

    // MARK: - Outils C

    /// `argv`/`envp` sous la forme attendue par `execve`, terminés par `nil`. Tout est
    /// alloué avant le fork.
    private static func cStrings(_ values: [String]) -> [UnsafeMutablePointer<CChar>?] {
        var pointers = values.map { strdup($0) }
        pointers.append(nil)
        return pointers
    }

    private static func freeCStrings(_ pointers: [UnsafeMutablePointer<CChar>?]) {
        for pointer in pointers { free(pointer) }
    }
}

// MARK: - Commande au premier plan (mac-quitter-sans-confirmation, S-2)

/// La commande que le shell a mise au premier plan du terminal : `processGroup` est
/// son groupe de process, `name` le nom court de son chef (`nil` si illisible).
struct TerminalForegroundCommand: Equatable, Sendable {
    let processGroup: Int32
    let name: String?
}

extension TerminalHost {
    /// La commande au premier plan, ou `nil` quand le shell est au repos sur son
    /// invite, ne vit pas, ou que le PTY est déjà fermé (Doc-10) : `tcgetpgrp` sur le
    /// maître rend le groupe qui tient le terminal, celui du shell (chef de session,
    /// `pgid == pid`) quand aucune commande ne tourne. Une tâche de fond ne prend
    /// pas le terminal, et `exec <commande>` (qui remplace le shell) n'est pas vu.
    /// Un seul appel système, sans effet sur le shell.
    func foregroundCommand() -> TerminalForegroundCommand? {
        guard childPID != nil, let pty, let shellGroup = groupPID else { return nil }
        let foreground = pty.foregroundProcessGroup()
        guard foreground > 0, foreground != shellGroup else { return nil }
        return TerminalForegroundCommand(processGroup: foreground, name: Self.processName(foreground))
    }

    /// `proc_name` (libproc, Doc-8) dans un tampon de 256 octets ; `nil` en échec
    /// ou pour un nom vide.
    private static func processName(_ pid: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 256)
        let length = proc_name(pid, &buffer, UInt32(buffer.count))
        guard length > 0 else { return nil }
        let name = String(decoding: buffer.prefix(Int(length)).map { UInt8(bitPattern: $0) }, as: UTF8.self)
        return name.isEmpty ? nil : name
    }
}

// MARK: - Types partagés avec les fils de lecture

/// Le maître du PTY, fermé UNE SEULE fois, par qui l'obtient le premier. Le lecteur
/// le ferme quand sa boucle se termine ; l'hôte n'a donc jamais à fermer un
/// descripteur pendant qu'un autre fil est dessus, et un descripteur recyclé ne peut
/// pas être fermé par un ancien lecteur.
private final class PTYMaster: @unchecked Sendable {
    let fd: Int32
    private let lock = NSLock()
    private var closed = false

    init(fd: Int32) { self.fd = fd }

    func close() {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return }
        closed = true
        _ = Darwin.close(fd)
    }

    /// Le groupe au premier plan du terminal (`tcgetpgrp`, Doc-7), lu SOUS le verrou
    /// pour ne jamais interroger un descripteur fermé (ou recyclé) : 0 une fois fermé.
    func foregroundProcessGroup() -> Int32 {
        lock.lock()
        defer { lock.unlock() }
        guard !closed else { return 0 }
        return tcgetpgrp(fd)
    }
}

/// File de sortie partagée entre le fil de lecture et le MainActor.
///
/// Son PLAFOND est la back-pressure de Doc-5 : au-delà, `append` BLOQUE le fil de
/// lecture jusqu'à la vidange par le MainActor. C'est ce qui borne la mémoire quand
/// le fils écrit plus vite que la fenêtre ne peint.
private final class PTYBuffer: @unchecked Sendable {
    private let condition = NSCondition()
    private let ceiling: Int
    private var pending: [UInt8] = []
    private var closed = false

    init(ceiling: Int) { self.ceiling = ceiling }

    func append(_ bytes: [UInt8]) {
        condition.lock()
        while pending.count >= ceiling && !closed { condition.wait() }
        guard !closed else {
            condition.unlock()
            return
        }
        pending.append(contentsOf: bytes)
        condition.unlock()
    }

    func drain() -> [UInt8] {
        condition.lock()
        let bytes = pending
        pending.removeAll(keepingCapacity: true)
        condition.broadcast()
        condition.unlock()
        return bytes
    }

    func close() {
        condition.lock()
        closed = true
        condition.broadcast()
        condition.unlock()
    }
}

/// Demande d'arrêt du lecteur : c'est elle qui lui permet de rendre la main sans
/// qu'on ferme son descripteur dans son dos.
private final class PTYLifespan: @unchecked Sendable {
    private let lock = NSLock()
    private var stopped = false

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    var isStopped: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }
}
