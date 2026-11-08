// Les notifications actionnables, côté client et sans système : la charge que le
// serveur pousse (omp-harness/push-alerts.ts), les gestes de chaque catégorie, le
// routage d'une action vers un geste ou une destination, l'exécution du geste avec la
// révision de la notification (If-Match), l'enregistrement du jeton de l'appareil, et
// les alertes locales que le Mac tire du flux.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private final class Recorder: HarnessTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [HarnessCall] = []
    private var servers: [String] = []
    let reply: @Sendable (HarnessCall) -> HarnessReply

    init(_ reply: @escaping @Sendable (HarnessCall) -> HarnessReply) { self.reply = reply }

    var calls: [HarnessCall] { lock.withLock { recorded } }
    /// L'hôte de chaque appel, dans l'ordre.
    var hosts: [String] { lock.withLock { servers } }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        lock.withLock {
            recorded.append(call)
            servers.append(server.baseURL.host ?? "")
        }
        return reply(call)
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        AsyncThrowingStream { $0.finish() }
    }
}

private func ok(_ json: String) -> HarnessReply { HarnessReply(status: 200, body: Data(json.utf8)) }

private let inbox = #"{"cursor":0,"batches":[],"awaiting":[],"decisions":[],"runs":[]}"#
private let approver = #"{"client":{"name":"app-approbateur","role":"admin","repos":"*","createdAt":1,"approver":true}}"#

/// Un serveur qui sert la boîte, `/v1/me` et accepte chaque geste.
private func server(me: String = approver) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): ok(inbox)
        case ("GET", "/v1/me"): ok(me)
        case ("POST", "/v1/push/devices"): HarnessReply(status: 201, body: Data(#"{"registered":true,"pushes":true}"#.utf8))
        case ("DELETE", _): ok(#"{"removed":true}"#)
        case ("POST", let path) where path.hasPrefix("/v1/workstation/actions/"):
            ok(#"{"action":{"seq":9,"createdAt":1,"updatedAt":2,"origin":"agent","kind":"type","rationale":"r","state":"queued","approved":true}}"#)
        default: ok(#"{"run":{}}"#)
        }
    }
}

@MainActor private func connected(_ transport: Recorder) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1)
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

/// Un événement du flux tel que le serveur l'écrit (`data:` = la ligne du journal).
private func event(_ name: String, _ data: String) -> HarnessStreamEvent {
    HarnessStreamEvent(name: name, data: Data(data.utf8))
}

private func body(_ call: HarnessCall?) -> [String: Any] {
    (call?.body).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
}

@Suite("Notifications actionnables")
@MainActor
struct HarnessNotificationsTests {
    @Test("la charge `omp` du serveur se lit : sorte, run, révision, envoi ; une sorte inconnue n'est pas une alerte")
    func payload() throws {
        // `JSONSerialization` : la forme exacte du userInfo que livre le système pour une charge APNs.
        let apns = try #require(
            try JSONSerialization.jsonObject(with: Data(#"""
            {"aps":{"alert":{"title":"Specs à valider","body":"demo · Panier"},"thread-id":"r1","category":"omp.validate"},
             "omp":{"kind":"specs","runId":"r1","rev":7}}
            """#.utf8)) as? [AnyHashable: Any]
        )
        #expect(HarnessPushAlert(userInfo: apns) == HarnessPushAlert(kind: .specs, runId: "r1", rev: 7))
        let approval = HarnessPushAlert(kind: .approval, rev: 1_761_730_000_123, seq: 9)
        #expect(HarnessPushAlert(userInfo: approval.userInfo) == approval, "une notification locale porte la même charge")
        #expect(HarnessPushAlert(userInfo: ["omp": ["kind": "inconnue"]]) == nil)
        #expect(HarnessPushAlert(userInfo: [:]) == nil)
    }

    @Test("chaque catégorie offre ses gestes : écrire exige l'appareil déverrouillé, refuser des specs demande la raison, approuver sans jeton approbateur ouvre l'app")
    func categories() {
        let validate = HarnessNotificationRouting.actions(for: .validate, approver: false)
        #expect(validate.map(\.action) == [.validate, .refuse, .open])
        #expect(validate[0].authenticationRequired && !validate[0].foreground)
        #expect(validate[1].authenticationRequired && validate[1].textInput && validate[1].destructive)
        #expect(validate[2].foreground && !validate[2].authenticationRequired)

        let approving = HarnessNotificationRouting.actions(for: .approve, approver: true)
        #expect(approving.map(\.action) == [.approve, .refuseSend, .open])
        #expect(approving[0].authenticationRequired && !approving[0].foreground, "l'approbateur approuve sans ouvrir l'app")
        let ordinary = HarnessNotificationRouting.actions(for: .approve, approver: false)
        #expect(ordinary.prefix(2).allSatisfy { $0.foreground && !$0.authenticationRequired }, "sans jeton approbateur : ouvrir l'app")

        #expect(HarnessNotificationRouting.actions(for: .open, approver: true).map(\.action) == [.open])
        #expect(HarnessNotificationCategory.allCases.map(\.rawValue) == ["omp.validate", "omp.approve", "omp.open"])
    }

    @Test("une action devient le geste de sa catégorie avec la révision de la notification ; sinon elle ouvre l'app là où le geste se fait")
    func routing() {
        let specs = HarnessPushAlert(kind: .specs, runId: "r1", rev: 7)
        let verdict = HarnessPushAlert(kind: .verdict, runId: "r2", rev: 3)
        let send = HarnessPushAlert(kind: .approval, rev: 1_761_730_000_123, seq: 9)
        func route(_ category: HarnessNotificationCategory, _ action: HarnessNotificationAction?, _ alert: HarnessPushAlert?, text: String? = nil, approver: Bool = true) -> HarnessNotificationGesture {
            HarnessNotificationRouting.gesture(category: category.rawValue, action: action, alert: alert, text: text, approver: approver)
        }
        #expect(route(.validate, .validate, specs) == .validate(runId: "r1", rev: 7))
        #expect(route(.validate, .refuse, verdict, text: "  le cache fuit  ") == .refuse(runId: "r2", rev: 3, reason: "le cache fuit"))
        #expect(route(.validate, .refuse, verdict, text: " ") == .open(.inbox(.verdicts)), "un refus sans raison ouvre l'app")
        #expect(route(.approve, .approve, send) == .approveSend(seq: 9, revision: 1_761_730_000_123))
        #expect(route(.approve, .refuseSend, send) == .refuseSend(seq: 9, revision: 1_761_730_000_123))
        #expect(route(.approve, .approve, send, approver: false) == .open(.section(.workstation)), "jeton ordinaire : le Poste")
        // Une action hors de sa catégorie (une charge forgée) n'agit pas.
        #expect(route(.open, .validate, specs) == .open(.inbox(.specs)))
        #expect(route(.validate, .approve, send) == .open(.section(.workstation)))
        #expect(route(.validate, .validate, HarnessPushAlert(kind: .specs)) == .open(.inbox(.specs)), "sans run, rien à valider")

        // Un toucher (ou « Ouvrir ») mène à la bonne section ou à la feature.
        let taps: [(HarnessPushAlert, HarnessPaletteCommand)] = [
            (specs, .inbox(.specs)),
            (verdict, .inbox(.verdicts)),
            (HarnessPushAlert(kind: .escalation, runId: "r1", rev: 2), .inbox(.toDecide)),
            (send, .section(.workstation)),
            (HarnessPushAlert(kind: .runFailed, runId: "r4", rev: 9), .run("r4")),
            (HarnessPushAlert(kind: .stalled, runId: "r4", rev: 9), .run("r4")),
            (HarnessPushAlert(kind: .budget, runId: "r4", rev: 9), .run("r4")),
            (HarnessPushAlert(kind: .vigieSilent), .section(.home)),
            (HarnessPushAlert(kind: .backupFailed), .section(.home)),
            (HarnessPushAlert(kind: .dailyBudget), .section(.home)),
        ]
        for (alert, destination) in taps {
            #expect(route(.open, nil, alert) == .open(destination))
            #expect(route(.open, .open, alert) == .open(destination))
        }
        #expect(route(.open, nil, nil) == .open(.section(.home)))
    }

    @Test("le geste part avec l'If-Match de la notification : valider, refuser avec sa raison, approuver ou refuser l'envoi")
    func execute() async {
        let transport = Recorder(server())
        let model = await connected(transport)
        #expect(await model.execute(.validate(runId: "r1", rev: 7)))
        var call = transport.calls.last { $0.path == "/v1/runs/r1/validate" }
        #expect(call?.headers["If-Match"] == "\"7\"")
        #expect(body(call)["approve"] as? Bool == true)

        #expect(await model.execute(.refuse(runId: "r1", rev: 8, reason: "le cache fuit")))
        call = transport.calls.last { $0.path == "/v1/runs/r1/validate" }
        #expect(call?.headers["If-Match"] == "\"8\"")
        #expect(body(call)["approve"] as? Bool == false)
        #expect(body(call)["reason"] as? String == "le cache fuit")

        #expect(await model.execute(.approveSend(seq: 9, revision: 1_761_730_000_123)))
        call = transport.calls.last { $0.path == "/v1/workstation/actions/9/approve" }
        #expect(call?.headers["If-Match"] == "\"1761730000123\"")

        #expect(await model.execute(.refuseSend(seq: 9, revision: 5)))
        #expect(transport.calls.last { $0.path == "/v1/workstation/actions/9/refuse" }?.headers["If-Match"] == "\"5\"")

        let before = transport.calls.count
        #expect(await model.execute(.open(.section(.home))) == false)
        #expect(transport.calls.count == before, "ouvrir n'appelle pas le serveur")
    }

    @Test("un envoi qui a bougé depuis la notification n'est pas approuvé : 412, l'échec le dit")
    func staleApproval() async {
        let transport = Recorder { call in
            if call.path.hasSuffix("/approve") { return HarnessReply(status: 412, body: Data(#"{"error":"périmé"}"#.utf8)) }
            return server()(call)
        }
        let model = await connected(transport)
        #expect(await model.execute(.approveSend(seq: 9, revision: 1)) == false)
        #expect(model.workstation.failure == .approvalChanged)
    }

    @Test("le jeton de l'appareil s'enregistre au serveur relié, le suit sur un autre serveur, et quitte le serveur oublié")
    func device() async {
        let transport = Recorder(server())
        let model = HarnessModel(
            transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(1)
        )
        // Pas encore de serveur : le jeton est retenu, rien ne part.
        #expect(await model.registerDevice(token: Data([0xab, 0x12]), environment: .sandbox) == false)
        #expect(transport.calls.isEmpty)

        _ = await model.configure(address: "vps.example", token: "t")
        let registered = transport.calls.last { $0.path == "/v1/push/devices" }
        #expect(registered?.method == "POST")
        #expect(body(registered)["token"] as? String == "ab12")
        #expect(body(registered)["platform"] as? String == "ios")
        #expect(body(registered)["environment"] as? String == "sandbox")

        _ = await model.configure(address: "autre.example", token: "t")
        let moves = transport.calls.enumerated().filter { $0.element.path.hasPrefix("/v1/push/devices") }
        #expect(moves.suffix(2).map(\.element.method) == ["DELETE", "POST"], "l'ancien serveur oublie l'appareil, le nouveau l'apprend")
        #expect(moves.suffix(2).map { transport.hosts[$0.offset] } == ["vps.example", "autre.example"])

        await model.forget()
        #expect(transport.calls.last?.method == "DELETE")
        #expect(transport.calls.last?.path == "/v1/push/devices/ab12")
    }

    @Test("la passerelle de l'appareil vient du profil embarqué : développement → sandbox ; ad hoc, App Store (sans profil) → production")
    func environment() {
        func profile(_ value: String) -> String {
            "\u{30}\u{82}<?xml version=\"1.0\"?><plist><dict><key>Entitlements</key><dict>"
                + "<key>aps-environment</key>\n\t\t<string>\(value)</string>"
                + "<key>get-task-allow</key><true/></dict></dict></plist>\u{A0}"
        }
        #expect(HarnessPushEnvironment(provisioningProfile: profile("development")) == .sandbox)
        #expect(HarnessPushEnvironment(provisioningProfile: profile("production")) == .production)
        #expect(HarnessPushEnvironment(provisioningProfile: "<plist><dict></dict></plist>") == .production)
        #expect(HarnessPushEnvironment(provisioningProfile: nil) == .production)
    }

    @Test("le Mac tire du flux les mêmes alertes que le serveur, avec la catégorie que permettent les droits du client")
    func localAlerts() throws {
        let operatorClient = HarnessClient(name: "mac", role: "operator")
        let viewerClient = HarnessClient(name: "lecteur", role: "viewer")
        let approverClient = HarnessClient(name: "app-approbateur", role: "admin", approver: true)

        let specs = try #require(HarnessNotificationRouting.localAlert(
            for: event("specs_ready", #"{"id":41,"at":1,"runId":"r1","repo":"demo","type":"specs_ready","payload":{"reason":"schéma"}}"#),
            client: operatorClient
        ))
        #expect(specs.alert == HarnessPushAlert(kind: .specs, runId: "r1"))
        #expect(specs.category == .validate)
        #expect(specs.eventId == 41)
        #expect(specs.thread == "r1")
        #expect(specs.title == NotificationText.specs)
        #expect(specs.body(runTitle: "Panier") == "demo · Panier")
        let viewing = HarnessNotificationRouting.localAlert(
            for: event("verdict", #"{"id":42,"runId":"r1","repo":"demo","payload":{}}"#), client: viewerClient
        )
        #expect(viewing?.category == .open, "un lecteur ne peut qu'ouvrir")

        let question = HarnessNotificationRouting.localAlert(
            for: event("escalations", #"{"id":43,"runId":"r1","repo":"demo","payload":{"items":[{"id":1,"question":"?"},{"id":2,"question":"?"}]}}"#),
            client: operatorClient
        )
        #expect(question?.title == NotificationText.questions(2))
        #expect(question?.category == .open)

        let send = event("workstation_approval", #"{"id":44,"runId":null,"repo":null,"payload":{"seq":9,"summary":"…"}}"#)
        #expect(HarnessNotificationRouting.localAlert(for: send, client: operatorClient) == nil, "seul l'approbateur")
        let approval = try #require(HarnessNotificationRouting.localAlert(for: send, client: approverClient))
        #expect(approval.alert == HarnessPushAlert(kind: .approval, seq: 9))
        #expect(approval.category == .approve)
        #expect(approval.thread == "workstation")
        #expect(approval.body(runTitle: nil) == NotificationText.approvalBody, "rien du contenu du poste")

        let backup = HarnessNotificationRouting.localAlert(
            for: event("backup_failed", #"{"id":45,"runId":null,"repo":null,"payload":{"where":"local","detail":"disque plein"}}"#),
            client: operatorClient
        )
        #expect(backup?.alert.kind == .backupFailed)
        #expect(backup?.thread == "server")
        #expect(backup?.body(runTitle: nil) == NotificationText.backupFailedBody)

        for (name, data) in [
            ("step_started", #"{"id":46,"runId":"r1","repo":"demo","payload":{}}"#),
            ("merged", #"{"id":47,"runId":"r1","repo":"demo","payload":{}}"#),
            ("escalations", #"{"id":48,"runId":"r1","repo":"demo","payload":{"items":[]}}"#),
            ("run_failed", #"{"id":49,"runId":null,"repo":null,"payload":{}}"#),
            ("specs_ready", "pas du JSON"),
        ] {
            #expect(HarnessNotificationRouting.localAlert(for: event(name, data), client: operatorClient) == nil, "\(name)")
        }
    }

    @Test("le client décode le drapeau approbateur de /v1/me ; absent (serveur ancien), il est faux")
    func approverFlag() async {
        let transport = Recorder(server())
        let model = await connected(transport)
        #expect(model.client?.approver == true)
        let ordinary = await connected(Recorder(server(me: #"{"client":{"name":"mac","role":"operator","repos":"*"}}"#)))
        #expect(ordinary.client?.approver == false)
    }
}
