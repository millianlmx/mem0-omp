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

    #expect(projectStatusLine(of: project) == "en cours — segment 2/2 « Lire le réel »")
    #expect(projectProgressLine(of: project) == "1/2 feature(s) fusionnée(s)")

    // Une URL non http(s) n'est pas cliquable ; une URL http(s) l'est.
    #expect(ProjectPlanRowView.linkURL("https://example.com/pull/1") != nil)
    #expect(ProjectPlanRowView.linkURL("issoir-1 pane") == nil)
}

@MainActor
@Test("conduite-de-projet/AC-8 : le vocabulaire d'état est celui du pilote")
func planUsesPilotVocabulary() async throws {
    #expect(featureStateLabel(.planned, failure: nil) == "à venir")
    #expect(featureStateLabel(.launched, failure: nil) == "lancée")
    #expect(featureStateLabel(.pr, failure: nil) == "PR ouverte")
    #expect(featureStateLabel(.merged, failure: nil) == "fusionnée")
    #expect(featureStateLabel(.removed, failure: nil) == "retirée")
    #expect(featureStateLabel(.failed, failure: nil) == "en échec")
    let failure = ProjectFailure(kind: .lot, reason: "la compilation échoue", at: 1)
    #expect(featureStateLabel(.failed, failure: failure) == "en échec — la compilation échoue")
}

@MainActor
@Test("conduite-de-projet/AC-8 : un projet terminé se dit « terminé »")
func planShowsDoneStatus() async throws {
    var project = twoSegmentProject()
    project.status = .done
    #expect(projectStatusLine(of: project) == "terminé")
}
