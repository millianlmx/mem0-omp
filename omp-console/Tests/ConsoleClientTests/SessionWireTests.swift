// Le PONT charge utile → modèle partagé (S-3) : c'est lui qui rend la parité
// vérifiable, l'app iOS ne relisant jamais le `.jsonl`.
//
// Deux familles d'assertions :
//   — les REPLIS documentés (offset absent ⇒ index, kind inconnu ⇒ entrée omise,
//     champ optionnel absent ⇒ absent) ;
//   — l'INVARIANT de non-régression de S-11 : une cible, un texte d'arguments et une
//     question sont DÉRIVÉS des arguments transportés. Si un seul champ de la
//     projection disparaissait (`arguments`), ces faits pinnés deviendraient
//     introuvables.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@Suite("Session par le fil")
struct SessionWireTests {
    /// La charge utile TELLE QUE LE SERVEUR L'ÉCRIT, champs additifs compris.
    private static let wireJSON = """
    {"header":{"id":"s1","cwd":"/tmp/proj"},
     "kind":"topLevel",
     "entries":[
       {"index":1,"offset":0,"kind":"user","text":"fais-le"},
       {"index":2,"offset":10,"kind":"assistant","text":"je lis le fichier","thinking":"je réfléchis","model":"m",
        "usage":{"input":1,"output":2,"cacheRead":0,"cacheWrite":0,"totalTokens":3},
        "toolCalls":[
          {"id":"c1","name":"read","arguments":{"path":"/tmp/proj/a.txt","i":"lire"}},
          {"id":"c2","name":"ask","arguments":{"questions":[
            {"id":"q1","question":"Continuer ?","options":[{"label":"oui"},{"label":"non","description":"arrêter"}]}]}}
        ]},
       {"index":3,"offset":20,"kind":"toolResult","text":"contenu","callId":"c1","name":"read"},
       {"index":4,"offset":30,"kind":"compaction","text":"résumé précédent","tokensBefore":1024},
       {"index":5,"offset":40,"kind":"branchSummary","text":"branche","fromId":"root"}
     ],
     "skipped":[],"truncated":false}
    """

    private static func decode(_ json: String) throws -> RemoteSessionPayload {
        try JSONDecoder().decode(RemoteSessionPayload.self, from: Data(json.utf8))
    }

    @Test("les faits transportés se reconstruisent à l'identique, du message aux marqueurs")
    func entriesMatchTheReader() throws {
        let entries = SessionWire.entries(try Self.decode(Self.wireJSON))
        #expect(
            entries == [
                ConversationEntry(index: 1, offset: 0, kind: .user(UserTurn(text: "fais-le"))),
                ConversationEntry(
                    index: 2,
                    offset: 10,
                    kind: .assistant(
                        AssistantTurn(
                            text: "je lis le fichier",
                            thinking: "je réfléchis",
                            model: "m",
                            usage: TokenUsage(
                                input: 1,
                                output: 2,
                                cacheRead: 0,
                                cacheWrite: 0,
                                totalTokens: 3,
                                cost: nil
                            ),
                            toolCalls: [
                                ToolCall(
                                    id: "c1",
                                    name: "read",
                                    arguments: .object([
                                        "path": .string("/tmp/proj/a.txt"),
                                        "i": .string("lire"),
                                    ])
                                ),
                                ToolCall(
                                    id: "c2",
                                    name: "ask",
                                    arguments: .object([
                                        "questions": .array([
                                            .object([
                                                "id": .string("q1"),
                                                "question": .string("Continuer ?"),
                                                "options": .array([
                                                    .object(["label": .string("oui")]),
                                                    .object([
                                                        "label": .string("non"),
                                                        "description": .string("arrêter"),
                                                    ]),
                                                ]),
                                            ])
                                        ])
                                    ])
                                ),
                            ]
                        )
                    )
                ),
                ConversationEntry(
                    index: 3,
                    offset: 20,
                    kind: .toolResult(
                        ToolResultTurn(
                            callId: "c1",
                            name: "read",
                            text: "contenu",
                            diff: nil,
                            isError: false
                        )
                    )
                ),
                ConversationEntry(
                    index: 4,
                    offset: 30,
                    kind: .compaction(CompactionMarker(summary: "résumé précédent", tokensBefore: 1024))
                ),
                ConversationEntry(
                    index: 5,
                    offset: 40,
                    kind: .branchSummary(BranchSummaryMarker(summary: "branche", fromId: "root"))
                ),
            ]
        )
    }

    @Test("les faits DÉRIVÉS des arguments survivent au transport : cible, arguments rendus, question")
    func derivedFactsSurviveTransport() throws {
        var builder = SessionRowBuilder()
        builder.projectRoot = "/tmp/proj"
        builder.append(SessionWire.entries(try Self.decode(Self.wireJSON)))

        #expect(builder.rows.map(\.id) == ["r0", "r10", "r10.c0", "r10.c1", "r30", "r40"])
        let calls = builder.rows.compactMap { row -> ToolCallRow? in
            guard case .toolCall(let call) = row.kind else { return nil }
            return call
        }
        #expect(calls.count == 2)

        let read = try #require(calls.first)
        #expect(read.target == "a.txt", "la cible vient de l'argument `path` transporté")
        #expect(read.argumentsJSON == #"{"i":"lire","path":"/tmp/proj/a.txt"}"#)
        #expect(
            read.result
                == ToolResultRow(callId: "c1", name: "read", text: "contenu", diff: nil, isError: false)
        )

        let ask = try #require(calls.last)
        #expect(ask.target == "Continuer ?")
        #expect(ask.ask?.questions.count == 1)
        #expect(ask.ask?.questions.first?.question == "Continuer ?")
        #expect(ask.ask?.questions.first?.options.map(\.label) == ["oui", "non"])
        #expect(ask.ask?.questions.first?.options.last?.description == "arrêter")
    }

    @Test("un `offset` absent retombe sur l'index : les identités restent uniques")
    func missingOffsetFallsBackOnIndex() throws {
        let payload = try Self.decode(
            #"{"entries":[{"index":7,"kind":"user","text":"sans offset"}],"skipped":[],"truncated":false}"#
        )
        let entries = SessionWire.entries(payload)
        #expect(entries.count == 1)
        #expect(entries.first?.index == 7)
        #expect(entries.first?.offset == 7, "sans offset, l'index fait foi")
    }

    @Test("un `kind` hors des cinq valeurs connues est OMIS, jamais fatal")
    func unknownKindIsOmitted() throws {
        let payload = try Self.decode(
            #"{"entries":[{"index":1,"offset":0,"kind":"hologramme","text":"?"},{"index":2,"offset":10,"kind":"user","text":"ok"}],"skipped":[],"truncated":false}"#
        )
        #expect(SessionWire.entries(payload).map(\.index) == [2])
    }

    @Test("les champs optionnels absents le RESTENT : ni tokens, ni arguments, ni motif")
    func absentFieldsStayAbsent() throws {
        let payload = try Self.decode(
            #"{"entries":[{"index":1,"offset":0,"kind":"assistant","text":"x","toolCalls":[{"id":"c1","name":"read"}]}],"skipped":[],"truncated":false}"#
        )
        let entry = try #require(SessionWire.entries(payload).first)
        guard case .assistant(let turn) = entry.kind else {
            Issue.record("l'entrée assistant n'a pas été reconstruite")
            return
        }
        #expect(turn.usage == nil, "usage absent ⇒ aucun token inventé")
        #expect(turn.toolCalls == [ToolCall(id: "c1", name: "read", arguments: nil)])

        var builder = SessionRowBuilder()
        builder.append([entry])
        guard case .toolCall(let call)? = builder.rows.last?.kind else {
            Issue.record("l'appel d'outil n'a pas produit de ligne")
            return
        }
        #expect(call.argumentsJSON == "null")
        #expect(call.target == "", "sans arguments, la cible reste vide — le nom suffit")
    }

    @Test("le motif d'un fichier illisible est transporté, et absent quand la lecture est saine")
    func unreadableReasonTravels() throws {
        let broken = try Self.decode(
            #"{"entries":[],"skipped":[],"truncated":false,"unreadableReason":"ouverture en lecture refusée"}"#
        )
        #expect(broken.unreadableReason == "ouverture en lecture refusée")
        let healthy = try Self.decode(#"{"entries":[],"skipped":[],"truncated":false}"#)
        #expect(healthy.unreadableReason == nil)
    }
}
