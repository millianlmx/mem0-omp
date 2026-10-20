// Preuves du flux temps réel (S-13) : un vrai client `URLSession` en flux sur un
// vrai serveur, qui reçoit ce qui change SANS émettre de nouvelle requête de
// lecture — appareils et composants du Mac.

import Combine
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Un lecteur SSE minimal : il collecte `(évènement, données)` au fil de l'eau et
/// rend la main au test dès qu'un évènement attendu est arrivé (attente bornée).
@MainActor
private final class SSECollector {
    private(set) var events: [(name: String, data: String)] = []
    private(set) var failure: String?
    private var task: Task<Void, Never>?

    func start(_ request: URLRequest, session: URLSession = .shared) {
        task = Task { @MainActor [weak self] in
            do {
                let (bytes, _) = try await session.bytes(for: request)
                // Lecture OCTET À OCTET : une trame SSE est délimitée par une ligne
                // vide, et le lecteur de lignes de Foundation ne rend pas
                // systématiquement les lignes vides — un évènement en fin de flux
                // resterait alors non dispatché.
                var buffer = Data()
                let separator = Data("\n\n".utf8)
                for try await byte in bytes {
                    if Task.isCancelled { return }
                    buffer.append(byte)
                    while let range = buffer.range(of: separator) {
                        let frame = buffer.subdata(in: buffer.startIndex..<range.lowerBound)
                        buffer.removeSubrange(buffer.startIndex..<range.upperBound)
                        self?.ingest(String(decoding: frame, as: UTF8.self))
                    }
                }
            } catch {
                // La fin du flux (révocation, arrêt) est un résultat, pas un échec —
                // mais on garde le motif, pour ne pas masquer un vrai échec.
                self?.failure = String(describing: error)
            }
        }
    }

    /// Une trame complète : ses lignes `event:`/`data:`, le reste étant ignoré.
    private func ingest(_ frame: String) {
        var name = ""
        var data = ""
        for raw in frame.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = String(raw)
            if line.hasPrefix("data: ") { data += String(line.dropFirst(6)) }
            if line.hasPrefix("event: ") { name = String(line.dropFirst(7)) }
        }
        guard !data.isEmpty else { return }
        events.append((name.isEmpty ? "message" : name, data))
    }

    func waitFor(_ name: String, occurrence: Int = 1, seconds: Double = 10) async -> String? {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            let matches = events.filter { $0.name == name }
            if matches.count >= occurrence { return matches[occurrence - 1].data }
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        return nil
    }

    /// Arrête la lecture du flux.
    func stop() {
        task?.cancel()
        task = nil
    }
}

@MainActor
@Test("un flux refusé est la réponse JSON 401 habituelle, jamais un flux")
func refusedStreamIsJSONUnauthorized() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }

    let withoutToken = try await stack.call("GET", "/v1/stream")
    #expect(withoutToken.status == 401)
    #expect(withoutToken.errorCode == "unauthorized")
    #expect(withoutToken.headers["content-type"]?.contains("application/json") == true)

    let unknownToken = try await stack.call("GET", "/v1/stream", token: "jeton-inconnu")
    #expect(unknownToken.status == 401)
    #expect(unknownToken.errorCode == "unauthorized")
}

@MainActor
@Test("le flux en-tête est un vrai `text/event-stream` sans longueur ni fermeture")
func streamHeadersAreTheEventStreamContract() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }
    let token = try await stack.pair()

    let (bytes, response) = try await URLSession.shared.bytes(for: stack.request("GET", "/v1/stream", token: token))
    let http = try #require(response as? HTTPURLResponse)
    #expect(http.statusCode == 200)
    #expect(http.value(forHTTPHeaderField: "Content-Type")?.contains("text/event-stream") == true)
    #expect(http.value(forHTTPHeaderField: "Cache-Control") == "no-store")
    #expect(http.value(forHTTPHeaderField: ConsoleAPI.Service.protocolHeader) == String(ConsoleAPI.protocolVersion))
    #expect(http.value(forHTTPHeaderField: "Content-Length") == nil)

    var iterator = bytes.lines.makeAsyncIterator()
    let first = try await iterator.next()
    #expect(first == "event: hello")
}

@MainActor
@Test("le battement de cœur tient le flux éveillé")
func heartbeatIsSent() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }
    _ = await collector.waitFor("hello")

    // Le battement est une ligne de commentaire : on lit le flux brut.
    let (bytes, _) = try await URLSession.shared.bytes(for: stack.request("GET", "/v1/stream", token: token))
    let deadline = Date().addingTimeInterval(RemoteStreamHub.heartbeatSeconds + 10)
    var seen = false
    var iterator = bytes.lines.makeAsyncIterator()
    while Date() < deadline {
        guard let line = try await iterator.next() else { break }
        if line.hasPrefix(":") { seen = true; break }
    }
    #expect(seen, "un commentaire de battement doit être émis")
}

@MainActor
@Test("à l'ouverture, l'ordre réel des trames est `hello`, `devices`, puis `components`")
func openingFramesAreHelloDevicesThenComponents() async throws {
    let stack = try await RemoteStack.make(
        components: { RemoteComponentsPayload(ompInstalled: true, ompPath: "/tmp/omp/bin/omp", setupBanner: nil) }
    )
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }

    for name in ["hello", "devices", "components"] {
        _ = await collector.waitFor(name)
    }
    // La connexion est déclarée au registre juste après `hello` : le `devices` que
    // `markConnected` publie précède donc `components` (S-13, S-6). Le harnais
    // câble `changeHandler` comme la production.
    #expect(Array(collector.events.map(\.name).prefix(3)) == ["hello", "devices", "components"])
    let components = try #require(collector.events.first { $0.name == "components" }?.data)
    let payload = try JSONDecoder().decode(RemoteComponentsPayload.self, from: Data(components.utf8))
    #expect(payload.ompInstalled)
    #expect(payload.ompPath == "/tmp/omp/bin/omp")
}

@MainActor
@Test("deux flux du même appareil sont autorisés et reçoivent tous les deux les évènements")
func twoStreamsOfTheSameDeviceBothReceive() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }
    let token = try await stack.pair()

    let first = SSECollector()
    let second = SSECollector()
    first.start(stack.request("GET", "/v1/stream", token: token))
    second.start(stack.request("GET", "/v1/stream", token: token))
    defer {
        first.stop()
        second.stop()
    }
    _ = await first.waitFor("hello")
    _ = await second.waitFor("hello")

    #expect(await first.waitFor("devices", seconds: 5) != nil)
    #expect(await second.waitFor("devices", seconds: 5) != nil)
    #expect(RemoteStreamHub.backlogLimit == 64, "la borne du client lent est celle du contrat")
}

/// Une valeur que le fournisseur d'un évènement relit à chaque émission.
@MainActor
private final class StreamBox<T> {
    var value: T
    init(_ value: T) { self.value = value }
}

@MainActor
@Test("ios-accueil/AC-13 : un changement des composants est poussé sans nouvelle requête")
func componentsChangesArePushed() async throws {
    let componentsBox = StreamBox(
        RemoteComponentsPayload(ompInstalled: true, ompPath: nil, setupBanner: nil)
    )
    let componentsSubject = PassthroughSubject<Void, Never>()

    let stack = try await RemoteStack.make(
        components: { componentsBox.value },
        componentsChanges: componentsSubject.eraseToAnyPublisher()
    )
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }
    _ = await collector.waitFor("components")

    // La présence change : la trame `components` repart avec la charge complète.
    componentsBox.value = RemoteComponentsPayload(
        ompInstalled: false, ompPath: nil, setupBanner: "Préparation incomplète."
    )
    componentsSubject.send()
    let pushed = try #require(
        await collector.waitFor("components", occurrence: 2),
        "un changement de composants doit être poussé (échec=\(collector.failure ?? "aucun"))"
    )
    #expect(pushed.contains("\"ompInstalled\":false"))
    #expect(pushed.contains("Préparation incomplète."))
}

/// Une source `@Published` réelle, comme `presence.$presence` de la racine de l'app.
@MainActor
private final class PublishedChangeSource: ObservableObject {
    @Published var tick = 0
}

@MainActor
@Test("flux SSE : les éditeurs @Published réels de l'app s'abonnent hors de l'acteur principal sans faire planter le Mac")
func publishedSourcesSubscribeOffTheMainActor() async throws {
    // Régression mesurée le 2026-10-08 : `.map { _ in () }` écrit dans un contexte
    // @MainActor héritait de l'acteur, et `RemoteStreamHub.startSources` abonne ces
    // éditeurs par `.values` depuis le pool coopératif — la vérification
    // d'isolation tuait l'app (EXC_BREAKPOINT) dès qu'un appareil ouvrait le flux.
    let presence = PublishedChangeSource()
    let stack = try await RemoteStack.make(componentsChanges: presence.$tick.voidChanges())
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }
    _ = await collector.waitFor("components")

    // L'abonnement a bien eu lieu : un `@Published` rend sa valeur COURANTE à
    // l'abonnement (deuxième trame), et un vrai changement en pousse une de plus.
    presence.tick += 1
    _ = try #require(
        await collector.waitFor("components", occurrence: 2),
        "la veille des composants doit être abonnée (échec=\(collector.failure ?? "aucun"))"
    )
}
