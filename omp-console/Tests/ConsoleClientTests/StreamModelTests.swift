// Le modèle observable du flux temps réel (S-2) : les trames mettent à jour les
// valeurs publiées SANS aucun rechargement (AC-11), et un geste rend le résultat
// typé de la route puis la trame `store` qui suit (AC-12).

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

@Suite("Flux et modèle")
@MainActor
struct StreamModelTests {
    @Test("client-distant-ios/AC-11 : une trame store met à jour snapshot sans rechargement")
    func storeFrameUpdatesSnapshot() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        // La connexion déclenche le rafraîchissement des faits de l'Accueil
        // (S-8) et la demande de relecture des PR (S-6) : on les attend, puis on
        // mesure la trame `store` seule.
        #expect(await eventually { harness.transport.count(method: "GET", path: "/v1/journal") >= 1 })
        #expect(await eventually {
            harness.transport.count(method: "POST", path: "/v1/pull-request-states/refresh") >= 1
        })
        let before = harness.transport.requestCount
        let snapshot = ClientFixtures.snapshot()
        harness.transport.push(ClientFixtures.storeFrame(snapshot))
        #expect(await eventually { harness.model.snapshot == snapshot })
        #expect(harness.transport.requestCount == before, "aucune requête émise à la réception d'une trame")
        harness.stop()
    }

    @Test("client-distant-ios/AC-12 : un geste rend le résultat typé et la trame store qui suit")
    func gestureThenStore() async throws {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.respond { request in
            if request.path == "/v1/cards/c1/reply" {
                return .success(ClientHTTPResponse(
                    status: 202,
                    protocolVersion: 1,
                    body: Data(#"{"accepted":true}"#.utf8)
                ))
            }
            return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        let accepted = try await harness.model.reply(cardId: "c1", text: "ok")
        #expect(accepted.accepted)
        let snapshot = ClientFixtures.snapshot()
        harness.transport.push(ClientFixtures.storeFrame(snapshot))
        #expect(await eventually { harness.model.snapshot == snapshot })
        harness.stop()
    }

    @Test("ios-projet/AC-6 : une trame conduite s'applique, la file est remplacée en entier")
    func conduiteFrameReplacesQueue() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })

        harness.transport.push(ClientFixtures.frame("conduite", #"{"state":"live"}"#))
        #expect(await eventually { harness.model.conduite?.state == "live" })
        #expect(harness.model.conduite?.dialogs.isEmpty == true)

        // La file est REMPLACÉE EN ENTIER, jamais un delta.
        harness.transport.push(ClientFixtures.frame(
            "conduite",
            #"{"state":"live","dialogs":[{"id":"d1","method":"confirm","title":"Valider ?","options":[],"optionDescriptions":[],"promptStyle":false}]}"#
        ))
        #expect(await eventually { harness.model.conduite?.dialogs.count == 1 })
        harness.transport.push(ClientFixtures.frame("conduite", #"{"state":"live"}"#))
        #expect(await eventually { harness.model.conduite?.dialogs.isEmpty == true })
        harness.stop()
    }

    @Test("le flux décode les trames devices et sessions, et borne les mises à jour")
    func streamEventsApplied() async {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        #expect(await eventually { harness.model.state == .searching })
        harness.discovery.emit([mac])
        #expect(await eventually { harness.model.state == .connected(endpoint: macEndpoint) })
        harness.transport.push(ClientFixtures.frame(
            "devices",
            #"{"devices":[{"id":"a","name":"iPhone","pairedAtMs":1,"lastSeenAtMs":2,"connected":true}]}"#
        ))
        #expect(await eventually { harness.model.devices.count == 1 })
        harness.transport.push(ClientFixtures.frame("sessions", #"{"file":"/tmp/x.jsonl"}"#))
        #expect(await eventually { harness.model.sessionUpdates.count == 1 })
        harness.stop()
    }

    @Test("le flux d'une session délivre ses ajouts à l'abonné de SON fichier, et à lui seul")
    func sessionFeedDeliversAdditionsByFile() async {
        let harness = await Self.connectedHarness()
        let x = FeedRecorder(harness.model.sessionFeed(forFile: "/tmp/x.jsonl"))
        let y = FeedRecorder(harness.model.sessionFeed(forFile: "/tmp/y.jsonl"))

        harness.transport.push(ClientFixtures.frame(
            "sessions",
            #"{"file":"/tmp/x.jsonl","added":[{"index":1,"offset":0,"kind":"user","text":"salut"}]}"#
        ))
        #expect(await eventually { x.items.count == 1 })
        #expect(y.items.isEmpty, "la trame d'un autre fichier n'est délivrée à personne")
        guard case .added(let added)? = x.items.first else {
            Issue.record("trame `sessions` non délivrée en `.added`")
            return
        }
        #expect(added.map(\.index) == [1])
        #expect(added.map(\.offset) == [0], "l'offset transporté est ce qui rend les identités stables")
        #expect(added.map(\.kind) == ["user"])
        #expect(added.map(\.text) == ["salut"])

        // Un `added` VIDE ne délivre rien, et la trame est toujours allée aux DEUX
        // abonnés du même fichier (multicast).
        let x2 = FeedRecorder(harness.model.sessionFeed(forFile: "/tmp/x.jsonl"))
        harness.transport.push(ClientFixtures.frame("sessions", #"{"file":"/tmp/x.jsonl","added":[]}"#))
        harness.transport.push(ClientFixtures.frame(
            "sessions",
            #"{"file":"/tmp/x.jsonl","added":[{"index":2,"offset":20,"kind":"user","text":"encore"}]}"#
        ))
        #expect(await eventually { x.items.count == 2 && x2.items.count == 1 })
        guard case .added(let second)? = x2.items.last else {
            Issue.record("le second abonné du même fichier n'a rien reçu")
            return
        }
        #expect(second.map(\.text) == ["encore"])
        #expect(y.items.isEmpty)
        x.stop()
        x2.stop()
        harness.stop()
    }

    @Test("un incident `truncated`/`replaced` commande une relecture, jamais un ajout")
    func sessionFeedRewroteOnIssue() async {
        let harness = await Self.connectedHarness()
        let feed = FeedRecorder(harness.model.sessionFeed(forFile: "/tmp/x.jsonl"))

        harness.transport.push(ClientFixtures.frame("sessions", #"{"file":"/tmp/x.jsonl","issue":"truncated"}"#))
        #expect(await eventually { feed.items == [.rewrote] })
        harness.transport.push(ClientFixtures.frame("sessions", #"{"file":"/tmp/x.jsonl","issue":"replaced"}"#))
        #expect(await eventually { feed.items == [.rewrote, .rewrote] })
        feed.stop()
        harness.stop()
    }

    @Test("la fin de l'abonné retire son continuateur : le fichier quitte le registre")
    func sessionFeedForgetsTerminatedSubscriber() async {
        let harness = await Self.connectedHarness()
        let feed = FeedRecorder(harness.model.sessionFeed(forFile: "/tmp/x.jsonl"))
        #expect(harness.model.sessionFeedSubscriberCount == 1)

        feed.stop()
        #expect(await eventually { harness.model.sessionFeedSubscriberCount == 0 })

        // La trame suivante n'a plus personne à réveiller : rien ne fuit, rien ne plante.
        harness.transport.push(ClientFixtures.frame(
            "sessions",
            #"{"file":"/tmp/x.jsonl","added":[{"index":1,"offset":0,"kind":"user","text":"tard"}]}"#
        ))
        #expect(harness.model.sessionFeedSubscriberCount == 0)
        harness.stop()
    }

    /// Un harnais DÉJÀ connecté au flux (les trames n'arrivent que là) : la recette
    /// de connexion est celle des autres tests de cette suite.
    private static func connectedHarness() async -> ClientHarness {
        let harness = ClientHarness(
            tokens: ["d": "tok"],
            preferences: [ClientPreferenceKey.deviceId: "d"]
        )
        harness.transport.script(.hold)
        harness.model.start()
        _ = await eventually { harness.model.state == .searching }
        harness.discovery.emit([mac])
        _ = await eventually { harness.model.state == .connected(endpoint: macEndpoint) }
        return harness
    }
}

/// L'observateur d'un flux de session : il accumule SANS terminer le flux, ce qui
/// permet d'observer le registre du modèle au fil des trames.
@MainActor
private final class FeedRecorder {
    private(set) var items: [RemoteSessionFeedItem] = []
    private var task: Task<Void, Never>?

    init(_ stream: AsyncStream<RemoteSessionFeedItem>) {
        task = Task { @MainActor [weak self] in
            for await item in stream {
                self?.items.append(item)
            }
        }
    }

    /// Annule la consommation : c'est ce qui termine le flux et déclenche
    /// `onTermination` côté modèle.
    func stop() {
        task?.cancel()
        task = nil
    }
}
