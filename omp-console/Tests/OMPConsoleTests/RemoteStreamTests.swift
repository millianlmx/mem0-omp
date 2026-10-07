// Preuves du flux temps réel (S-13) : un vrai client `URLSession` en flux sur un
// vrai serveur, qui reçoit ce qui change SANS émettre de nouvelle requête de
// lecture — ni pour le magasin, ni pour une session vivante.

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

/// Un fichier de session réel : l'en-tête puis une entrée utilisateur.
private func writeSessionFile(_ path: String, userLines: [String]) {
    var lines = [
        #"{"type":"session","version":3,"id":"session-flux","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/flux"}"#
    ]
    lines.append(contentsOf: userLines)
    try? (lines.joined(separator: "\n") + "\n").write(toFile: path, atomically: true, encoding: .utf8)
}

/// Ajoute une ligne à un fichier de session DÉJÀ écrit : c'est le geste d'une
/// session vivante (append), pas un remplacement atomique.
private func appendSessionLine(_ path: String, _ line: String) {
    guard let handle = FileHandle(forWritingAtPath: path) else { return }
    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: Data((line + "\n").utf8))
}

private func userLine(_ index: Int, _ text: String) -> String {
    """
    {"type":"message","id":"e\(index)","parentId":null,"timestamp":"2026-01-01T00:00:0\(index % 10).000Z",\
    "message":{"role":"user","content":[{"type":"text","text":"\(text)"}]}}
    """
}

@MainActor
@Test("api-distante-du-console/AC-15 : le magasin qui change et une session vivante produisent une mise à jour poussée sans nouvelle requête")
func storeChangeAndLiveSessionPushUpdates() async throws {
    let store = StoreFixture()
    let sessionFile = store.root + "/session.jsonl"
    writeSessionFile(sessionFile, userLines: [userLine(1, "premier")])

    let runId = fixtureId(0x51)
    store.publish(.running, "\(runId).json", object: runningObject(
        id: runId,
        cwd: store.root + "/worktree",
        phaseStartedAt: fixtureT0 - 5_000,
        updatedAt: fixtureT0 - 1_000,
        ownerPid: Double(getpid()),
        sessionFile: sessionFile
    ))

    let stack = try await RemoteStack.make(stateDir: store.root)
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }

    // À l'ouverture : `hello` puis l'instantané courant, sans `GET` initial.
    let hello = try #require(
        await collector.waitFor("hello"),
        "l'évènement `hello` doit ouvrir le flux (échec=\(collector.failure ?? "aucun"))"
    )
    #expect(hello.contains("\"protocolVersion\":1"))
    let initial = try #require(await collector.waitFor("store"), "l'instantané courant doit suivre")
    #expect(initial.contains("\"running\""))

    // 1. Le magasin change : l'évènement `store` arrive SANS nouvelle requête du client.
    let historyId = fixtureId(0x52)
    store.publish(.history, "\(historyId).json", object: historyObject(
        id: historyId,
        cwd: store.root + "/worktree",
        phaseStartedAt: fixtureT0 - 9_000,
        endedAt: fixtureT0 - 2_000
    ))
    let pushed = try #require(
        await collector.waitFor("store", occurrence: 2),
        "un changement du magasin doit être poussé"
    )
    #expect(pushed.contains(historyId), "l'instantané poussé porte le changement : \(pushed.prefix(400))")

    // 2. Une session VIVANTE produit : l'évènement `sessions` porte ce qui s'ajoute.
    appendSessionLine(sessionFile, userLine(2, "deuxième"))
    let sessions = try #require(
        await collector.waitFor("sessions"),
        "un ajout dans une session vivante doit être poussé (échec=\(collector.failure ?? "aucun"))"
    )
    #expect(sessions.contains("session.jsonl"), "l'évènement nomme le fichier de session")
    #expect(sessions.contains("deuxième"), "et porte l'entrée ajoutée")
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
    #expect(http.value(forHTTPHeaderField: ConsoleAPI.Service.protocolHeader) == "1")
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
@Test("à l'ouverture, l'ordre réel des trames est `hello`, `store`, `conduite`, puis `devices`")
func openingFramesAreHelloStoreConduiteThenDevices() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }

    _ = await collector.waitFor("hello")
    _ = await collector.waitFor("store")
    _ = await collector.waitFor("conduite")
    _ = await collector.waitFor("devices")
    // La connexion est déclarée au registre APRÈS les trois trames initiales : le
    // `devices` que `markConnected` publie arrive donc en dernier, et une seule
    // fois (S-13, S-6). Le harnais câble `changeHandler` comme la production.
    #expect(Array(collector.events.map(\.name).prefix(4)) == ["hello", "store", "conduite", "devices"])
}

@MainActor
@Test("deux flux du même appareil sont autorisés et reçoivent tous les deux les évènements")
func twoStreamsOfTheSameDeviceBothReceive() async throws {
    let store = StoreFixture()
    let stack = try await RemoteStack.make(stateDir: store.root)
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

@MainActor
@Test("une escalade de conduite est poussée entière sur l'évènement `conduite`")
func conduiteDialogIsPushed() async throws {
    let store = StoreFixture()
    let repoRoot = store.root + "/depot"
    try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    store.publish(.lots, "\(fixtureId(0xE1)).json", object: lotObject(id: fixtureId(0xE1), repoRoot: repoRoot))

    let transport = ScriptedRpcTransport()
    transport.readyLine = projectReadyLine()
    wireProjectAutoResponses(transport)
    makeProjectTransportRenderOnClose(transport)
    let project = makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: store.root)
    let stack = try await RemoteStack.make(stateDir: store.root, projectModel: project)
    defer { stack.stop() }
    let token = try await stack.pair()

    // Une conduite VIVE avant l'ouverture du flux : la trame d'ouverture la dit.
    await stack.project.startConduite(repoRoot: URL(fileURLWithPath: repoRoot), name: "Projet")
    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }

    let opening = try #require(
        await collector.waitFor("conduite"),
        "l'ouverture doit porter l'état de la conduite (échec=\(collector.failure ?? "aucun"))"
    )
    #expect(opening.contains("\"state\":\"live\""), "trame reçue : \(opening.prefix(300))")
    #expect(opening.contains("\"repoKey\""))

    // Une escalade qui apparaît pousse la file ENTIÈRE, sans nouvelle requête.
    transport.emit(projectDialogLine(
        id: "d-1",
        method: "select",
        extra: ["title": "Le plan", "options": ["A", "B"]]
    ))
    let pushed = try #require(
        await collector.waitFor("conduite", occurrence: 2),
        "l'escalade doit être poussée sur le flux"
    )
    #expect(pushed.contains("d-1"), "trame reçue : \(pushed.prefix(300))")
}

/// Une valeur que le fournisseur d'un évènement relit à chaque émission.
@MainActor
private final class StreamBox<T> {
    var value: T
    init(_ value: T) { self.value = value }
}

@MainActor
@Test("ios-accueil/AC-16 : à l'ouverture, `components` et `journal` suivent `hello`, `store` et `devices`")
func openingFramesIncludeComponentsAndJournal() async throws {
    let stack = try await RemoteStack.make(
        components: { RemoteComponentsPayload(ompInstalled: true, ompPath: "/tmp/omp/bin/omp", setupBanner: nil) },
        journal: { [] }
    )
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }

    for name in ["hello", "store", "conduite", "devices", "components", "journal"] {
        _ = await collector.waitFor(name)
    }
    // L'ordre d'ouverture fusionné : la trame `conduite` (ios-projet) précède
    // `devices`, et `components`/`journal` (ios-accueil) suivent `devices`.
    #expect(
        Array(collector.events.map(\.name).prefix(6)) == ["hello", "store", "conduite", "devices", "components", "journal"],
        "l'ordre d'ouverture réel doit être hello, store, conduite, devices, components, journal"
    )
    let components = try #require(collector.events.first { $0.name == "components" }?.data)
    let componentsPayload = try JSONDecoder().decode(RemoteComponentsPayload.self, from: Data(components.utf8))
    #expect(componentsPayload.ompInstalled)
    #expect(componentsPayload.ompPath == "/tmp/omp/bin/omp")
    let journal = try #require(collector.events.first { $0.name == "journal" }?.data)
    let journalPayload = try JSONDecoder().decode(RemoteJournalPayload.self, from: Data(journal.utf8))
    #expect(journalPayload.entries.isEmpty)
}

@MainActor
@Test("ios-accueil/AC-13 : un changement des composants ou du journal est poussé sans nouvelle requête")
func componentsAndJournalChangesArePushed() async throws {
    let componentsBox = StreamBox(
        RemoteComponentsPayload(ompInstalled: true, ompPath: nil, setupBanner: nil)
    )
    let entry = ActionJournalEntry(
        id: "cmd-1", kindLabel: ActionsText.launchLabel, targetLabel: "Titre", state: .awaitingAck, at: 1
    )
    let journalBox = StreamBox<[ActionJournalEntry]>([])
    let componentsSubject = PassthroughSubject<Void, Never>()
    let journalSubject = PassthroughSubject<Void, Never>()

    let stack = try await RemoteStack.make(
        components: { componentsBox.value },
        journal: { journalBox.value },
        componentsChanges: componentsSubject.eraseToAnyPublisher(),
        journalChanges: journalSubject.eraseToAnyPublisher()
    )
    defer { stack.stop() }
    let token = try await stack.pair()

    let collector = SSECollector()
    collector.start(stack.request("GET", "/v1/stream", token: token))
    defer { collector.stop() }
    _ = await collector.waitFor("components")
    _ = await collector.waitFor("journal")

    // 1. La présence change : la trame `components` repart avec la charge complète.
    componentsBox.value = RemoteComponentsPayload(
        ompInstalled: false, ompPath: nil, setupBanner: "Préparation incomplète."
    )
    componentsSubject.send()
    let pushedComponents = try #require(
        await collector.waitFor("components", occurrence: 2),
        "un changement de composants doit être poussé (échec=\(collector.failure ?? "aucun"))"
    )
    #expect(pushedComponents.contains("\"ompInstalled\":false"))
    #expect(pushedComponents.contains("Préparation incomplète."))

    // 2. Le journal change : la trame `journal` repart.
    journalBox.value = [entry]
    journalSubject.send()
    let pushedJournal = try #require(
        await collector.waitFor("journal", occurrence: 2),
        "un changement de journal doit être poussé (échec=\(collector.failure ?? "aucun"))"
    )
    #expect(pushedJournal.contains("\"kindLabel\":\"lancement\""))
    #expect(pushedJournal.contains("cmd-1"))
}
