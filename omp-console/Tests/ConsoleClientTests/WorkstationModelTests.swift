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
        #expect(HarnessFailure.approverOnly.message == "Seul l’appareil approbateur peut approuver, refuser ou régler le poste\u{00A0}: appairez cette app avec le code approbateur\u{00A0}: harness.sh approver sur le VPS, omp-harness-stack approver dans la console du conteneur harness (Portainer), ou le jeton de sudo omp-harness-client approver (systemd).")
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

// MARK: - Demandes et automatisations du poste

private func json(_ object: Any, status: Int = 200) -> HarnessReply {
    HarnessReply(status: status, body: (try? JSONSerialization.data(withJSONObject: object)) ?? Data())
}

private func requestJSON(
    _ id: String, _ state: String, instruction: String = "Relever les prix", reason: String? = nil,
    report: String? = nil, automationId: String? = nil
) -> [String: Any] {
    [
        "id": id, "createdAt": 1, "updatedAt": 2, "by": "mac", "instruction": instruction,
        "automationId": automationId ?? NSNull(), "state": state, "reason": reason ?? NSNull(),
        "report": report ?? NSNull(), "startedAt": NSNull(), "endedAt": NSNull(),
    ]
}

private func actionJSON(_ seq: Int, requestId: String, kind: String = "open", rationale: String, state: String = "done") -> [String: Any] {
    ["seq": seq, "requestId": requestId, "createdAt": 1, "updatedAt": 1, "origin": "session", "by": "mac", "kind": kind,
     "params": [String: Any](), "rationale": rationale, "state": state, "approved": false]
}

private func automationJSON(_ id: String, title: String = "Relancer les devis") -> [String: Any] {
    ["id": id, "createdAt": 1, "by": "mac", "title": title, "frequency": "chaque lundi",
     "steps": ["mail.google.com/mail", "crm.exemple.fr/devis/:id"], "profileVersion": 3]
}

/// Le profil de `profileJSON` précédé d'une tâche qui n'est PAS automatisable.
private let twoTasksProfileJSON = profileJSON.replacingOccurrences(
    of: #""repetitiveTasks":["#,
    with: #""repetitiveTasks":[{"title":"Trier la boîte","frequency":"chaque jour","steps":["mail.google.com/mail"],"automatable":false},"#
)

private let approverDenied = reply(#"{"error":"seul l'appareil approbateur (OMP Console appairée avec le code de `harness.sh approver`) peut approuver, refuser ou régler le poste"}"#, status: 403)

/// Un serveur du poste qui sert aussi les demandes et les automatisations, avec leur état.
private final class PosteServer: @unchecked Sendable {
    private let lock = NSLock()
    private var requests: [[String: Any]] = []
    private var automations: [[String: Any]] = []
    private var details: [String: [String: Any]] = [:]
    private var forced: [String: HarnessReply] = [:]
    private var health = reply(#"{"ok":true,"api":1,"features":["workstation-requests"],"checks":[]}"#)
    private var counter = 0

    func handler() -> @Sendable (HarnessCall) -> HarnessReply {
        { [self] call in handle(call) }
    }

    func force(_ key: String, _ forcedReply: HarnessReply?) { lock.withLock { forced[key] = forcedReply } }
    func setHealth(_ value: HarnessReply) { lock.withLock { health = value } }
    func setRequests(_ list: [[String: Any]]) { lock.withLock { requests = list } }
    func setAutomations(_ list: [[String: Any]]) { lock.withLock { automations = list } }
    func setDetail(_ id: String, request: [String: Any], actions: [[String: Any]]) {
        lock.withLock { details[id] = ["request": request, "actions": actions] }
    }
    func removeDetail(_ id: String) { lock.withLock { details[id] = nil } }

    private func handle(_ call: HarnessCall) -> HarnessReply {
        let key = "\(call.method) \(call.path)"
        let (forcedReply, healthReply) = lock.withLock { (forced[key], health) }
        if let forcedReply { return forcedReply }
        if key == "GET /v1/health" { return healthReply }
        if let routed = lock.withLock({ route(call) }) { return routed }
        return workstationServer(["GET /v1/workstation/profile": reply(profileJSON)])(call)
    }

    /// Le verrou est tenu.
    private func route(_ call: HarnessCall) -> HarnessReply? {
        let requestsBase = "/v1/workstation/requests"
        let automationsBase = "/v1/workstation/automations"
        switch (call.method, call.path) {
        case ("GET", requestsBase): return json(["requests": requests])
        case ("GET", automationsBase): return json(["automations": automations])
        case ("POST", requestsBase):
            let sent = (try? JSONSerialization.jsonObject(with: call.body ?? Data())) as? [String: Any]
            counter += 1
            let created = requestJSON("n\(counter)", "queued", instruction: sent?["instruction"] as? String ?? "")
            requests.insert(created, at: 0)
            return json(["request": created], status: 201)
        case ("POST", automationsBase):
            counter += 1
            let created = automationJSON("auto\(counter)")
            automations.append(created)
            return json(["automation": created], status: 201)
        default: break
        }
        if call.path.hasPrefix(requestsBase + "/") {
            let rest = String(call.path.dropFirst(requestsBase.count + 1))
            if call.method == "GET" {
                return details[rest].map { json($0) } ?? json(["error": "demande inconnue"], status: 404)
            }
            if call.method == "POST", rest.hasSuffix("/cancel") {
                let id = String(rest.dropLast("/cancel".count))
                guard let index = requests.firstIndex(where: { $0["id"] as? String == id }) else {
                    return json(["error": "demande inconnue"], status: 404)
                }
                requests[index]["state"] = "cancelled"
                return json(["request": requests[index]])
            }
        }
        if call.path.hasPrefix(automationsBase + "/") {
            let rest = String(call.path.dropFirst(automationsBase.count + 1))
            if call.method == "POST", rest.hasSuffix("/launch") {
                counter += 1
                let id = String(rest.dropLast("/launch".count))
                let created = requestJSON("n\(counter)", "queued", instruction: "Relancer les devis", automationId: id)
                requests.insert(created, at: 0)
                return json(["request": created], status: 201)
            }
            if call.method == "DELETE" {
                automations.removeAll { $0["id"] as? String == rest }
                return json(["removed": true])
            }
        }
        return nil
    }
}

/// Une doublure de transport qui retient la réponse d'un appel (celle qu'il avait à l'instant
/// de l'appel) jusqu'à `release`, pour entrelacer deux lectures.
private final class GatedTransport: HarnessTransport, @unchecked Sendable {
    let inner = ScriptedHarnessTransport()
    private let lock = NSLock()
    private var gated: Set<String> = []
    private var waiting: [String: [CheckedContinuation<Void, Never>]] = [:]

    var calls: [HarnessCall] { inner.calls }

    func hold(_ key: String) { lock.withLock { _ = gated.insert(key) } }

    func heldCount(_ key: String) -> Int { lock.withLock { waiting[key]?.count ?? 0 } }

    func release(_ key: String) {
        let continuations = lock.withLock { () -> [CheckedContinuation<Void, Never>] in
            gated.remove(key)
            return waiting.removeValue(forKey: key) ?? []
        }
        for continuation in continuations { continuation.resume() }
    }

    func send(_ call: HarnessCall, server: HarnessServer) async throws -> HarnessReply {
        let key = "\(call.method) \(call.path)"
        let answer = try await inner.send(call, server: server)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let passes = lock.withLock { () -> Bool in
                if gated.contains(key) {
                    waiting[key, default: []].append(continuation)
                    return false
                }
                return true
            }
            if passes { continuation.resume() }
        }
        return answer
    }

    func events(_ call: HarnessCall, server: HarnessServer) async throws -> AsyncThrowingStream<Data, Error> {
        try await inner.events(call, server: server)
    }
}

@MainActor
private func connectedGated(_ transport: GatedTransport) async -> HarnessModel {
    let model = HarnessModel(
        transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore(),
        retryDelay: .seconds(3600), refreshDelay: .milliseconds(1)
    )
    _ = await model.configure(address: "vps.example", token: "t")
    return model
}

private func touchesRequests(_ call: HarnessCall) -> Bool {
    call.path.hasPrefix("/v1/workstation/requests") || call.path.hasPrefix("/v1/workstation/automations")
}

@Suite("Poste de travail — demandes et automatisations")
@MainActor
struct WorkstationRequestsTests {
    private func opened(_ poste: PosteServer = PosteServer()) async -> (WorkstationModel, ScriptedHarnessTransport, PosteServer) {
        let transport = ScriptedHarnessTransport()
        transport.respond(poste.handler())
        let server = await connected(transport)
        await server.workstation.load()
        return (server.workstation, transport, poste)
    }

    @Test("demandes-et-automatisations-du-poste/AC-7 : une demande se décode avec sa raison d'attente, son compte rendu et un état inconnu ; l'action porte sa demande")
    func decodesRequestsAndAutomations() throws {
        let decoder = JSONDecoder()
        let list = try decoder.decode(WorkstationRequestList.self, from: json([
            "requests": [
                requestJSON("r1", "queued", reason: "l’extension est hors ligne"),
                requestJSON("r2", "failed", reason: "page introuvable"),
                requestJSON("r3", "en_pause"),
            ],
            "inconnu": true,
        ]).body)
        #expect(list.requests.map(\.id) == ["r1", "r2", "r3"])
        #expect(list.requests[0].phase == .queued && list.requests[0].reason == "l’extension est hors ligne")
        #expect(list.requests[1].phase == .failed && list.requests[1].reason == "page introuvable")
        #expect(list.requests[2].phase == nil && list.requests[2].state == "en_pause", "un état apparu plus tard se lit sans échouer")
        #expect(list.requests[0].report == nil && list.requests[0].automationId == nil)

        let detail = try decoder.decode(WorkstationRequestDetail.self, from: json([
            "request": requestJSON("r1", "done", report: "Trois prix relevés."),
            "actions": [actionJSON(21, requestId: "r1", rationale: "Ouvrir le catalogue")],
        ]).body)
        #expect(detail.report == "Trois prix relevés." && detail.actions.map(\.requestId) == ["r1"])
        let plain = try decoder.decode(WorkstationAction.self, from: Data(#"{"seq":1,"kind":"tabs","state":"done"}"#.utf8))
        #expect(plain.requestId == nil, "une action hors demande n'a pas de requestId")

        let automation = try decoder.decode(WorkstationAutomationList.self, from: json(["automations": [automationJSON("a1")]]).body)
        #expect(automation.automations[0].title == "Relancer les devis" && automation.automations[0].steps.count == 2)
    }

    @Test("demandes-et-automatisations-du-poste/AC-10 : les cinq états ont un libellé distinct, un état inconnu se rend brut")
    func fiveDistinctStates() {
        let labels = WorkstationRequestState.allCases.map { WorkstationText.requestState($0.rawValue) }
        #expect(labels.count == 5 && Set(labels).count == 5)
        #expect(WorkstationText.requestState("cancelled") == "Annulée par vous")
        #expect(WorkstationText.requestState("paused") == "paused")
    }

    @Test("demandes-et-automatisations-du-poste/AC-21 : sans le drapeau (ou /v1/health en 404) ni les blocs ni aucune route de demande ; les gestes ne partent pas")
    func noFlagNoRequests() async {
        let poste = PosteServer()
        poste.setHealth(reply(#"{"ok":true,"features":["workstation"]}"#))
        let (workstation, transport, _) = await opened(poste)
        #expect(workstation.availability == .available && !workstation.requestsEnabled)
        #expect(workstation.requests.isEmpty && workstation.automations.isEmpty && workstation.openRequest == nil)
        #expect(await workstation.ask("Relever les prix") == false)
        #expect(await workstation.cancel(WorkstationRequest(id: "r1", instruction: "x", state: "queued")) == false)
        #expect(await workstation.launch(WorkstationAutomation(id: "a1", title: "t")) == false)
        #expect(await workstation.delete(WorkstationAutomation(id: "a1", title: "t")) == false)
        await workstation.open(request: "r1")
        #expect(workstation.openRequestId == nil)
        #expect(!transport.calls.contains(where: touchesRequests))

        // Le serveur de test par défaut répond 404 à /v1/health : drapeau jamais lu.
        let plain = ScriptedHarnessTransport()
        plain.respond(workstationServer())
        let bare = await connected(plain)
        await bare.workstation.load()
        #expect(!bare.workstation.requestsEnabled && bare.workstation.availability == .available)
        #expect(!plain.calls.contains(where: touchesRequests))
    }

    @Test("demandes-et-automatisations-du-poste/AC-27 : le drapeau se lit en 503 ; injoignable ou illisible, la dernière valeur est gardée, sans lecture les blocs restent cachés")
    func flagReadAcrossHealthStates() async {
        let poste = PosteServer()
        poste.setHealth(reply(#"{"ok":false,"features":["workstation-requests"],"checks":[]}"#, status: 503))
        let (workstation, transport, _) = await opened(poste)
        #expect(workstation.requestsEnabled, "503 avec le drapeau : les blocs s'affichent")

        poste.setHealth(reply(#"{"error":"bad gateway"}"#, status: 502))
        await workstation.load()
        #expect(workstation.requestsEnabled, "502 : la dernière valeur lue est gardée")
        poste.setHealth(reply("<html>pas du JSON</html>"))
        await workstation.load()
        #expect(workstation.requestsEnabled && workstation.failure == nil, "illisible : valeur gardée, aucun échec")

        // Sans aucune lecture réussie : cachés, aucune route de demande.
        let unreadable = PosteServer()
        unreadable.setHealth(reply("pas du JSON"))
        let (hidden, hiddenTransport, _) = await opened(unreadable)
        #expect(!hidden.requestsEnabled && !hiddenTransport.calls.contains(where: touchesRequests))
        #expect(transport.calls.contains { $0.method == "GET" && $0.path == "/v1/health" })
    }

    @Test("demandes-et-automatisations-du-poste/AC-1 : « Demander » pose la consigne par POST /v1/workstation/requests et la demande apparaît en file ; AC-4 : aucun run ni projet")
    func askPostsTheInstruction() async throws {
        let (workstation, transport, _) = await opened()
        #expect(workstation.requestsEnabled && workstation.requests.isEmpty)
        #expect(await workstation.ask("  Relever les prix du catalogue \n"))
        let post = try #require(transport.calls.first { $0.method == "POST" })
        #expect(post.path == "/v1/workstation/requests")
        let sent = try body(post)
        #expect(NSDictionary(dictionary: sent) == NSDictionary(dictionary: ["instruction": "Relever les prix du catalogue"]))
        #expect(workstation.requests.map(\.instruction) == ["Relever les prix du catalogue"])
        #expect(workstation.requests[0].phase == .queued && workstation.requestsFailure == nil && !workstation.isAsking)
        let writes = transport.calls.filter { $0.method != "GET" }
        #expect(writes.map(\.path) == ["/v1/workstation/requests"])
        #expect(!transport.calls.contains { $0.path.hasPrefix("/v1/runs") || $0.path.hasPrefix("/v1/projects") })
    }

    @Test("demandes-et-automatisations-du-poste/AC-3 : une consigne vide ou faite d'espaces ne part pas")
    func blankInstructionIsNotSent() async {
        let (workstation, transport, _) = await opened()
        #expect(!WorkstationModel.canAsk("") && !WorkstationModel.canAsk("  \n\t") && WorkstationModel.canAsk(" a "))
        let before = transport.calls.count
        #expect(await workstation.ask("  \n") == false)
        #expect(transport.calls.count == before)
    }

    @Test("demandes-et-automatisations-du-poste/AC-5 : poste en pause, le 409 est dit dans le bloc Demandes et rien n'est ajouté")
    func askRefusedWhilePaused() async {
        let (workstation, _, poste) = await opened()
        poste.force("POST /v1/workstation/requests", reply(#"{"error":"le poste est en pause"}"#, status: 409))
        #expect(await workstation.ask("Relever les prix") == false)
        #expect(workstation.requestsFailure == .rejected("le poste est en pause"))
        #expect(workstation.requests.isEmpty && workstation.failure == nil && workstation.availability == .available)
        #expect(!workstation.isAsking)
    }

    @Test("demandes-et-automatisations-du-poste/AC-11 : « Annuler » une demande en file ou en cours appelle POST …/{id}/cancel et la demande se lit annulée ; AC-12 : jamais sur une demande finie")
    func cancelOnlyQueuedOrRunning() async throws {
        let poste = PosteServer()
        poste.setRequests([requestJSON("r1", "running"), requestJSON("r2", "done"), requestJSON("r3", "failed"), requestJSON("r4", "queued"), requestJSON("r5", "weird")])
        let (workstation, transport, _) = await opened(poste)
        #expect(workstation.requests.count == 5)
        #expect(WorkstationRequestState.allCases.filter { WorkstationModel.canCancel($0) } == [.queued, .running])
        #expect(!WorkstationModel.canCancel(nil))

        #expect(await workstation.cancel(workstation.requests[0]))
        let post = try #require(transport.calls.last { $0.method == "POST" })
        #expect(post.path == "/v1/workstation/requests/r1/cancel")
        #expect(workstation.requests[0].phase == .cancelled && workstation.busyRequests.isEmpty)

        let before = transport.calls.count
        for index in [1, 2, 4] { #expect(await workstation.cancel(workstation.requests[index]) == false) }
        #expect(transport.calls.count == before, "finie, échouée ou d'état inconnu : aucune requête")
        #expect(await workstation.cancel(workstation.requests[3]))
        #expect(workstation.requests[3].phase == .cancelled)
    }

    @Test("demandes-et-automatisations-du-poste/AC-14 : « Automatiser » envoie la version du profil et l'indice de la tâche ; AC-28 : la seconde tâche d'un profil dont la première ne l'est pas porte task: 1")
    func automateSendsVersionAndIndex() async throws {
        let poste = PosteServer()
        poste.force("GET /v1/workstation/profile", reply(twoTasksProfileJSON))
        let (workstation, transport, _) = await opened(poste)
        let profile = try #require(workstation.profile?.profile)
        #expect(profile.repetitiveTasks.map(\.automatable) == [false, true])

        #expect(await workstation.automate(taskAt: 1, of: profile))
        let post = try #require(transport.calls.last { $0.method == "POST" })
        #expect(post.path == "/v1/workstation/automations")
        let sent = try body(post)
        #expect(NSDictionary(dictionary: sent) == NSDictionary(dictionary: ["version": 3, "task": 1]))
        #expect(workstation.automations.map(\.title) == ["Relancer les devis"])
        #expect(workstation.automateFailure == nil && workstation.busyTasks.isEmpty)
    }

    @Test("demandes-et-automatisations-du-poste/AC-15 : aucune automatisation depuis une tâche non automatisable ou inexistante, aucune requête")
    func automateOnlyAutomatableTasks() async throws {
        let poste = PosteServer()
        poste.force("GET /v1/workstation/profile", reply(twoTasksProfileJSON))
        let (workstation, transport, _) = await opened(poste)
        let profile = try #require(workstation.profile?.profile)
        let before = transport.calls.count
        #expect(await workstation.automate(taskAt: 0, of: profile) == false)
        #expect(await workstation.automate(taskAt: 2, of: profile) == false)
        #expect(await workstation.automate(taskAt: -1, of: profile) == false)
        #expect(transport.calls.count == before)
    }

    @Test("demandes-et-automatisations-du-poste/AC-17 : « Lancer » appelle POST …/{id}/launch et une demande en file apparaît ; AC-18 : « Supprimer » appelle DELETE, l'automatisation part, la demande lancée reste")
    func launchThenDelete() async throws {
        let poste = PosteServer()
        poste.setAutomations([automationJSON("a1")])
        let (workstation, transport, _) = await opened(poste)
        #expect(workstation.automations.map(\.id) == ["a1"] && workstation.requests.isEmpty)

        #expect(await workstation.launch(workstation.automations[0]))
        let launch = try #require(transport.calls.last { $0.method == "POST" })
        #expect(launch.path == "/v1/workstation/automations/a1/launch")
        #expect(workstation.requests.count == 1 && workstation.requests[0].phase == .queued && workstation.requests[0].automationId == "a1")

        #expect(await workstation.delete(workstation.automations[0]))
        let delete = try #require(transport.calls.last { $0.method == "DELETE" })
        #expect(delete.path == "/v1/workstation/automations/a1")
        #expect(workstation.automations.isEmpty, "elle quitte la liste")
        #expect(workstation.requests.count == 1, "la demande déjà lancée reste lisible")
        #expect(workstation.busyAutomations.isEmpty && workstation.automationsFailure == nil)

        // Un 204 sans corps vaut succès.
        poste.setAutomations([automationJSON("a2")])
        await workstation.refresh()
        poste.force("DELETE /v1/workstation/automations/a2", HarnessReply(status: 204, body: Data()))
        #expect(await workstation.delete(workstation.automations[0]))
        #expect(workstation.automations.isEmpty)
    }

    @Test("demandes-et-automatisations-du-poste/AC-20 : le 403 approbateur donne .approverOnly pour chacun des cinq gestes, dans l'échec de son bloc, listes inchangées")
    func approverOnlyOnEveryGesture() async throws {
        let poste = PosteServer()
        poste.setRequests([requestJSON("r1", "queued")])
        poste.setAutomations([automationJSON("a1")])
        poste.force("GET /v1/workstation/profile", reply(profileJSON))
        let (workstation, _, _) = await opened(poste)
        for key in ["POST /v1/workstation/requests", "POST /v1/workstation/requests/r1/cancel", "POST /v1/workstation/automations",
                    "POST /v1/workstation/automations/a1/launch", "DELETE /v1/workstation/automations/a1"] {
            poste.force(key, approverDenied)
        }
        let requestsBefore = workstation.requests
        let automationsBefore = workstation.automations
        let profile = try #require(workstation.profile?.profile)

        #expect(await workstation.ask("Relever les prix") == false)
        #expect(workstation.requestsFailure == .approverOnly)
        #expect(await workstation.cancel(workstation.requests[0]) == false)
        #expect(workstation.requestsFailure == .approverOnly)
        #expect(await workstation.automate(taskAt: 0, of: profile) == false)
        #expect(workstation.automateFailure == .approverOnly)
        #expect(await workstation.launch(workstation.automations[0]) == false)
        #expect(workstation.automationsFailure == .approverOnly)
        #expect(await workstation.delete(workstation.automations[0]) == false)
        #expect(workstation.automationsFailure == .approverOnly)

        #expect(workstation.failure == nil && workstation.availability == .available)
        #expect(workstation.requests == requestsBefore && workstation.automations == automationsBefore)
        #expect(workstation.requestsFailure?.message == WorkstationText.approverOnly)

        // Un autre 403 garde son motif ; un geste qui repart efface l'échec de son bloc.
        poste.force("POST /v1/workstation/requests", reply(#"{"error":"le rôle viewer ne permet pas cela"}"#, status: 403))
        #expect(await workstation.ask("Relever les prix") == false)
        #expect(workstation.requestsFailure == .forbidden("le rôle viewer ne permet pas cela"))
        poste.force("POST /v1/workstation/requests", nil)
        #expect(await workstation.ask("Relever les prix"))
        #expect(workstation.requestsFailure == nil)
    }

    @Test("demandes-et-automatisations-du-poste/AC-6 : un événement workstation_request relit la liste et le détail ouvert sans geste, workstation_action le détail, workstation_automation les automatisations")
    func eventsReloadWithoutGesture() async {
        let poste = PosteServer()
        poste.setRequests([requestJSON("d1", "running")])
        poste.setDetail("d1", request: requestJSON("d1", "running"), actions: [actionJSON(1, requestId: "d1", rationale: "Ouvrir le catalogue")])
        let (workstation, transport, _) = await opened(poste)
        await workstation.open(request: "d1")
        #expect(workstation.requests[0].phase == .running && workstation.openRequest?.actions.count == 1)

        poste.setRequests([requestJSON("d1", "done", report: "Trois prix relevés.")])
        poste.setDetail("d1", request: requestJSON("d1", "done", report: "Trois prix relevés."), actions: [
            actionJSON(1, requestId: "d1", rationale: "Ouvrir le catalogue"), actionJSON(2, requestId: "d1", kind: "snapshot", rationale: "Lire les prix"),
        ])
        workstation.receive(["workstation_request"])
        #expect(await eventually { workstation.requests[0].phase == .done && workstation.openRequest?.actions.count == 2 })
        #expect(workstation.openRequest?.report == "Trois prix relevés.")

        poste.setDetail("d1", request: requestJSON("d1", "done", report: "Trois prix relevés."), actions: [
            actionJSON(1, requestId: "d1", rationale: "Ouvrir le catalogue"), actionJSON(2, requestId: "d1", kind: "snapshot", rationale: "Lire les prix"),
            actionJSON(3, requestId: "d1", kind: "click", rationale: "Valider"),
        ])
        workstation.receive(["workstation_action"])
        #expect(await eventually { workstation.openRequest?.actions.count == 3 })

        poste.setAutomations([automationJSON("a9")])
        let before = transport.calls.filter { $0.path == "/v1/workstation/automations" }.count
        workstation.receive(["workstation_automation"])
        #expect(await eventually { workstation.automations.map(\.id) == ["a9"] })
        #expect(transport.calls.filter { $0.path == "/v1/workstation/automations" }.count > before)
    }

    @Test("demandes-et-automatisations-du-poste/AC-25 : un événement reçu pendant une relecture en cours est relu après elle, une fois")
    func eventDuringReloadIsNotLost() async {
        let poste = PosteServer()
        poste.setRequests([requestJSON("d1", "running")])
        let transport = GatedTransport()
        transport.inner.respond(poste.handler())
        let server = await connectedGated(transport)
        let workstation = server.workstation
        await workstation.load()
        let key = "GET /v1/workstation/requests"
        let reads = { transport.calls.filter { $0.method == "GET" && $0.path == "/v1/workstation/requests" }.count }
        let before = reads()

        transport.hold(key)
        workstation.receive(["workstation_request"])
        #expect(await eventually { transport.heldCount(key) == 1 }, "la relecture est en cours, sa réponse retenue")
        poste.setRequests([requestJSON("d1", "done")])
        workstation.receive(["workstation_automation"])
        workstation.receive(["workstation_action"])
        transport.release(key)

        #expect(await eventually { workstation.requests.first?.phase == .done }, "la réponse retenue datait d'avant : une relecture de plus l'a corrigée")
        try? await Task.sleep(for: .milliseconds(40))
        #expect(reads() == before + 2, "deux événements pendant la relecture n'en donnent qu'une de plus")
    }

    @Test("demandes-et-automatisations-du-poste/AC-9 : le détail ouvert est celui de la demande ouverte, jamais d'une autre ni rétabli après fermeture ; un 404 le ferme sans échec")
    func openRequestInterleavings() async {
        let poste = PosteServer()
        poste.setRequests([requestJSON("A", "done"), requestJSON("B", "done")])
        poste.setDetail("A", request: requestJSON("A", "done", report: "Compte rendu A"), actions: [actionJSON(1, requestId: "A", rationale: "Action de A")])
        poste.setDetail("B", request: requestJSON("B", "done", report: "Compte rendu B"), actions: [actionJSON(2, requestId: "B", rationale: "Action de B")])
        let transport = GatedTransport()
        transport.inner.respond(poste.handler())
        let server = await connectedGated(transport)
        let workstation = server.workstation
        await workstation.load()
        let detailA = "GET /v1/workstation/requests/A"
        let detailB = "GET /v1/workstation/requests/B"

        // (a) A chargé, puis B retenu : le détail de A ne reste pas affiché.
        await workstation.open(request: "A")
        #expect(workstation.openRequest?.request.id == "A" && workstation.openRequest?.report == "Compte rendu A")
        transport.hold(detailB)
        let openB = Task { await workstation.open(request: "B") }
        #expect(await eventually { transport.heldCount(detailB) == 1 })
        #expect(workstation.openRequestId == "B" && workstation.openRequest == nil)
        transport.release(detailB)
        await openB.value
        #expect(workstation.openRequest?.request.id == "B")

        // (b) A retenu, B répond, A est libéré : B reste.
        transport.hold(detailA)
        let openA = Task { await workstation.open(request: "A") }
        #expect(await eventually { transport.heldCount(detailA) == 1 })
        await workstation.open(request: "B")
        transport.release(detailA)
        await openA.value
        #expect(workstation.openRequestId == "B" && workstation.openRequest?.request.id == "B")

        // (c) relecture dont le détail est retenu, fermeture, libération : rien n'est rétabli.
        transport.hold(detailB)
        let reload = Task { await workstation.refresh() }
        #expect(await eventually { transport.heldCount(detailB) == 1 })
        workstation.closeRequest()
        transport.release(detailB)
        await reload.value
        #expect(workstation.openRequestId == nil && workstation.openRequest == nil)

        // (d) la demande ouverte disparaît : 404, fermée sans échec, la liste est relue.
        await workstation.open(request: "A")
        poste.removeDetail("A")
        poste.setRequests([requestJSON("B", "done")])
        await workstation.refresh()
        #expect(workstation.openRequestId == nil && workstation.openRequest == nil)
        #expect(workstation.failure == nil && workstation.requestsFailure == nil)
        #expect(workstation.requests.map(\.id) == ["B"])

        // Ouvrir une demande inconnue : 404, ni détail ni échec.
        await workstation.open(request: "Z")
        #expect(workstation.openRequestId == nil && workstation.openRequest == nil && workstation.requestsFailure == nil)
    }
}
