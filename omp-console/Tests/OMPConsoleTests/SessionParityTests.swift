// La garde de parité des SESSIONS macOS ↔ iOS (S-11, AC-11) : depuis la MÊME
// fixture partagée que l'app iOS (`SessionParity.lines` / `SessionParity.payloadJSON`,
// déclarés dans `ConsoleCore`), la coque macOS (SessionReader → SessionRowBuilder)
// et le chemin iOS (payloadJSON → miroir client `SessionWire.entries` →
// SessionRowBuilder) doivent produire EXACTEMENT les mêmes faits. C'est la preuve
// que la parité porte sur des dérivations partagées, pas sur deux recopies.
//
// INVARIANT DE NON-RÉGRESSION : les faits pinnés ici sont lus sur les entrées
// RECONSTRUITES depuis la charge utile (le chemin iOS). Si un champ de la
// projection disparaît (par exemple `arguments`), un fait pinné (`cible du read`,
// question de l'`ask`, diff d'`edit`) devient introuvable et ce fichier rougit.
//
// La route est exercée par la pile RÉELLE (`RemoteStack`), comme dans
// `RemoteReadRoutesTests` : aucune doublure de routeur.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// `RemoteSessionPayload` existe des deux côtés (la coque et le miroir client) :
/// ce fichier suit le chemin iOS, donc le type du client.
private typealias WireSessionPayload = ConsoleClient.RemoteSessionPayload

@MainActor
@Suite("Parité des sessions (fixture partagée)")
struct SessionParityTests {

    // MARK: - Outillage

    /// Le chemin percent-encodé d'un segment : `%2F` reste DANS le segment, sinon
    /// un chemin de session se briserait en deux.
    private static func encoded(_ segment: String) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return segment.addingPercentEncoding(withAllowedCharacters: allowed) ?? segment
    }

    /// La charge utile figée, décodée par le miroir client.
    private static func wirePayload() throws -> WireSessionPayload {
        try JSONDecoder().decode(WireSessionPayload.self, from: Data(SessionParity.payloadJSON.utf8))
    }

    /// Le chemin iOS : la charge utile → entrées → lignes.
    private static func iosRows(_ payload: WireSessionPayload) -> [SessionRow] {
        var builder = SessionRowBuilder()
        builder.projectRoot = payload.header?.cwd
        builder.append(SessionWire.entries(payload))
        return builder.rows
    }

    /// Le chemin iOS depuis la charge utile figée.
    private static func iosRows() throws -> [SessionRow] {
        let payload = try wirePayload()
        return iosRows(payload)
    }

    /// Le chemin macOS : le fichier → lecteur → lignes. Le fichier est écrit par
    /// la fixture RÉELLE (`ViewerSessionFixture`), jamais un mock.
    private static func macRows(_ read: SessionConversation) -> [SessionRow] {
        var builder = SessionRowBuilder()
        builder.projectRoot = read.header?.cwd
        builder.append(read.entries)
        return builder.rows
    }

    private static func toolCall(_ rows: [SessionRow], _ callId: String) -> ToolCallRow? {
        for row in rows {
            if case .toolCall(let call) = row.kind, call.callId == callId { return call }
        }
        return nil
    }

    private static func toolResults(_ rows: [SessionRow]) -> [ToolResultRow] {
        rows.compactMap {
            if case .toolResult(let result) = $0.kind { return result } else { return nil }
        }
    }

    private static func assistantRows(_ rows: [SessionRow]) -> [AssistantRow] {
        rows.compactMap {
            if case .assistant(let assistant) = $0.kind { return assistant } else { return nil }
        }
    }

    private static func markers(_ rows: [SessionRow]) -> [MarkerRow] {
        rows.compactMap {
            if case .marker(let marker) = $0.kind { return marker } else { return nil }
        }
    }

    // MARK: - (1) Les entrées : lecteur macOS = miroir client

    @Test("ios-sessions/AC-11 : le lecteur macOS et le miroir client rendent les MÊMES entrées")
    func readerAndWireAgree() throws {
        let fixture = try ViewerSessionFixture()
        defer { fixture.remove() }
        try fixture.write(SessionParity.lines)

        let reader = SessionReader(path: fixture.path)
        reader.read()
        let read = reader.conversation
        let payload = try Self.wirePayload()

        // L'en-tête est lu une fois, et son `cwd` est la racine de projet du fil.
        #expect(read.header?.id == "parity-session-1")
        #expect(read.header?.cwd == SessionParity.projectRoot)
        #expect(read.kind == SessionKind.topLevel)

        // Neuf entrées : utilisateur, agent, trois résultats, compaction, résumé
        // de branche, puis les DEUX réponses finales (le doublon est une DONNÉE,
        // c'est le builder qui le replie).
        #expect(read.entries.count == 9)
        #expect(payload.entries.count == 9)

        // L'égalité qui porte la parité : mêmes offsets, mêmes horodatages, mêmes
        // arguments — l'`offset` par entrée est ce qui rend les identités stables.
        #expect(SessionWire.entries(payload) == read.entries)

        // Les lignes fautives sont nommées : JSON invalide, puis type inconnu. Le
        // type CONNU hors périmètre ne gonfle ni les entrées ni les ignorées.
        #expect(read.skipped.map(\.reason) == [.invalidJSON, .unknownType])
        #expect(read.skipped.count == 2)
    }

    // MARK: - (2) La route sert EXACTEMENT la charge utile figée

    @Test("ios-sessions/AC-11 : GET /v1/sessions/{id} sert la charge utile figée, mot pour mot")
    func routeServesTheFrozenPayload() async throws {
        let fixture = try ViewerSessionFixture()
        defer { fixture.remove() }
        try fixture.write(SessionParity.lines)

        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/sessions/\(Self.encoded(fixture.path))", token: token)
        #expect(reply.status == 200)
        // Octet pour octet : c'est ce qui rend `SessionParity.payloadJSON` une
        // fixture de référence, et non une approximation recopiée.
        #expect(reply.body == Data(SessionParity.payloadJSON.utf8))

        let payload = try reply.json(WireSessionPayload.self)
        #expect(payload.truncated == false)
        #expect(payload.unreadableReason == nil)
        #expect(payload.header?.id == "parity-session-1")
        #expect(payload.kind == "topLevel")
        #expect(payload.entries.compactMap(\.offset).count == payload.entries.count)
    }

    // MARK: - (3) Les mêmes lignes, des deux chemins

    @Test("ios-sessions/AC-11 : les lignes du chemin macOS et celles du chemin iOS sont ÉGALES")
    func macAndIOSPathsBuildTheSameRows() throws {
        let fixture = try ViewerSessionFixture()
        defer { fixture.remove() }
        try fixture.write(SessionParity.lines)

        let reader = SessionReader(path: fixture.path)
        reader.read()

        let mac = Self.macRows(reader.conversation)
        let ios = try Self.iosRows()

        #expect(ios == mac)
        // Dix lignes : le message utilisateur, l'agent et ses TROIS appels, le
        // résultat autonome, les deux marqueurs, puis la réponse finale et son
        // appel mémoire — la réponse dupliquée n'en produit aucune.
        #expect(mac.count == 10)
    }

    // MARK: - (4) Les faits pinnés du fil

    @Test("ios-sessions/AC-11 : cible, question, diffs, marqueurs et entrées ignorées, pinnés")
    func pinnedFacts() async throws {
        // (a) Les faits DOCUMENTÉS par la fixture : c'est ce que le test iOS
        //     retrouvera depuis `payloadJSON`, sans coque ni fichier.
        try Self.pinFacts(try Self.wirePayload())

        // (b) Les faits RÉELLEMENT servis par la route pour les mêmes lignes : la
        //     projection courante les porte, donc la disparition d'un champ
        //     (`arguments`, `offset`…) rend un fait pinné introuvable ICI — et pas
        //     seulement l'égalité d'octets de la charge utile figée.
        let fixture = try ViewerSessionFixture()
        defer { fixture.remove() }
        try fixture.write(SessionParity.lines)

        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair()
        let reply = try await stack.call("GET", "/v1/sessions/\(Self.encoded(fixture.path))", token: token)
        try Self.pinFacts(try reply.json(WireSessionPayload.self))
    }

    /// Les faits pinnés de la session de référence, pour la charge utile qu'on lui
    /// donne — le littéral figé comme la réponse de la route.
    private static func pinFacts(_ payload: WireSessionPayload) throws {
        let rows = try iosRows(payload)

        // — La CIBLE du `read` : chemin relatif à la racine du projet du fixture.
        let read = try #require(toolCall(rows, "call-read"))
        #expect(read.name == "read")
        #expect(read.target == "src/app.swift")
        #expect(read.argumentsJSON == #"{"i":"lire le fichier","offset":2,"path":"/tmp/omp-parity/src/app.swift"}"#)
        #expect(read.result?.text == "deux lignes lues")

        // — La QUESTION de l'`ask` et ses DEUX options (dont une décrite).
        let ask = try #require(toolCall(rows, "call-ask"))
        #expect(ask.target == "Quel plan préfères-tu ?")
        let span = try #require(ask.ask)
        #expect(span.questions.count == 1)
        let question = try #require(span.questions.first)
        #expect(question.id == "q1")
        #expect(question.header == "Plan")
        #expect(question.question == "Quel plan préfères-tu ?")
        #expect(question.options.map(\.label) == ["Garder le fichier", "Renommer le module"])
        #expect(question.options.map(\.description) == ["aucune modification", nil])

        // — Le DIFF porté par le résultat de l'`edit` : trois tons, sans en-tête.
        let edit = try #require(toolCall(rows, "call-edit"))
        #expect(edit.target == "src/app.swift")
        let editDiff = try #require(edit.result?.diff)
        #expect(editDiff == SessionParity.editDiff)
        #expect(diffLines(in: editDiff).map(\.tone) == [.context, .removed, .added])
        #expect(
            diffLines(in: editDiff).map { SessionDiffText.toneLabel($0.tone) }
                == ["contexte", "ligne supprimée", "ligne ajoutée"]
        )
        try assertTailFacts(payload: payload, rows: rows)
    }

    /// La seconde moitié des faits pinnés (diffs, marqueurs, doublon, ignorées).
    private static func assertTailFacts(payload: WireSessionPayload, rows: [SessionRow]) throws {

        // — Le diff UNIFIÉ dans le TEXTE d'un résultat autonome : les quatre tons.
        let orphan = try #require(Self.toolResults(rows).first { $0.callId == "call-absent" })
        #expect(orphan.text == SessionParity.patchText)
        let diffSegment = try #require(
            bodySegments(in: orphan.text).compactMap { segment -> [DiffLine]? in
                if case .diff(let lines) = segment { return lines } else { return nil }
            }.first
        )
        #expect(
            diffSegment.map(\.tone)
                == [.section, .section, .section, .section, .section, .removed, .added]
        )
        #expect(diffSegment.first?.text == "diff --git a/src/app.swift b/src/app.swift")
        #expect(SessionDiffText.toneLabel(.section) == "en-tête de diff")
        #expect(SessionDiffText.toneLabel(.removed) == "ligne supprimée")

        // — Les DEUX MARQUEURS, textes verbatim.
        let markers = Self.markers(rows)
        #expect(markers.count == 2)
        #expect(
            markers.first
                == MarkerRow.compaction(summary: "contexte compacté à 4 200 jetons", tokensBefore: 4200)
        )
        #expect(
            markers.last
                == MarkerRow.branchSummary(summary: "résumé de branche : reprise après compaction", fromId: "root")
        )

        // — Pensées et texte de l'agent ; le texte DUPLIQUÉ n'apparaît qu'une fois.
        let assistants = Self.assistantRows(rows)
        #expect(assistants.count == 2)
        #expect(assistants.first?.thinking == "je réfléchis à la correction à appliquer")
        #expect(
            assistants.map(\.text)
                == ["je lis le fichier puis je propose un plan", "La correction est appliquée."]
        )
        // L'appel mémoire est bien là, et l'agent ne réénonce pas sa réponse.
        #expect(Self.toolCall(rows, "call-memory")?.name == "mem0_add")

        // — Les entrées IGNORÉES : deux raisons, jamais une de plus (le type hors
        // périmètre est silencieux, le type inconnu est nommé).
        #expect(payload.skipped.map(\.reason) == ["invalidJSON", "unknownType"])
        #expect(payload.skipped.count == 2)
        #expect(payload.skipped.allSatisfy { $0.offset > 0 })
        #expect(payload.truncated == false)
    }

    // MARK: - (5) Fichier illisible et troncature (S-4)

    @Test("ios-sessions/AC-4 : le motif d'un fichier illisible et la mention de troncature")
    func unreadableAndTruncated() async throws {
        let unreadable = try ViewerSessionFixture(fileName: "illisible.jsonl")
        defer { unreadable.remove() }
        try unreadable.write([])
        try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: unreadable.path)
        defer {
            try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: unreadable.path)
        }

        let counted = try ViewerSessionFixture(fileName: "longue.jsonl")
        defer { counted.remove() }
        var longLines = [SessionParity.lines[0]]
        longLines.append(contentsOf: (0..<2001).map { ViewerLines.user("prompt \($0)", id: "u\($0)") })
        try counted.write(longLines)

        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair()

        // Fichier PRÉSENT mais illisible : 200, le motif OS, aucune entrée — et
        // jamais l'entrée ignorée factice d'autrefois.
        let broken = try await stack.call("GET", "/v1/sessions/\(Self.encoded(unreadable.path))", token: token)
        #expect(broken.status == 200)
        let brokenPayload = try broken.json(WireSessionPayload.self)
        #expect(brokenPayload.unreadableReason == "ouverture en lecture refusée")
        #expect(brokenPayload.entries.isEmpty)
        #expect(brokenPayload.skipped.isEmpty)
        #expect(brokenPayload.truncated == false)

        // 2001 entrées dépassent la borne de 2000 : la réponse le DIT et borne.
        let reply = try await stack.call("GET", "/v1/sessions/\(Self.encoded(counted.path))", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(WireSessionPayload.self)
        #expect(payload.truncated == true)
        #expect(payload.entries.count == RemoteLimits.sessionEntries)
    }
}
