// Le modèle de la section « Dépôts » (S-6 de orchestrator-living-in-a-vps) sur DEUX
// machines factices : lecture et fusion, dernier relevé mémorisé, bascule en trois
// temps, « Réessayer » et « Annuler la bascule », persistance de la bascule à
// terminer. Aucun réseau, aucune attente réelle.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private typealias Fx = RepoFixtures

@MainActor
private struct Rig {
    let log = CallLog()
    let sleeps = SleepRecorder()
    let preferences: InMemoryClientPreferences
    let mac: FakeMachineSource
    let vps: FakeMachineSource
    let model: UnifiedReposModel

    init(
        macRows: [RepoRow] = [],
        vpsRows: [RepoRow] = [],
        macAvailability: MachineAvailability = .reachable,
        vpsAvailability: MachineAvailability = .reachable,
        macEndpoint: ((CallLog) -> FakeEndpoint)? = nil,
        vpsEndpoint: ((CallLog) -> FakeEndpoint)? = nil,
        preferences initial: [String: String] = [:]
    ) {
        preferences = InMemoryClientPreferences(initial)
        mac = FakeMachineSource(
            .mac, availability: macAvailability, repos: macRows,
            endpoint: macEndpoint?(log) ?? FakeEndpoint("mac", log: log)
        )
        vps = FakeMachineSource(
            .vps, availability: vpsAvailability, repos: vpsRows,
            endpoint: vpsEndpoint?(log) ?? FakeEndpoint("vps", log: log)
        )
        model = UnifiedReposModel(mac: mac, vps: vps, preferences: preferences, sleep: sleeps.sleep)
    }
}

@Suite("UnifiedReposModel — la section Dépôts sur deux machines")
@MainActor
struct UnifiedReposModelTests {
    @Test("avant toute lecture la phase est « chargement » ; après, les dépôts des deux machines sont fusionnés")
    func refreshMergesBothMachines() async {
        let rig = Rig(macRows: [Fx.row("m-a", identity: "github.com/o/a")], vpsRows: [Fx.row("v-b", identity: "github.com/o/b")])
        #expect(rig.model.phase == .loading)
        await rig.model.refresh()
        #expect(rig.model.phase == .ready)
        #expect(rig.model.lines.map(\.id) == ["github.com/o/a", "github.com/o/b"])
        #expect(rig.model.lines.map(\.conductor) == [.mac, .vps])
        #expect(rig.mac.fetchCount == 1 && rig.vps.fetchCount == 1)
    }

    @Test("le relevé de chaque machine est mémorisé ; une machine injoignable au démarrage parle par son dernier relevé")
    func lastKnownSurvivesAnOutage() async {
        let first = Rig(macRows: [Fx.row("m-a", identity: "github.com/o/a")], vpsRows: [Fx.row("v-b", identity: "github.com/o/b")])
        await first.model.refresh()
        let stored = first.preferences.string(forKey: "machines.mac.lastRepos")
        #expect(stored != nil)
        #expect(first.preferences.string(forKey: "machines.vps.lastRepos") != nil)

        // Nouvelle session : le Mac est éteint, le VPS répond.
        let second = Rig(
            vpsRows: [Fx.row("v-b", identity: "github.com/o/b")],
            macAvailability: .unreachable,
            preferences: ["machines.mac.lastRepos": stored ?? ""]
        )
        await second.model.refresh()
        #expect(second.mac.fetchCount == 0, "une machine injoignable n'est pas lue")
        let lines = second.model.lines
        #expect(lines.map(\.id) == ["github.com/o/a", "github.com/o/b"])
        #expect(lines[0].status == .unreachable(.mac))
        #expect(lines[0].staleMachines == [.mac])
        #expect(lines[1].status == .drivable)
        #expect(lines[1].launchTarget?.machine == .vps)
    }

    @Test("une lecture qui échoue rend la machine injoignable pour ce relevé, sans perdre le précédent")
    func failedReadMakesTheMachineUnreachable() async {
        let rig = Rig(macRows: [Fx.row("m-a", identity: "github.com/o/a")])
        await rig.model.refresh()
        #expect(rig.model.lines[0].status == .drivable)
        rig.mac.repos = nil
        await rig.model.refresh()
        #expect(rig.model.lines.map(\.id) == ["github.com/o/a"])
        #expect(rig.model.lines[0].status == .unreachable(.mac))
    }

    @Test("une machine non configurée n'apporte aucune ligne")
    func notConfiguredMachine() async {
        let rig = Rig(macRows: [Fx.row("m-a", identity: "github.com/o/a")], vpsAvailability: .notConfigured)
        await rig.model.refresh()
        #expect(rig.model.lines.count == 1)
        #expect(rig.model.lines[0].offers.first?.disabledReason == "Le VPS n’est pas appairé")
        #expect(rig.vps.fetchCount == 0)
    }

    @Test("la phrase de confirmation compte les features pas encore démarrées lues dans l'instantané de la source")
    func confirmationCountsNotStarted() async {
        let row = Fx.row("m", root: "/work/m")
        let rig = Rig(macRows: [row])
        rig.mac.snapshot = Fx.snapshot(root: "/work/m", features: [
            Fx.feature("run", state: .running, worktree: "/w/run"),
            Fx.feature("a", state: .pending, worktree: ""),
            Fx.feature("b", state: .pending, worktree: ""),
        ])
        await rig.model.refresh()
        let line = rig.model.lines[0]
        let offer = line.offers[0]
        #expect(rig.model.confirmation(for: line, offer: offer)
            == "Confier n au VPS\u{00A0}? Les features en cours finissent sur le Mac\u{00A0}; 2 feature(s) pas encore démarrée(s) partent sur le VPS.")
    }

    @Test("« Confier » : les trois temps partent vers les bonnes machines, le succès est dit en une phrase et les dépôts sont relus")
    func handOverSucceeds() async {
        let rig = Rig(macRows: [Fx.row("m")], vpsRows: [])
        await rig.model.refresh()
        let line = rig.model.lines[0]
        await rig.model.handOver(line, offer: line.offers[0])
        #expect(rig.log.entries == [
            "mac.handover(m,vps)",
            "vps.adopt(github.com/o/n,a+b)",
            "mac.commit(m,h-1,a+b)",
        ])
        #expect(rig.model.message == .success("n est confié au VPS\u{00A0}: 2 feature(s) y démarrent."))
        #expect(rig.model.busy.isEmpty)
        #expect(rig.model.unfinished.isEmpty)
        #expect(rig.mac.fetchCount == 2, "les dépôts sont relus après la bascule")
    }

    @Test("un geste désactivé n'émet rien")
    func disabledOfferEmitsNothing() async {
        let rig = Rig(macRows: [Fx.row("m", identity: nil)], vpsRows: [])
        await rig.model.refresh()
        let line = rig.model.lines[0]
        #expect(line.offers[0].isEnabled == false)
        await rig.model.handOver(line, offer: line.offers[0])
        #expect(rig.log.entries.isEmpty)
        #expect(rig.model.message == nil)
    }

    @Test("un refus de la cible rouvre la source et affiche le motif tel quel")
    func adoptFailureShowsTheReason() async {
        let rig = Rig(
            macRows: [Fx.row("m")],
            vpsEndpoint: { FakeEndpoint("vps", log: $0, adoptError: HandoverFailure("clonage impossible : réseau")) }
        )
        await rig.model.refresh()
        let line = rig.model.lines[0]
        await rig.model.handOver(line, offer: line.offers[0])
        #expect(rig.log.entries.last == "mac.cancel(m,h-1)")
        #expect(rig.model.message == .failure("clonage impossible : réseau"))
        #expect(rig.model.unfinished.isEmpty)
    }

    @Test("un retrait final qui échoue laisse la bascule « à terminer » ; « Réessayer » ne refait que le retrait ; « Annuler » est impossible")
    func toFinishThenRetry() async {
        let frozen = RepoHandover(id: "h-1", to: .vps, state: .frozen)
        let rig = Rig(
            macRows: [Fx.row("m")],
            macEndpoint: { FakeEndpoint("mac", log: $0, commitFailures: 4, commitError: HandoverFailure("Mac injoignable")) }
        )
        await rig.model.refresh()
        var line = rig.model.lines[0]
        await rig.model.handOver(line, offer: line.offers[0])
        #expect(rig.sleeps.delays == [2, 2, 2])
        #expect(rig.model.unfinished[line.id]?.launched == ["a", "b"])
        #expect(rig.model.message == .failure("Mac injoignable"))

        // La source dit « gelée » : la ligne est « à terminer ».
        rig.mac.repos = [Fx.row("m", handover: frozen)]
        await rig.model.refresh()
        line = rig.model.lines[0]
        #expect(line.status == .handoverToFinish(to: .vps))

        // Annuler est impossible : la cible a démarré.
        let before = rig.log.entries.count
        await rig.model.cancelHandover(line)
        #expect(rig.log.entries.count == before)

        // Réessayer = refaire le retrait seul (le 5e appel de commit aboutit).
        await rig.model.retry(line)
        #expect(Array(rig.log.entries[before...]) == ["mac.commit(m,h-1,a+b)"])
        #expect(rig.model.unfinished.isEmpty)
        #expect(rig.model.message == .success("n est confié au VPS\u{00A0}: 2 feature(s) y démarrent."))
        #expect(rig.preferences.string(forKey: UnifiedRepos.unfinishedKey) == nil)
    }

    @Test("la bascule à terminer survit au redémarrage de l'app : « Annuler la bascule » ne rouvre pas la source")
    func toFinishSurvivesRestart() async {
        let first = Rig(
            macRows: [Fx.row("m")],
            macEndpoint: { FakeEndpoint("mac", log: $0, commitFailures: Int.max) }
        )
        await first.model.refresh()
        let line = first.model.lines[0]
        await first.model.handOver(line, offer: line.offers[0])
        let stored = first.preferences.string(forKey: UnifiedRepos.unfinishedKey)
        #expect(stored != nil)

        let frozen = Fx.row("m", handover: RepoHandover(id: "h-1", to: .vps, state: .frozen))
        let second = Rig(macRows: [frozen], preferences: [UnifiedRepos.unfinishedKey: stored ?? ""])
        #expect(second.model.unfinished[line.id]?.handoverId == "h-1")
        await second.model.refresh()
        #expect(second.model.lines[0].status == .handoverToFinish(to: .vps))
        await second.model.cancelHandover(second.model.lines[0])
        #expect(second.log.entries.isEmpty, "annuler rouvrirait la source alors que la cible a démarré")
        await second.model.retry(second.model.lines[0])
        #expect(second.log.entries == ["mac.commit(m,h-1,a+b)"])
        #expect(second.preferences.string(forKey: UnifiedRepos.unfinishedKey) == nil)
    }

    @Test("« Annuler la bascule » rouvre la source d'une bascule gelée")
    func cancelFrozenHandover() async {
        let frozen = Fx.row("m", handover: RepoHandover(id: "h-7", to: .vps, state: .frozen))
        let rig = Rig(macRows: [frozen], vpsRows: [Fx.row("v")])
        await rig.model.refresh()
        let line = rig.model.lines[0]
        #expect(line.status == .handoverInProgress(to: .vps))
        await rig.model.cancelHandover(line)
        #expect(rig.log.entries == ["mac.cancel(m,h-7)"])
        #expect(rig.model.message == nil)
    }

    @Test("un refus du geste « Annuler » affiche le motif")
    func cancelRefusalShowsTheReason() async {
        let frozen = Fx.row("m", handover: RepoHandover(id: "h-7", to: .vps, state: .frozen))
        let rig = Rig(
            macRows: [frozen], vpsRows: [Fx.row("v")],
            macEndpoint: { FakeEndpoint("mac", log: $0, cancelError: HandoverFailure("bascule déjà terminée")) }
        )
        await rig.model.refresh()
        await rig.model.cancelHandover(rig.model.lines[0])
        #expect(rig.model.message == .failure("bascule déjà terminée"))
        rig.model.dismissMessage()
        #expect(rig.model.message == nil)
    }

    @Test("un changement de disponibilité d'une machine relit les dépôts")
    func availabilityChangeRefreshes() async {
        let rig = Rig(macRows: [Fx.row("m-a", identity: "github.com/o/a")], vpsAvailability: .unreachable)
        await rig.model.refresh()
        #expect(rig.vps.fetchCount == 0)
        rig.vps.repos = [Fx.row("v-b", identity: "github.com/o/b")]
        rig.vps.availability = .reachable
        let seen = await eventually { rig.model.lines.count == 2 }
        #expect(seen)
        #expect(rig.vps.fetchCount >= 1)
    }
}
