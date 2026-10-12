// La composition « adresse du service → propriétaire » (S-2, S-4 ; BR-9) : la
// section Mémoire nomme ce qui tient l'adresse quand elle répond sans porter le
// jeton d'installation.
//
// Une adresse NON locale ne sonde AUCUN port (on n'interroge pas `lsof` pour un
// hôte distant) ; une adresse locale passe par `StackOwnership.holder` et sa
// classification figée. Aucun binaire réel n'est lancé : la doublure route
// `lsof`/`ps` par chemin absolu.

import Foundation
import Testing

@testable import OMPConsole

// MARK: - La doublure

private enum ForeignProbeError: Error { case unavailable }

/// La doublure de `CommandRunner` : `lsof` et `ps`, routés par binaire ABSOLU,
/// avec journal des appels.
private final class ForeignOwnershipDouble: @unchecked Sendable {
    struct Call: Equatable {
        var binary: String
        var arguments: [String]
    }

    private(set) var calls: [Call] = []
    var lsofResult: ProcessRun? = ProcessRun(code: 1, stdout: "", stderr: "", timedOut: false)
    var psResult: ProcessRun? = ProcessRun(code: 0, stdout: "", stderr: "", timedOut: false)

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, _, _ in
            calls.append(Call(binary: binary.path, arguments: arguments))
            switch binary.path {
            case "/usr/sbin/lsof":
                guard let result = lsofResult else { throw ForeignProbeError.unavailable }
                return result
            case "/bin/ps":
                guard let result = psResult else { throw ForeignProbeError.unavailable }
                return result
            default:
                return ProcessRun(code: 127, stdout: "", stderr: "binaire inattendu", timedOut: false)
            }
        }
    }

    var probedPorts: [String] {
        calls.filter { $0.binary == "/usr/sbin/lsof" }.compactMap { $0.arguments.first { $0.hasPrefix("-iTCP:") } }
    }
}

private let ourExecutable = URL(fileURLWithPath: "/Applications/OMP Console.app/Contents/Resources/mem0-rs")

/// Un enregistrement `lsof -F pcn`.
private func lsofRecord(pid: Int32, command: String, port: Int) -> String {
    "p\(pid)\nc\(command)\nf33\nn127.0.0.1:\(port)\n"
}

// MARK: - Adresse distante : aucun port sondé

@Test("bug-embedded-podman-machine/AC-1 : une adresse DISTANTE nomme l'hôte et ne sonde AUCUN port")
func remoteAddressNamesTheHostWithoutProbing() async {
    let double = ForeignOwnershipDouble()
    let ownership = await StackOwnership.foreignOwnership(
        address: "http://mem0.example.com:8321",
        ourExecutable: ourExecutable,
        environment: [:],
        run: double.runner
    )

    #expect(ownership?.owner == "le service distant mem0.example.com")
    #expect(ownership?.address == "http://mem0.example.com:8321")
    #expect(ownership?.gesture == StackOwnership.remoteAddressGesture)
    // Aucun `lsof`, aucun `ps` : on ne sonde pas un hôte distant.
    #expect(double.calls.isEmpty)
}

@Test("bug-embedded-podman-machine/AC-1 : trois écritures d'hôte local, et rien d'autre")
func localHostsAreTheThreeLoopbackSpellings() {
    #expect(StackOwnership.isLocalHost("localhost"))
    #expect(StackOwnership.isLocalHost("127.0.0.1"))
    #expect(StackOwnership.isLocalHost("::1"))
    #expect(StackOwnership.isLocalHost("[::1]"))
    #expect(!StackOwnership.isLocalHost("mem0.example.com"))
    #expect(!StackOwnership.isLocalHost("192.168.1.10"))
}

// MARK: - Adresse locale : la classification de `holder`

@Test("bug-embedded-podman-machine/AC-1 : un processus local étranger ⇒ « un autre programme », sans reprise")
func localForeignProcessIsNamed() async {
    let double = ForeignOwnershipDouble()
    double.lsofResult = ProcessRun(code: 0, stdout: lsofRecord(pid: 4711, command: "python3", port: 8321), stderr: "", timedOut: false)
    double.psResult = ProcessRun(code: 0, stdout: "python3 server.py\n", stderr: "", timedOut: false)

    let ownership = await StackOwnership.foreignOwnership(
        address: "http://localhost:8321",
        ourExecutable: ourExecutable,
        environment: ["HOME": "/Users/x"],
        run: double.runner
    )

    #expect(ownership?.owner == "un autre programme (python3, pid 4711)")
    #expect(double.probedPorts == ["-iTCP:8321"])
}

@Test("bug-embedded-podman-machine/AC-1 : une adresse sans hôte ou sans port ne rend AUCUN verdict")
func unparsableAddressYieldsNothing() async {
    let double = ForeignOwnershipDouble()
    let withoutHost = await StackOwnership.foreignOwnership(
        address: "pas-une-url",
        ourExecutable: ourExecutable,
        environment: [:],
        run: double.runner
    )
    let withoutPort = await StackOwnership.foreignOwnership(
        address: "http://localhost",
        ourExecutable: ourExecutable,
        environment: [:],
        run: double.runner
    )
    #expect(withoutHost == nil)
    #expect(withoutPort == nil)
    #expect(double.calls.isEmpty)
}
