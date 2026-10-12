// La sonde de propriété des ports (S-2, BR-2 ; AC-1).
//
// Deux preuves distinctes : la FORME exacte des argv `lsof`/`ps` (une option
// perdue et la preuve ne serait plus celle de la Documentation), et la
// CLASSIFICATION figée (`.ours` ssi la ligne de commande est notre exécutable,
// sinon `.foreign`, premier enregistrement lsof, `.free`/`.unknown`).
//
// Un seul test lance de VRAIS binaires : le listener POSIX réel, tenu par le
// processus de test — il n'attache PAS le port 8321 (le poste de référence a sa
// pile réelle dessus), c'est un port éphémère. Tous les autres passent par la
// doublure `OwnershipDouble` : aucun vrai `lsof`/`ps`/socket.

import Darwin
import Foundation
import Testing

@testable import OMPConsole

// MARK: - La doublure

private enum OwnershipProbeError: Error { case unavailable }

/// La doublure de `CommandRunner` pour la sonde : elle route par binaire ABSOLU
/// (`/usr/sbin/lsof`, `/bin/ps`), journalise chaque appel et décide la réponse
/// de chacun.
///
/// `@unchecked Sendable` : tous les accès viennent du MainActor (les tests y
/// vivent), il n'y a aucune course réelle.
final class OwnershipDouble: @unchecked Sendable {
    struct Call: Equatable {
        var binary: String
        var arguments: [String]
        var environment: [String: String]
        var timeout: Double
    }

    private(set) var calls: [Call] = []

    /// La réponse de `lsof` ; `nil` ⇒ le LANCEMENT échoue (binaire indisponible).
    var lsofResult: ProcessRun? = ProcessRun(code: 1, stdout: "", stderr: "", timedOut: false)

    /// La réponse de `ps` ; `nil` ⇒ le lancement échoue.
    var psResult: ProcessRun? = ProcessRun(code: 0, stdout: "", stderr: "", timedOut: false)

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, environment, timeout in
            calls.append(Call(binary: binary.path, arguments: arguments, environment: environment, timeout: timeout))
            switch binary.path {
            case "/usr/sbin/lsof":
                guard let result = lsofResult else { throw OwnershipProbeError.unavailable }
                return result
            case "/bin/ps":
                guard let result = psResult else { throw OwnershipProbeError.unavailable }
                return result
            default:
                return ProcessRun(code: 127, stdout: "", stderr: "binaire inattendu", timedOut: false)
            }
        }
    }

    var lsofArguments: [String]? {
        calls.first { $0.binary == "/usr/sbin/lsof" }?.arguments
    }
}

/// Notre exécutable de test : jamais lancé, seul son chemin est comparé.
private let ourExecutable = URL(fileURLWithPath: "/Applications/OMP Console.app/Contents/Resources/mem0-rs")

/// Un enregistrement `lsof -F pcn` pour un processus donné.
private func lsofRecord(pid: Int32, command: String, port: Int) -> String {
    "p\(pid)\nc\(command)\nf33\nn127.0.0.1:\(port)\n"
}

// MARK: - L'argv exact

@Test("bug-embedded-podman-machine/AC-1 : la sonde est `/usr/sbin/lsof -nP -iTCP:<port> -sTCP:LISTEN -F pcn`")
func lsofCommandIsExact() async {
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(code: 1, stdout: "", stderr: "", timedOut: false)
    _ = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: [:], run: double.runner)

    #expect(double.lsofArguments == ["-nP", "-iTCP:8321", "-sTCP:LISTEN", "-F", "pcn"])
    #expect(double.calls.first?.binary == "/usr/sbin/lsof")
    #expect(double.calls.first?.timeout == 10)
}

@Test("bug-embedded-podman-machine/AC-1 : le rattachement passe par `/bin/ps -p <pid> -o command=`")
func psCommandIsExact() async {
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(code: 0, stdout: lsofRecord(pid: 4711, command: "python3", port: 8321), stderr: "", timedOut: false)
    double.psResult = ProcessRun(code: 0, stdout: "python3 server.py\n", stderr: "", timedOut: false)
    _ = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: [:], run: double.runner)

    let psCall = double.calls.first { $0.binary == "/bin/ps" }
    #expect(psCall?.arguments == ["-p", "4711", "-o", "command="])
}

// MARK: - La classification

@Test("bug-embedded-podman-machine/AC-1 : aucun enregistrement lsof ⇒ `.free` (le code 1 n'est pas une erreur)")
func noRecordIsFree() async {
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(code: 1, stdout: "", stderr: "", timedOut: false)
    let ownership = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: [:], run: double.runner)
    #expect(ownership == .free)
}

@Test("omp-console-sans-podman : une ligne de commande = chemin de notre exécutable suivi d'arguments ⇒ `.ours`")
func commandOfOurExecutableIsOurs() async {
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(code: 0, stdout: lsofRecord(pid: 11399, command: "mem0-rs", port: 8321), stderr: "", timedOut: false)
    double.psResult = ProcessRun(
        code: 0,
        stdout: "/Applications/OMP Console.app/Contents/Resources/mem0-rs serve --port 8321\n",
        stderr: "", timedOut: false
    )
    let ownership = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: [:], run: double.runner)
    #expect(ownership == .ours(process: "mem0-rs", pid: 11399))
}

@Test("bug-embedded-podman-machine/AC-1 : une ligne de commande étrangère ⇒ `.foreign`")
func foreignCommandIsForeign() async {
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(code: 0, stdout: lsofRecord(pid: 4711, command: "python3", port: 8321), stderr: "", timedOut: false)
    double.psResult = ProcessRun(code: 0, stdout: "python3 server.py\n", stderr: "", timedOut: false)
    let ownership = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: ["HOME": "/Users/x"], run: double.runner)
    #expect(ownership == .foreign(process: "python3", pid: 4711))
}

@Test("bug-embedded-podman-machine/AC-1 : plusieurs enregistrements lsof ⇒ le PREMIER fait foi")
func firstRecordWins() async {
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(
        code: 0,
        stdout: "p111\ncpython3\nf3\nn*:8321\n\np222\ncnode\nf4\nn127.0.0.1:8321\n",
        stderr: "", timedOut: false
    )
    double.psResult = ProcessRun(code: 0, stdout: "python3 server.py\n", stderr: "", timedOut: false)
    let ownership = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: [:], run: double.runner)
    #expect(ownership == .foreign(process: "python3", pid: 111))
    // `ps` n'est appelé QUE pour le premier pid.
    #expect(double.calls.filter { $0.binary == "/bin/ps" }.map(\.arguments) == [["-p", "111", "-o", "command="]])
}

@Test("bug-embedded-podman-machine/AC-1 : `lsof` indisponible ⇒ `.unknown(detail:)`, jamais une accusation inventée")
func unavailableLsofIsUnknown() async {
    let double = OwnershipDouble()
    double.lsofResult = nil
    let ownership = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: [:], run: double.runner)
    #expect(ownership == .unknown(detail: "lsof indisponible"))
}

@Test("bug-embedded-podman-machine/AC-1 : un `lsof` en échec (code > 1) ⇒ `.unknown(detail:)` borné")
func failingLsofIsUnknown() async {
    let double = OwnershipDouble()
    double.lsofResult = ProcessRun(code: 2, stdout: "", stderr: "lsof: WARNING impossible\n", timedOut: false)
    let ownership = await StackOwnership.holder(ofPort: 8321, ourExecutable: ourExecutable, environment: [:], run: double.runner)
    #expect(ownership == .unknown(detail: "lsof: WARNING impossible"))
}

// MARK: - Les textes

@Test("bug-embedded-podman-machine/AC-1 : les textes figés de `MemoryPortOwnership`")
func ownershipTextsAreFrozen() {
    let cases: [(MemoryPortOwnership, String, String)] = [
        (.free, "personne", "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"),
        (.ours(process: "mem0-rs", pid: 11399),
         "le service mémoire d'OMP Console",
         "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"),
        (.foreign(process: "python3", pid: 4711),
         "un autre programme (python3, pid 4711)",
         "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"),
        (.unknown(detail: "lsof indisponible"),
         "indéterminé (lsof indisponible)",
         "arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"),
    ]
    for (ownership, description, gesture) in cases {
        #expect(ownership.userDescription == description)
        #expect(ownership.gesture == gesture)
    }
}

// MARK: - Le listener réel (preuve d'acceptation (a))

/// Ouvre un VRAI listener TCP sur `127.0.0.1`, port éphémère attribué par le
/// noyau (jamais 8321). Rend le descripteur et le port, ou `nil`.
private func openEphemeralListener() -> (fd: Int32, port: Int)? {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }

    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr = in_addr(s_addr: INADDR_LOOPBACK.bigEndian)

    let bound = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    guard bound == 0, listen(fd, 8) == 0 else {
        close(fd)
        return nil
    }

    var local = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let named = withUnsafeMutablePointer(to: &local) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            getsockname(fd, $0, &length)
        }
    }
    guard named == 0 else {
        close(fd)
        return nil
    }
    return (fd, Int(UInt16(bigEndian: local.sin_port)))
}

@Test("bug-embedded-podman-machine/AC-1 : un VRAI listener POSIX tenu par le test est classé `.foreign(process:pid:)`")
func realListenerIsForeign() async {
    guard let (fd, port) = openEphemeralListener() else {
        Issue.record("impossible d'ouvrir un listener POSIX éphémère")
        return
    }
    defer { close(fd) }

    let ownership = await StackOwnership.holder(
        ofPort: port,
        ourExecutable: ourExecutable,
        environment: ProcessInfo.processInfo.environment,
        run: .live
    )

    guard case .foreign(let process, let pid) = ownership else {
        Issue.record("attendu `.foreign`, obtenu \(ownership)")
        return
    }
    #expect(pid == Int32(getpid()))
    #expect(process == ProcessInfo.processInfo.processName)
}
