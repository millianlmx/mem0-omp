// Le premier chargement après un redéploiement : sans boîte lue (serveur qui redémarre, lecture en échec), le flux
// ne rejoue plus tout le journal depuis 0 — il part du dernier événement (`after=latest`, omp-harness
// premier-chargement/AC-3) et relit la boîte —, et le Mac ne change plus un vieil événement en notification locale.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private let inboxAt42 = #"{"cursor":42,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#

@Suite("Premier chargement")
@MainActor
struct PremierChargementTests {
    @Test("sans boîte lue, le flux part du dernier événement (after=latest) et relit la boîte ; ensuite il reprend de son curseur, jamais de 0")
    func streamWithoutCursorStartsAtLatest() async {
        let transport = ScriptedHarnessTransport()
        transport.respond { _ in HarnessReply(status: 500, body: Data(#"{"error":"panne"}"#.utf8)) }
        let model = HarnessModel(
            transport: transport,
            preferences: InMemoryClientPreferences([HarnessModel.addressKey: "https://vps.example"]),
            tokens: InMemoryTokenStore([HarnessModel.tokenAccount: "t"]),
            retryDelay: .milliseconds(50), refreshDelay: .milliseconds(10), reporter: .off
        )
        await model.load()
        #expect(model.eventCursor == 0, "la boîte n'a pas pu être lue")

        transport.respond { call in
            call.path == "/v1/inbox" ? HarnessReply(status: 200, body: Data(inboxAt42.utf8)) : HarnessReply(status: 404, body: Data())
        }
        model.startLive()
        #expect(await eventually { transport.calls.contains { $0.path == "/v1/events?after=latest" } })
        #expect(await eventually { model.eventCursor == 42 }, "la boîte est relue à l'ouverture du flux")
        // Le flux de la doublure se ferme aussitôt : il est rouvert, cette fois depuis le curseur de la boîte.
        #expect(await eventually { transport.calls.contains { $0.path == "/v1/events?after=42" } })
        model.stopLive()
        #expect(!transport.calls.contains { $0.path == "/v1/events?after=0" }, "le journal n'est jamais rejoué depuis 0")
    }

    @Test("un événement du flux vieux de plus de 10 minutes ne devient pas une notification locale ; sans date, il n'est pas jugé vieux")
    func staleEventsAreNotNotified() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        func event(at seconds: Double?) -> HarnessStreamEvent {
            let stamp = seconds.map { #","at":\#(Int64($0 * 1000))"# } ?? ""
            return HarnessStreamEvent(name: "specs_ready", data: Data(#"{"id":1\#(stamp),"runId":"r1","payload":{}}"#.utf8))
        }
        #expect(HarnessNotificationCenter.isStale(event(at: now.timeIntervalSince1970 - 11 * 60), now: now))
        #expect(!HarnessNotificationCenter.isStale(event(at: now.timeIntervalSince1970 - 60), now: now))
        #expect(!HarnessNotificationCenter.isStale(event(at: nil), now: now))
    }
}
