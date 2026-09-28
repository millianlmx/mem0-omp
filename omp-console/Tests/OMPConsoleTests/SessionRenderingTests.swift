// Preuves de S-5 : le rendu texte du modèle.
//
// Les fonctions de rendu sont PURES : les assertions portent donc sur des valeurs
// construites à la main — le format est normatif au caractère, et un test qui
// lirait un modèle depuis un fichier pour le vérifier mêlerait deux
// responsabilités. Un dernier test fait le joint avec le lecteur sur un vrai
// fichier temporaire.

import Foundation
import Testing

@testable import OMPConsole

// MARK: - Modèle construit à la main

private func entry(_ index: Int, _ offset: Int, _ kind: ConversationEntry.Kind) -> ConversationEntry {
    ConversationEntry(index: index, offset: offset, kind: kind)
}

private func conversation(_ entries: [ConversationEntry], skipped: [SkippedEntry] = []) -> SessionConversation {
    SessionConversation(
        header: SessionHeader(
            id: "session-1",
            cwd: "/tmp/projet",
            version: 3,
            timestamp: "2026-01-01T00:00:00.000Z",
            parentSession: nil
        ),
        kind: .topLevel,
        entries: entries,
        skipped: skipped
    )
}

private let fullUsage = TokenUsage(
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    totalTokens: 15,
    cost: 1.0
)

/// Les blocs du rendu. Le découpage sur la ligne vide est licite : les fixtures
/// de ce fichier ne mettent aucune ligne vide dans un corps.
private func blocks(of rendered: String) -> [String] {
    rendered.split(separator: "\n\n", omittingEmptySubsequences: true).map { chunk in
        let text = String(chunk)
        return text.hasSuffix("\n") ? text : text + "\n"
    }
}

/// Les têtes de bloc `== <i> …`, c'est-à-dire les entrées de conversation — ni
/// la ligne d'en-tête ni les lignes `== ignored`.
private func entryHeads(in rendered: String) -> [String] {
    rendered.split(separator: "\n").map(String.init).filter { line in
        let fields = line.split(separator: " ")
        return fields.count >= 3 && fields[0] == "==" && fields[1].allSatisfy(\.isNumber)
    }
}

// MARK: - AC-10

@Test("lecteur-de-sessions-omp/AC-10 : chaque entrée apparaît une fois, dans l'ordre, avec ses sous-parties")
func renderingCarriesEveryEntryOnceInOrder() {
    let entries = [
        entry(1, 100, .user(UserTurn(text: "question"))),
        entry(
            2,
            200,
            .assistant(
                AssistantTurn(
                    text: "je lis le fichier",
                    thinking: "je dois vérifier",
                    model: "a/1",
                    usage: fullUsage,
                    toolCalls: [
                        ToolCall(
                            id: "call-7",
                            name: "read",
                            arguments: .object([
                                "path": .string("/tmp/a.txt"),
                                "lines": .array([.number(1), .number(2)]),
                                "flag": .bool(true),
                                "none": .null,
                            ])
                        )
                    ]
                )
            )
        ),
        entry(
            3,
            300,
            .toolResult(
                ToolResultTurn(
                    callId: "call-7",
                    name: "read",
                    text: "contenu du fichier",
                    diff: " 1|a\n-2|b\n+2|c",
                    isError: false
                )
            )
        ),
        entry(4, 400, .compaction(CompactionMarker(summary: "contexte compacté", tokensBefore: 4200))),
        entry(5, 500, .branchSummary(BranchSummaryMarker(summary: "résumé de branche", fromId: "root"))),
        entry(6, 600, .user(UserTurn(text: "après la bascule"))),
    ]
    let rendered = renderConversation(conversation(entries))

    // (a) une tête de bloc par entrée, indices exactement 1…n dans l'ordre.
    let heads = entryHeads(in: rendered)
    #expect(heads.count == entries.count)
    #expect(heads.map { line in line.split(separator: " ")[1] } == ["1", "2", "3", "4", "5", "6"])

    // (b) les sous-parties sont là, et la compaction est entre les deux messages
    // qui l'encadrent — à la même place que dans `entries`.
    #expect(rendered.contains("== 2 assistant offset=200 model=a/1 usage input=10 output=2 cacheRead=3 cacheWrite=0 total=15 cost=1.0"))
    #expect(rendered.contains("-- thinking\nje dois vérifier\n"))
    #expect(rendered.contains("-- text\nje lis le fichier\n"))
    #expect(rendered.contains("-- tool read id=call-7\n"))
    #expect(rendered.contains(#"-- args {"flag":true,"lines":[1,2],"none":null,"path":"/tmp/a.txt"}"#))
    #expect(rendered.contains("== 3 tool-result offset=300 name=read id=call-7 error=false\ncontenu du fichier\n"))
    #expect(rendered.contains("-- diff\n 1|a\n-2|b\n+2|c\n"))
    #expect(rendered.contains("== 4 compaction offset=400 tokensBefore=4200\ncontexte compacté\n"))
    #expect(rendered.contains("== 5 branch-summary offset=500 from=root\nrésumé de branche\n"))
    #expect(heads[3].hasPrefix("== 4 compaction"))
    #expect(heads[2].hasPrefix("== 3 tool-result"))
    #expect(heads[4].hasPrefix("== 5 branch-summary"))
    #expect(heads[5].hasPrefix("== 6 user offset=600"))

    // (c) `renderEntry` est autonome : le bloc d'une entrée dans le rendu du
    // modèle est exactement ce que `renderEntry` produit seul.
    let chunks = blocks(of: rendered)
    #expect(chunks.count == entries.count + 1)
    #expect(chunks[0].hasPrefix("== session id=session-1 cwd=/tmp/projet version=3 kind=top-level parent=-\n"))
    for (position, item) in entries.enumerated() {
        #expect(chunks[position + 1] == renderEntry(item))
    }
}

@Test("lecteur-de-sessions-omp : le rendu place les entrées ignorées après les blocs de conversation")
func ignoredEntriesAreRenderedAfterTheConversation() {
    let rendered = renderConversation(
        conversation(
            [entry(1, 0, .user(UserTurn(text: "question")))],
            skipped: [
                SkippedEntry(offset: 40, reason: .invalidJSON),
                SkippedEntry(offset: 90, reason: .unknownType),
                SkippedEntry(offset: 140, reason: .malformed),
            ]
        )
    )
    // Le rendu entier, caractère pour caractère : une ligne d'en-tête, un bloc
    // par entrée, une ligne par entrée ignorée APRÈS les blocs, une ligne vide
    // entre deux blocs, un saut de ligne final.
    let expected =
        "== session id=session-1 cwd=/tmp/projet version=3 kind=top-level parent=-\n"
        + "\n"
        + "== 1 user offset=0\nquestion\n"
        + "\n"
        + "== ignored offset=40 reason=invalid-json\n"
        + "\n"
        + "== ignored offset=90 reason=unknown-type\n"
        + "\n"
        + "== ignored offset=140 reason=malformed\n"
    #expect(rendered == expected)
    #expect(entryHeads(in: rendered).count == 1)
}

// MARK: - Cas limites de S-5

@Test("lecteur-de-sessions-omp : cas limite — un modèle vide ne rend que sa ligne d'en-tête")
func emptyConversationRendersOnlyItsHeader() {
    let empty = SessionConversation(header: nil, kind: nil, entries: [], skipped: [])
    #expect(renderConversation(empty) == "== session id=? cwd=? version=? kind=? parent=-\n")
}

@Test("lecteur-de-sessions-omp : cas limite — un modèle sans en-tête écrit ? partout")
func conversationWithoutHeaderUsesQuestionMarks() {
    let rendered = renderConversation(
        SessionConversation(header: nil, kind: nil, entries: [entry(1, 0, .user(UserTurn(text: "x")))], skipped: [])
    )
    #expect(rendered.hasPrefix("== session id=? cwd=? version=? kind=? parent=-\n\n"))
}

@Test("lecteur-de-sessions-omp : cas limite — un tour assistant nu tient sur sa ligne de bloc")
func bareAssistantIsASingleLine() {
    let bare = entry(
        1,
        0,
        .assistant(AssistantTurn(text: "", thinking: nil, model: nil, usage: nil, toolCalls: []))
    )
    #expect(renderEntry(bare) == "== 1 assistant offset=0 model=? usage=?\n")
}

@Test("lecteur-de-sessions-omp : cas limite — pas de bloc diff sans diff, pas d'args sans arguments")
func optionalSubPartsAreOmitted() {
    let result = entry(
        1,
        0,
        .toolResult(ToolResultTurn(callId: nil, name: nil, text: "", diff: nil, isError: true))
    )
    #expect(renderEntry(result) == "== 1 tool-result offset=0 name=? id=? error=true\n")

    let call = entry(
        2,
        10,
        .assistant(
            AssistantTurn(
                text: "",
                thinking: nil,
                model: "a/1",
                usage: TokenUsage(input: 1, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1, cost: nil),
                toolCalls: [ToolCall(id: "c1", name: "bash", arguments: nil)]
            )
        )
    )
    #expect(renderEntry(call) == "== 2 assistant offset=10 model=a/1 usage input=1 output=0 cacheRead=0 cacheWrite=0 total=1 cost=?\n-- tool bash id=c1\n-- args\n")
}

@Test("lecteur-de-sessions-omp : cas limite — renderJSON trie les clés et reste compact et déterministe")
func renderJSONIsCompactSortedAndDeterministic() {
    let value = JSONValue.object([
        "b": .number(1),
        "a": .array([.string("x"), .null, .bool(true), .number(2.5)]),
        "c": .object(["z": .string("guillemet \" et antislash \\"), "y": .number(-3)]),
    ])
    #expect(
        renderJSON(value)
            == #"{"a":["x",null,true,2.5],"b":1,"c":{"y":-3,"z":"guillemet \" et antislash \\"}}"#
    )
    // Deux appels rendent exactement la même chose, quel que soit l'ordre
    // d'insertion — `JSONSerialization` n'en garantit aucun (Doc-4).
    let rebuilt = JSONValue.object([
        "c": .object(["y": .number(-3), "z": .string("guillemet \" et antislash \\")]),
        "a": .array([.string("x"), .null, .bool(true), .number(2.5)]),
        "b": .number(1),
    ])
    #expect(renderJSON(rebuilt) == renderJSON(value))
    #expect(renderJSON(.object([:])) == "{}")
    #expect(renderJSON(.array([])) == "[]")
}

// MARK: - Joint avec le lecteur

@Test("lecteur-de-sessions-omp : le rendu d'une session lue porte les offsets réels du fichier")
func renderingOfAReadSessionUsesRealOffsets() throws {
    let header = #"{"type":"session","version":3,"id":"s1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/projet"}"#
    let user = #"{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"bonjour"}]}}"#
    let compaction = #"{"type":"compaction","id":"e2","parentId":"e1","timestamp":"2026-01-01T00:00:00.000Z","summary":"compaction","firstKeptEntryId":"e1","tokensBefore":12}"#

    let directory = FileManager.default.temporaryDirectory
        .appendingPathComponent("rendu-session-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("session.jsonl")
    try Data(([header, user, compaction].joined(separator: "\n") + "\n").utf8).write(to: file)

    let reader = SessionReader(path: file.path)
    #expect(reader.read().issue == nil)

    let rendered = renderConversation(reader.conversation)
    let userOffset = header.utf8.count + 1
    let compactionOffset = userOffset + user.utf8.count + 1
    #expect(rendered.contains("== 1 user offset=\(userOffset)\nbonjour\n"))
    #expect(rendered.contains("== 2 compaction offset=\(compactionOffset) tokensBefore=12\ncompaction\n"))
    #expect(entryHeads(in: rendered).count == reader.conversation.entries.count)
}
