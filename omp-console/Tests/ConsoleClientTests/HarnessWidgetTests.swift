// Le widget d'écran d'accueil vu du client : l'instantané qu'il montre (ce qui attend
// l'humain d'abord, features terminées exclues), le lien qui ouvre l'Accueil, et la
// lecture de la boîte hors du modèle de l'app — sur la doublure de transport.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func run(_ id: String, _ state: String, step: String? = "impl") -> HarnessRun {
    HarnessRun(id: id, repo: "demo", slug: id, title: id.uppercased(), request: id, state: state, step: step)
}

@Suite("Serveur de pipelines — widget d'écran d'accueil")
struct HarnessWidgetTests {
    @Test("l'instantané met d'abord ce qui attend l'humain, écarte les features terminées et porte alertes et coûts")
    func snapshot() {
        let inbox = HarnessInbox(
            runs: [run("r1", "running"), run("r2", "awaiting_human", step: "specs"), run("r3", "merged"), run("r4", "queued", step: "req")],
            alerts: [HarnessAlert(runId: "r1", kind: "stalled")],
            costs: ["r1": 0.42]
        )
        let snapshot = HarnessWidgetSnapshot(inbox: inbox, configured: true, now: Date(timeIntervalSince1970: 100))
        #expect(snapshot.runs.map(\.id) == ["r2", "r1", "r4"])
        #expect(snapshot.activeCount == 3)
        #expect(snapshot.alerts == 1)
        #expect(snapshot.runs[1].alert == "stalled")
        #expect(snapshot.runs[1].cost == 0.42)
        #expect(snapshot.runs[0].needsHuman)
        let later = HarnessWidgetSnapshot(inbox: inbox, configured: true, now: Date(timeIntervalSince1970: 200))
        #expect(later.sameContent(as: snapshot), "seule l'heure de lecture change : rien à redessiner")
        #expect(!HarnessWidgetSnapshot.unconfigured.sameContent(as: snapshot))
        let many = HarnessInbox(runs: (1...20).map { run("x\($0)", "running") })
        #expect(HarnessWidgetSnapshot(inbox: many, configured: true).runs.count == HarnessWidgetSnapshot.keep)
        #expect(HarnessWidgetSnapshot(inbox: many, configured: true).activeCount == 20)
    }

    @Test("le lien du widget ouvre une section ; tout autre lien est ignoré")
    func link() {
        let url = HarnessWidgetLink.url(.home)
        #expect(url.absoluteString == "ompconsole://home")
        #expect(HarnessWidgetLink.section(of: url) == .home)
        #expect(HarnessWidgetLink.section(of: URL(string: "https://example.com/home")!) == nil)
        #expect(HarnessWidgetLink.section(of: URL(string: "ompconsole://inconnue")!) == nil)
    }

    @Test("l'instantané fait l'aller-retour par le groupe d'apps ; un bundle sans groupe n'en a pas")
    func store() throws {
        let store = HarnessWidgetStore(group: "test.omp.widget.\(UUID().uuidString)")
        let snapshot = HarnessWidgetSnapshot(configured: true, pending: 2, runs: [.init(id: "r1", title: "A", state: "running")], activeCount: 1, updatedAt: 5)
        store.save(snapshot)
        #expect(store.snapshot() == snapshot)
        store.saveAddress("https://vps.example")
        #expect(store.address() == "https://vps.example")
        store.saveAddress(nil)
        #expect(store.address() == nil)
        #expect(HarnessWidgetStore.fromBundle(Bundle(for: BundleMarker.self)) == nil)
    }

    @Test("le widget lit la boîte par GET /v1/inbox ; un jeton refusé se dit")
    func reader() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond { call in
            call.path == "/v1/inbox"
                ? HarnessReply(status: 200, body: Data(#"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":4}"#.utf8))
                : HarnessReply(status: 404, body: Data())
        }
        let inbox = try await HarnessInboxReader.read(address: "https://vps.example", token: "t", transport: transport)
        #expect(inbox.cursor == 4)
        transport.respond { _ in HarnessReply(status: 401, body: Data()) }
        await #expect(throws: HarnessFailure.unauthorized) {
            try await HarnessInboxReader.read(address: "https://vps.example", token: "t", transport: transport)
        }
    }
}

private final class BundleMarker {}
