// Le widget d'écran d'accueil vu du client : l'instantané qu'il montre (ce qui attend
// l'humain d'abord, features terminées exclues), le lien qui ouvre l'Accueil, et la
// lecture de la boîte hors du modèle de l'app — sur la doublure de transport. Et la
// télécommande hors de l'app : les liens `ompconsole://`, le choix de la Live Activity
// démarrée seule, la validation d'une revue depuis l'activité, la Demande d'un partage.

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
        let url = HarnessWidgetLink.url(.inbox)
        #expect(url.absoluteString == "ompconsole://inbox")
        #expect(HarnessWidgetLink.section(of: url) == .inbox)
        #expect(HarnessWidgetLink.section(of: URL(string: "https://example.com/inbox")!) == nil)
        #expect(HarnessWidgetLink.section(of: URL(string: "ompconsole://inconnue")!) == nil)
    }

    @Test("un lien mène à un fil, au tri des décisions, à « Maintenant », à une section ou à une page de Système ; tout autre lien est ignoré")
    func destinations() {
        #expect(HarnessWidgetLink.url(thread: "r1").absoluteString == "ompconsole://threads/r1")
        #expect(HarnessWidgetLink.decisions.absoluteString == "ompconsole://decisions")
        #expect(HarnessWidgetLink.now.absoluteString == "ompconsole://now")
        func destination(_ link: String) -> HarnessWidgetLink.Destination? { HarnessWidgetLink.destination(of: URL(string: link)!) }
        #expect(destination("ompconsole://threads/r1") == .thread("r1"))
        #expect(HarnessWidgetLink.destination(of: HarnessWidgetLink.url(thread: "r 1")) == .thread("r 1"), "un identifiant se relit tel quel")
        #expect(destination("ompconsole://runs/r2") == .thread("r2"), "le lien que le Mac lit déjà")
        #expect(destination("ompconsole://threads") == .section(.runs), "sans identifiant : la liste")
        #expect(destination("ompconsole://decisions") == .decisions)
        #expect(destination("ompconsole://now") == .now)
        #expect(destination("ompconsole://inbox") == .section(.inbox))
        #expect(destination("ompconsole://system/vigie") == .system(.vigie))
        #expect(destination("ompconsole://system/inconnue") == .section(.system))
        #expect(destination("ompconsole://inconnue") == nil)
        #expect(destination("https://example.com/threads/r1") == nil)

        // Dans la coque à sections : le fil est la page de la feature, le tri « À traiter ».
        #expect(HarnessWidgetLink.Destination.thread("r1").command == .run("r1"))
        #expect(HarnessWidgetLink.Destination.decisions.command == .inbox(.toDecide))
        #expect(HarnessWidgetLink.Destination.now.command == .section(.inbox))
        #expect(HarnessWidgetLink.Destination.section(.workstation).command == .section(.workstation))
        #expect(HarnessWidgetLink.Destination.system(.vigie).command == .system(.vigie))
    }

    @Test("l'activité démarrée seule est celle qui attend l'humain depuis le plus longtemps, sinon celle qui travaille ; une seule à la fois, jamais une activité écartée")
    func activityStart() {
        func at(_ id: String, _ state: String, _ updatedAt: Double, step: String? = "impl") -> HarnessRun {
            var item = run(id, state, step: step)
            item.updatedAt = updatedAt
            return item
        }
        let inbox = HarnessInbox(runs: [
            at("travail-ancien", "running", 10), at("travail-recent", "running", 50), at("file", "queued", 60),
            at("question-recente", "escalated", 40), at("revue-ancienne", "awaiting_human", 20, step: "review"), at("livree", "merged", 70),
        ])
        #expect(HarnessActivityStart.candidate(inbox: inbox, running: [])?.id == "revue-ancienne")
        #expect(HarnessActivityStart.candidate(inbox: inbox, running: [], declined: ["revue-ancienne"])?.id == "question-recente")
        #expect(HarnessActivityStart.candidate(inbox: inbox, running: [], declined: ["revue-ancienne", "question-recente"])?.id == "travail-recent")
        #expect(HarnessActivityStart.candidate(inbox: inbox, running: ["travail-ancien"]) == nil, "une seule activité à la fois")
        #expect(HarnessActivityStart.candidate(inbox: HarnessInbox(runs: [at("file", "queued", 1), at("livree", "merged", 2)]), running: []) == nil)
        #expect(HarnessActivityStart.candidate(inbox: nil, running: []) == nil)

        // « Valider » ne s'offre que pour une revue qui attend.
        #expect(HarnessActivityState(state: "awaiting_human", step: "review").awaitsReview)
        #expect(!HarnessActivityState(state: "awaiting_human", step: "specs").awaitsReview)
        #expect(!HarnessActivityState(state: "escalated", step: "review").awaitsReview)
        #expect(!HarnessActivityState(state: "running", step: "review").awaitsReview)
    }

    @Test("hors de l'app, la revue d'une feature se valide à la révision que le serveur vient de rendre ; des specs ou une feature repartie ne se valident pas")
    @MainActor
    func remoteValidation() async throws {
        let inbox = #"{"cursor":1,"batches":[],"decisions":[],"awaiting":["#
            + osRunJSON("r1", state: "awaiting_human", step: "review", extra: #","rev":9"#) + ","
            + osRunJSON("r2", state: "awaiting_human", step: "specs", extra: #","rev":3"#) + #"],"runs":[]}"#
        let transport = osTransport(inbox: inbox, routes: ["POST /v1/runs/r1/validate": osJSON(#"{"run":"# + osRunJSON("r1", state: "merging", step: "review") + "}")])
        let model = try #require(await HarnessModel.linked(address: "https://vps.example", token: "t", transport: transport))

        #expect(await HarnessRemote.validateReview(runId: "r1", on: model))
        let call = try #require(transport.last("POST", "/v1/runs/r1/validate"))
        #expect(call.headers["If-Match"] == "\"9\"")
        #expect(transport.body("POST", "/v1/runs/r1/validate")?["approve"] as? Bool == true)

        #expect(await HarnessRemote.validateReview(runId: "r2", on: model) == false, "des specs ne se valident pas d'ici")
        #expect(await HarnessRemote.validateReview(runId: "inconnue", on: model) == false)
        #expect(transport.count("POST", "/v1/runs/r2/validate") == 0)
        #expect(await HarnessModel.linked(address: "pas une adresse", token: "t", transport: transport) == nil)
    }

    @Test("un partage devient une Demande : la consigne saisie, sinon une demande par défaut sur la page, sinon le texte partagé ; la page et la sélection partent en contexte")
    func shareDraft() {
        let page = HarnessShareDraft(url: " https://example.com/article ", title: "Un article", text: "un passage choisi")
        #expect(page.headline == "Un article" && page.detail == "https://example.com/article")
        #expect(page.request(instruction: "  résume-le  ") { "page : \($0)" } == "résume-le")
        #expect(page.request(instruction: " ") { "page : \($0)" } == "page : Un article")
        #expect(page.context(instruction: "") == HarnessIntakeContext(url: "https://example.com/article", title: "Un article", selection: "un passage choisi"))

        let bare = HarnessShareDraft(url: "https://example.com/article")
        #expect(bare.headline == "https://example.com/article" && bare.detail == nil)
        #expect(bare.request(instruction: "") { "page : \($0)" } == "page : https://example.com/article")

        let note = HarnessShareDraft(text: "corriger le bandeau de l'accueil")
        #expect(note.request(instruction: "") { _ in "jamais" } == "corriger le bandeau de l'accueil", "le texte partagé est la demande")
        #expect(note.context(instruction: "") == nil, "rien à joindre : la demande dit déjà tout")
        #expect(note.request(instruction: "planifie ça") { _ in "jamais" } == "planifie ça")
        #expect(note.context(instruction: "planifie ça") == HarnessIntakeContext(selection: "corriger le bandeau de l'accueil"))

        let long = HarnessShareDraft(text: String(repeating: "a", count: 5000))
        #expect(long.request(instruction: "") { $0 }?.count == HarnessShareDraft.maxTextLength)
        #expect(HarnessShareDraft(url: " ", title: "Titre seul", text: "\n").isEmpty)
        #expect(HarnessShareDraft(url: " ", text: "\n").request(instruction: "") { $0 } == nil)
        // Une adresse qui n'est pas une page web est écartée ; un texte qui répète le titre aussi.
        let file = HarnessShareDraft(url: "file:///tmp/x", text: "note")
        #expect(file.url == nil && file.request(instruction: "") { _ in "jamais" } == "note")
        #expect(HarnessShareDraft(url: "https://example.com", title: "Un article", text: "Un article").text == nil)
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
