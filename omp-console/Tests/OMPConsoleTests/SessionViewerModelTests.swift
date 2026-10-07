// Preuves de S-2 et S-7 (modèle d'une fenêtre de visionneuse) : AC-7 à AC-13.
//
// Le modèle vit sur le fil principal (`@MainActor`) : les preuves sont donc
// `@MainActor` et attendent une CONDITION, jamais une durée fixe. Les fixtures sont
// de vrais fichiers sous `NSTemporaryDirectory()` — jamais `~/.omp`, jamais un
// `.jsonl` du dépôt.
//
// `watch: false` est la couture des tirages manuels (aucune veille à attendre) ;
// `watch: true` est la couture de ce qui doit se produire SANS appel manuel.

import Darwin
import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

// MARK: - Outillage

private func rowKind(_ row: SessionRow) -> String {
    switch row.kind {
    case .user: "user"
    case .assistant: "assistant"
    case .toolCall: "toolCall"
    case .toolResult: "toolResult"
    case .marker: "marker"
    }
}

@MainActor
private func makeModel(_ fixture: ViewerSessionFixture, watch: Bool = true) -> SessionViewerModel {
    SessionViewerModel(
        target: ViewerTarget(sessionFile: fixture.path, title: "mem0-omp/feature — tag"),
        watch: watch
    )
}

// MARK: - AC-4

@MainActor
@Test("visionneuse-de-session/AC-4 : déplier un appel n'ouvre que lui")
func expandingOneCallLeavesTheOthersAlone() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write(viewerReferenceLines())

    let model = makeModel(fixture, watch: false)
    model.refresh()

    let callRows = model.rows.filter { row in
        if case .toolCall = row.kind { return true }
        return false
    }
    #expect(callRows.count == 2)
    let read = callRows[0].id
    let ask = callRows[1].id
    let assistant = model.rows[1].id

    // À l'ouverture : replié par défaut, sauf l'appel `ask`, déplié d'emblée.
    #expect(model.isExpanded(read) == false)
    #expect(model.isExpanded(ask) == true)
    #expect(model.isExpanded(assistant) == false)

    // Le clic sur l'en-tête replié — ce que fait la vue, qui appelle `toggleFold`
    // sur l'identité de CETTE ligne.
    model.toggleFold(read)
    #expect(model.isExpanded(read) == true)
    // … n'ouvre QUE cet appel : aucun autre pli n'a bougé.
    #expect(model.expanded == [read, ask])

    // Et le replier ne referme pas les autres.
    model.toggleFold(read)
    #expect(model.isExpanded(read) == false)
    #expect(model.isExpanded(ask) == true)
    #expect(model.expanded == [ask])
}

// MARK: - AC-7

@MainActor
@Test("visionneuse-de-session/AC-7 : deux ajouts successifs grandissent la suite, sans doublon ni réordonnancement")
func appendsGrowTheThreadWithoutDuplication() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([ViewerLines.header(), ViewerLines.user("Bonjour")])

    let model = makeModel(fixture)
    defer { model.stop() }
    #expect(await awaitViewer { model.state == .ready && model.rows.count == 1 })
    let firstIds = model.rows.map(\.id)

    // Premier ajout, par le writer de l'hôte : la VEILLE déclenche la lecture.
    try fixture.append([ViewerLines.assistant(id: "e2", text: "premier ajout")])
    #expect(await awaitViewer { model.rows.count == 2 })

    // Second ajout, plus fourni.
    try fixture.append([
        ViewerLines.user("second ajout", id: "e3"),
        ViewerLines.compaction(id: "e4"),
    ])
    #expect(await awaitViewer { model.rows.count == 4 })

    #expect(model.rows.map(rowKind) == ["user", "assistant", "user", "marker"])
    #expect(Array(model.rows.map(\.id).prefix(1)) == firstIds)
    #expect(Set(model.rows.map(\.id)).count == 4)
    guard case .assistant(let second) = model.rows[1].kind else {
        Issue.record("la deuxième ligne doit être le message assistant ajouté")
        return
    }
    #expect(second.text == "premier ajout")

    // Relire le même contenu n'ajoute rien : l'anti-doublon tient sur l'offset.
    model.refresh()
    model.refresh()
    #expect(model.rows.count == 4)
    #expect(model.rows.map(rowKind) == ["user", "assistant", "user", "marker"])
}

// MARK: - AC-8

@MainActor
@Test("visionneuse-de-session/AC-8 : plier une ligne ne touche aucune autre, et une mise à jour ne touche aucun pli")
func foldsAreIndependentOfEachOtherAndOfRefreshes() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write(viewerReferenceLines())

    let model = makeModel(fixture, watch: false)
    model.refresh()
    #expect(model.state == .ready)
    #expect(model.rows.count == 7)

    let calls = model.rows.filter { if case .toolCall = $0.kind { return true } else { return false } }
    let first = calls[0].id
    let second = calls[1].id

    // Un appel `ask` entre DÉPLIÉ, tout autre appel entre replié.
    #expect(model.isExpanded(second) == true)
    #expect(model.isExpanded(first) == false)

    model.toggleFold(first)
    #expect(model.isExpanded(first) == true)
    #expect(model.isExpanded(second) == true)
    model.toggleFold(first)
    #expect(model.isExpanded(first) == false)
    #expect(model.isExpanded(second) == true)

    // Une mise à jour des faits ne touche ni les plis ni le suivi : le suivi,
    // suspendu par un geste de l'utilisateur, le reste.
    model.reportUserScroll(deltaY: 30)
    #expect(model.following == false)
    let expanded = model.expanded
    try fixture.append([ViewerLines.user("suite", id: "e9")])
    model.refresh()
    #expect(model.rows.count == 8)
    #expect(model.expanded == expanded)
    #expect(model.following == false)
}

// MARK: - AC-9

@MainActor
@Test("visionneuse-de-session/AC-9 : le journal d'octets ne compte que les octets neufs")
func byteJournalCountsOnlyNewBytes() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    let first = ViewerLines.user("Bonjour")
    try fixture.write([ViewerLines.header(), first])

    let model = makeModel(fixture, watch: false)
    // La lecture initiale consomme tout le fichier, une seule fois.
    #expect(model.totalBytesRead == fixture.size)
    #expect(model.totalBytesRead == (ViewerLines.header().utf8.count + first.utf8.count + 2))

    let settled = model.totalBytesRead
    model.refresh()
    #expect(model.totalBytesRead == settled)

    var expected = settled
    for index in 1...3 {
        let line = ViewerLines.user("ajout \(index)", id: "e\(index)")
        let fresh = line.utf8.count + 1
        let before = model.totalBytesRead
        try fixture.append([line])
        model.refresh()
        // Chaque lecture se borne aux octets AJOUTÉS depuis la précédente.
        #expect(model.totalBytesRead - before == fresh)
        expected += fresh
        #expect(model.totalBytesRead == expected)
    }
    #expect(model.totalBytesRead == fixture.size)
}

// MARK: - AC-10 et AC-11

@MainActor
@Test("visionneuse-de-session/AC-10 : au direct, un ajout de faits demande un défilement")
func followingRequestsAScrollOnAppendedFacts() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write([ViewerLines.header(), ViewerLines.user("Bonjour")])

    let model = makeModel(fixture)
    defer { model.stop() }
    #expect(await awaitViewer { model.state == .ready && model.rows.count == 1 })
    #expect(model.following == true)

    let requests = model.scrollRequest
    try fixture.append([ViewerLines.assistant(id: "e2", text: "nouveau fait")])
    #expect(await awaitViewer { model.rows.count == 2 })
    #expect(model.scrollRequest > requests)

    // Une lecture sans nouveauté ne redemande rien.
    let settled = model.scrollRequest
    model.refresh()
    #expect(model.scrollRequest == settled)
}

@MainActor
@Test("visionneuse-de-session/AC-11 : remonter le fil suspend le suivi, « Revenir au direct » le reprend")
func scrollingUpSuspendsFollowing() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write(viewerReferenceLines())

    let model = makeModel(fixture, watch: false)
    model.refresh()
    #expect(model.following == true)

    // Le geste de l'utilisateur : la molette VERS LE HAUT quitte le direct.
    model.reportUserScroll(deltaY: 30)
    #expect(model.following == false)

    // Un geste vers le BAS ne suspend rien — mais c'est la GÉOMÉTRIE qui rétablit
    // le suivi, pas le geste : tant que le bas du fil n'est pas atteint, il reste
    // suspendu.
    model.reportUserScroll(deltaY: -30)
    #expect(model.following == false)
    model.reportBottomGap(ViewerScrollGeometry(gap: 0, origin: 4000))
    #expect(model.following == true)

    // « Revenir au direct » : le suivi reprend et un défilement est demandé.
    let requests = model.scrollRequest
    model.returnToLive()
    #expect(model.following == true)
    #expect(model.scrollRequest == requests + 1)

    // La géométrie d'un défilement que NOUS avons demandé ne suspend pas le suivi,
    // même quand la distance au bas ne se résorbe pas (le document s'allonge après
    // le défilement : mesuré jusqu'à ~170 points sur le bundle réel). La demande
    // est alors REDEMANDÉE, un nombre borné de fois.
    let duringFollow = model.scrollRequest
    model.reportBottomGap(ViewerScrollGeometry(gap: 170, origin: 900))
    #expect(model.following == true)
    #expect(model.scrollRequest == duringFollow + 1)
    model.reportBottomGap(ViewerScrollGeometry(gap: 0, origin: 1200))
    #expect(model.following == true)

    // Des faits arrivent PENDANT que le fil est remonté : la position ne bouge pas
    // (le modèle ne redemande aucun défilement) et le suivi reste suspendu.
    model.reportUserScroll(deltaY: 40)
    #expect(model.following == false)
    let suspended = model.scrollRequest
    try fixture.append([ViewerLines.user("pendant la remontée", id: "e9")])
    model.refresh()
    #expect(model.rows.count == 8)
    #expect(model.following == false)
    #expect(model.scrollRequest == suspended)

    // Un défilement demandé qui n'arrive décidément pas au bas épuise son budget :
    // le suivi finit par se suspendre plutôt que de lutter contre l'utilisateur.
    model.returnToLive()
    for _ in 0...viewerFollowRetries {
        model.reportBottomGap(ViewerScrollGeometry(gap: 400, origin: 100))
    }
    #expect(model.following == false)
}

// MARK: - AC-12

@MainActor
@Test("visionneuse-de-session/AC-12 : ni la taille, ni l'empreinte, ni le répertoire ne changent")
func viewingNeverWrites() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    try fixture.write(viewerReferenceLines())

    let model = makeModel(fixture)
    defer { model.stop() }
    #expect(await awaitViewer { model.state == .ready && model.rows.count == 7 })

    // Les gestes de l'utilisateur…
    model.toggleFold(model.rows[2].id)
    model.toggleFold(model.rows[3].id)
    model.reportUserScroll(deltaY: 500)
    model.returnToLive()
    model.refresh()

    // … puis des faits qui arrivent pendant ce temps.
    try fixture.append([ViewerLines.user("externe", id: "e9")])
    #expect(await awaitViewer { model.rows.count == 8 })
    model.refresh()

    // Le relevé est pris APRÈS l'ajout externe : c'est lui, et lui seul, qui a le
    // droit d'avoir changé le fichier.
    let size = fixture.size
    let digest = fixture.digest
    let listing = fixture.listing

    model.toggleFold(model.rows[2].id)
    model.reportUserScroll(deltaY: 600)
    model.returnToLive()
    model.refresh()
    model.refresh()

    #expect(fixture.size == size)
    #expect(fixture.digest == digest)
    #expect(fixture.listing == listing)
    // Aucun fichier annexe (verrou, index, cache) n'a été créé à côté de la session.
    #expect(listing == [fixture.file.lastPathComponent])
}

// MARK: - AC-13

@MainActor
@Test("visionneuse-de-session/AC-13 : en attente, puis les faits s'affichent sans aucun geste")
func missingFileWaitsThenResumesByItself() async throws {
    let fixture = try ViewerSessionFixture()
    defer { fixture.remove() }
    #expect(!FileManager.default.fileExists(atPath: fixture.path))

    let model = makeModel(fixture)
    defer { model.stop() }
    #expect(model.state == .waiting)
    #expect(model.rows.isEmpty)
    try? await Task.sleep(for: .milliseconds(200))
    #expect(model.state == .waiting)

    // Le fichier devient lisible : AUCUN appel manuel de `refresh()`.
    try fixture.write(viewerReferenceLines())
    #expect(await awaitViewer { model.state == .ready })
    #expect(model.rows.count == 7)
}

@MainActor
@Test("visionneuse-de-session/AC-13 : un fichier illisible est annoncé, et la lecture reprend d'elle-même")
func unreadableFileIsReportedThenResumesByItself() async throws {
    let fixture = try ViewerSessionFixture()
    defer {
        chmod(fixture.path, 0o644)
        fixture.remove()
    }
    try fixture.write([ViewerLines.header()])

    let model = makeModel(fixture)
    defer { model.stop() }
    #expect(await awaitViewer { model.state == .ready })

    // Le fichier devient ILLISIBLE : la veille voit le changement de mode et
    // l'état est annoncé, sans qu'aucun fait déjà affiché ne disparaisse.
    chmod(fixture.path, 0o000)
    #expect(await awaitViewer { if case .unreadable = model.state { return true } else { return false } })
    guard case .unreadable(let message) = model.state else {
        Issue.record("l'état doit être illisible")
        return
    }
    #expect(!message.isEmpty)

    // Il redevient lisible : la lecture reprend d'elle-même, sans aucun geste.
    chmod(fixture.path, 0o644)
    try fixture.append([ViewerLines.user("Bonjour")])
    #expect(await awaitViewer { model.state == .ready && model.rows.count == 1 })
}

@MainActor
@Test("visionneuse-de-session/AC-13 : un fichier EXISTANT illisible à l'ouverture reprend dès qu'il redevient lisible")
func fileUnreadableAtArmingResumesByItself() async throws {
    let fixture = try ViewerSessionFixture()
    defer {
        chmod(fixture.path, 0o644)
        fixture.remove()
    }
    try fixture.write([ViewerLines.header(), ViewerLines.user("Bonjour")])
    // Illisible DÈS l'armement : la veille ne peut pas être une source vnode sur le
    // fichier (EACCES mesuré), et celle de son répertoire ne voit rien de lui. C'est
    // le chemin qui restait muet à vie ; il ne l'est plus.
    chmod(fixture.path, 0o000)

    let model = makeModel(fixture)
    defer { model.stop() }
    #expect(await awaitViewer { if case .unreadable = model.state { return true } else { return false } })
    #expect(model.rows.isEmpty)

    // Il redevient lisible SANS qu'un octet y soit ajouté : seule la permission
    // change. Aucun appel manuel de `refresh()`.
    chmod(fixture.path, 0o644)
    #expect(await awaitViewer { model.state == .ready })
    #expect(model.rows.count == 1)
}
