// La bascule d'un dépôt orchestrée par le client (S-5, S-6 de
// orchestrator-living-in-a-vps) : trois temps — handover sur la source, adopt sur
// la cible, commit sur la source —, annulation si la cible échoue, trois reprises
// à 2 s si le retrait final échoue. Extrémités et attente SCRIPTÉES : aucun réseau,
// aucune attente réelle.

@testable import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private func flow(
    source: FakeEndpoint,
    target: FakeEndpoint,
    sleeps: SleepRecorder
) -> HandoverFlow {
    HandoverFlow(source: source, target: target, sleep: sleeps.sleep)
}

@Suite("HandoverFlow — la bascule en trois temps")
struct HandoverFlowTests {
    @Test("orchestrator-living-in-a-vps/AC-9 : handover sur la source, adopt sur la cible avec les features reçues, commit sur la source avec les features lancées ; échec en 2 → DELETE puis erreur ; échec en 3 → 3 reprises à 2 s puis « bascule à terminer »")
    func gestureSequenceAndFailures() async {
        // Séquence nominale : 1 handover(source) → 2 adopt(cible, features) → 3 commit(source, launched).
        let log = CallLog()
        let sleeps = SleepRecorder()
        let source = FakeEndpoint("mac", log: log)
        let target = FakeEndpoint("vps", log: log)
        let done = await flow(source: source, target: target, sleeps: sleeps)
            .run(from: .mac, to: .vps, repoKey: "k-mac", name: "n")
        #expect(log.entries == [
            "mac.handover(k-mac,vps)",
            "vps.adopt(github.com/o/n,a+b)",
            "mac.commit(k-mac,h-1,a+b)",
        ])
        #expect(done == .completed(launched: 2, refused: []))
        #expect(sleeps.delays.isEmpty)

        // Échec en 2 : DELETE sur la source, puis le motif tel quel ; jamais de commit.
        let failedLog = CallLog()
        let failedSource = FakeEndpoint("mac", log: failedLog)
        let failedTarget = FakeEndpoint("vps", log: failedLog, adoptError: HandoverFailure("dépôt absent de ce Mac"))
        let failed = await flow(source: failedSource, target: failedTarget, sleeps: SleepRecorder())
            .run(from: .mac, to: .vps, repoKey: "k-mac", name: "n")
        #expect(failedLog.entries == [
            "mac.handover(k-mac,vps)",
            "vps.adopt(github.com/o/n,a+b)",
            "mac.cancel(k-mac,h-1)",
        ])
        #expect(failed == .failed("dépôt absent de ce Mac"))

        // Échec en 3 : une tentative + 3 reprises espacées de 2 s, puis « bascule à terminer » ;
        // la source n'est JAMAIS rouverte (la cible a démarré).
        let stuckLog = CallLog()
        let stuckSleeps = SleepRecorder()
        let stuckSource = FakeEndpoint("mac", log: stuckLog, commitFailures: Int.max, commitError: HandoverFailure("VPS injoignable"))
        let stuckTarget = FakeEndpoint("vps", log: stuckLog)
        let stuck = await flow(source: stuckSource, target: stuckTarget, sleeps: stuckSleeps)
            .run(from: .mac, to: .vps, repoKey: "k-mac", name: "n")
        #expect(stuckSource.commits == Array(repeating: ["a", "b"], count: 4))
        #expect(stuckSleeps.delays == [2, 2, 2])
        #expect(!stuckLog.entries.contains { $0.hasSuffix(".cancel(k-mac,h-1)") })
        guard case .toFinish(let pending) = stuck else {
            Issue.record("attendu .toFinish, reçu \(stuck)")
            return
        }
        #expect(pending.repoKey == "k-mac" && pending.handoverId == "h-1" && pending.launched == ["a", "b"])
        #expect(pending.from == .mac && pending.to == .vps && pending.name == "n")
        #expect(pending.message == "VPS injoignable")

        // « Réessayer » = refaire le 3 seul : ni handover ni adopt.
        let retryLog = CallLog()
        let retrySource = FakeEndpoint("mac", log: retryLog)
        let retried = await flow(source: retrySource, target: FakeEndpoint("vps", log: retryLog), sleeps: SleepRecorder())
            .finish(pending)
        #expect(retryLog.entries == ["mac.commit(k-mac,h-1,a+b)"])
        #expect(retried == .completed(launched: 2, refused: []))
    }

    @Test("un échec du handover sur la source n'appelle ni adopt ni cancel et rend le motif tel quel")
    func handoverFailureStopsEverything() async {
        let log = CallLog()
        let source = FakeEndpoint("mac", log: log, handoverError: HandoverFailure("dépôt sans dépôt distant GitHub"))
        let outcome = await flow(source: source, target: FakeEndpoint("vps", log: log), sleeps: SleepRecorder())
            .run(from: .mac, to: .vps, repoKey: "k-mac", name: "n")
        #expect(outcome == .failed("dépôt sans dépôt distant GitHub"))
        #expect(log.entries == ["mac.handover(k-mac,vps)"])
    }

    @Test("un échec en 2 dont l'annulation échoue aussi nomme le motif ET l'impossibilité de rouvrir la source")
    func cancelFailureIsReported() async {
        let log = CallLog()
        let source = FakeEndpoint("mac", log: log, cancelError: HandoverFailure("machine injoignable"))
        let target = FakeEndpoint("vps", log: log, adoptError: HandoverFailure("clonage impossible : timeout"))
        let outcome = await flow(source: source, target: target, sleeps: SleepRecorder())
            .run(from: .mac, to: .vps, repoKey: "k-mac", name: "n")
        guard case .failed(let message) = outcome else {
            Issue.record("attendu .failed, reçu \(outcome)")
            return
        }
        #expect(message.hasPrefix("clonage impossible : timeout"))
        #expect(message.contains("machine injoignable"))
    }

    @Test("un retrait qui aboutit à la reprise 2 termine la bascule après un seul délai de 2 s")
    func commitSucceedsOnSecondAttempt() async {
        let log = CallLog()
        let sleeps = SleepRecorder()
        let source = FakeEndpoint("mac", log: log, commitFailures: 1)
        let outcome = await flow(source: source, target: FakeEndpoint("vps", log: log), sleeps: sleeps)
            .run(from: .mac, to: .vps, repoKey: "k-mac", name: "n")
        #expect(outcome == .completed(launched: 2, refused: []))
        #expect(source.commits.count == 2)
        #expect(sleeps.delays == [2])
    }

    @Test("le retrait ne porte que les features réellement lancées ; les refus de la cible sont rendus")
    func refusalsAreNotCommitted() async {
        let log = CallLog()
        let adoption = HandoverAdoption(
            repoKey: "k-vps", repoRoot: "/srv/r", cloned: false, launched: ["a"],
            refused: [HandoverRefusal(slug: "b", reason: "dépendance absente")]
        )
        let source = FakeEndpoint("mac", log: log)
        let outcome = await flow(source: source, target: FakeEndpoint("vps", log: log, adoption: adoption), sleeps: SleepRecorder())
            .run(from: .mac, to: .vps, repoKey: "k-mac", name: "n")
        #expect(source.commits == [["a"]])
        #expect(outcome == .completed(launched: 1, refused: [HandoverRefusal(slug: "b", reason: "dépendance absente")]))
    }

    @Test("le geste « Annuler la bascule » rouvre la source ; son échec rend le motif")
    func cancelGesture() async {
        let log = CallLog()
        let ok = await flow(source: FakeEndpoint("mac", log: log), target: FakeEndpoint("vps", log: log), sleeps: SleepRecorder())
            .cancel(repoKey: "k-mac", handoverId: "h-9")
        if case .failure(let failure) = ok { Issue.record("succès attendu, reçu \(failure)") }
        #expect(log.entries == ["mac.cancel(k-mac,h-9)"])

        let refused = FakeEndpoint("mac", log: log, cancelError: HandoverFailure("bascule déjà terminée"))
        let failed = await flow(source: refused, target: FakeEndpoint("vps", log: log), sleeps: SleepRecorder())
            .cancel(repoKey: "k-mac", handoverId: "h-9")
        guard case .failure(let failure) = failed else {
            Issue.record("échec attendu")
            return
        }
        #expect(failure == HandoverFailure("bascule déjà terminée"))
    }

    @Test("les reprises du retrait sont 3, espacées de 2 s")
    func retryPolicyConstants() {
        #expect(HandoverFlow.commitRetries == 3)
        #expect(HandoverFlow.retryDelaySeconds == 2)
    }
}
