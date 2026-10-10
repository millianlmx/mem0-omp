// Les quatre routes de l'API Docker de la migration (S-3, BR-3 ; AC-4).
//
// Deux preuves distinctes, comme pour `GitCommand` : la FORME exacte de l'argv
// `curl` (une option perdue et le transport ne serait plus celui de la
// Documentation), et le DÉCODAGE tolérant des charges JSON figées (champs
// `Names`/`Id`/`State`, `Mounts[]`, label compose) plus les codes du stop.
//
// Toute la communication passe par la doublure `DockerCurlDouble` : aucun test
// d'ici ne lance un vrai binaire ni ne touche un vrai socket.

import Foundation
import Testing

@testable import OMPConsole

// MARK: - La doublure de transport

/// La doublure de `CommandRunner` pour les appels `curl` sur socket Unix : elle
/// enregistre chaque appel (binaire, argv BRUT, environnement, budget) et rend un
/// `ProcessRun` décidé par la route `(socket, url) -> ProcessRun`.
///
/// `@unchecked Sendable` : tous les accès viennent du MainActor (les tests et
/// `StackMigration` y vivent), il n'y a donc aucune course réelle. Partagée avec
/// `StackMigrationTests` (même cible de test).
final class DockerCurlDouble: @unchecked Sendable {
    struct Call: Equatable {
        var binary: String
        var arguments: [String]
        var environment: [String: String]
        var timeout: Double
    }

    enum DoubleError: Error { case unrouted }

    private(set) var calls: [Call] = []

    /// La réponse rendue pour un couple (socket, url). Par défaut : un échec, pour
    /// qu'une route oubliée se voie immédiatement.
    var route: (String, String) -> ProcessRun = { _, _ in
        ProcessRun(code: 7, stdout: "", stderr: "route absente", timedOut: false)
    }

    /// Fait échouer le LANCEMENT lui-même (socket injoignable).
    var throwOnCall = false

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, environment, timeout in
            calls.append(Call(binary: binary.path, arguments: arguments, environment: environment, timeout: timeout))
            if throwOnCall { throw DoubleError.unrouted }
            let socket = Self.value(of: "--unix-socket", in: arguments) ?? ""
            let url = arguments.last ?? ""
            return route(socket, url)
        }
    }

    static func value(of flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else { return nil }
        return arguments[index + 1]
    }
}

/// Le tronc commun figé du transport (S-3, mesuré le 2026-10-04).
private let curlPrefix = ["--silent", "--show-error", "--max-time", "10"]

// MARK: - Les candidats

@Test("all-in-one-app/AC-4 : les sockets sont essayés dans l'ordre `~/.docker/run/docker.sock` puis `/var/run/docker.sock`")
func socketCandidatesAreOrdered() {
    #expect(DockerSocket.candidates(home: "/Users/x") == [
        "/Users/x/.docker/run/docker.sock",
        "/var/run/docker.sock",
    ])
}

// MARK: - L'argv exact

@Test("all-in-one-app/AC-4 : la découverte est `curl --silent --show-error --max-time 10 --unix-socket <socket> …/containers/json?all=true`")
func discoveryCommandIsExact() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in ProcessRun(code: 0, stdout: "[]", stderr: "", timedOut: false) }
    let containers = await DockerSocket.containers(socket: "/tmp/d.sock", run: double.runner)

    #expect(containers == [])
    #expect(double.calls == [
        DockerCurlDouble.Call(
            binary: "/usr/bin/curl",
            arguments: curlPrefix + ["--unix-socket", "/tmp/d.sock", "http://localhost/containers/json?all=true"],
            environment: [:],
            timeout: 10
        )
    ])
}

@Test("all-in-one-app/AC-4 : l'inspect vise `GET /containers/{nom}/json` et n'ajoute que le socket et l'URL")
func inspectCommandIsExact() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in ProcessRun(code: 0, stdout: "{}", stderr: "", timedOut: false) }
    _ = await DockerSocket.inspect(socket: "/tmp/d.sock", name: "mem0-qdrant", run: double.runner)

    #expect(double.calls.first?.arguments == curlPrefix + [
        "--unix-socket", "/tmp/d.sock", "http://localhost/containers/mem0-qdrant/json",
    ])
}

@Test("all-in-one-app/AC-4 : le stop est `POST …/containers/{nom}/stop?t=10` et ne lit que le code HTTP (`-o /dev/null -w %{http_code}`)")
func stopCommandIsExact() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in ProcessRun(code: 0, stdout: "204\n", stderr: "", timedOut: false) }
    let result = await DockerSocket.stop(socket: "/tmp/d.sock", name: "mem0-qdrant", run: double.runner)

    #expect(result == .stopped)
    #expect(double.calls.first?.arguments == curlPrefix + [
        "--unix-socket", "/tmp/d.sock",
        "-o", "/dev/null", "-w", "%{http_code}", "-X", "POST",
        "http://localhost/containers/mem0-qdrant/stop?t=10",
    ])
}

// MARK: - Le décodage

@Test("all-in-one-app/AC-4 : `Names` perd son préfixe `/`, `Id` et `State` décident « tourne »")
func containersDecodeNamesIdAndState() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in
        ProcessRun(code: 0, stdout: """
        [
          {"Id":"q1","Names":["/mem0-qdrant"],"State":"running"},
          {"Id":"h1","Names":["/mem0-http"],"State":"exited"},
          {"Id":"a1","Names":["/omp-console-qdrant"],"State":"created"}
        ]
        """, stderr: "", timedOut: false)
    }
    let containers = await DockerSocket.containers(socket: "/tmp/d.sock", run: double.runner)
    #expect(containers == [
        DockerContainerSummary(name: "mem0-qdrant", id: "q1", running: true),
        DockerContainerSummary(name: "mem0-http", id: "h1", running: false),
        DockerContainerSummary(name: "omp-console-qdrant", id: "a1", running: false),
    ])
}

@Test("bug-embedded-podman-machine/AC-1 : `Ports[].PublicPort` est décodé (en marche ou arrêté) et `Ports` absent rend `[]`")
func containersDecodePublishedPorts() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in
        ProcessRun(code: 0, stdout: """
        [
          {"Id":"q1","Names":["/mem0-qdrant"],"State":"running",
           "Ports":[{"IP":"127.0.0.1","PrivatePort":6333,"PublicPort":6333,"Type":"tcp"},
                    {"IP":"127.0.0.1","PrivatePort":6334,"PublicPort":6334,"Type":"tcp"}]},
          {"Id":"h1","Names":["/mem0-http"],"State":"exited",
           "Ports":[{"IP":"127.0.0.1","PrivatePort":8321,"PublicPort":8321,"Type":"tcp"}]},
          {"Id":"n1","Names":["/sans-ports"],"State":"running"}
        ]
        """, stderr: "", timedOut: false)
    }
    let containers = await DockerSocket.containers(socket: "/tmp/d.sock", run: double.runner)
    #expect(containers == [
        DockerContainerSummary(name: "mem0-qdrant", id: "q1", running: true, publishedPorts: [6333, 6334]),
        DockerContainerSummary(name: "mem0-http", id: "h1", running: false, publishedPorts: [8321]),
        DockerContainerSummary(name: "sans-ports", id: "n1", running: true, publishedPorts: []),
    ])
}

@Test("bug-embedded-podman-machine/AC-1 : un `Ports` illisible (type inattendu, entrée sans `PublicPort`) rend `[]` sans échouer")
func containersTolerateMalformedPorts() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in
        ProcessRun(code: 0, stdout: """
        [
          {"Id":"a1","Names":["/garbage"],"State":"running","Ports":"pas un tableau"},
          {"Id":"a2","Names":["/partiel"],"State":"running",
           "Ports":[{"PrivatePort":8321},{"PublicPort":"8321"},{"PublicPort":6333}]}
        ]
        """, stderr: "", timedOut: false)
    }
    let containers = await DockerSocket.containers(socket: "/tmp/d.sock", run: double.runner)
    #expect(containers == [
        DockerContainerSummary(name: "garbage", id: "a1", running: true, publishedPorts: []),
        DockerContainerSummary(name: "partiel", id: "a2", running: true, publishedPorts: [6333]),
    ])
}

@Test("all-in-one-app/AC-4 : un socket illisible ou une charge illisible ne sont pas des erreurs — la lecture rend `nil`")
func unreadableReadsYieldNil() async {
    // Lancement impossible.
    let failing = DockerCurlDouble()
    failing.throwOnCall = true
    let unreachable = await DockerSocket.containers(socket: "/tmp/d.sock", run: failing.runner)
    #expect(unreachable == nil)

    // curl échoue (code ≠ 0).
    let failingCode = DockerCurlDouble()
    failingCode.route = { _, _ in ProcessRun(code: 7, stdout: "", stderr: "curl: (7)", timedOut: false) }
    let failedContainers = await DockerSocket.containers(socket: "/tmp/d.sock", run: failingCode.runner)
    let failedInspect = await DockerSocket.inspect(socket: "/tmp/d.sock", name: "mem0-qdrant", run: failingCode.runner)
    #expect(failedContainers == nil)
    #expect(failedInspect == nil)

    // Charge qui n'est pas le tableau attendu.
    let garbage = DockerCurlDouble()
    garbage.route = { _, _ in ProcessRun(code: 0, stdout: "pas du JSON", stderr: "", timedOut: false) }
    let notAnArray = await DockerSocket.containers(socket: "/tmp/d.sock", run: garbage.runner)
    #expect(notAnArray == nil)
}

@Test("all-in-one-app/AC-4 : l'inspect décode `Mounts[]` et le label `com.docker.compose.project.working_dir`")
func inspectDecodesMountsAndLabel() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in
        ProcessRun(code: 0, stdout: """
        {
          "Id": "q1",
          "Mounts": [
            {"Type":"bind","Source":"/Users/x/mem0-stack/qdrant_storage","Destination":"/qdrant/storage"}
          ],
          "Config": {"Labels": {"com.docker.compose.project.working_dir": "/Users/x/mem0-stack"}}
        }
        """, stderr: "", timedOut: false)
    }
    let detail = await DockerSocket.inspect(socket: "/tmp/d.sock", name: "mem0-qdrant", run: double.runner)
    #expect(detail == DockerContainerDetail(
        id: "q1",
        mounts: [DockerMount(type: "bind", source: "/Users/x/mem0-stack/qdrant_storage", destination: "/qdrant/storage")],
        composeWorkingDir: "/Users/x/mem0-stack"
    ))
}

@Test("all-in-one-app/AC-4 : un inspect sans label compose (ou sans `Mounts`) rend une liste vide et `nil`")
func inspectWithoutLabelOrMounts() async {
    let double = DockerCurlDouble()
    double.route = { _, _ in
        ProcessRun(code: 0, stdout: #"{"Id":"q1","Config":{"Labels":{}}}"#, stderr: "", timedOut: false)
    }
    let detail = await DockerSocket.inspect(socket: "/tmp/d.sock", name: "mem0-qdrant", run: double.runner)
    #expect(detail == DockerContainerDetail(id: "q1", mounts: [], composeWorkingDir: nil))
}

// MARK: - Les codes du stop

@Test("all-in-one-app/AC-4 : le stop distingue 204 (arrêté), 304 (déjà arrêté), 404 (absent) et l'échec")
func stopCodesAreDistinguished() async {
    func stop(returning body: String) async -> DockerStopResult {
        let double = DockerCurlDouble()
        double.route = { _, _ in ProcessRun(code: 0, stdout: body, stderr: "", timedOut: false) }
        return await DockerSocket.stop(socket: "/tmp/d.sock", name: "mem0-qdrant", run: double.runner)
    }

    let stopped = await stop(returning: "204")
    let alreadyStopped = await stop(returning: "304")
    let absent = await stop(returning: "404")
    let failed = await stop(returning: "500")
    #expect(stopped == .stopped)
    #expect(alreadyStopped == .alreadyStopped)
    #expect(absent == .absent)
    #expect(failed == .failed(detail: "code HTTP 500"))
}

@Test("all-in-one-app/AC-4 : un socket injoignable rend `.failed`, jamais un code inventé")
func stopOnUnreadableSocketFails() async {
    let double = DockerCurlDouble()
    double.throwOnCall = true
    let result = await DockerSocket.stop(socket: "/tmp/d.sock", name: "mem0-qdrant", run: double.runner)
    #expect(result == .failed(detail: "socket /tmp/d.sock injoignable"))
}
