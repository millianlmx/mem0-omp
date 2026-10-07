// Preuves de S-1 à S-4 : le modèle de conversation et la lecture incrémentale.
//
// Chaque critère a SON test, titré `lecteur-de-sessions-omp/AC-<n>` : c'est ce
// titre que /review relit par grep. Les fixtures sont ÉCRITES par les tests dans
// un répertoire temporaire — jamais une transcription de session réelle, jamais
// un chemin du dépôt ni de `~/.omp` : le dépôt est public (S-6).

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

// MARK: - Fabrique de lignes

/// Les lignes d'une session synthétique, construites en JSON littéral.
private enum Lines {
    static let timestamp = "2026-01-01T00:00:00.000Z"

    static let usage =
        #"{"input":10,"output":2,"cacheRead":3,"cacheWrite":0,"totalTokens":15,"cost":{"input":0.1,"output":0.2,"cacheRead":0.3,"cacheWrite":0.4,"total":1.0}}"#

    /// Un champ `"clé":"valeur"`.
    ///
    /// Les champs passent par ces deux helpers plutôt que par des chaînes brutes
    /// Swift : dans `#"…"#`, un guillemet fermant collé au délimiteur est avalé
    /// (`#"…"#` rend la chaîne SANS son guillemet) — piège mesuré à l'écriture de
    /// ces fixtures, qui produisait un JSON invalide.
    private static func text(_ key: String, _ value: String) -> String { "\"\(key)\":\"\(value)\"" }

    /// Un champ dont la valeur est un JSON déjà écrit (nombre, objet, tableau).
    private static func raw(_ key: String, _ value: String) -> String { "\"\(key)\":\(value)" }

    private static func block(_ type: String, _ key: String, _ value: String) -> String {
        "{" + [text("type", type), text(key, value)].joined(separator: ",") + "}"
    }

    /// Une entrée `message` : son enveloppe, puis l'objet `message` donné par ses
    /// champs. `parentIdJSON` est le JSON du parent — `null` pour un premier
    /// message, une chaîne sinon.
    private static func messageEntry(
        id: String,
        parentIdJSON: String = "\"e0\"",
        _ messageFields: [String]
    ) -> String {
        let envelope = [
            text("type", "message"), text("id", id),
            raw("parentId", parentIdJSON), text("timestamp", timestamp),
        ]
        let message = "{" + messageFields.joined(separator: ",") + "}"
        return "{" + envelope.joined(separator: ",") + "," + raw("message", message) + "}"
    }

    static func header(
        id: String = "session-1",
        cwd: String = "/tmp/projet",
        version: Int? = 3,
        parent: String? = nil
    ) -> String {
        var fields = [text("type", "session"), text("id", id), text("timestamp", timestamp), text("cwd", cwd)]
        if let version { fields.append(raw("version", String(version))) }
        if let parent { fields.append(text("parentSession", parent)) }
        return "{" + fields.joined(separator: ",") + "}"
    }

    /// Le créneau de titre en tête des fichiers courants : 255 octets de JSON plus
    /// un saut de ligne, soit 256 octets (Doc-1). Le lecteur doit l'ignorer sans le
    /// confondre avec l'en-tête, qui suit en ligne 2.
    static func titleSlot(_ title: String = "") -> String {
        let head =
            "{" + [text("type", "title"), raw("v", "1"), text("title", title), text("updatedAt", timestamp)]
            .joined(separator: ",") + ",\"pad\":\""
        let tail = "\"}"
        return head + String(repeating: " ", count: max(0, 255 - head.utf8.count - tail.utf8.count)) + tail
    }

    static func user(_ body: String, id: String = "u1") -> String {
        messageEntry(
            id: id,
            parentIdJSON: "null",
            [
                text("role", "user"),
                raw("content", "[" + block("text", "text", body) + "]"),
            ]
        )
    }

    static func assistant(
        id: String = "a1",
        model: String? = "a/1",
        usageJSON: String? = usage,
        content: String
    ) -> String {
        var fields = [text("role", "assistant")]
        if let model { fields.append(text("model", model)) }
        if let usageJSON { fields.append(raw("usage", usageJSON)) }
        fields.append(raw("content", content))
        return messageEntry(id: id, fields)
    }

    static func toolResult(
        id: String = "r1",
        callId: String = "call-1",
        name: String = "read",
        body: String = "contenu",
        detailsJSON: String? = nil,
        isError: String? = "false"
    ) -> String {
        var fields = [
            text("role", "toolResult"), text("toolCallId", callId), text("toolName", name),
            raw("content", "[" + block("text", "text", body) + "]"),
        ]
        if let isError { fields.append(raw("isError", isError)) }
        if let detailsJSON { fields.append(raw("details", detailsJSON)) }
        return messageEntry(id: id, fields)
    }

    static func compaction(id: String = "c1", summary: String = "contexte compacté", tokensBefore: Int? = 4200) -> String {
        var fields = [
            text("type", "compaction"), text("id", id), text("parentId", "e0"),
            text("timestamp", timestamp), text("summary", summary), text("firstKeptEntryId", "e1"),
        ]
        if let tokensBefore { fields.append(raw("tokensBefore", String(tokensBefore))) }
        return "{" + fields.joined(separator: ",") + "}"
    }

    static func branchSummary(id: String = "b1", fromId: String = "root", summary: String = "résumé de branche") -> String {
        "{"
            + [
                text("type", "branch_summary"), text("id", id), text("parentId", "e0"),
                text("timestamp", timestamp), text("fromId", fromId), text("summary", summary),
            ].joined(separator: ",")
            + "}"
    }
}

// MARK: - Fixture temporaire

/// Un fichier de session écrit par le test lui-même. `content` permet d'écrire
/// des OCTETS bruts (une ligne coupée au milieu d'un caractère multi-octets), ce
/// que `lines` ne peut pas exprimer.
private struct SessionFixture {
    let directory: URL
    let file: URL
    let lines: [String]
    let lineStarts: [Int]

    init(lines: [String], content: Data? = nil) throws {
        self.lines = lines
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("lecteur-sessions-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appendingPathComponent("session.jsonl")

        var starts: [Int] = []
        var offset = 0
        for line in lines {
            starts.append(offset)
            offset += line.utf8.count + 1
        }
        lineStarts = starts

        try (content ?? Data((lines.joined(separator: "\n") + "\n").utf8)).write(to: file, options: .atomic)
    }

    var path: String { file.path }

    var size: Int {
        let attributes = try? FileManager.default.attributesOfItem(atPath: path)
        return (attributes?[.size] as? NSNumber)?.intValue ?? 0
    }

    /// Premier octet de la ligne `index` (0-based dans `lines`).
    func offset(_ index: Int) -> Int { lineStarts[index] }

    func append(_ data: Data) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: handle.seekToEnd())
        try handle.write(contentsOf: data)
    }

    func append(_ text: String) throws { try append(Data(text.utf8)) }

    /// Réécriture EN PLACE (inode conservé) : c'est ce que la taille révèle.
    func rewriteInPlace(_ lines: [String]) throws {
        try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: file)
    }

    /// Remplacement par `rename` : l'inode change au même chemin.
    func replaceByRename(_ lines: [String]) throws {
        let replacement = directory.appendingPathComponent("remplacement.jsonl")
        try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: replacement, options: .atomic)
        try FileManager.default.removeItem(at: file)
        try FileManager.default.moveItem(at: replacement, to: file)
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }
}

private func withFixture(_ lines: [String], _ body: (SessionFixture) throws -> Void) throws {
    let fixture = try SessionFixture(lines: lines)
    defer { fixture.remove() }
    try body(fixture)
}

// MARK: - AC-1 : le modèle, dans l'ordre du fichier

@Test("lecteur-de-sessions-omp/AC-1 : messages, appel d'outil, résultat et compaction dans l'ordre du fichier")
func conversationFollowsFileOrder() throws {
    // L'AC-1 dit « exactement 5 éléments » avec `.compaction` en index 5 : le
    // même tour assistant porte donc ses pensées ET son appel d'outil.
    let lines = [
        Lines.header(),
        Lines.user("Bonjour", id: "e1"),
        Lines.assistant(
            id: "e2",
            model: "a/1",
            content: #"[{"type":"thinking","thinking":"je réfléchis"},{"type":"text","text":"je lis"},{"type":"toolCall","id":"call-1","name":"read","arguments":{"path":"/tmp/a.txt","offset":2}}]"#
        ),
        Lines.toolResult(id: "e3", detailsJSON: #"{"diff":" 1|a\n-2|b\n+2|c"}"#),
        Lines.user("suite", id: "e4"),
        Lines.compaction(id: "e5", summary: "contexte compacté", tokensBefore: 4200),
    ]

    try withFixture(lines) { fixture in
        let reader = SessionReader(path: fixture.path)
        let delta = reader.read()
        let entries = reader.conversation.entries

        #expect(delta.issue == nil)
        #expect(entries.count == 5)
        #expect(entries.map(\.index) == [1, 2, 3, 4, 5])
        // L'offset est celui de la LIGNE, pas du message : il suit l'ordre du
        // fichier au byte près.
        #expect(entries.map(\.offset) == (1...5).map(fixture.offset))

        #expect(
            entries[0].kind
                == .user(UserTurn(text: "Bonjour"))
        )
        #expect(
            entries[1].kind
                == .assistant(
                    AssistantTurn(
                        text: "je lis",
                        thinking: "je réfléchis",
                        model: "a/1",
                        usage: TokenUsage(
                            input: 10,
                            output: 2,
                            cacheRead: 3,
                            cacheWrite: 0,
                            totalTokens: 15,
                            cost: 1.0
                        ),
                        toolCalls: [
                            ToolCall(
                                id: "call-1",
                                name: "read",
                                arguments: .object([
                                    "path": .string("/tmp/a.txt"),
                                    "offset": .number(2),
                                ])
                            )
                        ]
                    )
                )
        )
        #expect(
            entries[2].kind
                == .toolResult(
                    ToolResultTurn(
                        callId: "call-1",
                        name: "read",
                        text: "contenu",
                        diff: " 1|a\n-2|b\n+2|c",
                        isError: false
                    )
                )
        )
        #expect(
            entries[3].kind
                == .user(UserTurn(text: "suite"))
        )
        #expect(
            entries[4].kind
                == .compaction(CompactionMarker(summary: "contexte compacté", tokensBefore: 4200))
        )
        // L'appel et son résultat se répondent par l'id.
        guard case .toolResult(let result) = entries[2].kind,
            case .assistant(let turn) = entries[1].kind
        else {
            Issue.record("les entrées 2 et 3 doivent être un tour assistant et son résultat")
            return
        }
        #expect(result.callId == turn.toolCalls.first?.id)
    }
}

// MARK: - AC-2 : modèle et usage portés par le message

@Test("lecteur-de-sessions-omp/AC-2 : chaque réponse porte le modèle en vigueur, jamais le dernier du fichier")
func modelComesFromTheMessageNotFromModelChanges() throws {
    let lines = [
        Lines.header(),
        #"{"type":"model_change","id":"m1","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","model":"a/1"}"#,
        Lines.assistant(id: "a1", model: "a/1", usageJSON: #"{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"total":0.01}}"#, content: #"[{"type":"text","text":"premier"}]"#),
        Lines.assistant(id: "a2", model: "a/1", usageJSON: #"{"input":2,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":4,"cost":{"total":0.02}}"#, content: #"[{"type":"text","text":"deuxième"}]"#),
        #"{"type":"model_change","id":"m2","parentId":"m1","timestamp":"2026-01-01T00:00:00.000Z","model":"b/2"}"#,
        Lines.assistant(id: "a3", model: "b/2", usageJSON: #"{"input":3,"output":3,"cacheRead":0,"cacheWrite":0,"totalTokens":6,"cost":{"total":0.03}}"#, content: #"[{"type":"text","text":"troisième"}]"#),
    ]

    try withFixture(lines) { fixture in
        let reader = SessionReader(path: fixture.path)
        #expect(reader.read().issue == nil)
        let entries = reader.conversation.entries

        #expect(entries.count == 3)
        #expect(entries.map { turn(of: $0)?.model } == ["a/1", "a/1", "b/2"])
        #expect(entries.map { turn(of: $0)?.usage?.input } == [1, 2, 3])
        #expect(entries.map { turn(of: $0)?.usage?.cost } == [0.01, 0.02, 0.03])
        // Les entrées `model_change` ne sont pas des entrées de conversation.
        #expect(entries.map { turn(of: $0)?.text } == ["premier", "deuxième", "troisième"])
    }
}

/// Le tour assistant d'une entrée, ou `nil` pour les autres variantes.
private func turn(of entry: ConversationEntry) -> AssistantTurn? {
    guard case .assistant(let turn) = entry.kind else { return nil }
    return turn
}

// MARK: - AC-3 : les entrées de structure sont ignorées

@Test("lecteur-de-sessions-omp/AC-3 : les entrées de structure hors périmètre n'apparaissent nulle part")
func structureEntriesStayOutOfTheModel() throws {
    let lines = [
        Lines.titleSlot("TITRE-INTERDIT"),
        Lines.header(),
        #"{"type":"thinking_level_change","id":"s2","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","level":"high"}"#,
        #"{"type":"session_init","id":"s3","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","systemPrompt":"PROMPT-INTERDIT"}"#,
        #"{"type":"label","id":"s4","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","label":"ETIQUETTE-INTERDITE"}"#,
        Lines.user("question", id: "e1"),
        #"{"type":"model_change","id":"s5","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","model":"a/1"}"#,
        #"{"type":"model_usage","id":"s6","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","usage":{"input":9}}"#,
        #"{"type":"custom","id":"s7","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","customType":"tool_execution_start","data":{"marque":"PERSONNALISE-INTERDIT"}}"#,
        #"{"type":"custom_message","id":"s8","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","message":{"role":"developer","content":"DEVELOPPEUR-INTERDIT"}}"#,
        Lines.assistant(id: "e2", content: #"[{"type":"text","text":"réponse"}]"#),
        #"{"type":"title_change","id":"s9","parentId":null,"timestamp":"2026-01-01T00:00:00.000Z","title":"TITRE-CHANGE-INTERDIT"}"#,
    ]

    try withFixture(lines) { fixture in
        let reader = SessionReader(path: fixture.path)
        #expect(reader.read().issue == nil)
        let conversation = reader.conversation

        #expect(conversation.entries.count == 2)
        #expect(conversation.entries.map(\.index) == [1, 2])
        #expect(conversation.entries[0].kind == .user(UserTurn(text: "question")))
        // Reconnues hors périmètre : ni entrées, ni ignorées.
        #expect(conversation.skipped.isEmpty)

        let rendered = renderConversation(conversation)
        for sentinel in [
            "TITRE-INTERDIT", "PROMPT-INTERDIT", "ETIQUETTE-INTERDITE",
            "PERSONNALISE-INTERDIT", "DEVELOPPEUR-INTERDIT", "TITRE-CHANGE-INTERDIT",
        ] {
            #expect(!rendered.contains(sentinel), "le rendu porte \(sentinel)")
        }
    }
}

// MARK: - AC-4 : le delta ne rend que ce qui est nouveau

@Test("lecteur-de-sessions-omp/AC-4 : un second read ne rend que les entrées ajoutées, chacune une seule fois")
func incrementalReadOnlyReturnsNewEntries() throws {
    // Toutes les lignes sont décrites dès le départ (les offsets en dépendent),
    // mais seules les quatre premières sont écrites.
    let lines = [
        Lines.header(),
        Lines.user("premier", id: "e1"),
        Lines.user("deuxième", id: "e2"),
        Lines.user("troisième", id: "e3"),
        Lines.user("quatrième", id: "e4"),
        Lines.user("cinquième", id: "e5"),
    ]
    let fixture = try SessionFixture(
        lines: lines,
        content: Data((lines[0...3].joined(separator: "\n") + "\n").utf8)
    )
    defer { fixture.remove() }

    let reader = SessionReader(path: fixture.path)
    let first = reader.read()
    #expect(first.added.count == 3)
    #expect(first.issue == nil)

    try fixture.append(lines[4...].joined(separator: "\n") + "\n")

    let second = reader.read()
    #expect(second.issue == nil)
    #expect(second.added.map(\.index) == [4, 5])
    #expect(second.added.map(\.offset) == [fixture.offset(4), fixture.offset(5)])

    // Sur l'ensemble des appels, chaque entrée du fichier est apparue
    // exactement une fois, aux mêmes offsets que le modèle.
    let delivered = (first.added + second.added).map(\.offset)
    #expect(delivered == reader.conversation.entries.map(\.offset))
    #expect(Set(delivered).count == delivered.count)
    #expect(delivered.count == 5)
}

// MARK: - AC-5 : une ligne écrite en deux temps

@Test("lecteur-de-sessions-omp/AC-5 : une ligne écrite en deux temps n'est rendue qu'entière, une seule fois")
func partiallyWrittenLineIsNotRendered() throws {
    let lines = [
        Lines.header(),
        Lines.user("complet", id: "e1"),
        Lines.user("écrit en deux temps", id: "e2"),
    ]
    let complete = [UInt8](lines[2].utf8)
    // Coupure au MILIEU du « é » : un lecteur qui décoderait avant de découper
    // sur 0x0A verrait un caractère de remplacement au lieu d'une frontière.
    let acute = complete.firstIndex(of: 0xC3)!
    let prefix = Data((lines[0] + "\n" + lines[1] + "\n").utf8) + Data(complete[...acute])
    let rest = Data(complete[(acute + 1)...]) + Data("\n".utf8)

    let fixture = try SessionFixture(lines: lines, content: prefix)
    defer { fixture.remove() }

    let reader = SessionReader(path: fixture.path)
    let between = reader.read()
    #expect(between.issue == nil)
    #expect(between.added.count == 1)
    #expect(reader.conversation.entries.count == 1)
    #expect(reader.conversation.entries[0].kind == .user(UserTurn(text: "complet")))

    try fixture.append(rest)

    let after = reader.read()
    #expect(after.issue == nil)
    #expect(after.added.count == 1)
    #expect(after.added[0].offset == fixture.offset(2))
    #expect(after.added[0].kind == .user(UserTurn(text: "écrit en deux temps")))
    #expect(reader.conversation.entries.count == 2)
    #expect(reader.conversation.entries.map(\.index) == [1, 2])
}

// MARK: - AC-6 : lignes ignorées tracées

@Test("lecteur-de-sessions-omp/AC-6 : les lignes illisibles ou inconnues sont sautées, tracées et rendues")
func skippedLinesAreTracedWithTheirOffset() throws {
    let lines = [
        Lines.header(),
        Lines.user("avant", id: "e1"),
        #"{"type":"message","#,
        #"{"type":"quantum_teleport","id":"x"}"#,
        Lines.user("après", id: "e2"),
    ]

    try withFixture(lines) { fixture in
        let reader = SessionReader(path: fixture.path)
        let delta = reader.read()
        let conversation = reader.conversation

        #expect(delta.issue == nil)
        // Toutes les entrées valides sont rendues, et la lecture continue après
        // la ligne illisible.
        #expect(conversation.entries.count == 2)
        #expect(conversation.entries.map(\.index) == [1, 2])
        #expect(conversation.entries[0].kind == .user(UserTurn(text: "avant")))
        #expect(conversation.entries[1].kind == .user(UserTurn(text: "après")))

        #expect(conversation.skipped.count == 2)
        #expect(
            conversation.skipped
                == [
                    SkippedEntry(offset: fixture.offset(2), reason: .invalidJSON),
                    SkippedEntry(offset: fixture.offset(3), reason: .unknownType),
                ]
        )
        #expect(delta.skipped == conversation.skipped)

        let rendered = renderConversation(conversation)
        #expect(rendered.contains("== ignored offset=\(fixture.offset(2)) reason=invalid-json"))
        #expect(rendered.contains("== ignored offset=\(fixture.offset(3)) reason=unknown-type"))
    }
}

// MARK: - AC-7 : troncature et remplacement sont signalés

@Test("lecteur-de-sessions-omp/AC-7 : un fichier tronqué ou remplacé est signalé, jamais rendu")
func truncationAndReplacementAreDistinctIssues() throws {
    try withFixture([
        Lines.header(),
        Lines.user("premier", id: "e1"),
        Lines.user("deuxième", id: "e2"),
    ]) { fixture in
        let reader = SessionReader(path: fixture.path)
        #expect(reader.read().added.count == 2)
        let reference = reader.conversation.entries
        let originalSize = fixture.size

        // (a) réécriture en place, plus courte.
        try fixture.rewriteInPlace([Lines.header()])
        let shorterSize = fixture.size
        #expect(shorterSize < originalSize)
        let truncation = reader.read()
        #expect(truncation.issue == .truncated(previousBytes: originalSize, currentBytes: shorterSize))
        #expect(truncation.added.isEmpty)
        #expect(truncation.skipped.isEmpty)
        #expect(reader.conversation.entries == reference)

        // Le fichier reste incohérent : le même incident est rendu à nouveau, sans
        // consommation d'octets.
        #expect(reader.read().issue == .truncated(previousBytes: originalSize, currentBytes: shorterSize))

        // (b) remplacement par `rename`, d'un contenu PLUS LONG : l'identité est
        // testée avant la taille.
        try fixture.replaceByRename([
            Lines.header(),
            Lines.user("contenu du remplaçant, plus long que l'original", id: "x1"),
            Lines.user("et une ligne de plus", id: "x2"),
            Lines.user("et encore une", id: "x3"),
        ])
        #expect(fixture.size > originalSize)
        let replacement = reader.read()
        #expect(replacement.issue == .replaced)
        #expect(replacement.added.isEmpty)
        #expect(replacement.skipped.isEmpty)
        // Le modèle reste celui de la dernière lecture cohérente : aucun texte du
        // nouveau fichier n'y entre.
        #expect(reader.conversation.entries == reference)
        #expect(reader.conversation.entries.count == 2)
    }
}

// MARK: - AC-8 : identité de session

@Test("lecteur-de-sessions-omp/AC-8 : une session de sous-agent nomme son parent, une session de premier niveau le dit")
func sessionKindComesFromTheHeader() throws {
    let parentPath = "/Users/millian/.omp/agent/sessions/-x/2026-01-01T00-00-00-000Z_abc.jsonl"
    try withFixture([Lines.header(parent: parentPath), Lines.user("bonjour")]) { fixture in
        let reader = SessionReader(path: fixture.path)
        #expect(reader.read().issue == nil)
        #expect(reader.conversation.kind == .subagent(parentSession: parentPath))
        #expect(reader.conversation.header?.parentSession == parentPath)
    }

    try withFixture([Lines.header(), Lines.user("bonjour")]) { fixture in
        let reader = SessionReader(path: fixture.path)
        #expect(reader.read().issue == nil)
        #expect(reader.conversation.kind == .topLevel)
        #expect(reader.conversation.header?.parentSession == nil)
    }
}

@Test("lecteur-de-sessions-omp : cas limite — parentSession vide, nul ou non-chaîne vaut absent")
func emptyOrNonStringParentSessionIsTopLevel() throws {
    let variants = [#""parentSession":"""#, #""parentSession":null"#, #""parentSession":42"#]
    for variant in variants {
        let header = #"{"type":"session","id":"session-1","timestamp":"2026-01-01T00:00:00.000Z","cwd":"/tmp/projet",\#(variant)}"#
        try withFixture([header]) { fixture in
            let reader = SessionReader(path: fixture.path)
            #expect(reader.read().issue == nil)
            #expect(reader.conversation.header?.parentSession == nil)
            #expect(reader.conversation.kind == .topLevel)
        }
    }
}

// MARK: - AC-9 : lecture seule, sans perturbation de l'écrivain

@Test("lecteur-de-sessions-omp/AC-9 : la lecture ne modifie rien et laisse l'écrivain écrire")
func readingLeavesTheFileAndItsDirectoryUntouched() throws {
    try withFixture([Lines.header(), Lines.user("premier", id: "e1")]) { fixture in
        let reader = SessionReader(path: fixture.path)
        #expect(reader.read().added.count == 1)

        let bytesBefore = try Data(contentsOf: fixture.file)
        let attributesBefore = try FileManager.default.attributesOfItem(atPath: fixture.path)
        let listingBefore = try FileManager.default.contentsOfDirectory(atPath: fixture.directory.path)

        let idle = reader.read()
        #expect(idle.issue == nil)
        #expect(idle.added.isEmpty)

        // (a) octets, taille et date de modification inchangés.
        let bytesAfter = try Data(contentsOf: fixture.file)
        let attributesAfter = try FileManager.default.attributesOfItem(atPath: fixture.path)
        #expect(bytesAfter == bytesBefore)
        #expect(attributesAfter[.size] as? NSNumber == attributesBefore[.size] as? NSNumber)
        #expect(attributesAfter[.modificationDate] as? Date == attributesBefore[.modificationDate] as? Date)

        // (b) aucun fichier annexe — verrou, index, temporaire — n'a été créé.
        let listingAfter = try FileManager.default.contentsOfDirectory(atPath: fixture.directory.path)
        #expect(listingAfter == listingBefore)

        // (c) et (d) : deux écrivains concurrents, ouverts pendant la lecture,
        // écrivent en fin de fichier sans recevoir d'erreur.
        let firstWriter = try FileHandle(forWritingTo: fixture.file)
        defer { try? firstWriter.close() }
        try firstWriter.seek(toOffset: firstWriter.seekToEnd())
        try firstWriter.write(contentsOf: Data(("\n" + Lines.user("écrit pendant la lecture", id: "e2") + "\n").utf8))

        // La lecture suivante voit l'écriture externe : le lecteur ne l'a ni
        // empêchée, ni verrouillée, ni ignorée.
        let grown = reader.read()
        #expect(grown.issue == nil)
        #expect(grown.added.map(\.index) == [2])
        #expect(grown.added[0].kind == .user(UserTurn(text: "écrit pendant la lecture")))

        let secondWriter = try FileHandle(forWritingTo: fixture.file)
        defer { try? secondWriter.close() }
        try secondWriter.seek(toOffset: secondWriter.seekToEnd())
        try secondWriter.write(contentsOf: Data((Lines.user("second écrivain", id: "e3") + "\n").utf8))

        let again = reader.read()
        #expect(again.issue == nil)
        #expect(again.added.map(\.index) == [3])
        #expect(again.added[0].kind == .user(UserTurn(text: "second écrivain")))
    }
}

// MARK: - AC-11 : aucune transcription de session dans le dépôt

@Test("lecteur-de-sessions-omp : la suite construit ses fixtures hors du dépôt, qui n'en contient aucune")
func fixturesAreBuiltByTheSuiteAndTheRepositoryHoldsNone() throws {
    // Les fixtures vivent dans le répertoire temporaire, jamais dans l'arbre.
    try withFixture([Lines.header(), Lines.user("fixture")]) { fixture in
        let temporary = FileManager.default.temporaryDirectory.standardizedFileURL.path
        #expect(fixture.path.hasPrefix(temporary))
        #expect(FileManager.default.fileExists(atPath: fixture.path))
    }

    // Et aucun fichier `.jsonl` ne vit dans le dépôt : la racine est déduite du
    // chemin COMPILÉ de ce fichier, donc c'est bien l'arbre courant qui est sondé.
    let repository = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()  // OMPConsoleTests
        .deletingLastPathComponent()  // Tests
        .deletingLastPathComponent()  // omp-console
        .deletingLastPathComponent()  // racine du dépôt
    #expect(transcripts(in: repository).isEmpty, "des transcriptions .jsonl vivent dans le dépôt")
}

/// Les fichiers `.jsonl` d'un arbre, en ignorant dépendances et artefacts de
/// build. Les liens symboliques ne sont pas suivis (pas de boucle).
private func transcripts(in directory: URL) -> [String] {
    let ignored: Set<String> = [".git", "node_modules", ".typecheck", "qdrant_storage", "build"]
    guard let entries = try? FileManager.default.contentsOfDirectory(
        at: directory,
        includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]
    ) else { return [] }

    var found: [String] = []
    for entry in entries {
        let name = entry.lastPathComponent
        guard !ignored.contains(name), !name.hasPrefix(".build") else { continue }
        let values = try? entry.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
        guard values?.isSymbolicLink != true else { continue }
        if values?.isDirectory == true {
            found.append(contentsOf: transcripts(in: entry))
        } else if name.hasSuffix(".jsonl") {
            found.append(entry.path)
        }
    }
    return found
}


// MARK: - Horodatage de l'entrée (feature statistiques, S-2)

@Test("statistiques/AC-1 : une entrée porte son horodatage, avec ou sans fraction de seconde")
func entriesCarryTheirParsedTimestamp() throws {
    // Deux formes : `Date.ISO8601FormatStyle(includingFractionalSeconds: true)` lit
    // les deux, là où un `ISO8601DateFormatter` unique en exigerait une seule.
    let withFraction = #"{"type":"message","id":"e1","parentId":null,"timestamp":"2026-01-01T00:00:00.500Z","message":{"role":"user","content":[{"type":"text","text":"a"}]}}"#
    let withoutFraction = #"{"type":"message","id":"e2","parentId":null,"timestamp":"2026-01-01T00:00:02Z","message":{"role":"user","content":[{"type":"text","text":"b"}]}}"#
    try withFixture([Lines.header(), withFraction, withoutFraction]) { fixture in
        let reader = SessionReader(path: fixture.path)
        #expect(reader.read().issue == nil)
        let entries = reader.conversation.entries
        #expect(entries.count == 2)
        // L'analyse passe par des secondes `Double` : on compare à la sous-milliseconde.
        #expect(abs((entries[0].timestampMs ?? 0) - 1_767_225_600_500) < 0.01)
        #expect(abs((entries[1].timestampMs ?? 0) - 1_767_225_602_000) < 0.01)
    }
}
