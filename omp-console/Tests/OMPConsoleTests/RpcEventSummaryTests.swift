// Preuves de l'humanisation des trames de Session OMP (S-18 R8 de
// omp-console-redesign) : chaque trame se lit en une ligne française, le détail
// tient en 80 caractères, une trame illisible le dit, l'activité est bornée et
// la plus récente en haut.

import Testing
@testable import OMPConsole

private func inbound(_ id: Int, _ text: String) -> TranscriptLine {
    TranscriptLine(id: id, kind: .inbound, text: text)
}

@Test("omp-console-redesign/S-18 : les trames de Session OMP se lisent en français")
func rpcFramesReadInFrench() {
    let response = RpcEventSummary.summary(inbound(1, #"{"type":"response","id":"app-1","command":"get_state","success":true,"data":{}}"#))
    #expect(response.title == "Réponse · get_state")
    #expect(response.detail == "")
    #expect(response.id == 1)

    let failed = RpcEventSummary.summary(inbound(2, #"{"type":"response","command":"prompt","success":false,"error":{"message":"modèle indisponible"}}"#))
    #expect(failed.title == "Échec · prompt")
    #expect(failed.detail == "modèle indisponible")

    let agent = RpcEventSummary.summary(inbound(3, #"{"type":"message_update","message":{"role":"assistant","content":[]},"assistantMessageEvent":{"type":"text_delta","delta":"Je lis\nle fichier"}}"#))
    #expect(agent.title == "Message de l'agent")
    // Le détail tient sur UNE ligne.
    #expect(agent.detail == "Je lis le fichier")

    // L'aperçu d'un message est du texte brut : aucune marque Markdown.
    let styled = RpcEventSummary.summary(inbound(11, #"{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Les plugins **mem0** et `omp-console`"}]}}"#))
    #expect(styled.detail == "Les plugins mem0 et omp-console")

    let call = RpcEventSummary.summary(inbound(4, #"{"type":"tool_execution_start","toolCallId":"c1","toolName":"read","args":{"path":"Sources/App.swift"}}"#))
    #expect(call.title == "Appel d'outil · read")
    #expect(call.detail == "Sources/App.swift")
    #expect(call.symbol == ToolVerb.symbol("read"))

    let toolFailed = RpcEventSummary.summary(inbound(5, #"{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{},"isError":true}"#))
    #expect(toolFailed.title == "Échec d'outil · bash")

    let question = RpcEventSummary.summary(inbound(6, #"{"type":"extension_ui_request","id":"q1","method":"select","title":"Quelle branche ?","options":["a","b"]}"#))
    #expect(question.title == "Question de l'hôte")
    #expect(question.detail == "Quelle branche ?")

    let sent = RpcEventSummary.summary(TranscriptLine(id: 7, kind: .outbound, text: #"→ {"id":"app-2","message":"Bonjour","type":"prompt"}"#))
    #expect(sent.title == "Message envoyé")
    #expect(sent.detail == "Bonjour")

    let answer = RpcEventSummary.summary(TranscriptLine(id: 8, kind: .outbound, text: #"→ {"cancelled":true,"id":"q1","type":"extension_ui_response"}"#))
    #expect(answer.title == "Réponse à l'hôte")
    #expect(answer.detail == "annulé")

    let localError = RpcEventSummary.summary(TranscriptLine(id: 9, kind: .clientError, text: "! omp ne répond plus"))
    #expect(localError.title == "Erreur locale")
    #expect(localError.detail == "omp ne répond plus")

    // Un type que l'app ne connaît pas garde son nom.
    #expect(RpcEventSummary.summary(inbound(10, #"{"type":"futur_evenement"}"#)).title == "Événement · futur_evenement")
}

@Test("omp-console-redesign/S-18 : une trame illisible le dit, une trame tronquée garde son type")
func unreadableFrameSaysSo() {
    let garbage = RpcEventSummary.summary(inbound(1, "pas du json {"))
    #expect(garbage.title == "Trame illisible")
    #expect(garbage.detail == "pas du json {")

    // JSON valide mais sans `type` : illisible aussi.
    #expect(RpcEventSummary.summary(inbound(2, #"{"id":"x"}"#)).title == "Trame illisible")

    // Le host tronque une trame au-delà de 4 096 caractères : son début dit encore
    // ce qu'elle était.
    let truncated = #"{"type":"tool_execution_end","toolCallId":"c9","toolName":"grep","result":{"content":"aaaa"# + "…[12000 octets tronqués]"
    let line = RpcEventSummary.summary(inbound(3, truncated))
    #expect(line.title == "Outil terminé · grep")
    #expect(line.detail == SessionConsoleText.Frame.truncated)
}

@Test("omp-console-redesign/S-18 : le détail d'une trame tient en 80 caractères")
func frameDetailIsClipped() {
    let long = String(repeating: "mot ", count: 60)
    let line = RpcEventSummary.summary(inbound(1, #"{"type":"extension_ui_request","id":"n","method":"notify","message":""# + long + #""}"#))
    #expect(line.title == "Notification de l'hôte")
    #expect(line.detail.count == RpcEventSummary.detailLimit)
    #expect(line.detail.hasSuffix("…"))
    #expect(line.detail.hasPrefix("mot mot"))
}

@Test("omp-console-redesign/S-18 : l'activité montre les 200 trames les plus récentes, la plus récente en haut")
func activityIsRecentFirstAndBounded() {
    let lines = (1...250).map { inbound($0, #"{"type":"turn_start"}"#) }
    let activity = RpcEventSummary.activity(lines)
    #expect(activity.count == 200)
    #expect(activity.first?.id == 250)
    #expect(activity.last?.id == 51)
}

@MainActor
@Test("omp-console-redesign/S-18 : le cache de l'activité rend les mêmes lignes que le calcul direct")
func activityCacheMatchesDirectSummary() {
    let cache = RpcActivityCache()
    var lines = (1...5).map { inbound($0, #"{"type":"agent_start"}"#) }
    #expect(cache.activity(lines) == RpcEventSummary.activity(lines))
    // Une trame neuve arrive : elle est en tête, les anciennes suivent.
    lines.append(inbound(6, #"{"type":"agent_end"}"#))
    #expect(cache.activity(lines) == RpcEventSummary.activity(lines))
    // La fenêtre glisse au-delà de la limite : la plus ancienne en sort.
    lines += (7...12).map { inbound($0, #"{"type":"turn_end"}"#) }
    let windowed = cache.activity(lines, limit: 4)
    #expect(windowed.map(\.id) == [12, 11, 10, 9])
}
