// Preuves de S-1 (couche de données du spectateur) : AC-3, AC-5, AC-6 et la part
// MESURÉE de AC-9.
//
// Un critère par test, titré `visionneuse-de-session/AC-<n>` : c'est ce titre que
// /review relit par grep. Les fixtures sont des fichiers de session RÉELS écrits
// sous `NSTemporaryDirectory()` (jamais `~/.omp`, jamais un `.jsonl` du dépôt).

import Foundation
import Testing

@testable import OMPConsole

// MARK: - Extraction des faits essentiels

/// Les faits essentiels extraits du MODÈLE, dans l'ordre du fichier.
private func modelFacts(_ entries: [ConversationEntry]) -> [String] {
    var facts: [String] = []
    for entry in entries {
        switch entry.kind {
        case .user(let turn):
            facts.append("user|\(turn.text)")
        case .assistant(let turn):
            facts.append("assistant|\(turn.text)")
            for call in turn.toolCalls {
                facts.append(
                    "tool|\(call.name)|\(renderJSON(call.arguments ?? .null))|\(askFacts(askSpan(from: call.arguments)))"
                )
            }
        case .toolResult(let turn):
            facts.append(resultFact(callId: turn.callId, text: turn.text, diff: turn.diff))
        case .compaction(let marker):
            facts.append("compaction|\(marker.summary)|\(marker.tokensBefore.map(String.init) ?? "-")")
        case .branchSummary(let marker):
            facts.append("branch|\(marker.summary)|\(marker.fromId)")
        }
    }
    return facts
}

/// Les MÊMES faits essentiels extraits des LIGNES affichables. C'est la
/// confrontation des deux listes qui prouve AC-3 : un fait perdu, dupliqué ou
/// déplacé par l'assemblage fait diverger les deux.
private func rowFacts(_ rows: [SessionRow]) -> [String] {
    var facts: [String] = []
    for row in rows {
        switch row.kind {
        case .user(let content):
            facts.append("user|\(content.text)")
        case .assistant(let content):
            facts.append("assistant|\(content.text)")
        case .toolCall(let content):
            facts.append("tool|\(content.name)|\(content.argumentsJSON)|\(askFacts(content.ask))")
            if let result = content.result {
                facts.append(resultFact(callId: result.callId, text: result.text, diff: result.diff))
            }
        case .toolResult(let content):
            facts.append(resultFact(callId: content.callId, text: content.text, diff: content.diff))
        case .marker(.compaction(let summary, let tokens)):
            facts.append("compaction|\(summary)|\(tokens.map(String.init) ?? "-")")
        case .marker(.branchSummary(let summary, let fromId)):
            facts.append("branch|\(summary)|\(fromId)")
        }
    }
    return facts
}

private func resultFact(callId: String?, text: String, diff: String?) -> String {
    "result|\(callId ?? "-")|\(text)|\(diff ?? "-")"
}

private func askFacts(_ span: AskSpan?) -> String {
    guard let span else { return "-" }
    return span.questions.map { question in
        let options = question.options.map { "\($0.label)/\($0.description ?? "-")" }.joined(separator: ",")
        return "\(question.id):\(question.question):\(options)"
    }.joined(separator: ";")
}

private func kindName(_ row: SessionRow) -> String {
    switch row.kind {
    case .user: "user"
    case .assistant: "assistant"
    case .toolCall: "toolCall"
    case .toolResult: "toolResult"
    case .marker: "marker"
    }
}

// MARK: - Accès typé aux lignes

private func userRow(_ row: SessionRow) -> UserRow? {
    guard case .user(let value) = row.kind else { return nil }
    return value
}

private func assistantRow(_ row: SessionRow) -> AssistantRow? {
    guard case .assistant(let value) = row.kind else { return nil }
    return value
}

private func toolCallRow(_ row: SessionRow) -> ToolCallRow? {
    guard case .toolCall(let value) = row.kind else { return nil }
    return value
}

private func toolResultRow(_ row: SessionRow) -> ToolResultRow? {
    guard case .toolResult(let value) = row.kind else { return nil }
    return value
}

private func markerRow(_ row: SessionRow) -> MarkerRow? {
    guard case .marker(let value) = row.kind else { return nil }
    return value
}

// MARK: - AC-3

@Test("visionneuse-de-session/AC-3 : les faits essentiels sont ceux du modèle, une fois chacun, dans l'ordre")
func rowsCarryTheEssentialFactsInOrder() throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write(viewerReferenceLines())

    let reader = SessionReader(path: fixture.path)
    let delta = reader.read()
    #expect(delta.issue == nil)

    var builder = SessionRowBuilder()
    builder.append(delta.added)
    let rows = builder.rows

    // (1) L'oracle d'AC-3, en deux volets.
    //
    // (a) L'ORDRE EXACT est écrit en clair : c'est l'ordre du fichier, à une seule
    // exception PRÉVUE par S-1 — le résultat d'un appel est porté par la ligne de
    // CET appel (c'est ce qui rend le repli individuel possible), il se lit donc
    // avec lui, et non après le dernier appel du même message.
    #expect(
        rowFacts(rows) == [
            "user|Bonjour, lis le fichier",
            "assistant|je lis le fichier",
            #"tool|read|{"offset":2,"path":"/tmp/a.txt"}|-"#,
            "result|call-1|contenu du fichier|-",
            #"tool|ask|{"questions":[{"header":"Plan","id":"q1","options":[{"label":"A"},{"description":"le second","label":"B"}],"question":"Quel plan ?"}]}|q1:Quel plan ?:A/-,B/le second"#,
            "result|call-9|sortie orpheline|-",
            "compaction|contexte compacté|4200",
            "branch|résumé de branche|root",
        ]
    )
    // (b) Aucun fait manquant ni surnuméraire : l'ENSEMBLE des faits des lignes est
    // celui du modèle — même contenu, même nombre d'occurrences de chacun.
    #expect(rowFacts(rows).sorted() == modelFacts(reader.conversation.entries).sorted())

    // (2) Aucun fait surnuméraire : le nombre de lignes est celui qu'exige le
    // fichier (un message assistant porte ses appels, un résultat apparié ne crée
    // aucune ligne, un résultat orphelin en crée une).
    #expect(rows.map(kindName) == ["user", "assistant", "toolCall", "toolCall", "toolResult", "marker", "marker"])

    let user = try #require(userRow(rows[0]))
    #expect(user.text == "Bonjour, lis le fichier")

    let assistant = try #require(assistantRow(rows[1]))
    #expect(assistant.text == "je lis le fichier")
    #expect(assistant.thinking == "je réfléchis")

    let read = try #require(toolCallRow(rows[2]))
    #expect(read.name == "read")
    #expect(read.target == "/tmp/a.txt")
    #expect(read.argumentsJSON == #"{"offset":2,"path":"/tmp/a.txt"}"#)
    #expect(read.ask == nil)
    #expect(read.result?.text == "contenu du fichier")
    #expect(read.result?.isError == false)

    let ask = try #require(toolCallRow(rows[3]))
    #expect(ask.name == "ask")
    #expect(ask.target == "Quel plan ?")
    #expect(ask.result == nil)
    let question = try #require(ask.ask?.questions.first)
    #expect(question.id == "q1")
    #expect(question.header == "Plan")
    #expect(question.options.map(\.label) == ["A", "B"])
    #expect(question.options.first?.description == nil)
    #expect(question.options.last?.description == "le second")

    let orphan = try #require(toolResultRow(rows[4]))
    #expect(orphan.callId == "call-9")
    #expect(orphan.name == "bash")
    #expect(orphan.text == "sortie orpheline")

    let compaction = try #require(markerRow(rows[5]))
    #expect(compaction == .compaction(summary: "contexte compacté", tokensBefore: 4200))

    let branch = try #require(markerRow(rows[6]))
    #expect(branch == .branchSummary(summary: "résumé de branche", fromId: "root"))

    // (3) Les identités sont ancrées sur l'offset de l'entrée : elles ne dépendent
    // donc pas du nombre de faits déjà lus, et sont stables à vie.
    #expect(rows[1].id == "r\(delta.added[1].offset)")
    #expect(rows[2].id == "\(rows[1].id).c0")
    #expect(rows[3].id == "\(rows[1].id).c1")
    #expect(rows[4].id == "r\(delta.added[3].offset)")
}

// MARK: - AC-5

@Test("visionneuse-de-session/AC-5 : ajout, suppression, contexte et en-tête sont distingués par le contenu")
func diffsAreClassifiedByContent() throws {
    // (1) Trois lignes de MÊME contenu textuel, trois marqueurs : trois teintes.
    let same = diffLines(in: "+même texte\n-même texte\n même texte")
    #expect(same.map(\.tone) == [.added, .removed, .context])
    #expect(same.map(\.text) == ["+même texte", "-même texte", " même texte"])
    #expect(Set(same.map(\.tone)) == [.added, .removed, .context])

    // (2) Les en-têtes ne sont jamais confondus avec une addition ou une
    // suppression, même quand leur premier caractère est `+` ou `-`.
    #expect(
        diffLines(in: "diff --git a/f b/f\n@@ -1 +1 @@\n--- a/f\n+++ b/f\n-a\n+b").map(\.tone)
            == [.section, .section, .section, .section, .removed, .added]
    )

    // (3) Le format RÉEL d'un `details.diff` d'édition d'OMP, classé ligne à ligne
    // par le PREMIER caractère, sans cas particulier.
    #expect(diffLines(in: ViewerLines.editDiff).map(\.tone) == [.context, .removed, .added])
    #expect(diffLines(in: ViewerLines.editDiff).count == 3)

    // (4) Un diff unifié DÉTECTÉ au milieu d'un texte quelconque : texte, diff,
    // texte — les segments sont maximaux et disjoints.
    let mixed = "avant\n@@ -1,2 +1,2 @@\n-a\n+b\n après\nfin"
    let segments = bodySegments(in: mixed)
    #expect(segments.count == 3)
    #expect(segments.first == .text("avant\n"))
    #expect(segments.last == .text("fin"))
    guard case .diff(let block) = segments[1] else {
        Issue.record("le segment du milieu doit être un bloc de diff")
        return
    }
    #expect(block.map(\.tone) == [.section, .removed, .added, .context])
    #expect(block.map(\.text) == ["@@ -1,2 +1,2 @@", "-a", "+b", " après"])

    // (5) Un texte sans aucun bloc reste UN seul texte, verbatim.
    #expect(bodySegments(in: "ligne un\nligne deux\n") == [.text("ligne un\nligne deux\n")])
    // (6) Une tête de diff sans aucun changement n'est pas un diff.
    #expect(bodySegments(in: "--- a\n+++ b") == [.text("--- a\n+++ b")])
    // (7) Une ligne vide TERMINE le bloc : le diff ne mange pas le texte suivant.
    let interrupted = "@@ -1 +1 @@\n-a\n+b\n\nfin"
    let stopped = bodySegments(in: interrupted)
    #expect(stopped.count == 2)
    guard case .diff(let interruptedBlock) = stopped[0] else {
        Issue.record("le premier segment doit être le diff interrompu par la ligne vide")
        return
    }
    #expect(interruptedBlock.count == 3)
    #expect(stopped.last == .text("\nfin"))

    // (8) Un fait portant un diff d'édition le transporte jusque dans sa ligne.
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([
        ViewerLines.header(),
        ViewerLines.assistant(
            id: "e2",
            text: "j'édite",
            calls: [ViewerLines.call(id: "call-1", name: "edit", arguments: ["path": "/tmp/a.txt"])]
        ),
        ViewerLines.toolResult(
            id: "e3",
            callId: "call-1",
            name: "edit",
            body: "1 édition",
            diff: ViewerLines.editDiff
        ),
    ])
    let reader = SessionReader(path: fixture.path)
    var builder = SessionRowBuilder()
    builder.append(reader.read().added)
    let call = try #require(toolCallRow(builder.rows[1]))
    let diff = try #require(call.result?.diff)
    #expect(diffLines(in: diff).map(\.tone) == [.context, .removed, .added])
}

// MARK: - AC-6

@Test("visionneuse-de-session/AC-6 : la question `ask` et ses options sont extraites, et rien d'autre")
func askQuestionsAreExtracted() throws {
    let valid = JSONValue.object([
        "questions": .array([
            .object([
                "id": .string("q1"),
                "question": .string("Quel plan ?"),
                "header": .string("Plan"),
                "options": .array([
                    .object(["label": .string("A")]),
                    .object(["label": .string("B"), "description": .string("le second")]),
                ]),
            ])
        ])
    ])
    let span = try #require(askSpan(from: valid))
    #expect(span.questions.count == 1)
    #expect(span.questions[0].id == "q1")
    #expect(span.questions[0].question == "Quel plan ?")
    #expect(span.questions[0].header == "Plan")
    #expect(span.questions[0].options.map(\.label) == ["A", "B"])
    #expect(span.questions[0].options[1].description == "le second")

    // La cible de l'en-tête d'un appel `ask` est sa première question.
    #expect(primaryArgument(name: "ask", arguments: valid) == "Quel plan ?")

    // Une question sans option reste une question (options vide accepté).
    #expect(
        askSpan(
            from: .object([
                "questions": .array([
                    .object(["id": .string("q1"), "question": .string("Seule ?"), "options": .array([])])
                ])
            ])
        )?.questions.first?.options.isEmpty == true
    )

    // Échec FERMÉ : une seule question malformée suffit à tout refuser.
    let malformed: [JSONValue] = [
        .object(["questions": .array([])]),
        .object(["questions": .string("pas un tableau")]),
        .object(["questions": .array([.object(["question": .string("sans id"), "options": .array([])])])]),
        .object(["questions": .array([.object(["id": .string("q1"), "options": .array([])])])]),
        .object(["questions": .array([.object(["id": .string("q1"), "question": .string("x")])])]),
        .object(["questions": .array([.object(["id": .string("q1"), "question": .string("x"), "options": .array([.object(["description": .string("sans label")])])])])]),
        .object([
            "questions": .array([
                .object(["id": .string("q1"), "question": .string("ok"), "options": .array([])]),
                .object(["id": .number(2), "question": .string("cassée"), "options": .array([])]),
            ])
        ]),
        .string("pas un objet"),
        .null,
    ]
    for value in malformed {
        #expect(askSpan(from: value) == nil)
    }
    #expect(askSpan(from: nil) == nil)

    // Un appel `ask` malformé retombe en appel d'outil ordinaire : aucune question
    // affichée, mais le fait n'est pas perdu pour autant.
    let rows = sessionRows(calls: [
        ToolCall(id: "call-1", name: "ask", arguments: .object(["questions": .array([])]))
    ])
    let call = try #require(toolCallRow(rows[2]))
    #expect(call.ask == nil)
    #expect(call.name == "ask")
    #expect(call.argumentsJSON == #"{"questions":[]}"#)
}

// MARK: - AC-9

@Test("visionneuse-de-session/AC-9 : les octets relus se bornent aux octets neufs")
func readerReportsOnlyNewBytes() throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    let header = ViewerLines.header()
    try fixture.write([header])

    let reader = SessionReader(path: fixture.path)
    let first = reader.read()
    #expect(first.issue == nil)
    #expect(first.bytesRead == header.utf8.count + 1)

    // Aucune nouveauté : AUCUN octet consommé.
    let unchanged = reader.read()
    #expect(unchanged.issue == nil)
    #expect(unchanged.added.isEmpty)
    #expect(unchanged.bytesRead == 0)

    // Un ajout de `k` octets rend exactement `k`.
    let line = ViewerLines.user("Bonjour")
    let appended = line.utf8.count + 1
    try fixture.append([line])
    let second = reader.read()
    #expect(second.added.count == 1)
    #expect(second.bytesRead == appended)

    // Un fait à moitié écrit n'est PAS consommé : le curseur ne recule pas et les
    // octets seront comptés une fois la ligne complète.
    let partial = ViewerLines.user("Suite", id: "e5")
    try fixture.append(partial)
    let incomplete = reader.read()
    #expect(incomplete.added.isEmpty)
    #expect(incomplete.bytesRead == 0)

    try fixture.append("\n")
    let completed = reader.read()
    #expect(completed.added.count == 1)
    #expect(completed.bytesRead == partial.utf8.count + 1)
}

// MARK: - Outillage local

/// Des lignes assemblées pour un tour assistant donné, sans passer par un fichier.
private func sessionRows(calls: [ToolCall]) -> [SessionRow] {
    var builder = SessionRowBuilder()
    builder.append([
        ConversationEntry(index: 1, offset: 0, kind: .user(UserTurn(text: "question"))),
        ConversationEntry(
            index: 2,
            offset: 10,
            kind: .assistant(
                AssistantTurn(text: "réponse", thinking: nil, model: nil, usage: nil, toolCalls: calls)
            )
        ),
    ])
    return builder.rows
}
