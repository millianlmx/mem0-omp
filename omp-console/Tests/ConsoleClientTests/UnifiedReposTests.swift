// La vue UNIFIÉE des dépôts des deux machines (S-6 de orchestrator-living-in-a-vps) :
// fusion pure de ConsoleCore, sans E/S. Les tests vivent dans la cible des tests
// hermétiques de la couche cliente (qui dépend de ConsoleCore).

import ConsoleCore
import Foundation
import Testing

private typealias Fx = RepoFixtures

private func line(_ lines: [UnifiedRepo], _ id: String) -> UnifiedRepo? {
    lines.first { $0.id == id }
}

@Suite("UnifiedRepos — la vue unifiée des dépôts")
struct UnifiedReposTests {
    @Test("orchestrator-living-in-a-vps/AC-11 : les dépôts des deux machines forment une vue, chaque ligne marquée de sa machine ; Mac injoignable → ses lignes injoignables, celles du VPS pilotables")
    func oneViewMarkedByMachine() {
        let macRows = [Fx.row("m-a", name: "a", identity: "github.com/o/a"), Fx.row("m-b", name: "b", identity: "github.com/o/b")]
        let vpsRows = [Fx.row("v-c", name: "c", identity: "github.com/o/c")]

        let both = UnifiedRepos.merge(mac: .reachable(macRows), vps: .reachable(vpsRows))
        #expect(both.map(\.id) == ["github.com/o/a", "github.com/o/b", "github.com/o/c"])
        #expect(both.map(\.conductor) == [.mac, .mac, .vps])
        #expect(both.map(\.status) == [.drivable, .drivable, .drivable])
        #expect(both.allSatisfy { $0.staleMachines.isEmpty })
        #expect(both.map(\.name) == ["a", "b", "c"])
        #expect(line(both, "github.com/o/c")?.launchTarget?.machine == .vps)
        #expect(line(both, "github.com/o/c")?.launchTarget?.row.repoKey == "v-c")

        // Le Mac est éteint : son dernier relevé parle, ses lignes sont injoignables ;
        // la ligne du VPS reste pilotable.
        let down = UnifiedRepos.merge(mac: .unreachable(lastKnown: macRows), vps: .reachable(vpsRows))
        #expect(down.count == 3)
        for id in ["github.com/o/a", "github.com/o/b"] {
            let row = line(down, id)
            #expect(row?.status == .unreachable(.mac))
            #expect(row?.staleMachines == [.mac])
            #expect(row?.launchTarget == nil)
        }
        let alive = line(down, "github.com/o/c")
        #expect(alive?.status == .drivable)
        #expect(alive?.launchTarget?.machine == .vps)
        #expect(ReposText.unreachable(.mac) == "Mac injoignable")
    }

    @Test("un dépôt connu des deux machines sous une même identité est UNE ligne portant les deux lignes de machine")
    func groupedByIdentity() {
        let mac = Fx.row("m", handover: RepoHandover(id: "h", to: .vps, state: .done))
        let vps = Fx.row("v")
        let merged = UnifiedRepos.merge(mac: .reachable([mac]), vps: .reachable([vps]))
        #expect(merged.count == 1)
        #expect(merged[0].mac == mac && merged[0].vps == vps)
        #expect(merged[0].conductor == .vps, "le Mac a confié le dépôt : le VPS le conduit")
        #expect(merged[0].status == .drivable)
        #expect(merged[0].launchTarget?.row == vps)
    }

    @Test("sans identité : une ligne par machine, nommée par la ligne de la machine")
    func noIdentityOneLinePerMachine() {
        let mac = Fx.row("k", name: "local", identity: nil)
        let vps = Fx.row("k", name: "local", identity: nil)
        let merged = UnifiedRepos.merge(mac: .reachable([mac]), vps: .reachable([vps]))
        #expect(merged.map(\.id).sorted() == ["mac:k", "vps:k"])
        #expect(merged.allSatisfy { $0.name == "local" && $0.identity == nil })
        #expect(Set(merged.compactMap(\.conductor)) == [.mac, .vps])
    }

    @Test("une bascule gelée est « en cours » ; avec un retrait en attente elle est « à terminer »")
    func frozenHandover() {
        let frozen = RepoHandover(id: "h-1", to: .vps, state: .frozen)
        let mac = Fx.row("m", handover: frozen)
        let inProgress = UnifiedRepos.merge(mac: .reachable([mac]), vps: .reachable([Fx.row("v")]))
        #expect(inProgress[0].status == .handoverInProgress(to: .vps))
        #expect(inProgress[0].frozenHandover?.source == .mac)
        #expect(inProgress[0].frozenHandover?.handover == frozen)
        #expect(inProgress[0].launchTarget == nil)
        #expect(inProgress[0].offers.isEmpty, "aucun nouveau geste pendant la bascule")

        let toFinish = UnifiedRepos.merge(mac: .reachable([mac]), vps: .reachable([Fx.row("v")]), toFinish: ["github.com/o/n"])
        #expect(toFinish[0].status == .handoverToFinish(to: .vps))
        #expect(toFinish[0].offers.isEmpty)
        #expect(ReposText.handoverInProgress(to: .vps) == "Bascule vers le VPS en cours")
    }

    @Test("deux machines sans bascule pour la même identité : conflit, avec un geste vers chaque machine")
    func conflict() {
        let merged = UnifiedRepos.merge(mac: .reachable([Fx.row("m")]), vps: .reachable([Fx.row("v")]))
        #expect(merged[0].status == .conflict)
        #expect(merged[0].conductor == nil)
        #expect(merged[0].launchTarget == nil)
        #expect(merged[0].offers.map(\.to) == [.mac, .vps])
        #expect(merged[0].offers.allSatisfy { $0.isEnabled })
    }

    @Test("une machine non configurée n'apporte aucune ligne et le geste « Confier » dit qu'elle n'est pas appairée")
    func notConfigured() {
        let merged = UnifiedRepos.merge(mac: .reachable([Fx.row("m")]), vps: .notConfigured)
        #expect(merged.count == 1)
        #expect(merged[0].conductor == .mac && merged[0].status == .drivable)
        #expect(merged[0].offers == [HandoverOffer(from: .mac, to: .vps, disabledReason: "Le VPS n’est pas appairé")])
        #expect(merged[0].offers[0].isEnabled == false)

        let neither = UnifiedRepos.merge(mac: .notConfigured, vps: .notConfigured)
        #expect(neither.isEmpty)
    }

    @Test("motifs de désactivation du geste « Confier » : cible non appairée, source injoignable, cible injoignable, sans dépôt distant")
    func offerDisabledReasons() {
        let row = Fx.row("m")
        // Source injoignable.
        let sourceDown = UnifiedRepos.merge(mac: .unreachable(lastKnown: [row]), vps: .reachable([]))
        #expect(sourceDown[0].offers.map(\.disabledReason) == ["Mac injoignable"])
        // Cible injoignable.
        let targetDown = UnifiedRepos.merge(mac: .reachable([row]), vps: .unreachable(lastKnown: []))
        #expect(targetDown[0].offers.map(\.disabledReason) == ["VPS injoignable"])
        // Pas de dépôt distant GitHub.
        let local = UnifiedRepos.merge(mac: .reachable([Fx.row("m", identity: nil)]), vps: .reachable([]))
        #expect(local[0].offers.map(\.disabledReason) == ["Ce dépôt n’a pas de dépôt distant GitHub"])
        // Tout va bien : le geste est offert.
        let ready = UnifiedRepos.merge(mac: .reachable([row]), vps: .reachable([]))
        #expect(ready[0].offers == [HandoverOffer(from: .mac, to: .vps, disabledReason: nil)])
        #expect(ReposText.handoverButton(to: .vps) == "Confier au VPS")
        #expect(ReposText.handoverButton(to: .mac) == "Confier au Mac")
    }

    @Test("« N feature(s) finissent sur le Mac » : la machine non conductrice garde ses features démarrées")
    func finishingOnTheOldConductor() {
        let mac = Fx.row("m", handover: RepoHandover(id: "h", to: .vps, state: .done))
        let merged = UnifiedRepos.merge(
            mac: .reachable([mac]),
            vps: .reachable([Fx.row("v")]),
            finishing: [.mac: ["m": 2]]
        )
        #expect(merged[0].conductor == .vps)
        #expect(merged[0].finishing?.machine == .mac)
        #expect(merged[0].finishing?.count == 2)
        #expect(ReposText.finishing(2, on: .mac) == "2 feature(s) finissent sur le Mac")

        let none = UnifiedRepos.merge(mac: .reachable([mac]), vps: .reachable([Fx.row("v")]))
        #expect(none[0].finishing == nil)
    }

    @Test("les features démarrées et pas encore démarrées se lisent dans l'instantané de la machine")
    func countsFromSnapshot() {
        let snapshot = Fx.snapshot(root: "/work/m", features: [
            Fx.feature("run", state: .running, worktree: "/work/m-run"),
            Fx.feature("wait", state: .waiting, worktree: "/work/m-wait"),
            Fx.feature("done", state: .done, worktree: "/work/m-done"),
            Fx.feature("todo", state: .pending, worktree: ""),
            Fx.feature("todo2", state: .pending, worktree: ""),
        ])
        #expect(UnifiedRepos.startedUnfinished(in: snapshot, repoRoot: "/work/m") == 2)
        #expect(UnifiedRepos.notStarted(in: snapshot, repoRoot: "/work/m") == 2)
        #expect(UnifiedRepos.startedUnfinished(in: snapshot, repoRoot: "/autre") == 0)
        #expect(UnifiedRepos.startedUnfinished(in: nil, repoRoot: "/work/m") == 0)
        let counts = UnifiedRepos.finishingCounts(rows: [Fx.row("m", root: "/work/m"), Fx.row("z", root: "/vide")], snapshot: snapshot)
        #expect(counts == ["m": 2])
    }

    @Test("le dernier relevé d'une machine se sérialise et se relit ; une valeur illisible donne un relevé vide")
    func lastKnownRoundTrip() {
        let rows = [Fx.row("m", handover: RepoHandover(id: "h", to: .vps, state: .frozen)), Fx.row("z", identity: nil)]
        let text = UnifiedRepos.encodeLastKnown(rows)
        #expect(UnifiedRepos.decodeLastKnown(text) == rows)
        #expect(UnifiedRepos.decodeLastKnown(nil).isEmpty)
        #expect(UnifiedRepos.decodeLastKnown("{pas du json").isEmpty)
        #expect(UnifiedRepos.lastReposKey(.vps) == "machines.vps.lastRepos")
    }

    @Test("sans VPS configuré l'ardoise du Mac est rendue telle quelle, sans badge ; avec un VPS les cartes sont préfixées et une machine injoignable donne un bandeau")
    func unifiedBoard() {
        let macCard = KanbanCard(
            id: "c1", column: .enCours, repo: "r", title: "t", state: "s", phase: nil, models: nil,
            prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: []
        )
        let vpsCard = KanbanCard(
            id: "c2", column: .enCours, repo: "r", title: "t", state: "s", phase: nil, models: nil,
            prUrl: nil, startMs: 0, endMs: nil, marks: [], sources: []
        )
        let macState = KanbanBoardState.board(KanbanBoard(cards: [macCard], anomalies: []))
        let vpsState = KanbanBoardState.board(KanbanBoard(cards: [vpsCard], anomalies: []))

        let alone = UnifiedBoard.merge(mac: .state(macState), vps: .notConfigured)
        #expect(alone == UnifiedBoard(state: macState, unreachable: [], showsBadges: false))

        let both = UnifiedBoard.merge(mac: .state(macState), vps: .state(vpsState))
        guard case .board(let board) = both.state else {
            Issue.record("ardoise attendue")
            return
        }
        #expect(board.cards.map(\.id) == ["c1", "vps:c2"])
        #expect(both.showsBadges && both.unreachable.isEmpty)
        #expect(board.cards.map { MachineCardID.machine(of: $0.id) } == [.mac, .vps])
        #expect(board.cards.map { MachineCardID.raw($0.id) } == ["c1", "c2"])

        let macDown = UnifiedBoard.merge(mac: .unreachable, vps: .state(vpsState))
        guard case .board(let remaining) = macDown.state else {
            Issue.record("ardoise attendue")
            return
        }
        #expect(remaining.cards.map(\.id) == ["vps:c2"])
        #expect(macDown.unreachable == [.mac])
        #expect(ReposText.machineBanner(.mac) == "Mac injoignable")
    }
}
