// L'APPAIRAGE PAR QR CODE côté client (omp-harness pairing.ts) : le lien `ompconsole://pair`, la création
// d'un ticket, et son échange SANS jeton contre celui d'un client nommé, sur la doublure de transport.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let meAdmin = reply(#"{"client":{"name":"owner","role":"admin","repos":"*","createdAt":0,"approver":false}}"#)
private let meApprover = reply(#"{"client":{"name":"owner","role":"admin","repos":"*","createdAt":0,"approver":true}}"#)
private let healthWithPairing = reply(
    #"{"ok":true,"features":["brief","pairing-ticket"],"checks":{"db":{"ok":true},"scheduler":{"ok":true},"disk":{"ok":true}}}"#
)
private let healthWithout = reply(
    #"{"ok":true,"features":["brief"],"checks":{"db":{"ok":true},"scheduler":{"ok":true},"disk":{"ok":true}}}"#
)

private func redeemed(approver: Bool = false, memory: String = "null") -> HarnessReply {
    reply(
        #"{"client":{"name":"iphone-ab12cd","role":"admin","repos":"*","approver":"# + (approver ? "true" : "false")
            + #"},"token":"jeton-neuf","memory":"# + memory + "}"
    )
}

private let memoryJSON = #"{"url":"https://vps.example:8443","token":"memoire"}"#

/// Les appairages reçus par `onPaired`, rangés sous verrou (le crochet est `@Sendable`).
private final class PairedBox: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [HarnessPairing] = []
    func add(_ pairing: HarnessPairing) { lock.withLock { values.append(pairing) } }
    var all: [HarnessPairing] { lock.withLock { values } }
}

/// Un transport qui n'atteint jamais le serveur.
private struct UnreachableTransport: HarnessTransport {
    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply { throw HarnessFailure.unreachable }
    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        throw HarnessFailure.unreachable
    }
}

@Suite("Appairage par QR code — le lien")
struct HarnessPairLinkTests {
    @Test("le lien se construit avec l'adresse et le ticket encodés en pourcentage, et se relit à l'identique")
    func roundTrip() throws {
        let link = try #require(HarnessPairLink(address: "https://vps.tailnet.ts.net", ticket: "ab-CD_12"))
        #expect(link.url.absoluteString == "ompconsole://pair?u=https%3A%2F%2Fvps.tailnet.ts.net&t=ab-CD_12")
        #expect(HarnessPairLink(url: link.url) == link)

        // Une adresse avec un port et un préfixe garde l'un et l'autre ; la barre finale tombe.
        let prefixed = try #require(HarnessPairLink(address: "http://vps.example:8443/omp/", ticket: "t0"))
        #expect(prefixed.address == "http://vps.example:8443/omp")
        #expect(HarnessPairLink(url: prefixed.url) == prefixed)

        // Une adresse nue passe par la même normalisation que la saisie du serveur (https par défaut).
        let bare = try #require(HarnessPairLink(address: "vps.example", ticket: "t0"))
        #expect(bare.address == HarnessModel.normalizedAddress("vps.example"))
        #expect(bare.address == "https://vps.example")
    }

    @Test("un lien analysé rend l'adresse normalisée et le ticket décodés")
    func parsesPercentEncoding() throws {
        let url = try #require(URL(string: "ompconsole://pair?t=tk_9-x&u=vps.example%3A8443%2F"))
        let link = try #require(HarnessPairLink(url: url))
        #expect(link.address == "https://vps.example:8443")
        #expect(link.ticket == "tk_9-x")
    }

    @Test("un autre schéma, un autre hôte, une adresse ou un ticket vide ou faux, un champ répété ou absent sont refusés")
    func refusals() throws {
        let refused = [
            "https://pair?u=https%3A%2F%2Fvps.example&t=tk",
            "ompconsole://inbox?u=https%3A%2F%2Fvps.example&t=tk",
            "ompconsole://pair?u=&t=tk",
            "ompconsole://pair?u=https%3A%2F%2Fvps.example&t=",
            "ompconsole://pair?u=https%3A%2F%2Fvps.example",
            "ompconsole://pair?t=tk",
            "ompconsole://pair",
            "ompconsole://pair?u=ftp%3A%2F%2Fvps.example&t=tk",
            "ompconsole://pair?u=https%3A%2F%2F&t=tk",
            "ompconsole://pair?u=https%3A%2F%2Fvps.example&t=a%20b",
            "ompconsole://pair?u=https%3A%2F%2Fvps.example&u=https%3A%2F%2Fautre.example&t=tk",
            "ompconsole://pair?u=https%3A%2F%2Fvps.example&t=tk&t=tk2",
        ]
        for text in refused {
            let url = try #require(URL(string: text), "\(text)")
            #expect(HarnessPairLink(url: url) == nil, "\(text)")
        }
        #expect(HarnessPairLink(address: "https://vps.example", ticket: "") == nil)
        #expect(HarnessPairLink(address: "https://vps.example", ticket: "a b") == nil)
        #expect(HarnessPairLink(address: "", ticket: "tk") == nil)
        #expect(HarnessPairLink(address: "ftp://vps.example", ticket: "tk") == nil)
    }

    @Test("`isPairLink` reconnaît l'hôte `pair` même incomplet ; les liens des widgets n'y passent pas et gardent leur destination")
    func recognition() throws {
        #expect(try HarnessPairLink.isPairLink(#require(URL(string: "ompconsole://pair"))))
        #expect(try HarnessPairLink.isPairLink(#require(URL(string: "ompconsole://pair?u=x"))))
        #expect(!HarnessPairLink.isPairLink(HarnessWidgetLink.now))
        #expect(!HarnessPairLink.isPairLink(HarnessWidgetLink.url(.inbox)))
        #expect(HarnessWidgetLink.destination(of: HarnessWidgetLink.now) == .now)
        #expect(HarnessWidgetLink.destination(of: HarnessWidgetLink.url(.runs)) == .section(.runs))
        // Le lien d'appairage n'est pas une destination : les widgets ne l'ouvrent jamais.
        #expect(try HarnessWidgetLink.destination(of: #require(URL(string: "ompconsole://pair?u=x&t=y"))) == nil)
    }

    @Test("l'échéance d'un ticket se lit en secondes restantes, jamais négatives")
    func countdown() throws {
        let link = try #require(HarnessPairLink(address: "https://vps.example", ticket: "tk"))
        let start = Date(timeIntervalSince1970: 1_000)
        let invite = HarnessPairInvite(link: link, expiresAt: start.addingTimeInterval(600), approver: false)
        #expect(invite.secondsLeft(at: start) == 600)
        #expect(invite.secondsLeft(at: start.addingTimeInterval(0.4)) == 600)
        #expect(invite.secondsLeft(at: start.addingTimeInterval(599.5)) == 1)
        #expect(!invite.isExpired(at: start.addingTimeInterval(599)))
        #expect(invite.isExpired(at: start.addingTimeInterval(600)))
        #expect(invite.secondsLeft(at: start.addingTimeInterval(9_000)) == 0)
        #expect(PairingText.remaining(seconds: 601) == "Expire dans 10 min 1 s")
        #expect(PairingText.remaining(seconds: 41) == "Expire dans 41 s")
    }
}

@Suite("Appairage par QR code — créer un ticket")
@MainActor
struct HarnessPairInviteTests {
    private func connected(me: HarnessReply = meAdmin, health: HarnessReply = healthWithPairing, ticket: HarnessReply? = nil)
        async -> (HarnessModel, ScriptedHarnessTransport)
    {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("GET", "/v1/me"): me
            case ("GET", "/v1/health"): health
            case ("POST", "/v1/pair/tickets"):
                ticket ?? reply(#"{"ticket":"tk-secret_1","expiresAt":1700000600000,"ttlSec":600,"approver":false}"#, status: 201)
            default: nil
            }
        }
        return (await osConnected(transport), transport)
    }

    @Test("le ticket part avec l'étiquette, le drapeau approbateur et la mémoire ; le lien porte l'adresse du serveur relié")
    func createsTicket() async throws {
        let (model, transport) = await connected(me: meApprover)
        let now = Date(timeIntervalSince1970: 5_000)
        let invite = try await model.createPairInvite(
            label: "  iPhone de Millian ", approver: true,
            memory: HarnessPairMemory(url: "https://vps.example:8443", token: "memoire"), now: now
        )
        let body = try #require(transport.body("POST", "/v1/pair/tickets"))
        #expect(body["label"] as? String == "iPhone de Millian")
        #expect(body["approver"] as? Bool == true)
        let memory = try #require(body["memory"] as? [String: String])
        #expect(memory == ["url": "https://vps.example:8443", "token": "memoire"])
        #expect(transport.last("POST", "/v1/pair/tickets")?.authenticated == true, "la création est celle d'un client connecté")
        #expect(transport.tokens.last == "t", "avec le jeton du client")

        #expect(invite.link.address == "https://vps.example")
        #expect(invite.link.ticket == "tk-secret_1")
        #expect(HarnessPairLink(url: invite.link.url) == invite.link)
        #expect(invite.expiresAt == now.addingTimeInterval(600), "l'échéance suit l'horloge de l'appareil + la durée annoncée")
        #expect(!invite.approver, "le drapeau est celui que le serveur a accordé")
    }

    @Test("sans étiquette ni mémoire, ces champs ne partent pas ; une étiquette trop longue est coupée à 40 caractères")
    func optionalFields() async throws {
        let (model, transport) = await connected()
        _ = try await model.createPairInvite(label: "   ")
        var body = try #require(transport.body("POST", "/v1/pair/tickets"))
        #expect(body["label"] == nil && body["memory"] == nil)
        #expect(body["approver"] as? Bool == false)

        _ = try await model.createPairInvite(label: String(repeating: "é", count: 60))
        body = try #require(transport.body("POST", "/v1/pair/tickets"))
        #expect((body["label"] as? String)?.count == 40)
    }

    @Test("un refus du serveur lève l'échec lisible : 403 (droit manquant), 409 (dix tickets en attente) ; sans serveur relié, injoignable")
    func failures() async throws {
        let (forbidden, _) = await connected(ticket: reply(#"{"error":"l'appairage d'un appareil est réservé au propriétaire"}"#, status: 403))
        do {
            _ = try await forbidden.createPairInvite(label: "iPhone")
            Issue.record("le refus du serveur doit lever")
        } catch let failure as HarnessFailure {
            #expect(failure == .forbidden("l'appairage d'un appareil est réservé au propriétaire"))
            #expect(!failure.message.isEmpty)
        }

        // Le refus d'appairer un approbateur (marqueur des gestes du poste) ne parle pas d'approuver un envoi.
        let (notApprover, _) = await connected(
            ticket: reply(#"{"error":"seul l'appareil approbateur peut en appairer un autre comme approbateur (code de `harness.sh approver`)"}"#, status: 403)
        )
        do {
            _ = try await notApprover.createPairInvite(label: "iPhone", approver: true)
            Issue.record("le refus doit lever")
        } catch let failure as HarnessFailure {
            #expect(failure == .forbidden(PairingText.approverDenied))
            #expect(failure.message.contains(PairingText.approverDenied))
        }

        let (full, _) = await connected(ticket: reply(#"{"error":"10 tickets d'appairage sont déjà en attente"}"#, status: 409))
        do {
            _ = try await full.createPairInvite(label: "iPhone")
            Issue.record("le serveur plein doit lever")
        } catch let failure as HarnessFailure {
            #expect(failure == .rejected("10 tickets d'appairage sont déjà en attente"))
        }

        let alone = HarnessModel(
            transport: ScriptedHarnessTransport(), preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), reporter: .off
        )
        do {
            _ = try await alone.createPairInvite(label: "iPhone")
            Issue.record("sans serveur relié, rien ne part")
        } catch let failure as HarnessFailure {
            #expect(failure == .unreachable)
        }
    }

    @Test("la feuille n'est offerte que si le serveur annonce `pairing-ticket` et que le client est admin sur tous les dépôts ; le droit d'approuver, au seul approbateur")
    func availability() async {
        let (ready, _) = await connected()
        await ready.refreshServices()
        #expect(ready.canCreatePairInvite)
        #expect(!ready.canPairApprover, "un client ordinaire ne peut pas appairer un approbateur")

        let (approver, _) = await connected(me: meApprover)
        await approver.refreshServices()
        #expect(approver.canCreatePairInvite && approver.canPairApprover)

        let (old, _) = await connected(health: healthWithout)
        await old.refreshServices()
        #expect(!old.canCreatePairInvite, "un serveur qui n'annonce pas la capacité")

        let (unread, _) = await connected()
        #expect(!unread.canCreatePairInvite, "tant que la santé n'est pas lue")

        let (limited, _) = await connected(
            me: reply(#"{"client":{"name":"ipad","role":"admin","repos":["demo"],"createdAt":0}}"#)
        )
        await limited.refreshServices()
        #expect(!limited.canCreatePairInvite, "un client borné à des dépôts")

        let (viewer, _) = await connected(me: reply(#"{"client":{"name":"v","role":"viewer","repos":"*","createdAt":0}}"#))
        await viewer.refreshServices()
        #expect(!viewer.canCreatePairInvite)
    }
}

@Suite("Appairage par QR code — l'échange")
@MainActor
struct HarnessPairRedeemTests {
    private let link = HarnessPairLink(address: "https://vps.example", ticket: "tk-secret_1")!

    private func device(
        _ redeem: HarnessReply, me: HarnessReply = meAdmin, inbox: HarnessReply? = nil
    ) -> (HarnessModel, ScriptedHarnessTransport, InMemoryTokenStore, InMemoryClientPreferences, PairedBox) {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("POST", "/v1/pair/redeem"): redeem
            case ("GET", "/v1/me"): me
            case ("GET", "/v1/inbox"): inbox
            default: nil
            }
        }
        let tokens = InMemoryTokenStore()
        let preferences = InMemoryClientPreferences()
        let paired = PairedBox()
        let model = HarnessModel(
            transport: transport, preferences: preferences, tokens: tokens,
            retryDelay: .seconds(3600), refreshDelay: .milliseconds(1),
            onPaired: { paired.add($0) }, reporter: .off
        )
        return (model, transport, tokens, preferences, paired)
    }

    @Test("l'échange ne porte AUCUN jeton ; il relie ensuite l'app comme un code `omp1:` : adresse du lien, jeton reçu au trousseau, mémoire reçue à `onPaired`")
    func redeems() async throws {
        let (model, transport, tokens, preferences, paired) = device(redeemed(memory: memoryJSON))
        let outcome = await model.pair(with: link)
        #expect(outcome == .paired(address: "https://vps.example"))
        #expect(outcome.message == PairingText.success(address: "https://vps.example"))

        let call = try #require(transport.last("POST", "/v1/pair/redeem"))
        #expect(!call.authenticated, "route publique : le ticket est le secret")
        #expect(call.headers.keys.allSatisfy { $0.lowercased() != "authorization" })
        #expect(transport.tokens.first == "", "aucun jeton n'accompagne l'échange")
        #expect(transport.body("POST", "/v1/pair/redeem") as? [String: String] == ["ticket": "tk-secret_1"])
        #expect(transport.count("POST", "/v1/pair/redeem") == 1)

        #expect(model.address == "https://vps.example")
        #expect(preferences.string(forKey: HarnessModel.addressKey) == "https://vps.example")
        #expect(await tokens.knownTokens[HarnessModel.tokenAccount] == "jeton-neuf")
        let later = Array(transport.tokens.dropFirst())
        #expect(!later.isEmpty && later.allSatisfy { $0 == "jeton-neuf" }, "tous les appels suivants portent le jeton reçu")
        #expect(model.isConfigured && model.inbox != nil)

        let received = try #require(paired.all.first)
        #expect(paired.all.count == 1)
        #expect(received.address == "https://vps.example")
        #expect(received.memoryAddress == "https://vps.example:8443")
        #expect(received.memoryToken == "memoire")
        #expect(received.token == "jeton-neuf" && received.approverToken == nil)
        #expect(received.appToken == "jeton-neuf")
    }

    @Test("sans mémoire jointe, `onPaired` reçoit des champs mémoire vides, comme un code `omp1:` sans mémoire")
    func withoutMemory() async throws {
        let (model, _, _, _, paired) = device(redeemed())
        #expect(await model.pair(with: link) == .paired(address: "https://vps.example"))
        let received = try #require(paired.all.first)
        #expect(received.memoryAddress.isEmpty && received.memoryToken.isEmpty)
    }

    @Test("un client approbateur reçoit son jeton comme jeton d'app (`appToken`), et la forme ordinaire reste vide : ~/.omp ne l'apprend jamais")
    func approverDevice() async throws {
        let (model, transport, tokens, _, paired) = device(redeemed(approver: true), me: meApprover)
        #expect(await model.pair(with: link) == .paired(address: "https://vps.example"))
        let received = try #require(paired.all.first)
        #expect(received.approverToken == "jeton-neuf")
        #expect(received.appToken == "jeton-neuf")
        #expect(received.token.isEmpty, "le jeton ordinaire n'est pas celui de l'approbateur")
        #expect(await tokens.knownTokens[HarnessModel.tokenAccount] == "jeton-neuf")
        #expect(transport.tokens.dropFirst().allSatisfy { $0 == "jeton-neuf" })
        #expect(model.client?.approver == true)

        // L'écriture partagée n'emporte pas le jeton approbateur.
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("pair-link-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }
        try received.writeShared(home: home)
        let text = try String(contentsOf: home.appendingPathComponent(".omp/harness.json"), encoding: .utf8)
        #expect(!text.contains("jeton-neuf"))
    }

    @Test("un ticket refusé, une limite atteinte, un serveur qui ne peut pas créer le client ou ne connaît pas la route : chaque cause a sa phrase, et rien n'est relié")
    func refusals() async {
        let cases: [(HarnessReply, HarnessPairFailure, String)] = [
            (reply(#"{"error":"ticket inconnu, expiré ou déjà utilisé"}"#, status: 401), .ticketRefused, PairingText.ticketRefused),
            (reply(#"{"error":"trop d'échanges refusés"}"#, status: 429), .tooManyAttempts, PairingText.tooManyAttempts),
            (reply(#"{"error":"nom déjà pris"}"#, status: 409), .serverRefused("nom déjà pris"), PairingText.serverRefused("nom déjà pris")),
            (reply(#"{"error":"route inconnue"}"#, status: 404), .unsupported, PairingText.unsupported),
            (reply("illisible", status: 200), .transport(.unreadable), PipelineServerText.unreadable),
            (reply(#"{"client":{"name":"a","role":"admin","repos":"*"},"token":"","memory":null}"#), .transport(.unreadable), PipelineServerText.unreadable),
        ]
        for (answer, failure, text) in cases {
            let (model, _, tokens, preferences, paired) = device(answer)
            let outcome = await model.pair(with: link)
            #expect(outcome == .failed(failure), "\(failure)")
            #expect(outcome.message == text)
            #expect(!model.isConfigured && model.address == nil)
            #expect(preferences.string(forKey: HarnessModel.addressKey) == nil)
            #expect(await tokens.knownTokens.isEmpty)
            #expect(paired.all.isEmpty)
        }
        #expect(PairingText.ticketRefused.contains("expiré") && PairingText.ticketRefused.contains("déjà servi"))
        #expect(PairingText.serverRefused("  ") == L10n.text("Le serveur ne peut pas créer d’accès pour cet appareil."))
    }

    @Test("un serveur injoignable se dit injoignable ; un ticket échangé mais un serveur qui refuse ensuite le nouveau jeton se dit, sans rien enregistrer")
    func transportAndJoin() async {
        let model = HarnessModel(
            transport: UnreachableTransport(), preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(), reporter: .off
        )
        let outcome = await model.pair(with: link)
        #expect(outcome == .failed(.transport(.unreachable)))
        #expect(outcome.message == PipelineServerText.unreachable)

        let (joining, _, tokens, preferences, paired) = device(redeemed(), inbox: reply(#"{"error":"jeton refusé"}"#, status: 401))
        let joined = await joining.pair(with: link)
        #expect(joined == .failed(.joinFailed))
        #expect(joined.message == PairingText.joinFailed)
        #expect(!joining.isConfigured)
        #expect(await tokens.knownTokens.isEmpty)
        #expect(preferences.string(forKey: HarnessModel.addressKey) == nil)
        #expect(paired.all.isEmpty)
    }

    @Test("appairer un appareil déjà relié à un autre serveur le fait quitter l'ancien")
    func replacesServer() async {
        let (model, transport, tokens, _, _) = device(redeemed())
        _ = await model.configure(address: "ancien.example", token: "ancien")
        #expect(model.address == "https://ancien.example")
        #expect(await model.pair(with: link) == .paired(address: "https://vps.example"))
        #expect(model.address == "https://vps.example")
        #expect(await tokens.knownTokens[HarnessModel.tokenAccount] == "jeton-neuf")
        #expect(transport.count("POST", "/v1/pair/redeem") == 1)
    }

    @Test("le transport de production n'écrit pas d'`Authorization` pour un appel public, même demandé en en-tête ; un appel ordinaire porte le jeton")
    func productionRequest() throws {
        let server = HarnessServer(baseURL: try #require(URL(string: "https://vps.example/omp")), token: "secret")
        let publicCall = HarnessCall(
            method: "POST", path: "/v1/pair/redeem", body: Data("{}".utf8), headers: ["Authorization": "Bearer volé"], authenticated: false
        )
        let publicRequest = try URLSessionHarnessTransport.request(publicCall, server: server, stream: false)
        #expect(publicRequest.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(publicRequest.url?.absoluteString == "https://vps.example/omp/v1/pair/redeem")
        #expect(publicRequest.httpMethod == "POST")
        #expect(publicRequest.value(forHTTPHeaderField: "Content-Type") == "application/json")

        let ordinary = try URLSessionHarnessTransport.request(HarnessCall(method: "GET", path: "/v1/inbox"), server: server, stream: false)
        #expect(ordinary.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    }
}
