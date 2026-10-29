// Le client du POSTE DE TRAVAIL (routes `/v1/workstation*` d'omp-harness) : contrat
// JSON tel que le serveur l'écrit, gestes de l'humain (méthode, chemin, corps), flux
// d'événements partagé avec la boîte, badge des envois à approuver — sur la doublure
// de transport du serveur de pipelines, sans réseau.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func reply(_ json: String, status: Int = 200) -> HarnessReply { HarnessReply(status: status, body: Data(json.utf8)) }

private let emptyInbox = #"{"batches":[],"awaiting":[],"decisions":[],"runs":[],"cursor":42}"#

/// L'état du poste tel que le serveur l'écrit : clé inconnue, valeurs `null`.
private let statusJSON = #"""
{"online":true,"lastSeenAt":1761730000000,"extensionVersion":"0.1.0","observedSeconds":14400,"thresholdHours":8,
 "autonomy":{"setting":"auto","effective":"observe"},"paused":false,"selfIdentities":["moi@exemple.fr"],"pending":2,
 "profileUpdatedAt":null,"lastShift":null,"nextShiftAt":null,"champInconnu":{"x":1}}
"""#

/// Deux envois à approuver : destinataires connus (avec l'empreinte de l'extension), puis
/// inconnus (liste vide, empreinte absente).
private let approvalsJSON = #"""
{"actions":[
 {"seq":9,"createdAt":3,"updatedAt":1761730000123,"origin":"agent","by":"agent","kind":"click","params":{"tabId":12,"ref":"e4"},
  "rationale":"Répondre à Paul sur sa demande de devis","state":"awaiting_approval","approved":false,
  "approval":{"summary":"Envoyer un message à Paul Martin sur Gmail","recipients":["paul@exemple.fr"],"preview":"Bonjour Paul, voici le devis.",
              "fingerprint":"9f2c4e","decidedBy":null,"decidedAt":null,"reason":null},"result":null,"error":null},
 {"seq":7,"createdAt":1,"updatedAt":2,"origin":"session","by":"mac-studio","kind":"key","params":{"tabId":3,"key":"Enter"},
  "rationale":"Valider le commentaire","state":"awaiting_approval","approved":false,
  "approval":{"summary":"Publier un commentaire","recipients":[],"preview":"OK pour moi"},"result":null,"error":null}
]}
"""#

/// Le journal : une décision seule, un échec, un geste fait avec son résultat, un état inconnu.
private let journalJSON = #"""
{"actions":[
 {"seq":12,"createdAt":10,"updatedAt":10,"origin":"agent","by":"agent","kind":"decision","params":{},
  "rationale":"Ne pas relancer le client avant lundi","state":"done","approved":false,"approval":null,"result":null,"error":null},
 {"seq":11,"createdAt":9,"updatedAt":9,"origin":"agent","by":"agent","kind":"open","params":{"url":"https://exemple.fr"},
  "rationale":"Lire la page du devis","state":"failed","approved":false,"approval":null,"result":null,"error":"l’extension n’a pas rendu le résultat"},
 {"seq":10,"createdAt":8,"updatedAt":8,"origin":"session","by":"mac-studio","kind":"tabs","params":{},
  "rationale":"Voir les onglets ouverts","state":"done","approved":false,"approval":null,
  "result":{"text":"1 · Gmail · https://mail.google.com/\n2 · Devis · https://exemple.fr/devis","data":{"count":2}},"error":null},
 {"seq":8,"createdAt":7,"updatedAt":7,"origin":"robot","by":null,"kind":"teleport","rationale":"essai","state":"en_orbite"}
]}
"""#

private let profileJSON = #"""
{"profile":{"version":3,"updatedAt":1761730000000,"summary":"Commercial B2B, beaucoup de devis.","habits":["Mails le matin"],
  "tools":[{"name":"Gmail","usage":"échanges clients"}],"schedule":"9 h – 18 h","repetitiveTasks":[
   {"title":"Relancer les devis","frequency":"chaque lundi","steps":["mail.google.com/mail","crm.exemple.fr/devis/:id"],"automatable":true}],
  "clientNeeds":[{"need":"Un devis avant vendredi","who":"Paul Martin","meetingId":"m1","at":1761720000000},{"need":"Démo","who":null,"meetingId":null,"at":null}],
  "preferences":["Tutoiement interdit"],"inconnu":true},
 "stats":{"observedSeconds":14400,"since":1761000000000,"topSites":[{"host":"mail.google.com","seconds":7200,"share":0.5}],
  "activeHours":[0,0,0,0,0,0,0,0,0,3600,1800,0,0,0,0,0,0,0,0,0,0,0,0,0],"sequences":[{"steps":["a","b"],"count":4}]}}
"""#

private let meetingsJSON = #"""
{"meetings":[
 {"id":"m1","title":"Point Paul","url":"https://meet.google.com/abc","startedAt":1761720000000,"endedAt":1761723600000,"state":"digested",
  "summary":"Paul veut un devis.","needs":[{"need":"Un devis avant vendredi","who":"Paul Martin","due":"vendredi","quote":"il me le faut vendredi"}],"segments":42},
 {"id":"m2","title":"Daily","url":"https://meet.google.com/xyz","startedAt":1761730000000,"endedAt":null,"state":"live","summary":null,"needs":[],"segments":3}
]}
"""#

/// Un serveur qui sert la boîte et le poste ; `overrides` remplace une réponse par chemin.
private func workstationServer(_ overrides: [String: HarnessReply] = [:]) -> @Sendable (HarnessCall) -> HarnessReply {
    { call in
        if let forced = overrides["\(call.method) \(call.path)"] { return forced }
        switch (call.method, call.path) {
        case ("GET", "/v1/inbox"): return reply(emptyInbox)
        case ("GET", "/v1/workstation"): return reply(statusJSON)
        case ("GET", "/v1/workstation/actions?state=awaiting_approval&limit=200"): return reply(approvalsJSON)
        case ("GET", "/v1/workstation/actions?limit=100"): return reply(journalJSON)
        case ("GET", "/v1/workstation/profile"): return reply(profileJSON)
        case ("GET", "/v1/workstation/meetings?limit=20"): return reply(meetingsJSON)
        default: return reply(#"{"error":"route inconnue"}"#, status: 404)
        }
    }
}

@MainActor
private func connected(_ transport: ScriptedHarnessTransport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1)
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

private func body(_ call: HarnessCall?) throws -> [String: Any] {
    let data = try #require(call?.body)
    let object = try JSONSerialization.jsonObject(with: data)
    return try #require(object as? [String: Any])
}

@Suite("Poste de travail — client")
@MainActor
struct WorkstationModelTests {
    @Test("chaque type du poste se décode tel que le serveur l'écrit : null, clé inconnue, liste vide, état inconnu")
    func decodesEveryContractType() throws {
        let decoder = JSONDecoder()
        let status = try decoder.decode(WorkstationStatus.self, from: Data(statusJSON.utf8))
        #expect(status.online && status.pending == 2 && status.extensionVersion == "0.1.0")
        #expect(status.autonomySetting == .auto && status.autonomy.effective == "observe")
        #expect(status.lastShift == nil && status.profileUpdatedAt == nil && status.nextShiftAt == nil)
        #expect(status.observedProgress == 0.5, "4 h observées sur un seuil de 8 h")

        let approvals = try decoder.decode(WorkstationActionList.self, from: Data(approvalsJSON.utf8)).actions
        #expect(approvals.map(\.seq) == [9, 7])
        #expect(approvals.filter(\.awaitsApproval).count == 2)
        #expect(approvals[0].approval?.recipients == ["paul@exemple.fr"])
        #expect(approvals[0].params["tabId"] == .number(12))
        #expect(approvals[1].approval?.recipients == [], "destinataires inconnus : liste vide, approbation exigée")
        #expect(approvals[1].approval?.decidedBy == nil, "un champ absent vaut nil")
        #expect(approvals[0].approval?.fingerprint == "9f2c4e", "l'empreinte de l'extension est lue")
        #expect(approvals[1].approval?.fingerprint == nil, "une empreinte absente vaut nil")

        let journal = try decoder.decode(WorkstationActionList.self, from: Data(journalJSON.utf8)).actions
        #expect(journal.count == 4)
        #expect(journal[0].kind == "decision" && journal[0].phase == .done && journal[0].approval == nil)
        #expect(journal[1].error == "l’extension n’a pas rendu le résultat")
        #expect(journal[2].result?.data == .object(["count": .number(2)]))
        #expect(journal[2].shortResult == "1 · Gmail · https://mail.google.com/", "la première ligne seule")
        #expect(journal[3].phase == nil && journal[3].params == [:] && journal[3].by == nil, "un état apparu après cette version se lit sans échouer")
        #expect(WorkstationText.state(journal[3].state) == "en_orbite")
        #expect(WorkstationText.kind("click") != "click" && WorkstationText.origin("agent") == WorkstationText.originAgent)

        let profile = try decoder.decode(WorkstationProfileReply.self, from: Data(profileJSON.utf8))
        #expect(profile.profile?.version == 3)
        #expect(profile.profile?.repetitiveTasks.first?.automatable == true)
        #expect(profile.profile?.clientNeeds.last?.who == nil)
        #expect(profile.stats.topSites.first?.share == 0.5)
        #expect(profile.stats.activeHourBars.map(\.hour) == [9, 10], "les heures sans activité ne font pas de barre")
        #expect(profile.stats.sequences.first?.count == 4)

        let none = try decoder.decode(WorkstationProfileReply.self, from: Data(#"{"profile":null,"stats":{"observedSeconds":0,"since":null,"topSites":[],"activeHours":[],"sequences":[]}}"#.utf8))
        #expect(none.profile == nil && none.stats.topSites.isEmpty)
        let bare = try decoder.decode(WorkstationProfile.self, from: Data(#"{"version":1,"summary":"s"}"#.utf8))
        #expect(bare.habits.isEmpty && bare.tools.isEmpty && bare.schedule.isEmpty, "listes et textes absents : vides")

        let meetings = try decoder.decode(WorkstationMeetingList.self, from: Data(meetingsJSON.utf8)).meetings
        #expect(meetings.map(\.state) == ["digested", "live"])
        #expect(meetings[0].needs.first?.due == "vendredi" && meetings[0].segments == 42)
        #expect(meetings[1].endedAt == nil && meetings[1].summary == nil)
    }

    @Test("ouvrir la section lit l'état, les envois à approuver, le journal, le profil et les réunions ; le badge vaut l'attente du serveur")
    func loadReadsEverything() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(workstationServer())
        let server = await connected(transport)
        let workstation = server.workstation
        #expect(workstation.availability == .unknown && workstation.pendingCount == 0)

        await workstation.refresh()
        #expect(workstation.availability == .available)
        #expect(workstation.approvals.map(\.seq) == [9, 7])
        #expect(workstation.pendingCount == 2)
        #expect(workstation.journal.isEmpty && workstation.profile == nil, "le détail attend l'ouverture de la section")

        await workstation.load()
        #expect(workstation.journal.map(\.seq) == [12, 11, 10, 8])
        #expect(workstation.profile?.profile?.summary == "Commercial B2B, beaucoup de devis.")
        #expect(workstation.meetings.map(\.id) == ["m1", "m2"])
        #expect(workstation.failure == nil)
        let reads = transport.calls.filter { $0.path.hasPrefix("/v1/workstation") }.map { "\($0.method) \($0.path)" }
        #expect(reads.suffix(5) == [
            "GET /v1/workstation",
            "GET /v1/workstation/actions?state=awaiting_approval&limit=200",
            "GET /v1/workstation/actions?limit=100",
            "GET /v1/workstation/profile",
            "GET /v1/workstation/meetings?limit=20",
        ])
    }

    @Test("approuver et refuser partent sur la bonne route, avec le bon corps, puis relisent ; l'envoi quitte la liste")
    func approveAndRefuse() async throws {
        let transport = ScriptedHarnessTransport()
        let approved = #"{"action":{"seq":9,"origin":"agent","kind":"click","params":{},"rationale":"r","state":"queued","approved":true,"approval":{"summary":"s","recipients":["paul@exemple.fr"],"preview":"p","decidedBy":"iphone","decidedAt":5,"reason":null}}}"#
        let refused = #"{"action":{"seq":7,"origin":"session","kind":"key","params":{},"rationale":"r","state":"refused","approved":false,"approval":{"summary":"s","recipients":[],"preview":"p","decidedBy":"iphone","decidedAt":6,"reason":"pas avant lundi"}}}"#
        transport.respond(workstationServer([
            "POST /v1/workstation/actions/9/approve": reply(approved),
            "POST /v1/workstation/actions/7/refuse": reply(refused),
        ]))
        let server = await connected(transport)
        let workstation = server.workstation
        await workstation.refresh()
        let shown = workstation.approvals

        #expect(await workstation.approve(shown: shown[0]))
        let approve = try #require(transport.calls.last { $0.method == "POST" })
        #expect(approve.path == "/v1/workstation/actions/9/approve")
        let approveBody = try body(approve)
        #expect(approveBody.isEmpty, "approuver n'envoie rien d'autre que le geste")
        #expect(transport.calls.last?.path.hasPrefix("/v1/workstation") == true, "l'état est relu après le geste")
        #expect(workstation.busy.isEmpty && workstation.failure == nil)

        #expect(await workstation.refuse(shown: shown[1], reason: "  pas avant lundi \n"))
        let refuse = try #require(transport.calls.last { $0.method == "POST" })
        #expect(refuse.path == "/v1/workstation/actions/7/refuse")
        let refuseBody = try body(refuse)
        #expect(refuseBody["reason"] as? String == "pas avant lundi")

        #expect(await workstation.refuse(shown: shown[1], reason: "   "))
        let silent = try #require(transport.calls.last { $0.method == "POST" })
        let silentBody = try body(silent)
        #expect(silentBody.isEmpty, "une raison vide n'est pas envoyée")
    }

    @Test("approuver et refuser portent If-Match : l'updatedAt de l'action AFFICHÉE, en millisecondes entières")
    func gesturesCarryTheShownRevision() async throws {
        let transport = ScriptedHarnessTransport()
        let queued = #"{"action":{"seq":9,"origin":"agent","kind":"click","params":{},"rationale":"r","state":"queued","approved":true}}"#
        let refused = #"{"action":{"seq":7,"origin":"session","kind":"key","params":{},"rationale":"r","state":"refused"}}"#
        transport.respond(workstationServer([
            "POST /v1/workstation/actions/9/approve": reply(queued),
            "POST /v1/workstation/actions/7/refuse": reply(refused),
        ]))
        let server = await connected(transport)
        let workstation = server.workstation
        await workstation.refresh()
        let shown = workstation.approvals

        #expect(await workstation.approve(shown: shown[0]))
        let approve = try #require(transport.calls.last { $0.method == "POST" })
        #expect(approve.headers["If-Match"] == "\"1761730000123\"", "la révision de l'envoi que l'humain a vu")

        #expect(await workstation.refuse(shown: shown[1]))
        let refuse = try #require(transport.calls.last { $0.method == "POST" })
        #expect(refuse.path == "/v1/workstation/actions/7/refuse")
        #expect(refuse.headers["If-Match"] == "\"2\"")
    }

    @Test("un envoi changé depuis son affichage (412) ou sans révision reçue (428) : rien n'est approuvé, la liste est relue, la cause est dite")
    func changedApprovalReloadsAndSaysSo() async throws {
        for status in [412, 428] {
            let transport = ScriptedHarnessTransport()
            transport.respond(workstationServer([
                "POST /v1/workstation/actions/9/approve": reply(#"{"error":"l’envoi a changé depuis son affichage : relisez-le"}"#, status: status),
            ]))
            let server = await connected(transport)
            let workstation = server.workstation
            await workstation.refresh()
            let shown = try #require(workstation.approvals.first)
            let before = transport.calls.count

            #expect(await workstation.approve(shown: shown) == false, "statut \(status)")
            let after = transport.calls.dropFirst(before).map { "\($0.method) \($0.path)" }
            #expect(after.first == "POST /v1/workstation/actions/9/approve")
            #expect(after.contains("GET /v1/workstation/actions?state=awaiting_approval&limit=200"), "les envois à approuver sont relus (statut \(status))")
            #expect(workstation.failure == .approvalChanged, "statut \(status)")
            #expect(workstation.failure?.message == WorkstationText.approvalChanged)
            #expect(workstation.busy.isEmpty)
        }
        #expect(HarnessFailure.approvalChanged.message == "L’envoi a changé depuis son affichage\u{00A0}: relisez-le avant d’approuver.")
    }

    @Test("une action proposée par l'agent 24/24 (sans empreinte) se distingue d'un envoi de message")
    func proposalIsNotAMessageSend() throws {
        let json = #"""
        {"actions":[
         {"seq":21,"origin":"agent","kind":"click","params":{"tabId":4,"ref":"e2"},"rationale":"Ouvrir le devis","state":"awaiting_approval",
          "approval":{"summary":"Cliquer sur e2 dans l’onglet 4","recipients":[],"preview":"","fingerprint":null}},
         {"seq":20,"origin":"agent","kind":"click","params":{"tabId":4,"ref":"e9"},"rationale":"Répondre","state":"awaiting_approval",
          "approval":{"summary":"Envoyer un message","recipients":["paul@exemple.fr"],"preview":"Bonjour","fingerprint":"ab"}},
         {"seq":19,"origin":"session","kind":"key","params":{},"rationale":"Valider","state":"awaiting_approval",
          "approval":{"summary":"Publier","recipients":[],"preview":"OK","fingerprint":null}},
         {"seq":18,"origin":"agent","kind":"decision","params":{},"rationale":"Attendre","state":"done","approval":null}
        ]}
        """#
        let actions = try JSONDecoder().decode(WorkstationActionList.self, from: Data(json.utf8)).actions
        #expect(actions.map(\.isProposal) == [true, false, false, false])
        #expect(WorkstationText.proposal == "Action proposée par l’agent 24/24")
    }

    @Test("un envoi déjà tranché ailleurs : le motif du serveur reste affiché après la relecture, rien n'est approuvé")
    func approveConflictKeepsTheMotive() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(workstationServer([
            "POST /v1/workstation/actions/9/approve": reply(#"{"error":"l’action n’attend pas d’approbation"}"#, status: 409),
        ]))
        let server = await connected(transport)
        await server.workstation.refresh()
        #expect(await server.workstation.approve(shown: server.workstation.approvals[0]) == false)
        #expect(server.workstation.failure == .rejected("l’action n’attend pas d’approbation"))
        #expect(server.workstation.busy.isEmpty)
        #expect(server.workstation.approvals.map(\.seq) == [9, 7], "la liste reste celle que le serveur relit")
    }

    @Test("un jeton ordinaire (403 APPROVER_ONLY) : approuver, refuser et régler disent comment obtenir le code approbateur ; le poste reste lisible")
    func approverOnlyIsItsOwnFailure() async {
        // Le corps exact d'omp-harness/http.ts `APPROVER_ONLY`.
        let denied = reply(#"{"error":"seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste"}"#, status: 403)
        let transport = ScriptedHarnessTransport()
        transport.respond(workstationServer([
            "POST /v1/workstation/actions/9/approve": denied,
            "POST /v1/workstation/actions/7/refuse": denied,
            "PUT /v1/workstation/settings": denied,
        ]))
        let server = await connected(transport)
        let workstation = server.workstation
        await workstation.refresh()

        #expect(await workstation.approve(shown: workstation.approvals[0]) == false)
        #expect(workstation.failure == .approverOnly)
        #expect(workstation.availability == .available, "un refus d'approbateur n'est pas un poste réservé")
        #expect(workstation.approvals.map(\.seq) == [9, 7], "les envois restent affichés, et leurs gestes offerts")
        #expect(workstation.busy.isEmpty)

        #expect(await workstation.refuse(shown: workstation.approvals[1]) == false)
        #expect(workstation.failure == .approverOnly)
        #expect(await workstation.setPaused(true) == false)
        #expect(workstation.failure == .approverOnly)
        #expect(workstation.isSaving == false)

        #expect(workstation.failure?.message == WorkstationText.approverOnly)
        #expect(HarnessFailure.approverOnly.message == "Seul l’appareil approbateur peut approuver, refuser ou régler le poste\u{00A0}: appairez cette app avec le code qu’affiche harness.sh approver sur le VPS, ou avec le jeton qu’affiche sudo omp-harness-client approver (systemd).")
        // Un autre 403 garde son motif.
        transport.respond(workstationServer(["PUT /v1/workstation/settings": reply(#"{"error":"le rôle viewer ne permet pas cela"}"#, status: 403)]))
        #expect(await workstation.setPaused(true) == false)
        #expect(workstation.failure == .forbidden("le rôle viewer ne permet pas cela"))
    }

    @Test("autonomie, pause et adresses partent en PUT /v1/workstation/settings, seul le champ réglé ; l'état rendu remplace l'ancien")
    func settingsHitTheSettingsRoute() async throws {
        let transport = ScriptedHarnessTransport()
        let saved = statusJSON.replacingOccurrences(of: #""setting":"auto","effective":"observe""#, with: #""setting":"propose","effective":"propose""#)
        transport.respond(workstationServer(["PUT /v1/workstation/settings": reply(saved)]))
        let server = await connected(transport)
        let workstation = server.workstation
        await workstation.refresh()

        #expect(await workstation.setAutonomy(.propose))
        var put = try #require(transport.calls.last { $0.method == "PUT" })
        #expect(put.path == "/v1/workstation/settings")
        let autonomyBody = try body(put)
        #expect(NSDictionary(dictionary: autonomyBody) == NSDictionary(dictionary: ["autonomy": "propose"]))
        #expect(workstation.status?.autonomySetting == .propose)

        #expect(await workstation.setPaused(true))
        put = try #require(transport.calls.last { $0.method == "PUT" })
        let pausedBody = try body(put)
        #expect(NSDictionary(dictionary: pausedBody) == NSDictionary(dictionary: ["paused": true]))

        #expect(await workstation.setSelfIdentities([" moi@exemple.fr ", "", "MOI@exemple.fr", "@moi"]))
        put = try #require(transport.calls.last { $0.method == "PUT" })
        let identitiesBody = try body(put)
        #expect(identitiesBody["selfIdentities"] as? [String] == ["moi@exemple.fr", "@moi"], "nettoyées, sans doublon de casse")
        #expect(Set(identitiesBody.keys) == ["selfIdentities"])
        #expect(workstation.isSaving == false)
    }

    @Test("reconstruire le profil : POST accepté en 202, la demande est notée")
    func rebuildIsQueued() async throws {
        let transport = ScriptedHarnessTransport()
        transport.respond(workstationServer(["POST /v1/workstation/profile/rebuild": reply(#"{"queued":true}"#, status: 202)]))
        let server = await connected(transport)
        await server.workstation.refresh()
        #expect(await server.workstation.rebuildProfile())
        #expect(server.workstation.rebuildQueued)
        #expect(transport.calls.last?.path == "/v1/workstation/profile/rebuild")
    }

    @Test("un événement workstation_* du flux de la boîte fait relire le poste ; un autre événement, non ; aucun second flux")
    func liveEventsReloadTheWorkstation() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(workstationServer())
        let server = await connected(transport)
        await server.workstation.refresh()
        let statusReads = { transport.calls.filter { $0.path == "/v1/workstation" }.count }
        let before = statusReads()

        transport.stream([Data("id: 43\nevent: run_state\ndata: {}\n\n".utf8)])
        server.startLive()
        #expect(await eventually { transport.calls.filter { $0.path == "/v1/inbox" }.count > 1 })
        server.stopLive()
        try? await Task.sleep(for: .milliseconds(30))
        #expect(statusReads() == before, "un événement de la boîte ne relit pas le poste")

        transport.stream([Data("id: 44\nevent: workstation_approval\ndata: {\"payload\":{\"seq\":9}}\n\n".utf8)])
        server.startLive()
        #expect(await eventually { statusReads() > before })
        server.stopLive()
        #expect(transport.calls.filter { $0.path.hasPrefix("/v1/events") }.count == 2, "le poste n'ouvre aucun flux à lui")
    }

    @Test("un serveur sans poste (404) ou un jeton limité à des dépôts (403) : badge à zéro, les événements n'y font rien")
    func absentOrReservedWorkstation() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(workstationServer(["GET /v1/workstation": reply(#"{"error":"route inconnue"}"#, status: 404)]))
        let server = await connected(transport)
        await server.workstation.refresh()
        #expect(server.workstation.availability == .absent)
        #expect(server.workstation.pendingCount == 0 && server.workstation.failure == nil)
        #expect(!transport.calls.contains { $0.path.hasPrefix("/v1/workstation/actions") }, "rien d'autre n'est demandé")

        transport.respond(workstationServer(["GET /v1/workstation": reply(#"{"error":"le poste est réservé au propriétaire"}"#, status: 403)]))
        await server.workstation.refresh()
        #expect(server.workstation.availability == .reserved("le poste est réservé au propriétaire"))
        #expect(server.workstation.pendingCount == 0)
        let reads = transport.calls.filter { $0.path == "/v1/workstation" }.count
        server.workstation.receive(["workstation_action"])
        try? await Task.sleep(for: .milliseconds(30))
        #expect(transport.calls.filter { $0.path == "/v1/workstation" }.count == reads)
    }

    @Test("oublier le serveur oublie le poste ; sans serveur, rien ne part")
    func forgetClearsTheWorkstation() async {
        let transport = ScriptedHarnessTransport()
        transport.respond(workstationServer())
        let server = await connected(transport)
        await server.workstation.load()
        #expect(server.workstation.pendingCount == 2)
        let shown = server.workstation.approvals[0]
        await server.forget()
        #expect(server.workstation.availability == .unknown)
        #expect(server.workstation.approvals.isEmpty && server.workstation.journal.isEmpty && server.workstation.status == nil)
        let count = transport.calls.count
        await server.workstation.refresh()
        #expect(await server.workstation.approve(shown: shown) == false)
        #expect(transport.calls.count == count)
    }

    @Test("la saisie des adresses : une par ligne ou par virgule, nettoyée, sans doublon ; « Enregistrer » ne s'ouvre qu'à un changement")
    func identitiesDraft() {
        #expect(WorkstationModel.identities(from: " a@x.fr \n\nb@x.fr, A@X.fr ,@moi") == ["a@x.fr", "b@x.fr", "@moi"])
        #expect(WorkstationModel.identitiesText(["a@x.fr", "@moi"]) == "a@x.fr\n@moi")
        let drafts = HarnessDrafts()
        let status = WorkstationStatus(selfIdentities: ["a@x.fr"])
        #expect(!drafts.identitiesChanged(from: status), "rien de saisi")
        drafts.workstationIdentities = "a@x.fr\n"
        #expect(!drafts.identitiesChanged(from: status))
        drafts.workstationIdentities = "a@x.fr\nb@x.fr"
        #expect(drafts.identitiesChanged(from: status))
        let action = WorkstationAction(seq: 3, kind: "click", rationale: "r", state: "awaiting_approval")
        drafts.workstationRefusalReason = "ancienne"
        drafts.beginWorkstationRefusal(action)
        #expect(drafts.workstationRefusal?.seq == 3 && drafts.workstationRefusalReason.isEmpty)
    }
}
