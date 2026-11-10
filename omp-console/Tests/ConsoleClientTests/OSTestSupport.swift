// Le socle des tests de l'OS agentique côté client : un faux serveur sur la doublure de
// transport (la boîte, puis les routes que le test décrit ; tout le reste en 404 « route
// inconnue », comme un serveur antérieur), un modèle relié, et la lecture des appels partis.

@testable import ConsoleClient
import Foundation
import Testing

func osJSON(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

/// Une feature telle que le serveur l'écrit, au strict nécessaire ; `extra` : des champs en plus (`,"rev":4`).
func osRunJSON(_ id: String, state: String = "running", step: String = "impl", repo: String = "demo", title: String? = nil, extra: String = "") -> String {
    #"{"id":""# + id + #"","repo":""# + repo + #"","slug":""# + id + #"","title":""# + (title ?? id) + #"","request":"demande","state":""# + state
        + #"","step":""# + step + #"","fixes":0,"modules":[],"createdAt":1,"updatedAt":2"# + extra + "}"
}

/// Une boîte où la feature `r1` travaille, à la révision 4 : un geste part avec `If-Match: "4"`.
let osInboxJSON = #"{"cursor":42,"batches":[],"awaiting":[],"decisions":[],"runs":["# + osRunJSON("r1", extra: #","rev":4"#) + "]}"

/// Un faux serveur : `handler` répond aux routes du test (`nil` : pas la sienne) ; la boîte est
/// servie, le reste rend 404 « route inconnue ».
func osTransport(inbox: String = osInboxJSON, _ handler: @escaping @Sendable (HarnessCall) -> HarnessReply?) -> ScriptedHarnessTransport {
    let transport = ScriptedHarnessTransport()
    transport.respond { call in
        if let reply = handler(call) { return reply }
        if call.method == "GET", call.path == "/v1/inbox" { return osJSON(inbox) }
        return osJSON(#"{"error":"route inconnue"}"#, status: 404)
    }
    return transport
}

/// Un faux serveur décrit par une table « MÉTHODE chemin » → réponse.
func osTransport(inbox: String = osInboxJSON, routes: [String: HarnessReply]) -> ScriptedHarnessTransport {
    osTransport(inbox: inbox) { call in routes["\(call.method) \(call.path)"] }
}

/// Un modèle relié au faux serveur, relectures regroupées sur 1 ms.
@MainActor
func osConnected(_ transport: ScriptedHarnessTransport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1), reporter: .off
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

extension ScriptedHarnessTransport {
    /// Le dernier appel parti vers cette route.
    func last(_ method: String, _ path: String) -> HarnessCall? {
        calls.last { $0.method == method && $0.path == path }
    }

    /// Le nombre d'appels partis vers cette route.
    func count(_ method: String, _ path: String) -> Int {
        calls.filter { $0.method == method && $0.path == path }.count
    }

    /// Le corps JSON du dernier appel vers cette route ; `nil` sans appel ou sans corps.
    func body(_ method: String, _ path: String) -> [String: Any]? {
        guard let data = last(method, path)?.body else { return nil }
        return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Le corps brut du dernier appel vers cette route, tel qu'il est parti.
    func rawBody(_ method: String, _ path: String) -> String? {
        last(method, path)?.body.map { String(decoding: $0, as: UTF8.self) }
    }

    /// Livre ces événements au flux de la boîte (`event:` seul compte pour les modèles).
    func push(events names: [String]) {
        stream(names.enumerated().map { index, name in Data("id: \(100 + index)\nevent: \(name)\ndata: {}\n\n".utf8) })
    }
}
