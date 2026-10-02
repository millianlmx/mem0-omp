// Preuves du plan d'un projet (BR-2) : AC-8 — segments, états, PR, vocabulaire.

import Foundation
import Testing
@testable import OMPConsole

private func feature(
    _ slug: String,
    status: ProjectFeatureStatus,
    prUrl: String? = nil,
    failure: ProjectFailure? = nil,
    removedReason: String? = nil
) -> ProjectFeature {
    ProjectFeature(
        slug: slug,
        intention: "intention de \(slug)",
        model: "opencode-go/deepseek-v4.1-flash",
        status: status,
        prUrl: prUrl,
        failure: failure,
        removedReason: removedReason,
        updatedAt: 1_790_000_000_000
    )
}

private func twoSegmentProject() -> Project {
    Project(
        repoKey: "d0ef9a50f7dc3a37",
        repoRoot: "/Users/millian/Experiments/mem0-omp",
        relayKey: "/Users/millian/.omp/agent/pipeline/projects/x@1",
        purpose: "but",
        function: "fonction",
        status: .running,
        segments: [
            ProjectSegment(name: "Fondations", features: [feature("socle-app-swift", status: .merged)]),
            ProjectSegment(name: "Lire le réel", features: [
                feature("conduite-de-projet", status: .pr, prUrl: "https://exemple.test/pull/43"),
                feature("retiree", status: .removed, removedReason: "abandonnée par l'utilisateur"),
            ]),
        ],
        current: 1,
        base: nil,
        hostSession: nil,
        createdAt: 1_790_000_000_000,
        updatedAt: 1_790_000_000_000
    )
}

@MainActor
@Test("conduite-de-projet/AC-8 : la vue projet montre le segment, l'état et le lien de la PR")
func planShowsSegmentsStatesAndPR() async throws {
    let project = twoSegmentProject()
    let sections = projectPlanSections(of: project)

    #expect(sections.count == 2)
    #expect(sections[0].state == .merged)
    #expect(sections[1].state == .current)
    #expect(sections[1].name == "Lire le réel")

    let prRow = sections[1].features.first { $0.slug == "conduite-de-projet" }
    #expect(prRow?.stateLabel == "PR ouverte")
    #expect(prRow?.prUrl == "https://exemple.test/pull/43")

    // Les retirées sont listées à part, avec leur motif.
    #expect(sections[1].features.contains { $0.slug == "retiree" } == false)
    #expect(sections[1].removed.count == 1)
    #expect(sections[1].removed.first?.removedReason == "abandonnée par l'utilisateur")

    // L'en-tête situe le segment courant (rang 1-basé, total, nom) et compte les
    // fusionnées parmi les features non retirées.
    let status = projectStatusLine(of: project)
    #expect(status.contains("segment 2 sur 2"))
    #expect(status.contains("Lire le réel"))
    let counts = projectProgressCounts(of: project)
    #expect(counts.merged == 1)
    #expect(counts.total == 2)

    // Une URL non http(s) n'est pas cliquable ; une URL http(s) l'est.
    #expect(ProjectPlanRowView.linkURL("https://example.com/pull/1") != nil)
    #expect(ProjectPlanRowView.linkURL("issoir-1 pane") == nil)
}

@MainActor
@Test("conduite-de-projet/AC-8 : une feature en échec porte son motif")
func planFailedFeatureCarriesReason() async throws {
    let failure = ProjectFailure(kind: .lot, reason: "la compilation échoue", at: 1)
    let bare = featureStateLabel(.failed, failure: nil)
    #expect(featureStateLabel(.failed, failure: failure) == "\(bare) — la compilation échoue")
    // Un motif vide ne laisse pas de tiret orphelin.
    #expect(featureStateLabel(.failed, failure: ProjectFailure(kind: .lot, reason: "", at: 1)) == bare)
}

@MainActor
@Test("conduite-de-projet/AC-8 : un projet terminé ne cite plus de segment")
func planShowsDoneStatus() async throws {
    var project = twoSegmentProject()
    project.status = .done
    #expect(projectStatusLine(of: project) == ProjectViewText.statusDone)
}
