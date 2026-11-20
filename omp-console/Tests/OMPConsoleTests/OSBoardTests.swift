// Le Tableau de l'OS agentique, la logique pure : le rangement des fils en colonnes par phase
// (ordre, colonnes vides masquées, borne de 7 jours, changement de colonne), le contenu et le
// libellé VoiceOver d'une carte, l'état montré, la largeur d'une colonne selon la taille de
// texte, et la navigation de l'espace de travail (ouvrir un fil, revenir au tableau).

import ConsoleClient
import ConsoleCore
@testable import ConsoleUI
import Foundation
import SwiftUI
import Testing

private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
    return calendar
}()

/// Midi, le 20 novembre 2026 (UTC).
private let now = Date(timeIntervalSince1970: 1_795_176_000)

/// Minuit d'aujourd'hui moins 7 jours, en millisecondes : la borne des fils terminés.
private let weekFloor = utc.startOfDay(for: now).timeIntervalSince1970 * 1000 - 7 * 86_400_000

private let day = 86_400_000.0

private func run(_ id: String, repo: String = "web", title: String? = nil) -> HarnessRun {
    HarnessRun(id: id, repo: repo, slug: id, title: title ?? id, request: id, state: "merged", createdAt: 1, updatedAt: 1)
}

/// Un fil, par `OSThreads.build`, puis sa phase, sa date et son attente posées à la main.
private func thread(
    _ id: String, _ phase: OSPhase, updatedAt: Double? = nil, repo: String = "web", pending: Int = 0, title: String? = nil
) -> OSThread {
    var built = OSThreads.build(runs: [run(id, repo: repo, title: title)], inbox: nil)[0]
    built.phase = phase
    built.pending = pending
    built.updatedAt = updatedAt ?? now.timeIntervalSince1970 * 1000
    return built
}

private func request(_ id: String) throws -> WorkstationRequest {
    try JSONDecoder().decode(
        WorkstationRequest.self,
        from: JSONSerialization.data(withJSONObject: ["id": id, "instruction": id, "state": "done", "createdAt": 5, "updatedAt": 5, "by": "mac"])
    )
}

/// Un client sans serveur relié : en mémoire, il n'appelle personne.
@MainActor
private func unlinkedServer() -> HarnessModel {
    HarnessModel(transport: URLSessionHarnessTransport(), preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore())
}

private func columns(_ threads: [OSThread]) -> [OSBoardColumn] {
    OSBoard.columns(threads, now: now, calendar: utc)
}

@Suite("Tableau des fils")
@MainActor
struct OSBoardTests {
    private let phases: [OSPhase] = [.yours, .working, .queued, .done, .failed, .stopped]

    // MARK: Colonnes

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-5 : six colonnes dans l'ordre des phases, titrées et comptées")
    func sixColumnsInOrder() {
        // Les fils entrent à l'envers, dans des nombres différents par phase.
        var input: [OSThread] = []
        for (index, phase) in phases.reversed().enumerated() {
            for copy in 0 ... index { input.append(thread("\(phase.rawValue)-\(copy)", phase)) }
        }
        let board = columns(input)
        #expect(board.map(\.phase) == phases)
        #expect(board.map(\.threads.count) == [6, 5, 4, 3, 2, 1])
        for column in board {
            #expect(column.threads.allSatisfy { $0.phase == column.phase })
            #expect(OSBoard.columnLabel(column) == column.phase.label + ", " + OSText.threadCount(column.threads.count))
        }
        #expect(board.map(\.phase.label) == [
            OSText.phaseYours, OSText.phaseWorking, OSText.phaseQueued, OSText.phaseDone, OSText.phaseFailed, OSText.stopped,
        ])
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-6 : une colonne sans fil n'est pas rendue")
    func emptyColumnsAreHidden() {
        let board = columns([thread("a", .done), thread("b", .working)])
        #expect(board.map(\.phase) == [.working, .done])
        #expect(columns([]).isEmpty)
    }

    @Test("un fil se range par date décroissante, puis par identifiant, quel que soit l'ordre d'entrée")
    func columnOrderIsStable() {
        let a = thread("a", .working, updatedAt: 5), b = thread("b", .working, updatedAt: 5), c = thread("c", .working, updatedAt: 9)
        let expected = ["r:c", "r:a", "r:b"]
        #expect(columns([a, b, c])[0].threads.map(\.id) == expected)
        #expect(columns([c, b, a])[0].threads.map(\.id) == expected)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-14 : livré, en échec et arrêté ne gardent que les fils de moins de 7 jours")
    func finishedColumnsAreBounded() {
        for phase in [OSPhase.done, .failed, .stopped] {
            let board = columns([
                thread("recent", phase, updatedAt: now.timeIntervalSince1970 * 1000 - 3 * day),
                thread("old", phase, updatedAt: now.timeIntervalSince1970 * 1000 - 10 * day),
            ])
            #expect(board.count == 1)
            #expect(board[0].threads.map(\.id) == ["r:recent"])
        }
        // La borne : minuit d'aujourd'hui moins 7 jours, incluse ; une milliseconde avant, exclue.
        let edge = columns([thread("edge", .done, updatedAt: weekFloor), thread("before", .done, updatedAt: weekFloor - 1)])
        #expect(edge[0].threads.map(\.id) == ["r:edge"])
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-15 : un fil vivant reste, quelle que soit sa date")
    func liveColumnsAreNotBounded() {
        let ancient = now.timeIntervalSince1970 * 1000 - 30 * day
        let board = columns([thread("q", .queued, updatedAt: ancient), thread("w", .working, updatedAt: ancient), thread("y", .yours, updatedAt: ancient)])
        #expect(board.map(\.phase) == [.yours, .working, .queued])
        #expect(board.allSatisfy { $0.threads.count == 1 })
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-11 : un fil dont la phase change change de colonne")
    func threadMovesWhenItsPhaseChanges() {
        var queued = thread("a", .queued)
        #expect(columns([queued]).map(\.phase) == [.queued])
        queued.phase = .working
        let board = columns([queued])
        #expect(board.map(\.phase) == [.working])
        #expect(board[0].threads.map(\.id) == ["r:a"])
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-13 : le tableau montre les fils que la liste montre pour l'espace et le lieu retenus")
    func boardFollowsTheScope() {
        let perso = HarnessSpace(id: "e1", name: "Perso", repos: ["demo"], poste: false)
        let client = HarnessSpace(id: "e2", name: "Client", repos: ["boutique"], poste: false)
        let all = [
            thread("a", .working, repo: "demo"), thread("b", .done, repo: "demo"),
            thread("c", .working, repo: "boutique"),
            thread("old", .done, updatedAt: now.timeIntervalSince1970 * 1000 - 30 * day, repo: "demo"),
        ]
        let ofPerso = OSThreadScope.threads(all, spaceId: "e1", place: nil, spaces: [perso, client])
        #expect(columns(ofPerso).flatMap(\.threads).map(\.id).sorted() == ["r:a", "r:b"], "vivants et récents de l'espace seulement")
        let ofClient = OSThreadScope.threads(all, spaceId: "e2", place: nil, spaces: [perso, client])
        #expect(columns(ofClient).flatMap(\.threads).map(\.id) == ["r:c"])
        let ofRepo = OSThreadScope.threads(all, spaceId: nil, place: "boutique", spaces: [perso, client])
        #expect(columns(ofRepo).map(\.phase) == [.working])
    }

    // MARK: Cartes

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-7 : titre nettoyé, lieu, compteur ; Poste pour un fil du poste ; rien sans attente")
    func cardContent() throws {
        let web = thread("w", .yours, pending: 2, title: "Suite de « corrige le bandeau »")
        #expect(web.title == "Corrige le bandeau")
        #expect(OSBoard.place(of: web) == "web")
        #expect(OSBoard.waiting(of: web) == 2)

        var poste = thread("p", .working)
        poste.requests = [try request("p")]
        #expect(OSBoard.place(of: poste) == OSText.poste)
        #expect(OSBoard.waiting(of: poste) == nil, "aucune attente : pas de compteur")

        var local = thread("l", .working)
        local.repo = nil
        #expect(OSBoard.place(of: local) == OSText.vps)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-20 : VoiceOver lit titre, lieu, attente et colonne ; un titre de colonne, son nombre")
    func accessibilityLabels() {
        let web = thread("w", .yours, pending: 2, title: "Suite de « corrige le bandeau »")
        #expect(OSBoard.cardLabel(web) == ["Corrige le bandeau", "web", OSText.boardWaiting(2), OSText.boardColumn(OSPhase.yours.label)].joined(separator: ", "))
        let calm = thread("c", .done)
        #expect(OSBoard.cardLabel(calm) == [calm.title, "web", OSText.boardColumn(OSPhase.done.label)].joined(separator: ", "))
        #expect(OSText.boardWaiting(1) != OSText.boardWaiting(2))
        let column = OSBoardColumn(phase: .yours, threads: [web, calm, calm])
        #expect(OSBoard.columnLabel(column) == OSText.phaseYours + ", " + OSText.threadCount(3))
    }

    // MARK: État

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-16 : sans serveur relié, l'état dit qu'aucun serveur n'est relié, quoi qu'il arrive")
    func unconfiguredWins() {
        let some = columns([thread("a", .working)])
        for loaded in [false, true] {
            for failure in [nil, HarnessFailure.unreachable] {
                #expect(OSBoard.state(isConfigured: false, loaded: loaded, failure: failure, columns: some) == .unconfigured)
                #expect(OSBoard.state(isConfigured: false, loaded: loaded, failure: failure, columns: []) == .unconfigured)
            }
        }
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-17 : serveur relié, lu, sans fil : « aucun fil », au vouvoiement")
    func emptyBoard() {
        #expect(OSBoard.state(isConfigured: true, loaded: true, failure: nil, columns: []) == .empty)
        #expect(!OSText.boardEmpty.isEmpty)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-25 : avant la première lecture, jamais « aucun fil »")
    func loadingBeforeTheFirstRead() {
        let some = columns([thread("a", .working)])
        #expect(OSBoard.state(isConfigured: true, loaded: false, failure: nil, columns: []) == .loading)
        #expect(OSBoard.state(isConfigured: true, loaded: false, failure: nil, columns: some) == .loading)
        #expect(OSBoard.state(isConfigured: true, loaded: false, failure: .unreachable, columns: []) == .loading)
        #expect(OSBoard.state(isConfigured: true, loaded: true, failure: nil, columns: some) == .columns)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-26 : un échec sans fil dit l'échec ; avec des fils, les colonnes restent")
    func failureStates() {
        let some = columns([thread("a", .working)])
        #expect(OSBoard.state(isConfigured: true, loaded: true, failure: .unreachable, columns: []) == .failed(.unreachable))
        #expect(OSBoard.state(isConfigured: true, loaded: true, failure: .unreachable, columns: some) == .columns)
    }

    // MARK: Largeur

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-21 : la largeur croît avec la taille de texte, jusqu'à la plus grande")
    func widthGrowsWithTextSize() {
        let widths = DynamicTypeSize.allCases.map(OSBoard.textWidth)
        for (smaller, larger) in zip(widths, widths.dropFirst()) { #expect(smaller < larger) }
        #expect(OSBoard.columnWidth(.accessibility5, available: 390) > OSBoard.columnWidth(.large, available: 390))
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-19 : sur iPhone, une colonne lisible et la suivante amorcée")
    func phoneColumn() {
        #expect(OSBoard.columnWidth(.large, available: 390) == 260)
        let width = OSBoard.columnWidth(.large, available: 390)
        let peek = 390 - OSBoard.margin - (width + OSBoard.spacing)
        #expect(peek >= OSBoard.minimumPeek)
        // Très grand texte : une colonne plus étroite que la largeur lisible, mais 40 pt d'amorce.
        #expect(OSBoard.columnWidth(.accessibility5, available: 390) == 322)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-18 : la dernière colonne visible est amorcée, aucune colonne ne rétrécit")
    func tabletColumnsPeek() {
        for size in [DynamicTypeSize.large, .accessibility5] {
            for available in [744, 820, 834, 1024, 1032, 1180] as [CGFloat] {
                let width = OSBoard.columnWidth(size, available: available)
                let step = width + OSBoard.spacing
                let whole = ((available - OSBoard.margin + OSBoard.spacing) / step).rounded(.down)
                let peek = available - OSBoard.margin - whole * step
                #expect(width >= OSBoard.textWidth(size), "\(size) \(available)")
                #expect(whole >= 1, "\(size) \(available)")
                #expect(peek >= OSBoard.minimumPeek, "\(size) \(available)")
            }
        }
        #expect(OSBoard.columnWidth(.large, available: 820) == 325)
        #expect(OSBoard.columnWidth(.large, available: 834) == 332)
        for available in [744, 1024, 1032, 1180] as [CGFloat] {
            #expect(OSBoard.columnWidth(.large, available: available) == 260)
        }
        for available in [744, 820, 834, 1024, 1032, 1180] as [CGFloat] {
            #expect(OSBoard.columnWidth(.accessibility5, available: available) == 428)
        }
    }

    // MARK: Navigation

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-2 : choisir une autre entrée fixe remplace le tableau")
    func otherEntryReplacesTheBoard() {
        let workspace = OSWorkspace(server: unlinkedServer())
        workspace.selection = OSWorkspace.board
        #expect(workspace.selection == OSWorkspace.board)
        workspace.selection = OSWorkspace.now
        #expect(workspace.selection == OSWorkspace.now)
        #expect(workspace.selection != OSWorkspace.board)
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-8 : cliquer une carte fait du fil la sélection")
    func cardOpensTheThread() {
        let workspace = OSWorkspace(server: unlinkedServer())
        workspace.selection = OSWorkspace.board
        workspace.open("r:a")
        #expect(workspace.selection == "r:a")
    }

    @Test("vue-kanban-dans-les-apps-macos-et-ios/AC-22 : revenir au tableau garde l'espace et le lieu retenus")
    func boardKeepsTheScope() {
        let workspace = OSWorkspace(server: unlinkedServer())
        workspace.spaceId = "e1"
        workspace.place = "demo"
        workspace.selection = OSWorkspace.board
        workspace.open("r:a")
        #expect(workspace.spaceId == "e1" && workspace.place == "demo")
        workspace.selection = OSWorkspace.board
        #expect(workspace.selection == OSWorkspace.board)
        #expect(workspace.spaceId == "e1" && workspace.place == "demo")
    }
}
