// Preuves du SUPERVISEUR d'ownership (S-5, BR-8 ; AC-5) : la transition figée
// « les deux ports étaient à nous » → « un ne l'est plus » émet UN SEUL évènement,
// livré par le chemin d'alerte EXISTANT (registre + livreur).
//
// Aucun vrai `lsof`/`ps`/socket : `OwnershipRunner` route par binaire ABSOLU et
// répond selon le script du test. Le magasin et le registre sont de vraies fixtures.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - La doublure de `CommandRunner`

/// La doublure de sonde pour le superviseur : elle tient, par port, le verdict à
/// rendre (`lsof` + `ps`), et le script change entre deux observations.
///
/// `@unchecked Sendable` : tous les accès viennent du MainActor (les tests y vivent).
final class OwnershipRunner: @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [Int: MemoryPortOwnership]
    private let supportRoot: URL

    init(_ answers: [Int: MemoryPortOwnership], supportRoot: URL) {
        self.answers = answers
        self.supportRoot = supportRoot
    }

    func set(_ port: Int, _ ownership: MemoryPortOwnership) {
        withLock { answers[port] = ownership }
    }

    private func answer(_ port: Int) -> MemoryPortOwnership {
        withLock { answers[port] ?? .free }
    }

    private func withLock<T>(_ body: () -> T) -> T {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    /// Le PID conventionnel de la pile de l'app : `ps` y rattache `<supportRoot>/`.
    static let oursPid: Int32 = 900

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, _, _ in
            if binary.path == "/usr/sbin/lsof" { return lsof(arguments) }
            if binary.path == "/bin/ps" { return ps(arguments) }
            // curl sur un socket Docker : muet ⇒ aucune ancienne pile détectée.
            return ProcessRun(code: 7, stdout: "", stderr: "socket muet", timedOut: false)
        }
    }

    private func lsof(_ arguments: [String]) -> ProcessRun {
        let port = arguments.first { $0.hasPrefix("-iTCP:") }
            .flatMap { Int($0.dropFirst("-iTCP:".count)) } ?? 0
        switch answer(port) {
        case .ours:
            return ProcessRun(code: 0, stdout: "p\(Self.oursPid)\ncqemu\n", stderr: "", timedOut: false)
        case .foreign(_, let pid):
            return ProcessRun(code: 0, stdout: "p\(pid)\ncpython3\n", stderr: "", timedOut: false)
        case .legacyStack:
            return ProcessRun(code: 0, stdout: "p901\ncforwarder\n", stderr: "", timedOut: false)
        case .free:
            return ProcessRun(code: 1, stdout: "", stderr: "", timedOut: false)
        case .unknown:
            return ProcessRun(code: 2, stdout: "", stderr: "lsof cassé", timedOut: false)
        }
    }

    private func ps(_ arguments: [String]) -> ProcessRun {
        let pid = arguments.dropFirst().first.flatMap { Int32($0) } ?? 0
        let command = pid == Self.oursPid
            ? supportRoot.path + "/bin/qemu"
            : "/usr/bin/python3"
        return ProcessRun(code: 0, stdout: command + "\n", stderr: "", timedOut: false)
    }
}

// MARK: - Le montage

private let ownershipSupportRoot = URL(fileURLWithPath: "/tmp/omp-ownership-support", isDirectory: true)
private let ours = MemoryPortOwnership.ours(process: "qemu", pid: OwnershipRunner.oursPid)
private let foreign4711 = MemoryPortOwnership.foreign(process: "python3", pid: 4711)

/// Monte la chaîne complète : superviseur → abonnement d'`AlertsModel` → registre +
/// livreur. La scrutation AUTOMATIQUE est annulée aussitôt : les `refresh()` sont
/// pilotés par le test, donc déterministes.
@MainActor
private func ownershipChain(
    _ answers: [Int: MemoryPortOwnership],
    fixture: StoreFixture,
    deliverer: RecorderAlertDeliverer,
    ledgerPath: String
) -> (ownership: StackOwnershipModel, alerts: AlertsModel, runner: OwnershipRunner) {
    let runner = OwnershipRunner(answers, supportRoot: ownershipSupportRoot)
    let ownership = StackOwnershipModel(
        paths: AppPaths(supportRoot: ownershipSupportRoot),
        environment: [:],
        run: runner.runner,
        nowMs: { fixtureT0 }
    )
    ownership.interval = 3_600
    let alerts = AlertsModel(
        hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }),
        ledgerPath: ledgerPath,
        deliverer: deliverer,
        isWindowFrontmost: { false },
        nowMs: { fixtureT0 },
        ownership: ownership
    )
    alerts.start()
    ownership.stop()  // seule la scrutation auto est coupée ; l'abonnement reste
    return (ownership, alerts, runner)
}

// MARK: - AC-5 : la transition émet UNE alerte, texte et clé figés

@MainActor
@Test("bug-embedded-podman-machine/AC-5 : ours → foreign(pid) émet UNE alerte, clé `process:<pid>`, clé au registre")
func ownershipLossEmitsExactlyOneAlert() async {
    let fixture = StoreFixture()
    let ledgerPath = fixtureLedgerPath(fixture)
    let deliverer = RecorderAlertDeliverer()
    let chain = ownershipChain(
        [8321: ours, 6333: ours],
        fixture: fixture,
        deliverer: deliverer,
        ledgerPath: ledgerPath
    )
    defer { chain.alerts.stop() }

    // (1) Les deux ports sont à nous : aucun évènement (ce n'est pas une perte).
    await chain.ownership.refresh()
    #expect(chain.ownership.holders.count == 2)
    try? await Task.sleep(for: .milliseconds(50))
    #expect(deliverer.messages.isEmpty)

    // (2) 8321 passe à un python3 étranger : UN évènement.
    chain.runner.set(8321, foreign4711)
    await chain.ownership.refresh()
    #expect(await awaitMainTrue { deliverer.messages.count == 1 })
    #expect(deliverer.keys == ["stack-ownership-lost:8321:process:4711"])
    #expect(deliverer.messages.first?.title == "La pile mémoire d'OMP Console a perdu le port 8321")
    #expect(deliverer.messages.first?.body == "un autre programme (python3, pid 4711) l'occupe désormais : les souvenirs ne passent plus par la pile de l'app.")
    #expect(!AlertLedger(path: ledgerPath).contains("stack-ownership-lost:8321:process:4712"))

    // (3) Même état : aucun nouvel évènement.
    await chain.ownership.refresh()
    try? await Task.sleep(for: .milliseconds(80))
    #expect(deliverer.messages.count == 1)

    // Le registre porte EXACTEMENT la clé de la perte.
    let ledger = AlertLedger(path: ledgerPath)
    #expect(ledger.contains("stack-ownership-lost:8321:process:4711"))
}

@MainActor
@Test("bug-embedded-podman-machine/AC-5 : une pile jamais tenue n'émet AUCUN évènement (une absence n'est pas une perte)")
func neverHeldEmitsNothing() async {
    let fixture = StoreFixture()
    let ledgerPath = fixtureLedgerPath(fixture)
    let deliverer = RecorderAlertDeliverer()
    let chain = ownershipChain(
        [8321: foreign4711, 6333: foreign4711],
        fixture: fixture,
        deliverer: deliverer,
        ledgerPath: ledgerPath
    )
    defer { chain.alerts.stop() }

    await chain.ownership.refresh()
    await chain.ownership.refresh()
    await chain.ownership.refresh()
    try? await Task.sleep(for: .milliseconds(80))

    #expect(deliverer.messages.isEmpty)
    #expect(!AlertLedger(path: ledgerPath).contains("stack-ownership-lost:8321:process:4711"))
}

@MainActor
@Test("bug-embedded-podman-machine/AC-5 : un propriétaire DIFFÉRENT (autre pid) produit une nouvelle clé")
func differentOwnerGetsNewKey() async {
    let fixture = StoreFixture()
    let ledgerPath = fixtureLedgerPath(fixture)
    let deliverer = RecorderAlertDeliverer()
    let chain = ownershipChain(
        [8321: ours, 6333: ours],
        fixture: fixture,
        deliverer: deliverer,
        ledgerPath: ledgerPath
    )
    defer { chain.alerts.stop() }

    await chain.ownership.refresh()
    chain.runner.set(8321, foreign4711)
    await chain.ownership.refresh()
    #expect(await awaitMainTrue { deliverer.messages.count == 1 })

    // La pile reprend son port, puis le reperd au profit d'un AUTRE programme.
    chain.runner.set(8321, ours)
    await chain.ownership.refresh()
    chain.runner.set(8321, .foreign(process: "postgres", pid: 4722))
    await chain.ownership.refresh()
    #expect(await awaitMainTrue { deliverer.messages.count == 2 })

    #expect(deliverer.keys == [
        "stack-ownership-lost:8321:process:4711",
        "stack-ownership-lost:8321:process:4722",
    ])
}

@MainActor
@Test("bug-embedded-podman-machine/AC-5 : `lsof` indisponible (`.unknown`) est traité comme une perte")
func unknownCountsAsLoss() async {
    let fixture = StoreFixture()
    let ledgerPath = fixtureLedgerPath(fixture)
    let deliverer = RecorderAlertDeliverer()
    let chain = ownershipChain(
        [8321: ours, 6333: ours],
        fixture: fixture,
        deliverer: deliverer,
        ledgerPath: ledgerPath
    )
    defer { chain.alerts.stop() }

    await chain.ownership.refresh()
    chain.runner.set(8321, .unknown(detail: "lsof cassé"))
    await chain.ownership.refresh()
    #expect(await awaitMainTrue { deliverer.messages.count == 1 })

    #expect(deliverer.keys == ["stack-ownership-lost:8321:unknown"])
    #expect(deliverer.messages.first?.body == "indéterminé (lsof cassé) l'occupe désormais : les souvenirs ne passent plus par la pile de l'app.")
}

// MARK: - L'ordre figé `[8321, 6333]`

@MainActor
@Test("bug-embedded-podman-machine/AC-5 : le premier port perdu de l'ordre [8321, 6333] désigne l'évènement")
func firstLostPortWins() async {
    let fixture = StoreFixture()
    let ledgerPath = fixtureLedgerPath(fixture)
    let deliverer = RecorderAlertDeliverer()
    let chain = ownershipChain(
        [8321: ours, 6333: ours],
        fixture: fixture,
        deliverer: deliverer,
        ledgerPath: ledgerPath
    )
    defer { chain.alerts.stop() }

    // Seul 6333 est perdu ⇒ l'évènement désigne 6333.
    await chain.ownership.refresh()
    chain.runner.set(6333, foreign4711)
    await chain.ownership.refresh()
    #expect(await awaitMainTrue { deliverer.messages.count == 1 })
    #expect(deliverer.keys == ["stack-ownership-lost:6333:process:4711"])
}

@MainActor
@Test("bug-embedded-podman-machine/AC-5 : deux ports perdus ensemble ⇒ UN SEUL évènement, pour 8321")
func bothLostEmitOneEvent() async {
    let fixture = StoreFixture()
    let ledgerPath = fixtureLedgerPath(fixture)
    let deliverer = RecorderAlertDeliverer()
    let chain = ownershipChain(
        [8321: ours, 6333: ours],
        fixture: fixture,
        deliverer: deliverer,
        ledgerPath: ledgerPath
    )
    defer { chain.alerts.stop() }

    await chain.ownership.refresh()
    chain.runner.set(8321, foreign4711)
    chain.runner.set(6333, .foreign(process: "postgres", pid: 4722))
    await chain.ownership.refresh()
    #expect(await awaitMainTrue { deliverer.messages.count == 1 })
    try? await Task.sleep(for: .milliseconds(80))

    #expect(deliverer.messages.count == 1)
    #expect(deliverer.keys == ["stack-ownership-lost:8321:process:4711"])
}

// MARK: - La scrutation

@MainActor
@Test("bug-embedded-podman-machine/AC-5 : `start()` sonde à l'intervalle donné, `stop()` l'arrête")
func startPollsUntilStopped() async {
    let runner = OwnershipRunner([8321: ours, 6333: ours], supportRoot: ownershipSupportRoot)
    let ownership = StackOwnershipModel(
        paths: AppPaths(supportRoot: ownershipSupportRoot),
        environment: [:],
        run: runner.runner,
        nowMs: { 0 }
    )
    ownership.interval = 0.05
    ownership.start()
    #expect(await awaitMainTrue { ownership.holders.count == 2 })

    ownership.stop()
    let stoppedAt = ownership.holders
    runner.set(8321, foreign4711)
    try? await Task.sleep(for: .milliseconds(200))
    // Arrêté : plus aucune observation n'a eu lieu.
    #expect(ownership.holders == stoppedAt)
}
