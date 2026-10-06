// Preuves de S-3 (lot) et S-4 (projet) : AC-4 — le lot et le projet sont rendus
// typés, et aucun fichier du magasin n'a changé (contenu ni date). Les fixtures sont
// construites AU FORMAT RÉEL du dépôt : AC-4 exige ce format, jamais la présence
// d'un fichier de la machine (aucune dépendance à `~/.omp`).

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

private let repoKey = "d0ef9a50f7dc3a37"

@Test("client-magasin-etat/AC-4 : le lot est rendu avec ses features et son propriétaire")
func lotIsTyped() throws {
    let fixture = StoreFixture()
    fixture.publish(
        .lots,
        "\(repoKey).json",
        object: lotObject(
            id: repoKey,
            features: [
                lotFeatureObject(),
                lotFeatureObject(slug: "socle-app-swift", state: "done", phase: "release"),
            ],
            heartbeatAt: fixtureT0 - 1_000
        )
    )
    let lot = try #require(StoreReader(stateDir: fixture.root, clock: fixtureClock).readLots().lots.first)
    #expect(lot.id == repoKey)
    #expect(lot.repoRoot == "/Users/millian/Experiments/mem0-omp")
    #expect(lot.status == .running)
    #expect(lot.reviewCap == 3)
    #expect(lot.slotCap == 4)
    #expect(lot.recapAt == nil)
    #expect(lot.createdAt == 1_790_436_998_531)
    #expect(lot.launchedAt == 1_790_499_449_883)
    #expect(lot.isStale == false)
    // Le propriétaire : pid vivant, battement frais.
    #expect(lot.owner.pid == Int(getpid()))
    #expect(lot.owner.heartbeatAt == fixtureT0 - 1_000)
    #expect(lot.owner.sessionFile == nil)
    #expect(lot.features.count == 2)
    let feature = try #require(lot.features.first)
    #expect(feature.slug == "client-magasin-etat")
    #expect(feature.name == "client-magasin-etat")
    #expect(feature.branch == "feat/client-magasin-etat")
    #expect(feature.state == .running)
    #expect(feature.phase == .impl)
    #expect(feature.origin == .session)
    #expect(feature.waitKind == nil)
    #expect(feature.waitPrompt == nil)
    #expect(feature.pendingTexts.isEmpty)
    #expect(feature.deps.isEmpty)
    #expect(feature.fixes == 0)
    #expect(feature.lastVerdict == nil)
    #expect(feature.endedAt == nil)
    // Les optionnels « écrits seulement dans leur forme valide » sont ABSENTS.
    #expect(feature.launched == nil)
    #expect(feature.auditSession == nil)
    #expect(feature.relayKind == nil)
    #expect(feature.base == nil)
    #expect(feature.held == nil)
    #expect(lot.features.last?.state == .done)
}

@Test("client-magasin-etat/AC-4 : le projet est rendu avec ses segments et sa session hôte")
func projectIsTyped() throws {
    let fixture = StoreFixture()
    fixture.publish(
        .projects,
        "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey,
            segments: [
                [
                    "name": "Fondations",
                    "features": [
                        projectFeatureObject(
                            slug: "socle-app-swift",
                            status: "merged",
                            prUrl: "https://forge.example/pr/36"
                        ),
                    ],
                ],
                [
                    "name": "Lire le réel",
                    "features": [
                        projectFeatureObject(),
                        projectFeatureObject(
                            slug: "canal-de-commande-extension",
                            status: "failed",
                            failure: ["kind": "pr", "reason": "CI rouge", "at": 1_790_598_000_000]
                        ),
                    ],
                ],
            ],
            current: 1,
            base: ["segment": 0, "sha": String(repeating: "a", count: 40)]
        )
    )
    let project = try #require(
        StoreReader(stateDir: fixture.root, clock: fixtureClock).readProjects().projects.first
    )
    #expect(project.repoKey == repoKey)
    #expect(project.repoRoot == "/Users/millian/Experiments/mem0-omp")
    #expect(project.relayKey.hasPrefix("/"))
    #expect(project.status == .running)
    #expect(project.segments.map(\.name) == ["Fondations", "Lire le réel"])
    #expect(project.current == 1)
    #expect(project.base == ProjectBase(segment: 0, sha: String(repeating: "a", count: 40)))
    #expect(project.hostSession == "/Users/millian/.omp/agent/sessions/session.jsonl")
    #expect(project.createdAt == 1_790_585_406_349)
    let merged = try #require(project.segments.first?.features.first)
    #expect(merged.slug == "socle-app-swift")
    #expect(merged.status == .merged)
    #expect(merged.prUrl == "https://forge.example/pr/36")
    #expect(merged.failure == nil)
    #expect(merged.removedReason == nil)
    #expect(ModelSlots.resolve(
        legacy: merged.model, reqSpecs: merged.modelReqSpecs, implReview: merged.modelImplReview
    ) == ModelSlots(
        reqSpecs: "opencode-go/deepseek-v4.1-flash",
        implReview: "opencode-go/deepseek-v4.1-flash"
    ))
    let failed = try #require(project.segments.last?.features.last)
    #expect(failed.status == .failed)
    #expect(failed.failure?.kind == .pr)
    #expect(failed.failure?.reason == "CI rouge")
    #expect(failed.failure?.at == 1_790_598_000_000)
}

@Test("client-magasin-etat/AC-4 : lire le lot et le projet ne change ni contenu ni date")
func readingNeverChangesTheStore() {
    let fixture = StoreFixture()
    fixture.publish(
        .lots,
        "\(repoKey).json",
        object: lotObject(id: repoKey, heartbeatAt: fixtureT0 - 1_000)
    )
    fixture.publish(.projects, "\(repoKey).json", object: projectObject(repoKey: repoKey))
    fixture.publish(
        .running,
        "\(fixtureId(0x91)).json",
        object: runningObject(
            id: fixtureId(0x91),
            cwd: "/tmp/worktree-lecture",
            phaseStartedAt: fixtureT0 - 5_000,
            updatedAt: fixtureT0 - 1_000,
            ownerPid: Double(deadPid())
        )
    )

    let before = fixture.listing()
    let lotText = fixture.contents(.lots, "\(repoKey).json")
    let projectText = fixture.contents(.projects, "\(repoKey).json")

    let snapshot = StoreReader(stateDir: fixture.root, clock: fixtureClock).readAll()
    #expect(snapshot.lots.lots.count == 1)
    #expect(snapshot.projects.projects.count == 1)
    #expect(snapshot.running.entries.count == 1)

    // Seconde moitié d'AC-4 (S-10) : contenu ET dates inchangés.
    #expect(fixture.listing() == before)
    #expect(fixture.contents(.lots, "\(repoKey).json") == lotText)
    #expect(fixture.contents(.projects, "\(repoKey).json") == projectText)
}

@Test("client-magasin-etat/AC-4 : une feature invalide rejette le lot ENTIER")
func invalidLotFeatureRejectsTheLot() {
    let fixture = StoreFixture()
    // Slug hors `^[a-z0-9][a-z0-9-]*$`.
    fixture.publish(
        .lots,
        "\(fixtureId(0xa1)).json",
        object: lotObject(id: fixtureId(0xa1), features: [lotFeatureObject(slug: "Bad_Slug")])
    )
    // `waitKind` ABSENTE : le dépôt rejette la feature, donc le lot.
    var withoutWaitKind = lotFeatureObject(slug: "sans-wait-kind")
    withoutWaitKind.removeValue(forKey: "waitKind")
    fixture.publish(
        .lots,
        "\(fixtureId(0xa2)).json",
        object: lotObject(id: fixtureId(0xa2), features: [withoutWaitKind])
    )
    // Version 2.
    var future = lotObject(id: fixtureId(0xa3))
    future["version"] = 2
    fixture.publish(.lots, "\(fixtureId(0xa3)).json", object: future)

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readLots()
    #expect(envelope.lots.isEmpty)
    #expect(envelope.discarded == 3)
}

@Test("client-magasin-etat/AC-4 : coercitions du lot (slotCap, reviewCap, sans battement, sha de base)")
func lotCoercions() throws {
    let fixture = StoreFixture()
    let first = fixtureId(0xd0)
    // `slotCap` 0 ⇒ 1, `reviewCap` absent ⇒ 1, `base` en SHA-256 accepté,
    // `launched: false` et `model` non blanc conservés.
    var feature = lotFeatureObject(slug: "coercitions")
    feature["base"] = String(repeating: "b", count: 64)
    feature["launched"] = false
    feature["model"] = "  opencode-go/deepseek-v4.1-flash  "
    feature["modelReqSpecs"] = "  anthropic/claude-opus-4-7  "
    feature["modelImplReview"] = ""
    feature["pendingTexts"] = [" premier ", 7, "", "deuxième"]
    feature["lastVerdict"] = "bizarre"
    feature["fixes"] = -3
    var object = lotObject(id: first, features: [feature])
    object["slotCap"] = 0
    object.removeValue(forKey: "reviewCap")
    fixture.publish(.lots, "\(first).json", object: object)

    let lot = try #require(StoreReader(stateDir: fixture.root, clock: fixtureClock).readLots().lots.first)
    #expect(lot.slotCap == 1)
    #expect(lot.reviewCap == 1)
    let typed = try #require(lot.features.first)
    #expect(typed.base == String(repeating: "b", count: 64))
    #expect(typed.launched == false)
    // Le modèle garde sa valeur d'origine, blancs compris (parité : seul le test de
    // vacuité rogne).
    #expect(typed.model == "  opencode-go/deepseek-v4.1-flash  ")
    // Les deux clés neuves suivent la MÊME tolérance : valeur conservée telle
    // quelle, blanc lu ABSENT.
    #expect(typed.modelReqSpecs == "  anthropic/claude-opus-4-7  ")
    #expect(typed.modelImplReview == nil)
    #expect(typed.pendingTexts == [" premier ", "deuxième"])
    #expect(typed.lastVerdict == nil)
    #expect(typed.fixes == 0)

    // `slotCap` hors bornes ⇒ ramené à 32 ; lot SANS battement ⇒ lu, jamais périmé
    // par le temps (le pid seul fait autorité).
    let second = fixtureId(0xd1)
    var high = lotObject(id: second, features: [lotFeatureObject(slug: "borne-haute")])
    high["slotCap"] = 99
    fixture.publish(.lots, "\(second).json", object: high)
    let both = StoreReader(stateDir: fixture.root, clock: fixtureClock).readLots().lots
    let bounded = try #require(both.first { $0.id == second })
    #expect(bounded.slotCap == 32)
    #expect(bounded.owner.heartbeatAt == nil)
    #expect(bounded.isStale == false)

    // Les optionnels « écrits seulement dans leur forme valide » : `held` rogné à la
    // borne de l'éditeur, `auditSession` ABSOLUE seulement, `relayKind` seulement
    // `"project"`.
    let third = fixtureId(0xd2)
    var optional = lotFeatureObject(slug: "optionnels")
    optional["held"] = [
        "phase": "review",
        "fix": true,
        "kind": "phase",
        "resume": false,
        "text": String(repeating: "x", count: 5_000),
    ]
    optional["auditSession"] = "relatif/session.jsonl"
    optional["relayKind"] = "autre"
    var absolute = lotFeatureObject(slug: "audit-absolu")
    absolute["auditSession"] = "/Users/x/sessions/audit.jsonl"
    absolute["relayKind"] = "project"
    fixture.publish(.lots, "\(third).json", object: lotObject(id: third, features: [optional, absolute]))
    let rendered = try #require(
        StoreReader(stateDir: fixture.root, clock: fixtureClock).readLots().lots.first { $0.id == third }
    )
    let held = try #require(rendered.features.first)
    #expect(held.held?.phase == .review)
    #expect(held.held?.fix == true)
    #expect(held.held?.kind == .phase)
    #expect(held.held?.resume == false)
    #expect(held.held?.text?.count == 4_000)
    #expect(held.auditSession == nil)
    #expect(held.relayKind == nil)
    let absoluteFeature = try #require(rendered.features.last)
    #expect(absoluteFeature.auditSession == "/Users/x/sessions/audit.jsonl")
    #expect(absoluteFeature.relayKind == .project)
}

@Test("client-magasin-etat/AC-4 : le projet rejette 0 segment, un `current` hors bornes et un invariant violé")
func invalidProjectsAreDiscarded() {
    let fixture = StoreFixture()
    fixture.publish(.projects, "\(fixtureId(0xb1)).json", object: projectObject(segments: [], current: 0))
    fixture.publish(
        .projects,
        "\(fixtureId(0xb2)).json",
        object: projectObject(segments: [["name": "seul", "features": []]], current: 1)
    )
    // `failed` sans échec : invariant violé.
    fixture.publish(
        .projects,
        "\(fixtureId(0xb3)).json",
        object: projectObject(
            segments: [["name": "s", "features": [projectFeatureObject(status: "failed")]]],
            current: 0
        )
    )
    // `relayKey` RELATIVE : refusée.
    var relative = projectObject()
    relative["relayKey"] = "projects/relatif"
    fixture.publish(.projects, "\(fixtureId(0xb4)).json", object: relative)
    // `base` ABSENTE : la clé est exigée.
    var withoutBase = projectObject()
    withoutBase.removeValue(forKey: "base")
    fixture.publish(.projects, "\(fixtureId(0xb5)).json", object: withoutBase)

    let envelope = StoreReader(stateDir: fixture.root, clock: fixtureClock).readProjects()
    #expect(envelope.projects.isEmpty)
    #expect(envelope.discarded == 5)
}

@Test("client-magasin-etat/AC-4 : `hostSession` nulle et feature retirée au motif présent sont rendues")
func projectToleratedForms() throws {
    let fixture = StoreFixture()
    var featureWithoutModel = projectFeatureObject(slug: "sans-modele")
    featureWithoutModel.removeValue(forKey: "model")
    fixture.publish(
        .projects,
        "\(repoKey).json",
        object: projectObject(
            repoKey: repoKey,
            segments: [
                [
                    "name": "Seul segment",
                    "features": [
                        projectFeatureObject(slug: "retiree", status: "removed", removedReason: "abandonnée"),
                        featureWithoutModel,
                    ],
                ],
            ],
            current: 0,
            hostSession: NSNull(),
            base: NSNull()
        )
    )

    let read = try #require(StoreReader(stateDir: fixture.root, clock: fixtureClock).readProjects().projects.first)
    #expect(read.hostSession == nil)
    #expect(read.base == nil)
    #expect(read.current == 0)
    #expect(read.segments.count == 1)
    #expect(read.segments[0].features.first?.status == .removed)
    #expect(read.segments[0].features.first?.removedReason == "abandonnée")
    #expect(read.segments[0].features.last?.model == nil)
    #expect(read.segments[0].features.last?.modelReqSpecs == nil)
    #expect(read.segments[0].features.last?.modelImplReview == nil)
}
