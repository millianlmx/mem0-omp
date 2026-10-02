// Preuves de S-4 (sélecteur de runs) : AC-1 et AC-2.
//
// Les fixtures sont le VRAI magasin d'état sous `NSTemporaryDirectory()`
// (`StoreFixture`), jamais `~/.omp` : la liste des runs est lue par le même lecteur
// que celui de la salle de contrôle, donc la preuve porte sur le format réel.

import Foundation
import Testing

@testable import OMPConsole

private let liveSession = "/tmp/sessions/2026-09-28T15-07-55-136Z_01a0e88e-e980-4f5a-9d0d-2b0d2c0e9a11.jsonl"
private let otherSession = "/tmp/sessions/2026-09-28T16-00-00-000Z_01a0e99f-1111-2222-3333-444455556666.jsonl"

/// L'instant courant en millisecondes : une entrée publiée « maintenant » n'est pas
/// périmée (le sélecteur lit l'horloge murale, il n'en reçoit pas).
private var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

private func publishRunning(
    _ fixture: StoreFixture,
    id: String,
    label: String,
    phaseStartedAt: Double,
    sessionFile: String?,
    updatedAt: Double = nowMs
) {
    fixture.publish(
        .running,
        "\(id).json",
        object: runningObject(
            id: id,
            cwd: "/tmp/\(id)",
            label: label,
            phase: "impl",
            state: "running",
            phaseStartedAt: phaseStartedAt,
            updatedAt: updatedAt,
            ownerPid: Double(getpid()),
            sessionFile: sessionFile
        )
    )
}

// MARK: - AC-1

@Test("visionneuse-de-session/AC-1 : choisir un run du magasin porte SA session, nommée par sa feature")
@MainActor
func choicesCarryTheSessionToDisplay() async throws {
    let fixture = StoreFixture()
    let id = fixtureId(0xA1)
    let startedAt = (nowMs - 5_000).rounded()
    publishRunning(
        fixture,
        id: id,
        label: "mem0-omp/visionneuse-de-session",
        phaseStartedAt: startedAt,
        sessionFile: liveSession
    )

    let model = SessionSelectorModel(stateDir: fixture.root)
    defer { model.stop() }

    // L'agrégat courant est publié dès l'initialisation : pas d'état de chargement.
    #expect(await awaitViewer { model.choices.count == 1 })
    let choice = try #require(model.choices.first)
    #expect(choice.id == liveSession)
    #expect(choice.sessionFile == liveSession)
    #expect(choice.label == "mem0-omp/visionneuse-de-session")
    #expect(choice.phase == .impl)
    #expect(choice.state == .live(.running))
    #expect(choice.isStale == false)
    #expect(choice.repo == "mem0-omp")
    #expect(choice.featureTitle == "visionneuse-de-session")
    // La fenêtre se nomme par la feature, sans identifiant de session.
    #expect(choice.target.title == "visionneuse-de-session")
    #expect(choice.target.sessionFile == liveSession)
    // Le run est daté par son entrée, et la fenêtre porte « <étape> · <dépôt> ».
    #expect(choice.startedAtMs == startedAt)
    #expect(choice.target.subtitle == "Implémentation · mem0-omp")

    // L'étiquette de session, sur les formes réelles.
    #expect(sessionTag(forSessionFile: liveSession) == "01a0e88e")
    #expect(sessionTag(forSessionFile: "/tmp/abcdef1234567890.jsonl") == "abcdef12")
    #expect(sessionTag(forSessionFile: "/tmp/_.jsonl") == "session")
}

@Test("visionneuse-de-session/AC-1 : sans `sessionFile` il n'y a rien à afficher, sans magasin rien du tout")
@MainActor
func runsWithoutSessionAreLeftOut() async throws {
    let fixture = StoreFixture()
    let withSession = fixtureId(0xB1)
    let withoutSession = fixtureId(0xB2)
    publishRunning(
        fixture,
        id: withSession,
        label: "avec session",
        phaseStartedAt: nowMs - 9_000,
        sessionFile: liveSession
    )
    publishRunning(
        fixture,
        id: withoutSession,
        label: "sans session",
        phaseStartedAt: nowMs - 8_000,
        sessionFile: nil
    )

    let model = SessionSelectorModel(stateDir: fixture.root)
    defer { model.stop() }
    #expect(await awaitViewer { model.choices.count == 1 })
    #expect(model.choices.map(\.label) == ["avec session"])
    #expect(model.storeAbsent == false)

    // Magasin ABSENT : un état distinct de « magasin vide », avec son message.
    let missing = StoreFixture(stores: [])
    let empty = SessionSelectorModel(stateDir: missing.root)
    defer { empty.stop() }
    #expect(await awaitViewer { empty.storeAbsent })
    #expect(empty.choices.isEmpty)

    // Magasin PRÉSENT mais aucun run ouvrable : autre état, autre message.
    let bare = StoreFixture()
    let bareModel = SessionSelectorModel(stateDir: bare.root)
    defer { bareModel.stop() }
    #expect(await awaitViewer { bareModel.storeAbsent == false })
    #expect(bareModel.choices.isEmpty)
}

@Test("visionneuse-de-session/AC-1 : un run vivant l'emporte sur son jumeau réconcilié, et l'ordre est celui du magasin")
@MainActor
func choicesAreDeduplicatedBySession() async throws {
    let fixture = StoreFixture()
    let older = fixtureId(0xC1)
    let newer = fixtureId(0xC2)
    let twin = fixtureId(0xC3)
    publishRunning(
        fixture,
        id: older,
        label: "premier arrivé",
        phaseStartedAt: nowMs - 9_000,
        sessionFile: liveSession
    )
    publishRunning(
        fixture,
        id: newer,
        label: "second arrivé",
        phaseStartedAt: nowMs - 8_000,
        sessionFile: otherSession
    )
    // La MÊME session, terminée et réconciliée sous un autre id : le dédoublonnage
    // garde la première occurrence — le run vivant.
    fixture.publish(
        .history,
        "\(twin).json",
        object: historyObject(
            id: twin,
            cwd: "/tmp/\(twin)",
            label: "premier arrivé",
            phase: "impl",
            finalState: "done",
            phaseStartedAt: nowMs - 9_000,
            endedAt: nowMs,
            sessionFile: liveSession
        )
    )

    let model = SessionSelectorModel(stateDir: fixture.root)
    defer { model.stop() }
    #expect(await awaitViewer { model.choices.count == 2 })
    // Ordre : les runs vivants d'abord (ordre de l'enveloppe), puis l'historique.
    #expect(model.choices.map(\.label) == ["premier arrivé", "second arrivé"])
    #expect(model.choices.map(\.id) == [liveSession, otherSession])
    // La première occurrence gagne, et c'est bien le run VIVANT.
    #expect(model.choices[0].state == .live(.running))

    // Une pipeline close n'est jamais périmée ; un run dont le battement est ancien
    // l'est (le marquage vient de l'entrée du magasin).
    fixture.publish(
        .history,
        "\(fixtureId(0xC4)).json",
        object: historyObject(
            id: fixtureId(0xC4),
            cwd: "/tmp/seule",
            label: "close",
            phase: "review",
            finalState: "failed",
            phaseStartedAt: nowMs - 7_000,
            endedAt: nowMs - 1_000,
            sessionFile: "/tmp/sessions/2026-09-28T17-00-00-000Z_01a0eaaa-2222.jsonl"
        )
    )
    #expect(await awaitViewer { model.choices.count == 3 })
    #expect(model.choices[2].label == "close")
    #expect(model.choices[2].state == .ended(.failed))
    #expect(model.choices[2].isStale == false)

    publishRunning(
        fixture,
        id: fixtureId(0xC5),
        label: "au battement ancien",
        phaseStartedAt: nowMs - 6_000,
        sessionFile: "/tmp/sessions/2026-09-28T18-00-00-000Z_01a0ebbb-3333.jsonl",
        updatedAt: nowMs - 600_000
    )
    #expect(await awaitViewer { model.choices.count == 4 })
    // Les runs vivants restent groupés en tête, dans l'ordre de l'enveloppe
    // (`phaseStartedAt` croissant) ; l'historique vient après.
    #expect(model.choices.map(\.label) == ["premier arrivé", "second arrivé", "au battement ancien", "close"])
    #expect(model.choices[2].isStale == true)
    #expect(model.choices[3].isStale == false)
}

// MARK: - AC-2

@Test("visionneuse-de-session/AC-2 : deux runs, deux fenêtres ; le même run, la sienne")
@MainActor
func distinctRunsYieldDistinctWindows() async throws {
    let fixture = StoreFixture()
    publishRunning(
        fixture,
        id: fixtureId(0xD1),
        label: "mem0-omp/alpha",
        phaseStartedAt: nowMs - 9_000,
        sessionFile: liveSession
    )
    publishRunning(
        fixture,
        id: fixtureId(0xD2),
        label: "mem0-omp/beta",
        phaseStartedAt: nowMs - 8_000,
        sessionFile: otherSession
    )

    let model = SessionSelectorModel(stateDir: fixture.root)
    defer { model.stop() }
    #expect(await awaitViewer { model.choices.count == 2 })

    let first = model.choices[0].target
    let second = model.choices[1].target

    // Deux VALEURS distinctes : `WindowGroup(for:)` ouvre donc deux fenêtres, avec
    // deux titres distincts.
    #expect(first != second)
    #expect(first.sessionFile != second.sessionFile)
    #expect(first.title != second.title)

    // Re-choisir le même run rend la MÊME valeur : le système ramène sa fenêtre au
    // premier plan au lieu d'en ouvrir une seconde.
    #expect(model.choices[0].target == first)
    #expect(Set([first, second]).count == 2)

    // L'identité ne dépend QUE de la session : un run renommé garde sa fenêtre.
    #expect(ViewerTarget(sessionFile: first.sessionFile, title: "renommé après coup") == first)

    // Un couple (valeur, titre) est encodable : `WindowGroup(for:)` l'exige.
    let encoded = try JSONEncoder().encode(first)
    #expect(try JSONDecoder().decode(ViewerTarget.self, from: encoded) == first)
}
