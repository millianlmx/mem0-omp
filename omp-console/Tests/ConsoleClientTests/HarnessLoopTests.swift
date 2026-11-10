// La BOUCLE de l'OS agentique côté client (contrat §1, §2.1, §2.2, §4 « refaire », §6.3) :
// les champs nouveaux d'une feature et d'une question, le corps exact de chaque geste
// (annuler avec un motif, corriger, restreindre les modules, poser l'autonomie, répondre
// ou refuser « pour toujours », relancer à l'identique), l'autonomie et le contexte de
// page d'un lancement, et la pause globale — sur la doublure de transport.

@testable import ConsoleClient
import Foundation
import Testing

private let queuedRun = #"""
{"id":"r9","repo":"demo","slug":"s","title":"T","request":"q","state":"queued","fixes":0,"modules":["src/a"],"createdAt":1,"updatedAt":2,
 "autonomy":"deliver","cancelCause":null,"waitCause":"modules","waitUntil":1700000000000,
 "blockedBy":[{"runId":"r1","title":"Export CSV","state":"running","modules":["src/a","src/b"]}]}
"""#

private func intakeJSON(_ id: String, state: String, extra: String = "") -> String {
    #"{"id":""# + id + #"","text":"corrige X","source":"console","repo":"demo","requestedRepo":null,"state":""# + state
        + #"","kind":"bug","plan":{"kind":"bug","repo":"demo","title":"Corriger X","statement":"corrige X"},"question":null,"answer":null,"#
        + #""exchanges":[],"statement":"corrige X","created":null,"reason":null,"by":"mac","createdAt":1,"updatedAt":2"# + extra + "}"
}

private let acceptedRun = #"{"run":"# + osRunJSON("r1", extra: #","rev":5"#) + "}"

@Suite("Boucle — client")
@MainActor
struct HarnessLoopTests {
    @Test("une feature en file dit son autonomie, ce qui la retient et jusqu'à quand ; un serveur antérieur laisse tout vide")
    func runFields() throws {
        let run = try JSONDecoder().decode(HarnessRun.self, from: Data(queuedRun.utf8))
        #expect(run.autonomy == .deliver)
        #expect(run.cancelCause == nil && run.cancelReason == nil)
        #expect(run.blockedBy == [HarnessRunBlocker(runId: "r1", title: "Export CSV", state: "running", modules: ["src/a", "src/b"])])
        #expect(run.waitUntil == Date(timeIntervalSince1970: 1_700_000_000))
        // L'instantané gardé hors ligne (boîte encodée) rend la même feature.
        #expect(try JSONDecoder().decode(HarnessRun.self, from: JSONEncoder().encode(run)) == run)

        let cancelled = try JSONDecoder().decode(
            HarnessRun.self, from: Data(osRunJSON("r2", state: "cancelled", extra: #","autonomy":"ask","cancelCause":"too_big""#).utf8)
        )
        #expect(cancelled.autonomy == .ask)
        #expect(cancelled.cancelReason == .tooBig)
        #expect(HarnessCancelCause.allCases.map(\.rawValue) == ["off_target", "too_big", "obsolete", "duplicate", "too_costly", "other"])
        #expect(HarnessCancelCause.offTarget.teachesMemory && HarnessCancelCause.tooBig.teachesMemory && !HarnessCancelCause.obsolete.teachesMemory)

        let unknown = try JSONDecoder().decode(
            HarnessRun.self, from: Data(osRunJSON("r3", extra: #","autonomy":"plus_tard","cancelCause":"motif_futur""#).utf8)
        )
        #expect(unknown.autonomy == nil, "un niveau inconnu se lit comme les règles du dépôt")
        #expect(unknown.cancelCause == "motif_futur" && unknown.cancelReason == nil)

        let older = try JSONDecoder().decode(HarnessRun.self, from: Data(osRunJSON("r4").utf8))
        #expect(older.autonomy == nil && older.cancelCause == nil && older.blockedBy.isEmpty && older.waitUntil == nil)
    }

    @Test("une question ouverte dit quand sa recommandation s'appliquera seule ; `null` ou absent : elle n'expire pas")
    func escalationDeadline() throws {
        func escalation(_ extra: String) throws -> HarnessEscalation {
            try JSONDecoder().decode(
                HarnessEscalation.self,
                from: Data((#"{"id":7,"runId":"r1","category":"schema","question":"Où ?","options":["colonne","table"],"status":"open""# + extra + "}").utf8)
            )
        }
        let timed = try escalation(#","recommended":"colonne","autoAt":1700000060000,"autoAnswer":"colonne""#)
        #expect(timed.autoAt == 1_700_000_060_000)
        #expect(timed.autoDate == Date(timeIntervalSince1970: 1_700_000_060))
        #expect(timed.autoAnswer == "colonne")
        let never = try escalation(#","autoAt":null,"autoAnswer":null"#)
        #expect(never.autoAt == nil && never.autoDate == nil && never.autoAnswer == nil)
        let older = try escalation("")
        #expect(older.autoAt == nil && older.autoAnswer == nil)
    }

    @Test("annuler sans motif garde le corps d'avant ; avec un motif, `cause` et la note rognée partent, à la révision lue")
    func cancelWithCause() async throws {
        let transport = osTransport(routes: ["POST /v1/runs/r1/cancel": osJSON(acceptedRun)])
        let model = await osConnected(transport)

        #expect(await model.cancel(runId: "r1"))
        #expect(transport.rawBody("POST", "/v1/runs/r1/cancel") == "{}")

        #expect(await model.cancel(runId: "r1", cause: .offTarget, note: "  hors sujet \n"))
        let body = try #require(transport.body("POST", "/v1/runs/r1/cancel"))
        #expect(body["cause"] as? String == "off_target")
        #expect(body["note"] as? String == "hors sujet")
        #expect(transport.last("POST", "/v1/runs/r1/cancel")?.headers["If-Match"] == "\"4\"")

        #expect(await model.cancel(runId: "r1", cause: .duplicate, note: "  "))
        let bare = try #require(transport.body("POST", "/v1/runs/r1/cancel"))
        #expect(bare["cause"] as? String == "duplicate" && bare["note"] == nil)
    }

    @Test("corriger envoie le texte rogné et rend la voie prise ; `always` ne part que demandé ; un texte vide ne part pas, un refus reste dans `failure`")
    func amend() async throws {
        let transport = osTransport { call in
            guard call.method == "POST" else { return nil }
            switch call.path {
            case "/v1/runs/r1/amend": return osJSON(#"{"run":"# + osRunJSON("r1") + #","via":"specs"}"#)
            case "/v1/runs/r2/amend": return osJSON(#"{"run":"# + osRunJSON("r2") + #","via":"voie_future"}"#)
            case "/v1/runs/r3/amend": return osJSON(#"{"error":"feature fusionnée"}"#, status: 409)
            default: return nil
            }
        }
        let model = await osConnected(transport)

        #expect(await model.amend(runId: "r1", text: "  plutôt en CSV  ") == .specs)
        let plain = try #require(transport.body("POST", "/v1/runs/r1/amend"))
        #expect(plain["text"] as? String == "plutôt en CSV")
        #expect(plain["always"] == nil)
        #expect(transport.last("POST", "/v1/runs/r1/amend")?.headers["If-Match"] == "\"4\"")

        #expect(await model.amend(runId: "r1", text: "toujours en CSV", always: true) == .specs)
        #expect(transport.body("POST", "/v1/runs/r1/amend")?["always"] as? Bool == true)

        #expect(await model.amend(runId: "r2", text: "x") == .instruction, "une voie inconnue se lit comme une consigne passée")

        let before = transport.calls.count
        #expect(await model.amend(runId: "r1", text: " \n ") == nil)
        #expect(transport.calls.count == before, "un texte vide ne part pas")

        #expect(await model.amend(runId: "r3", text: "trop tard") == nil)
        #expect(model.failure == .rejected("feature fusionnée"))
        #expect(HarnessAmendVia.allCases.map(\.rawValue) == ["specs", "fix", "retry", "instruction"])
    }

    @Test("restreindre les modules envoie la liste rognée et sans doublon ; poser l'autonomie envoie le niveau, `null` pour revenir aux règles du dépôt")
    func modulesAndAutonomy() async throws {
        let transport = osTransport(routes: [
            "POST /v1/runs/r1/modules": osJSON(acceptedRun),
            "POST /v1/runs/r1/autonomy": osJSON(acceptedRun),
        ])
        let model = await osConnected(transport)

        #expect(await model.setModules(runId: "r1", modules: [" src/api ", "", "docs", "src/api"]))
        #expect(transport.body("POST", "/v1/runs/r1/modules")?["modules"] as? [String] == ["src/api", "docs"])
        #expect(transport.last("POST", "/v1/runs/r1/modules")?.headers["If-Match"] == "\"4\"")
        let before = transport.calls.count
        #expect(await model.setModules(runId: "r1", modules: [" ", ""]) == false)
        #expect(transport.calls.count == before, "une liste vide ne part pas")

        #expect(await model.setAutonomy(runId: "r1", level: .deliver))
        #expect(transport.body("POST", "/v1/runs/r1/autonomy")?["level"] as? String == "deliver")
        #expect(await model.setAutonomy(runId: "r1", level: nil))
        #expect(transport.rawBody("POST", "/v1/runs/r1/autonomy") == #"{"level":null}"#)
        #expect(HarnessRunAutonomy.allCases.map(\.rawValue) == ["ask", "deliver"])
    }

    @Test("une réponse ou un refus « pour toujours » porte `always: true` ; sans lui, le corps est celui d'avant")
    func alwaysOnAnswerAndRefusal() async throws {
        let transport = osTransport(routes: [
            "POST /v1/runs/r1/escalations": osJSON(acceptedRun),
            "POST /v1/runs/r1/validate": osJSON(acceptedRun),
        ])
        let model = await osConnected(transport)

        #expect(await model.answer(runId: "r1", answers: [7: "colonne", 8: "oui"], reasons: [8: " plus simple "], always: [7]))
        let answers = try #require(transport.body("POST", "/v1/runs/r1/escalations")?["answers"] as? [[String: Any]])
        #expect(answers.count == 2)
        #expect(answers[0]["id"] as? Int == 7 && answers[0]["answer"] as? String == "colonne" && answers[0]["always"] as? Bool == true)
        #expect(answers[0]["reason"] == nil)
        #expect(answers[1]["id"] as? Int == 8 && answers[1]["reason"] as? String == "plus simple" && answers[1]["always"] == nil)

        #expect(await model.answer(runId: "r1", answers: [7: "table"]))
        let plain = try #require(transport.body("POST", "/v1/runs/r1/escalations")?["answers"] as? [[String: Any]])
        #expect(plain.count == 1 && Set(plain[0].keys) == ["id", "answer"], "sans raison ni « toujours », la réponse est celle d'avant")

        #expect(await model.validate(runId: "r1", approve: false, reason: "pas de cache", always: true))
        let refusal = try #require(transport.body("POST", "/v1/runs/r1/validate"))
        #expect(refusal["approve"] as? Bool == false && refusal["reason"] as? String == "pas de cache" && refusal["always"] as? Bool == true)

        #expect(await model.validate(runId: "r1", approve: true, reason: ""))
        #expect(transport.body("POST", "/v1/runs/r1/validate")?["always"] == nil)
    }

    @Test("le lancement d'une feature, d'un projet et la confirmation d'une Demande portent l'autonomie choisie ; non choisie, elle reste hors du corps")
    func launchAutonomy() async throws {
        let transport = osTransport { call in
            switch (call.method, call.path) {
            case ("POST", "/v1/runs"): osJSON(#"{"run":"# + osRunJSON("r7", extra: #","autonomy":"ask""#) + "}", status: 201)
            case ("POST", "/v1/projects"): osJSON(#"{"projectId":"p1","runs":[]}"#, status: 201)
            case ("GET", _) where call.path.hasPrefix("/v1/intake?"): osJSON(#"{"intakes":["# + intakeJSON("i1", state: "planned") + "]}")
            case ("POST", "/v1/intake/i1/confirm"): osJSON(#"{"intake":"# + intakeJSON("i1", state: "confirmed") + "}", status: 201)
            default: nil
            }
        }
        let model = await osConnected(transport)

        let options = try #require(HarnessLaunchDraft(autonomy: .ask).options)
        #expect(options.autonomy == .ask)
        #expect(HarnessLaunchDraft(autonomy: .ask).isCustomized)
        let run = await model.launchRun(repo: "demo", title: "T", request: "r", options: options)
        #expect(run?.autonomy == .ask)
        #expect(transport.body("POST", "/v1/runs")?["autonomy"] as? String == "ask")
        _ = await model.launchRun(repo: "demo", title: "T", request: "r")
        #expect(transport.body("POST", "/v1/runs")?["autonomy"] == nil)

        let feature = HarnessFeatureDraft(title: "A", request: "a")
        #expect(await model.launchProject(repo: "demo", title: "P", features: [feature], autonomy: .deliver) == "p1")
        #expect(transport.body("POST", "/v1/projects")?["autonomy"] as? String == "deliver")
        _ = await model.launchProject(repo: "demo", title: "P", features: [feature])
        #expect(transport.body("POST", "/v1/projects")?["autonomy"] == nil)

        await model.intakes.refresh()
        let planned = try #require(model.intakes.open.first)
        try await model.intakes.confirm(planned, autonomy: .deliver)
        #expect(transport.body("POST", "/v1/intake/i1/confirm")?["autonomy"] as? String == "deliver")
    }

    @Test("une Demande part avec son contexte de page, rogné et borné ; une adresse qui n'est pas http(s) ou un contexte vide ne partent pas ; la demande relue le porte")
    func intakeContext() async throws {
        let context = #","context":{"url":"https://exemple.fr/page","title":"Tarifs","selection":"12 € par mois"}"#
        let transport = osTransport(routes: [
            "POST /v1/intake": osJSON(#"{"intake":"# + intakeJSON("i9", state: "classifying", extra: context) + "}", status: 201),
        ])
        let model = await osConnected(transport)

        let posted = try await model.intakes.submit(
            text: "résume cette page", source: "console",
            context: HarnessIntakeContext(url: " https://exemple.fr/page ", title: " Tarifs ", selection: String(repeating: "x", count: 5000))
        )
        #expect(posted.context == HarnessIntakeContext(url: "https://exemple.fr/page", title: "Tarifs", selection: "12 € par mois"))
        let sent = try #require(transport.body("POST", "/v1/intake")?["context"] as? [String: Any])
        #expect(sent["url"] as? String == "https://exemple.fr/page")
        #expect(sent["title"] as? String == "Tarifs")
        #expect((sent["selection"] as? String)?.count == HarnessIntakeContext.maxSelectionLength)

        try await model.intakes.submit(text: "x", source: "ios", context: HarnessIntakeContext(url: "file:///etc/passwd", title: "Local"))
        let local = try #require(transport.body("POST", "/v1/intake")?["context"] as? [String: Any])
        #expect(local["url"] == nil && local["title"] as? String == "Local")

        try await model.intakes.submit(text: "x", source: "ios", context: HarnessIntakeContext(url: "javascript:alert(1)", title: "  "))
        #expect(transport.body("POST", "/v1/intake")?["context"] == nil)
        try await model.intakes.submit(text: "x", source: "ios")
        #expect(transport.body("POST", "/v1/intake")?["context"] == nil)

        // Un serveur antérieur ne rend pas `context` ; un contexte `null` se lit de même.
        let older = try JSONDecoder().decode(HarnessIntake.self, from: Data(intakeJSON("i1", state: "planned").utf8))
        #expect(older.context == nil)
        let empty = try JSONDecoder().decode(HarnessIntake.self, from: Data(intakeJSON("i1", state: "planned", extra: #","context":null"#).utf8))
        #expect(empty.context == nil)
    }

    @Test("« refaire » lit le gabarit d'une feature et en tire les options d'un lancement identique ; un serveur antérieur n'en a pas")
    func runTemplate() async throws {
        let transport = osTransport(routes: [
            "GET /v1/runs/r1/template": osJSON(#"""
            {"template":{"repo":"demo","title":"Export CSV","request":"Exporter les commandes","kind":"feature","labels":["client"],
             "modules":["src/api"],"lane":"full","budgetUsd":3.5,"autonomy":"deliver"}}
            """#),
            "GET /v1/runs/r2/template": osJSON(#"""
            {"template":{"repo":"demo","title":"B","request":"b","kind":null,"labels":[],"modules":[],"lane":null,"budgetUsd":null,"autonomy":null}}
            """#),
        ])
        let model = await osConnected(transport)

        let template = try #require(await model.runTemplate(runId: "r1"))
        #expect(template.repo == "demo" && template.title == "Export CSV" && template.request == "Exporter les commandes")
        #expect(template.options == HarnessLaunchOptions(lane: .full, modules: ["src/api"], budgetUsd: 3.5, kind: .feature, labels: ["client"], autonomy: .deliver))

        let bare = try #require(await model.runTemplate(runId: "r2"))
        #expect(bare.options == HarnessLaunchOptions())

        #expect(await model.runTemplate(runId: "inconnue") == nil)
        #expect(model.failure == nil, "un gabarit absent n'est pas une panne")
    }

    @Test("la pause se lit, se pose avec sa raison rognée et se relit sur l'événement `pause` ; un autre événement ne la relit pas ; oublier le serveur l'efface")
    func pause() async throws {
        let paused = #"{"pause":{"paused":true,"by":"mac","at":1700000000000,"reason":"maintenance","now":true}}"#
        let transport = osTransport(routes: [
            "GET /v1/pause": osJSON(#"{"pause":{"paused":false,"by":null,"at":null,"reason":null,"now":false}}"#),
            "POST /v1/pause": osJSON(paused),
        ])
        let model = await osConnected(transport)
        #expect(model.pause.availability == .unknown && model.pause.isServed)

        await model.pause.refresh()
        #expect(model.pause.availability == .available)
        #expect(model.pause.pause == HarnessPause(paused: false))
        #expect(!model.pause.isPaused)

        #expect(await model.pause.setPause(paused: true, reason: "  maintenance  ", now: true))
        let body = try #require(transport.body("POST", "/v1/pause"))
        #expect(body["paused"] as? Bool == true && body["reason"] as? String == "maintenance" && body["now"] as? Bool == true)
        #expect(model.pause.pause == HarnessPause(paused: true, by: "mac", at: 1_700_000_000_000, reason: "maintenance", now: true))
        #expect(model.pause.isPaused)

        #expect(await model.pause.setPause(paused: true))
        #expect(transport.rawBody("POST", "/v1/pause") == #"{"paused":true}"#, "sans `now`, l'étape en cours finit : le champ ne part pas")
        #expect(await model.pause.setPause(paused: false, now: true))
        #expect(transport.rawBody("POST", "/v1/pause") == #"{"paused":false}"#, "relancer n'interrompt rien")
        // Une vue sans `now` (serveur d'avant la précision) se lit quand même.
        #expect(try JSONDecoder().decode(HarnessPause.self, from: Data(#"{"paused":true,"by":"mac","at":1,"reason":null}"#.utf8)).now == false)

        let reads = transport.count("GET", "/v1/pause")
        let boxes = transport.count("GET", "/v1/inbox")
        transport.push(events: ["run_state"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/inbox") > boxes })
        #expect(transport.count("GET", "/v1/pause") == reads, "un événement d'un autre sujet ne relit pas la pause")
        model.stopLive()

        transport.push(events: ["pause"])
        model.startLive()
        #expect(await eventually { transport.count("GET", "/v1/pause") > reads })
        model.stopLive()

        await model.forget()
        #expect(model.pause.availability == .unknown && model.pause.pause == nil)
    }

    @Test("suspendre est réservé au propriétaire : un client borné est refusé (403), la pause affichée ne bouge pas et l'échec le dit")
    func pauseRefused() async {
        let transport = osTransport(routes: [
            "GET /v1/pause": osJSON(#"{"pause":{"paused":false,"by":null,"at":null,"reason":null,"now":false}}"#),
            "POST /v1/pause": osJSON(#"{"error":"réservé au propriétaire"}"#, status: 403),
        ])
        let model = await osConnected(transport)
        await model.pause.refresh()
        #expect(await model.pause.setPause(paused: true, now: true) == false)
        #expect(model.pause.failure == .forbidden("réservé au propriétaire"))
        #expect(model.pause.pause == HarnessPause(paused: false) && !model.pause.isSaving)
        #expect(model.pause.availability == .available, "la lecture reste permise")
    }

    @Test("un serveur sans /v1/pause (404) : la pause est absente, sans échec ; l'état du serveur dit `paused`, faux quand il ne le dit pas")
    func pauseOnOlderServer() async throws {
        let model = await osConnected(osTransport(routes: [:]))
        await model.pause.refresh()
        #expect(model.pause.availability == .absent)
        #expect(!model.pause.isServed && !model.pause.isPaused)
        #expect(model.pause.failure == nil)

        let status = try JSONDecoder().decode(HarnessStatus.self, from: Data(#"{"repos":[],"paused":true}"#.utf8))
        #expect(status.paused)
        #expect(try JSONDecoder().decode(HarnessStatus.self, from: Data(#"{"repos":[]}"#.utf8)).paused == false)
    }
}
