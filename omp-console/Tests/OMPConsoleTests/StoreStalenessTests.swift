// Preuves de S-7 (péremption, marquage seul) : AC-10 et AC-11.
//
// L'horloge est FIXE (`fixtureClock`) : « périmé » ne dépend jamais de l'heure qu'il
// est. Le seuil est celui du dépôt — `lotOwnerStaleMs`, soit `5 × LOT_TICK_MS`.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

@Test("client-magasin-etat/AC-10 : pid mort et battement ancien sont MARQUÉS, jamais retirés ni déplacés")
func runningStalenessIsMarkedOnly() throws {
    let fixture = StoreFixture()
    let deadOwnerId = fixtureId(0x71)
    let frozenId = fixtureId(0x72)
    let deadOwner = deadPid()
    // 1) Le pid n'existe plus.
    fixture.publish(
        .running,
        "\(deadOwnerId).json",
        object: runningObject(
            id: deadOwnerId,
            cwd: "/tmp/worktree-mort",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(deadOwner)
        )
    )
    // 2) Le pid vit, mais le battement dépasse le seuil du dépôt. C'est un cas
    // ATTENDU, pas une anomalie : `publishRunning` n'écrit rien quand seule la
    // valeur d'`updatedAt` changerait (`samePublished`, publish.ts:241-275), donc un
    // run VIVANT au repos garde un `updatedAt` figé — le marquage est un badge.
    fixture.publish(
        .running,
        "\(frozenId).json",
        object: runningObject(
            id: frozenId,
            cwd: "/tmp/worktree-fige",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - (lotOwnerStaleMs + 1),
            ownerPid: Double(getpid())
        )
    )
    let before = fixture.listing()

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning()
    // Tri par `phaseStartedAt` égal ⇒ départage par `cwd`.
    #expect(envelope.entries.map(\.id) == [frozenId, deadOwnerId])
    let frozen = try #require(envelope.entries.first)
    #expect(frozen.isStale)
    #expect(frozen.ownerPid == Int(getpid()))
    let dead = try #require(envelope.entries.last)
    #expect(dead.isStale)
    #expect(dead.ownerPid == deadOwner)

    // Marquage SEUL : l'entrée reste dans `running`, rien n'est écrit, rien n'est
    // déplacé vers l'historique.
    #expect(fixture.names(.running).count == 2)
    #expect(fixture.listing() == before)
    #expect(StoreReader(stateDir: fixture.root, clock: fixtureClock).readHistory().entries.isEmpty)
}

@Test("client-magasin-etat/AC-10 : un battement frais et une horloge reculée ne marquent pas")
func runningNotStale() throws {
    let fixture = StoreFixture()
    let id = fixtureId(0x73)
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: "/tmp/worktree-frais",
            // `updatedAt` POSTÉRIEUR à l'horloge : un écart négatif vaut « non
            // périmé » (parité `elapsedLabel`, store.ts:172).
            phaseStartedAt: fixtureT0 + 5_000,
            updatedAt: fixtureT0 + 1_000,
            ownerPid: Double(getpid())
        )
    )
    let entry = try #require(StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning().entries.first)
    #expect(entry.isStale == false)

    // Le seuil est STRICT : à l'instant pile du seuil, l'entrée est encore fraîche.
    let atLimit = fixtureId(0x74)
    fixture.publish(
        .running,
        "\(atLimit).json",
        object: runningObject(
            id: atLimit,
            cwd: "/tmp/worktree-limite",
            phaseStartedAt: fixtureT0 - 9_000,
            updatedAt: fixtureT0 - lotOwnerStaleMs,
            ownerPid: Double(getpid())
        )
    )
    let atLimitEntry = try #require(
        StoreReader(stateDir: fixture.root, clock: fixtureClock).readRunning().entries.first { $0.id == atLimit }
    )
    #expect(atLimitEntry.isStale == false)
}

@Test("client-magasin-etat/AC-11 : un lot et un relais audit au battement ancien sont rendus et marqués")
func lotAndRelayStaleness() throws {
    let fixture = StoreFixture()
    let staleLotId = fixtureId(0x75)
    let freshLotId = fixtureId(0x76)
    let staleRelayId = fixtureId(0x77)
    let deadRelayId = fixtureId(0x78)

    fixture.publish(
        .lots,
        "\(staleLotId).json",
        object: lotObject(
            id: staleLotId,
            ownerPid: Double(getpid()),
            heartbeatAt: fixtureT0 - (lotOwnerStaleMs + 1)
        )
    )
    fixture.publish(
        .lots,
        "\(freshLotId).json",
        object: lotObject(
            id: freshLotId,
            ownerPid: Double(getpid()),
            heartbeatAt: fixtureT0 - 1_000
        )
    )
    fixture.publish(
        .audit,
        "\(staleRelayId).json",
        object: auditObject(pid: Double(getpid()), heartbeatAt: fixtureT0 - (lotOwnerStaleMs + 1))
    )
    fixture.publish(
        .audit,
        "\(deadRelayId).json",
        object: auditObject(pid: Double(deadPid()), heartbeatAt: fixtureT0 - 1_000)
    )
    let before = fixture.listing()

    let reader = StoreReader(stateDir: fixture.root, clock: fixtureClock)
    let lots = reader.readLots().lots
    // Fichiers triés par NOM (spec S-3) : 0x75 avant 0x76.
    #expect(lots.map(\.id) == [staleLotId, freshLotId])
    let staleLot = try #require(lots.first { $0.id == staleLotId })
    #expect(staleLot.isStale)
    // Le lot est rendu avec ses features et son propriétaire, malgré le marquage.
    #expect(staleLot.features.count == 1)
    #expect(staleLot.owner.pid == Int(getpid()))
    #expect(staleLot.owner.heartbeatAt == fixtureT0 - (lotOwnerStaleMs + 1))
    let freshLot = try #require(lots.first { $0.id == freshLotId })
    #expect(freshLot.isStale == false)

    let relays = reader.readAudit().relays
    let staleRelay = try #require(relays.first { $0.id == staleRelayId })
    #expect(staleRelay.isStale)
    #expect(staleRelay.pid == Int(getpid()))
    let deadRelay = try #require(relays.first { $0.id == deadRelayId })
    #expect(deadRelay.isStale)
    #expect(deadRelay.heartbeatAt == fixtureT0 - 1_000)

    // Marquage seul : rien n'est retiré, rien n'est écrit.
    #expect(fixture.listing() == before)
}

@Test("client-magasin-etat/AC-11 : un lot sans battement garde le pid pour seule autorité")
func lotWithoutHeartbeat() throws {
    let fixture = StoreFixture()
    let aliveId = fixtureId(0x79)
    let deadId = fixtureId(0x7a)
    // `lotObject` SANS `heartbeatAt` : la clé n'est pas écrite, comme dans un lot
    // d'une version antérieure.
    fixture.publish(.lots, "\(aliveId).json", object: lotObject(id: aliveId, ownerPid: Double(getpid())))
    fixture.publish(.lots, "\(deadId).json", object: lotObject(id: deadId, ownerPid: Double(deadPid())))

    let lots = StoreReader(stateDir: fixture.root, clock: fixtureClock).readLots().lots
    let aliveLot = try #require(lots.first { $0.id == aliveId })
    #expect(aliveLot.owner.heartbeatAt == nil)
    #expect(aliveLot.isStale == false)
    let deadLot = try #require(lots.first { $0.id == deadId })
    #expect(deadLot.owner.heartbeatAt == nil)
    #expect(deadLot.isStale)
}

@Test("client-magasin-etat/AC-10 : `pidAlive` — seul un pid inexistant est mort")
func pidAliveRules() {
    #expect(pidAlive(Int(getpid())))
    #expect(!pidAlive(0))
    #expect(!pidAlive(-1))
    #expect(!pidAlive(deadPid()))
}
