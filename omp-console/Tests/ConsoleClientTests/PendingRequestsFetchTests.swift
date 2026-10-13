// La liste des attentes lue par l'iPhone (attentes-dispersees-entre-sources, S-8) :
// trois lectures du Mac (store, conduite, session), un échec typé dès qu'une
// source manque, jamais de liste partielle.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

/// Le chemin de la lecture de chaque source.
private func path(of source: PendingRequestsSource) -> String {
    switch source {
    case .store: return "/v1/store"
    case .conduite: return "/v1/conduite"
    case .session: return "/v1/session"
    }
}

/// Un corps d'erreur du contrat, construit par `JSONSerialization`.
private func envelope(_ code: String, _ message: String) -> Data {
    (try? JSONSerialization.data(
        withJSONObject: ["error": ["code": code, "message": message]],
        options: [.sortedKeys]
    )) ?? Data()
}

private let unavailableDetail = "le service OMP ne répond pas"

private let storeBody: Data = {
    let snapshot = try! JSONEncoder().encode(ClientFixtures.snapshot())
    return Data(#"{"snapshot":"#.utf8) + snapshot + Data("}".utf8)
}()

/// Une file de dialogues SANS `at` : un Mac ou un service antérieur.
private let conduiteBody = Data("""
{"state":"live","repoKey":"0123456789abcdef","name":"Projet","repoRoot":"/tmp/projet",\
"dialogs":[{"id":"dlg-1","method":"select","title":"Quelle feature ?","options":["a","b"],\
"optionDescriptions":[],"promptStyle":false}]}
""".utf8)

private let sessionBody = Data("""
{"state":"running","stateLabel":"En marche","sessionId":"sess-1","dialogs":[\
{"id":"dlg-2","method":"confirm","title":"Arrêter ?","options":[],"optionDescriptions":[],"promptStyle":false}\
],"transcript":[],"truncated":false}
""".utf8)

private func ok(_ body: Data) -> Result<ClientHTTPResponse, Error> {
    .success(ClientHTTPResponse(status: 200, protocolVersion: ConsoleAPI.protocolVersion, body: body))
}

/// Un modèle au Mac connu par son adresse manuelle, non démarré : aucune lecture de
/// fond, seules les requêtes du test partent. `failing` répond 503 avec enveloppe.
@MainActor
private func harness(failing: PendingRequestsSource? = nil) -> ClientHarness {
    let harness = ClientHarness(tokens: ["d": "tok"], preferences: [ClientPreferenceKey.deviceId: "d"])
    harness.transport.respond { request in
        if let failing, request.path == path(of: failing) {
            return .success(ClientHTTPResponse(
                status: 503, protocolVersion: ConsoleAPI.protocolVersion, body: envelope("unavailable", unavailableDetail)
            ))
        }
        switch request.path {
        case "/v1/store": return ok(storeBody)
        case "/v1/conduite": return ok(conduiteBody)
        case "/v1/session": return ok(sessionBody)
        default: return .failure(ClientError.transport(.unreachable("route non scriptée")))
        }
    }
    _ = harness.model.setManualAddress("10.0.0.5:9000")
    return harness
}

@Suite("attentes-dispersees-entre-sources — la liste lue par l'iPhone")
@MainActor
struct PendingRequestsFetchTests {
    @Test(
        "attentes-dispersees-entre-sources/AC-11 : une source en échec rend un échec typé qui la désigne, sans aucune liste",
        arguments: PendingRequestsSource.allCases
    )
    func oneFailingSourceFailsTheWholeList(_ source: PendingRequestsSource) async {
        let harness = harness(failing: source)
        var list: [PendingRequest]?
        await #expect(throws: PendingRequestsUnavailable(source: source, cause: .api(.unavailable(unavailableDetail)))) {
            list = try await harness.model.pendingRequests()
        }
        #expect(list == nil, "aucune liste, même partielle")
        // Les sources sont lues dans l'ordre store → conduite → session, et la
        // première en échec arrête la lecture.
        let order = PendingRequestsSource.allCases
        let failedAt = order.firstIndex(of: source)!
        for (index, other) in order.enumerated() {
            #expect(
                harness.transport.count(method: "GET", path: path(of: other)) == (index <= failedAt ? 1 : 0),
                "\(other.rawValue) lue \(index <= failedAt ? "une fois" : "jamais")"
            )
        }
    }

    @Test("un client non connecté échoue sur le magasin sans émettre de requête")
    func notConnectedFailsOnStoreWithoutRequest() async {
        let harness = ClientHarness()
        await #expect(throws: PendingRequestsUnavailable(source: .store, cause: .notConnected)) {
            _ = try await harness.model.pendingRequests()
        }
        #expect(harness.transport.requestCount == 0)
    }

    @Test("les dialogues sans horodatage d'un Mac antérieur sont listés avec une ancienneté nulle")
    func dialogsWithoutTimestampAreListedAtZero() async throws {
        let harness = harness()
        let list = try await harness.model.pendingRequests()
        #expect(list.map(\.nature) == [.conduiteDialog, .sessionDialog])
        #expect(list.map(\.at) == [0, 0])
        #expect(list.map(\.id) == ["conduite:dlg-1:0", "session:dlg-2:0"])
        #expect(list.map(\.reply) == [
            .conduiteDialog(dialogId: "dlg-1", method: .select),
            .sessionDialog(dialogId: "dlg-2", method: .confirm),
        ])
    }
}
