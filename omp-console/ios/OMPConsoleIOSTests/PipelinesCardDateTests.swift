import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS
@testable import ConsoleCore

/// Les preuves Swift de la date et du statut des cartes de l'écran Pipelines
/// (S-1, S-2) : une carte homonyme se distingue par sa minute et son statut, une
/// carte sans instant valide ne montre aucune date, et le statut dit la voie.
@MainActor
@Suite("ios-pipelines-cartes-homonymes — date et statut des cartes")
struct PipelinesCardDateTests {
    private let paris = TimeZone(identifier: "Europe/Paris")!
    /// 2026-10-09 14:32 Europe/Paris (CEST).
    private let base: Double = 1_791_549_120_000

    private func entry(_ n: Int, _ finalState: String, endedAt: Double) -> String {
        """
        {
          "id": "h00000000000000\(n)",
          "cwd": "/tmp/omp-homonymes/mem0-omp-\(n)",
          "label": "mem0-omp/context-optimization-architecture",
          "phase": "review",
          "finalState": "\(finalState)",
          "phaseStartedAt": \(Int(endedAt) - 600_000),
          "endedAt": \(Int(endedAt))
        }
        """
    }

    /// Sept clôtures homonymes (cwd distincts : la règle D2 écarterait deux
    /// clôtures de même cwd et même `endedAt`) et une clôture unique, en ardoise.
    private var homonymesBoard: KanbanBoard {
        let entries = [
            entry(1, "done", endedAt: base),
            entry(2, "done", endedAt: base + 5_580_000),
            entry(3, "failed", endedAt: base),
            entry(4, "failed", endedAt: base - 86_400_000),
            entry(5, "done", endedAt: base - 172_800_000),
            entry(6, "failed", endedAt: base + 60_000),
            entry(7, "done", endedAt: base - 3_600_000),
            """
            {
              "id": "h000000000000008",
              "cwd": "/tmp/omp-homonymes/export-csv",
              "label": "mem0-omp/export-csv",
              "phase": "review",
              "finalState": "done",
              "phaseStartedAt": \(Int(base + 120_000) - 600_000),
              "endedAt": \(Int(base + 120_000))
            }
            """,
        ].joined(separator: ",\n")
        let json = """
        {
          "root": "present",
          "running": { "availability": "present", "discardedEntries": [], "entries": [] },
          "history": { "availability": "present", "discardedEntries": [], "entries": [\(entries)] },
          "lots": { "availability": "present", "discardedEntries": [], "lots": [] },
          "projects": { "availability": "present", "discardedEntries": [], "projects": [] },
          "inbox": { "availability": "present", "discardedEntries": [], "boxes": [] },
          "audit": { "availability": "present", "discardedEntries": [], "relays": [] }
        }
        """
        // Le type de l'instantané est déduit de la fixture partagée : la garde
        // coque-ios/AC-8 interdit de nommer le type du magasin dans les sources iOS.
        let snapshot = Self.decode(like: HomeParity.snapshot, json)
        return KanbanBoard.build(snapshot: snapshot, nowMs: base, isAlive: .transported(snapshot), prFacts: [:])
    }

    private var parityBoard: KanbanBoard {
        KanbanBoard.build(snapshot: HomeParity.snapshot, nowMs: base, isAlive: .transported(HomeParity.snapshot), prFacts: [:])
    }

    private static func decode<T: Decodable>(like _: T, _ json: String) -> T {
        // swiftlint:disable:next force_try
        try! JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    private func card(start: Double, end: Double?, column: KanbanColumn = .enCours) -> KanbanCard {
        KanbanCard(
            id: "c", column: column, repo: "r", title: "t", state: "s", phase: nil, models: nil,
            prUrl: nil, startMs: start, endMs: end, marks: [], sources: []
        )
    }

    @Test("ios-pipelines-cartes-homonymes/AC-1 : sept cartes de même titre, sept (titre, date, statut) distincts")
    func homonymousCardsAreDistinguishable() {
        let all = homonymesBoard.cards
        let homonyms = all.filter { KanbanCardPresentation.title($0) == "context-optimization-architecture" }
        #expect(homonyms.count == 7)
        var triplets = Set<String>()
        for card in homonyms {
            let date = PipelinesModel.cardDate(card, timeZone: paris)
            #expect(date != nil)
            triplets.insert("\(KanbanCardPresentation.title(card))|\(date ?? "")|\(ConsoleStatus.of(card: card).text)")
        }
        #expect(triplets.count == 7)
    }

    @Test("ios-pipelines-cartes-homonymes/AC-2 : une carte unique porte la même date et son statut")
    func uniqueCardUsesTheSameFormat() throws {
        let unique = try #require(homonymesBoard.cards.first { KanbanCardPresentation.title($0) == "export-csv" })
        #expect(PipelinesModel.cardDate(unique, timeZone: paris) == ConsoleFormat.dateTime(ms: base + 120_000, timeZone: paris))
        #expect(ConsoleStatus.of(card: unique).text == "Terminée")
    }

    @Test("ios-pipelines-cartes-homonymes/AC-3 : deux homonymes du même jour montrent leur propre minute")
    func sameDayHomonymsShowTheirOwnMinute() throws {
        let cards = homonymesBoard.cards
        let first = try #require(cards.first { $0.endMs == base && $0.column == .termineeSansPr })
        let later = try #require(cards.first { $0.endMs == base + 5_580_000 })
        let firstDate = try #require(PipelinesModel.cardDate(first, timeZone: paris))
        let laterDate = try #require(PipelinesModel.cardDate(later, timeZone: paris))
        #expect(firstDate != laterDate)
        #expect(firstDate.contains("14:32"))
        #expect(laterDate.contains("16:05"))
    }

    @Test("ios-pipelines-cartes-homonymes/AC-4 : sans instant valide, aucune date n'est montrée")
    func missingInstantIsNotShown() {
        #expect(PipelinesModel.cardDate(card(start: 0, end: nil), timeZone: paris) == nil)
        #expect(PipelinesModel.cardDate(card(start: base, end: 0), timeZone: paris) == nil)
        #expect(PipelinesModel.cardDate(card(start: .nan, end: nil), timeZone: paris) == nil)
        #expect(PipelinesModel.cardDate(card(start: -5, end: nil), timeZone: paris) == nil)
        #expect(PipelinesModel.cardDate(card(start: base, end: .infinity), timeZone: paris) == nil)
        #expect(PipelinesModel.cardDate(card(start: base, end: nil), timeZone: paris)?.contains("14:32") == true)
        #expect(PipelinesModel.cardDate(card(start: base - 600_000, end: base), timeZone: paris)?.contains("14:32") == true)
    }

    @Test("ios-pipelines-cartes-homonymes/AC-5 : le statut d'une carte appartient aux mots de sa voie")
    func statusMatchesItsLane() {
        let allowed: [KanbanLane: Set<String>] = [
            .pasCommencees: ["Pas commencée"],
            .enCours: ["En cours", "En pause"],
            .aVous: ["À vous", "Specs à valider", "Revue à accepter"],
            .livrees: ["PR ouverte", "PR créée", "PR fusionnée", "PR fermée", "Terminée"],
            .arretees: ["Échec", "Bloquée", "Annulée"],
        ]
        func check(_ card: KanbanCard) {
            let lane = KanbanLane.of(card)
            let text = ConsoleStatus.of(card: card).text
            #expect(allowed[lane]?.contains(text) == true, "\(card.column) → \(lane) : « \(text) »")
        }
        for column in KanbanColumn.allCases {
            check(card(start: base, end: nil, column: column))
        }
        var seen = 0
        for built in [homonymesBoard, parityBoard] {
            for content in built.lanes {
                for card in content.cards {
                    check(card)
                    seen += 1
                }
            }
        }
        #expect(seen > 8)
    }
}
