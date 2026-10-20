// Les preuves Swift des rangées lues par VoiceOver (BR-1 : la liste racine), puis
// celles des rangées serrées de la Mémoire (rangees-sessions-memoire-serrees, BR-2).
//
// Chaque test PORTE l'id d'acceptation qu'il prouve. Les libellés attendus se
// composent par interpolation, avec les mots lus par symbole (`IOSShellText`,
// `ConsoleSection`) et jamais recopiés.

import ConsoleClient
import ConsoleCore
import SwiftUI
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-accessibilite-rangees-et-sessions — rangées lues par VoiceOver")
struct IOSRowAccessibilityTests {
    // MARK: - Liste racine (BR-1)

    @Test("ios-accessibilite-rangees-et-sessions/AC-2 : le libellé d'une rangée racine annonce le badge visible, et lui seul")
    func sectionRowLabelFollowsShownBadge() {
        let pending = IOSShellText.rowPending
        let home = ConsoleSection.home.title
        #expect(IOSShellText.sectionRowLabel(home, badge: 2) == "\(home), 2 \(pending)")
        #expect(IOSShellText.sectionRowLabel(home, badge: 0) == home)
        #expect(IOSShellText.sectionRowLabel(home, badge: 120) == "\(home), 120 \(pending)")
    }

    // MARK: - Rangées de la Mémoire (rangees-sessions-memoire-serrees, BR-2)

    @Test("rangees-sessions-memoire-serrees/AC-3 : le texte d'un souvenir tient en 3 lignes sur iPhone, 4 sur iPad, quelle que soit la taille de texte")
    func memoryRowLinesFollowTheWidth() {
        // Le plafond suit la LARGEUR (décision utilisateur), jamais la taille de texte :
        // compact (iPhone) → 3 ; régulier (iPad) ou inconnu → 4 (AC-3, AC-4, AC-5).
        #expect(IOSMetrics.memoryRowLines(.compact) == 3)
        #expect(IOSMetrics.memoryRowLines(.regular) == 4)
        #expect(IOSMetrics.memoryRowLines(nil) == 4)
        #expect(IOSMetrics.memoryRowLines(.compact) == IOSMetrics.compactMemoryRowLines)
        #expect(IOSMetrics.memoryRowLines(.regular) == IOSMetrics.regularMemoryRowLines)
    }

    @Test("rangees-sessions-memoire-serrees/AC-8 : la ligne de contexte d'un souvenir se découpe en segments, date puis étiquettes, qui redonnent la bande jointe")
    func memoryRowContextSplitsIntoSegments() throws {
        let nowMs = 1_760_000_000_000.0
        let updatedAt = "2026-10-01T11:50:31.746110+00:00"
        let ms = try #require(MemoryText.updatedAtMs(updatedAt))
        let date = ConsoleFormat.relative(ms: ms, nowMs: nowMs)
        let tags = ["omp-console", "memoire"]
        let tagLine = MemoryText.tagList(tags)

        func row(updatedAt: String?, tags: [String]) -> RemoteMemoryRow {
            RemoteMemoryRow(id: "m-contexte", text: "Un souvenir.", updatedAt: updatedAt, score: nil, tags: tags, agentId: "projet")
        }
        let cases: [(row: RemoteMemoryRow, segments: [String])] = [
            // Date et étiquettes : deux segments, la date d'abord.
            (row(updatedAt: updatedAt, tags: tags), [date, tagLine]),
            // Étiquettes seules.
            (row(updatedAt: nil, tags: tags), [tagLine]),
            // Date seule.
            (row(updatedAt: updatedAt, tags: []), [date]),
            // Ni l'une ni les autres : aucune ligne de contexte.
            (row(updatedAt: nil, tags: []), []),
        ]
        for (row, expected) in cases {
            let segments = IOSMemoryDetailView.subtitleSegments(row, nowMs: nowMs)
            #expect(segments == expected)
            // L'invariant de jointure : empilés ou en bande, les mêmes mots.
            #expect(segments.joined(separator: MemoryText.separator) == IOSMemoryDetailView.subtitle(row, nowMs: nowMs))
        }
    }
}
