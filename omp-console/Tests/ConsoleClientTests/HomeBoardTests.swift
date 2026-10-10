// Les faits de l'Accueil portés par le client (S-8, BR-3) : l'ardoise dérivée du
// fixture partagé, l'état de `omp`, la préférence de bienvenue et le journal.
//
// La dérivation est prouvée ici, côté CLIENT, sur `HomeParity.snapshot` avec une
// horloge FIXE : la vue iOS ne dérive rien, elle lit ces valeurs publiées.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
private let mac = DiscoveredMac(
    name: "OMP Console",
    endpoint: .bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)
)

@MainActor
private let macEndpoint = ClientEndpoint.bonjour(name: "OMP Console", host: "192.168.1.12", port: 8787)

/// L'horloge fixe des tests : la même que les timestamps du fixture, pour que la
/// dérivation soit déterministe.
private let fixedNowMs: Double = 1_700_000_000_000

@Suite("Ardoise et faits de l'Accueil")
@MainActor
struct HomeBoardTests {
    private func connectedHarness() async -> ClientHarness {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"],
            nowMs: { fixedNowMs }
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        return harness
    }

    @Test("ios-accueil/AC-1, accueil-en-cours-melange-pause-et-compte/AC-2 : board porte les cinq listes du fixture partagé, identiques à celles du Mac, après une trame store")
    func boardDerivesFromFixture() async {
        let harness = await connectedHarness()
        #expect(harness.model.board == .loading, "aucun instantané ⇒ .loading")
        harness.transport.push(ClientFixtures.storeFrame(HomeParity.snapshot))
        #expect(await eventually { harness.model.board != .loading })

        let board = harness.model.board
        #expect(
            HomePresentation.attentionCount(omp: harness.model.omp, board: board) == 5,
            "5 attentions (question en vol, jalon specs, jalon revue, échec, blocage)"
        )
        guard case .dashboard(let dashboard) = HomePresentation.state(omp: harness.model.omp, board: board),
              case .board(let macBoard) = HomeParity.board else {
            Issue.record("l'ardoise du fixture donne un tableau de bord")
            return
        }
        #expect(dashboard.attention.count == 5)
        #expect(dashboard.running.count == 2)
        #expect(dashboard.paused.count == 1)
        #expect(dashboard.notStarted.count == 1)
        #expect(dashboard.delivered.count == 2)
        // AC-2 : les cinq listes du client sont celles que le Mac dérive du même
        // instantané (identifiants, dans l'ordre).
        let mac = HomePresentation.dashboard(macBoard)
        #expect(dashboard.attention.map(\.id) == mac.attention.map(\.id))
        #expect(dashboard.running.map(\.id) == mac.running.map(\.id))
        #expect(dashboard.paused.map(\.id) == mac.paused.map(\.id))
        #expect(dashboard.notStarted.map(\.id) == mac.notStarted.map(\.id))
        #expect(dashboard.delivered.map(\.id) == mac.delivered.map(\.id))
        harness.stop()
    }

    @Test("ios-accueil/AC-2 : store() REST recalcule aussi l'ardoise")
    func boardDerivesFromRestStore() async throws {
        let harness = await connectedHarness()
        harness.transport.respond { request in
            if request.path == "/v1/store" {
                let payload = RemoteStorePayload(snapshot: HomeParity.snapshot)
                guard let body = try? JSONEncoder().encode(payload) else {
                    return .failure(ClientError.decoding("instantané non encodable"))
                }
                return .success(ClientHTTPResponse(status: 200, protocolVersion: 1, body: body))
            }
            return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
        _ = try await harness.model.store()
        #expect(harness.model.snapshot == HomeParity.snapshot)
        #expect(HomePresentation.attentionCount(omp: harness.model.omp, board: harness.model.board) == 5)
        harness.stop()
    }

    @Test("ios-accueil/AC-10 : omp bascule .missing seulement sur ompInstalled == false")
    func ompFollowsComponents() async {
        let harness = await connectedHarness()
        // Sans réponse du Mac, on ne conclut JAMAIS à l'absence.
        #expect(harness.model.components == nil)
        #expect(harness.model.omp != .missing)

        harness.transport.push(ClientFixtures.frame("components", #"{"ompInstalled":false}"#))
        #expect(await eventually { harness.model.omp == .missing })

        harness.transport.push(
            ClientFixtures.frame("components", #"{"ompInstalled":true,"ompPath":"/usr/local/bin/omp"}"#)
        )
        #expect(await eventually {
            harness.model.omp == .available(URL(fileURLWithPath: "/usr/local/bin/omp"))
        })
        harness.stop()
    }

    @Test("ios-accueil/AC-18 : closeWelcome persiste home.welcomeSeen et la relit")
    func welcomePreference() async {
        let preferences = InMemoryClientPreferences()
        let first = ConsoleClientModel(
            transport: ScriptedTransport(),
            discovery: ScriptedDiscovery(),
            preferences: preferences,
            tokens: InMemoryTokenStore(),
            pathSource: ScriptedPathSource()
        )
        first.start()
        #expect(first.welcomeSeen == false)
        first.closeWelcome()
        #expect(first.welcomeSeen == true)
        #expect(preferences.bool(forKey: ClientPreferenceKey.welcomeSeen) == true)
        first.stop()

        let second = ConsoleClientModel(
            transport: ScriptedTransport(),
            discovery: ScriptedDiscovery(),
            preferences: preferences,
            tokens: InMemoryTokenStore(),
            pathSource: ScriptedPathSource()
        )
        second.start()
        #expect(second.welcomeSeen == true, "une seconde construction relit la préférence")
        second.stop()
    }

    @Test("ios-accueil/AC-7 : une trame journal publie les entrées et un geste les rafraîchit")
    func journalFrameAndGesture() async throws {
        let harness = await connectedHarness()
        let entry = ActionJournalEntry(
            id: "j1",
            kindLabel: "réponse",
            targetLabel: "alpha",
            state: .delivered,
            at: fixedNowMs
        )
        let payload = RemoteJournalPayload(entries: [entry])
        let json = String(decoding: try JSONEncoder().encode(payload), as: UTF8.self)
        harness.transport.push(ClientFixtures.frame("journal", json))
        #expect(await eventually { harness.model.journal == [entry] })

        // Un geste émis rafraîchit les faits : la route du geste ET les lectures
        // `components()`/`journal()` partent réellement.
        harness.transport.respond { request in
            if request.path == "/v1/cards/c1/resume" {
                return .success(ClientHTTPResponse(
                    status: 202,
                    protocolVersion: 1,
                    body: Data(#"{"accepted":true}"#.utf8)
                ))
            }
            if request.path == "/v1/journal" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: try! JSONEncoder().encode(payload)
                ))
            }
            if request.path == "/v1/components" {
                return .success(ClientHTTPResponse(
                    status: 200,
                    protocolVersion: 1,
                    body: Data(#"{"ompInstalled":true,"ompPath":"/usr/local/bin/omp"}"#.utf8)
                ))
            }
            return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
        _ = try await harness.model.resume(cardId: "c1")
        #expect(await eventually { harness.transport.count(method: "GET", path: "/v1/journal") >= 1 })
        #expect(await eventually { harness.transport.count(method: "GET", path: "/v1/components") >= 1 })
        harness.stop()
    }

    @Test("ios-accueil/AC-3, AC-4, AC-5, AC-6, AC-7 : chaque geste part par sa route et son corps exacts")
    func gestureRoutesAndBodies() async throws {
        let harness = await connectedHarness()
        harness.transport.respond { request in
            let accepted = request.method == "POST"
            return .success(ClientHTTPResponse(
                status: accepted ? 202 : 200,
                protocolVersion: 1,
                body: Data((accepted ? #"{"accepted":true}"# : #"{"entries":[]}"#).utf8)
            ))
        }
        // Les cinq gestes de l'Accueil : deux formes de réponse, un verdict, une
        // reprise, un texte libre.
        _ = try await harness.model.answer(cardId: "c1", kind: "selected", label: "Avec le drapeau", text: nil)
        _ = try await harness.model.answer(cardId: "c1", kind: "custom", label: nil, text: "livrer plus tard")
        _ = try await harness.model.reply(cardId: "c1", text: "ma réponse")
        _ = try await harness.model.verdict(cardId: "c1", verdict: "specs")
        _ = try await harness.model.verdict(cardId: "c1", verdict: "review")
        _ = try await harness.model.resume(cardId: "c1")

        func bodies(_ path: String) -> [[String: Any]] {
            harness.transport.requests
                .filter { $0.path == path }
                .compactMap { (try? JSONSerialization.jsonObject(with: $0.body ?? Data())) as? [String: Any] }
        }

        let answers = bodies("/v1/cards/c1/answer")
        #expect(answers.count == 2, "une réponse sélectionnée puis un texte libre")
        #expect(answers.first?["kind"] as? String == "selected")
        #expect(answers.first?["label"] as? String == "Avec le drapeau")
        #expect(answers.last?["kind"] as? String == "custom")
        #expect(answers.last?["text"] as? String == "livrer plus tard")

        let replies = bodies("/v1/cards/c1/reply")
        #expect(replies.first?["text"] as? String == "ma réponse")

        let verdicts = bodies("/v1/cards/c1/verdict")
        #expect(verdicts.compactMap { $0["verdict"] as? String } == ["specs", "review"])

        // La reprise n'a AUCUN corps : un POST sur sa route suffit.
        #expect(harness.transport.requests.contains { $0.method == "POST" && $0.path == "/v1/cards/c1/resume" })

        // Aucune écriture du magasin : toutes les écritures partent par une route
        // de carte (aucune ne vise le magasin). La relecture des PR demandée à
        // l'ouverture du flux (S-6) n'écrit rien : elle est hors de ce compte.
        let writes = harness.transport.requests.filter {
            $0.method != "GET" && $0.path != "/v1/pull-request-states/refresh"
        }
        #expect(writes.allSatisfy { $0.path.hasPrefix("/v1/cards/") })
        harness.stop()
    }
}
