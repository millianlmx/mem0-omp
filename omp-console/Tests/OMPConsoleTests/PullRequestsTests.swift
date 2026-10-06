// La couche pure du suivi de PR, figée (S-1) : table des `bucket`, normalisation des
// trois statuts requis, doublon réduit au pire, numéro de PR, identifiant de run,
// ordre des lignes et fraîcheur.

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

private func feature(
    _ slug: String,
    status: ProjectFeatureStatus,
    prUrl: String? = nil
) -> ProjectFeature {
    ProjectFeature(
        slug: slug,
        intention: "intention de \(slug)",
        model: nil,
        status: status,
        prUrl: prUrl,
        failure: nil,
        removedReason: nil,
        updatedAt: 1_790_000_000_000
    )
}

private func project(_ segments: [ProjectSegment]) -> Project {
    Project(
        repoKey: "d0ef9a50f7dc3a37",
        repoRoot: "/tmp/projet",
        relayKey: "/tmp/pipeline/projects/x@1",
        purpose: "but",
        function: "fonction",
        status: .running,
        segments: segments,
        current: 0,
        base: nil,
        hostSession: nil,
        createdAt: 1_790_000_000_000,
        updatedAt: 1_790_000_000_000
    )
}

@Test("suivi-pr-ci/AC-1 : la table bucket → state est celle de gh, tout bucket inconnu est « en cours »")
func bucketTableIsExact() {
    #expect(prCheckState(forBucket: "pass") == .green)
    #expect(prCheckState(forBucket: "fail") == .red)
    #expect(prCheckState(forBucket: "cancel") == .red)
    #expect(prCheckState(forBucket: "pending") == .pending)
    #expect(prCheckState(forBucket: "skipping") == .ignored)
    #expect(prCheckState(forBucket: nil) == .pending)
    #expect(prCheckState(forBucket: "inconnu") == .pending)
    // Les libellés affichés, en toutes lettres.
    #expect(PRCheckState.green.label == "vert")
    #expect(PRCheckState.red.label == "rouge")
    #expect(PRCheckState.pending.label == "en cours")
    #expect(PRCheckState.ignored.label == "ignoré")
}

@Test("suivi-pr-ci/AC-1 : un statut requis absent de la réponse est « en cours », sans lien")
func missingRequiredCheckIsPending() {
    let readings = [
        PRCheckReading(name: "check (ubuntu-latest)", state: .green, link: "https://exemple.test/job/1"),
    ]
    let normalized = normalizedRequiredChecks(readings)
    #expect(normalized.count == 3)
    #expect(normalized.map(\.name) == [
        "check (ubuntu-latest)", "check (macos-latest)", "release-simulation",
    ])
    #expect(normalized[0].state == .green)
    #expect(normalized[1].state == .pending)
    #expect(normalized[1].link == nil)
    #expect(normalized[2].state == .pending)
}

@Test("suivi-pr-ci/AC-1 : un même nom en double retient le PIRE état, jamais une promotion au vert")
func duplicateCheckKeepsWorst() throws {
    let json = """
    [
      {"name": "check (macos-latest)", "bucket": "pass", "link": "https://exemple.test/job/a"},
      {"name": "check (macos-latest)", "bucket": "fail", "link": "https://exemple.test/job/b"}
    ]
    """
    let readings = try parseChecks(json)
    let macos = readings.first { $0.name == "check (macos-latest)" }
    #expect(macos?.state == .red)
    #expect(macos?.link == "https://exemple.test/job/b")
}

@Test("suivi-pr-ci/AC-1 : le numéro de PR et l'identifiant de run se lisent dans l'URL")
func urlDerivations() {
    #expect(pullRequestNumber(in: "https://exemple.test/owner/repo/pull/45") == 45)
    #expect(pullRequestNumber(in: "https://exemple.test/owner/repo/pull/45/") == 45)
    #expect(pullRequestNumber(in: "https://exemple.test/owner/repo/pull/ma-branche") == nil)
    #expect(pullRequestNumber(in: "issoir-1 pane") == nil)

    #expect(runIdentifier(of: "https://exemple.test/actions/runs/36/job/109789011950") == "109789011950")
    #expect(runIdentifier(of: "https://exemple.test/actions/runs/36/job/109789011950/") == "109789011950")
    #expect(runIdentifier(of: nil) == nil)
    #expect(runIdentifier(of: "109789011950") == nil)
}

@Test("suivi-pr-ci/AC-1 : les lignes suivent l'ordre du plan et portent les trois statuts dans l'ordre de S-1")
func rowsFollowPlanOrder() {
    let subject = project([
        ProjectSegment(name: "Fondations", features: [feature("socle", status: .merged)]),
        ProjectSegment(name: "Lire le réel", features: [
            feature("premiere", status: .pr, prUrl: "https://exemple.test/pull/43"),
            feature("sans-url", status: .pr, prUrl: nil),
            feature("seconde", status: .pr, prUrl: "https://exemple.test/pull/45"),
            feature("retiree", status: .removed),
        ]),
    ])
    let followed = followedPRs(of: subject)
    #expect(followed.map(\.slug) == ["premiere", "seconde"])
    #expect(followed.map(\.number) == [43, 45])

    let knowledge: [String: PRKnowledge] = [
        "premiere": PRKnowledge(
            snapshot: PRSnapshot(
                title: "Première PR",
                headOid: "aaa",
                body: "",
                checks: [
                    PRCheckReading(name: "check (ubuntu-latest)", state: .green, link: nil),
                    PRCheckReading(name: "check (macos-latest)", state: .red, link: "https://exemple.test/job/109789011950"),
                    PRCheckReading(name: "release-simulation", state: .pending, link: nil),
                ]
            ),
            freshness: .fresh
        ),
    ]
    let rows = projectPRRows(followed: followed, knowledge: knowledge)
    #expect(rows.map(\.slug) == ["premiere", "seconde"])
    #expect(rows[0].checks.map(\.required) == [.ubuntu, .macos, .releaseSimulation])
    #expect(rows[0].checks.map(\.state) == [.green, .red, .pending])
    #expect(rows[0].isMergeAvailable == false)
    #expect(rows[0].headline == "PR #43 — Première PR")
    // Jamais lue : trois statuts « en cours », aucun titre, jamais mêlée au vert.
    #expect(rows[1].checks.allSatisfy { $0.state == .pending })
    #expect(rows[1].freshness == .unknown)
    #expect(rows[1].title == nil)
    #expect(rows[1].isMergeAvailable == false)
}

@Test("suivi-pr-ci/AC-1 : un projet absent ne suit aucune PR")
func noProjectNoRows() {
    #expect(followedPRs(of: nil).isEmpty)
    #expect(projectPRRows(followed: [], knowledge: [:]).isEmpty)
}

@Test("suivi-pr-ci/AC-4 : la fusion n'est disponible que si les trois statuts sont verts")
func mergeAvailabilityRequiresThreeGreens() {
    let checks = RequiredCheck.allCases.map {
        PRCheckReading(name: $0.name, state: .green, link: nil)
    }
    let green = ProjectPRRow(
        slug: "a", number: 1, title: "t", url: "https://exemple.test/pull/1",
        checks: RequiredCheck.allCases.enumerated().map { index, required in
            PRCheckRow(required: required, state: .green, link: nil)
        },
        freshness: .fresh
    )
    #expect(green.isMergeAvailable)
    #expect(checks.count == 3)

    for index in 0..<3 {
        let states: [PRCheckState] = RequiredCheck.allCases.enumerated().map { i, _ in
            i == index ? .pending : .green
        }
        let row = ProjectPRRow(
            slug: "a", number: 1, title: "t", url: "https://exemple.test/pull/1",
            checks: RequiredCheck.allCases.enumerated().map { i, required in
                PRCheckRow(required: required, state: states[i], link: nil)
            },
            freshness: .fresh
        )
        #expect(row.isMergeAvailable == false, "un statut \(states[index]) doit interdire la fusion")
    }
}

@Test("suivi-pr-ci/AC-1 : headline a ses trois formes")
func headlineHasThreeForms() {
    func row(number: Int?, title: String?) -> ProjectPRRow {
        ProjectPRRow(
            slug: "a", number: number, title: title, url: "https://exemple.test/pull/45",
            checks: [], freshness: .unknown
        )
    }
    #expect(row(number: 45, title: "Mon titre").headline == "PR #45 — Mon titre")
    #expect(row(number: 45, title: nil).headline == "PR #45")
    #expect(row(number: nil, title: nil).headline == "https://exemple.test/pull/45")
}

@Test("suivi-pr-ci/AC-1 : la lecture d'une PR décode les trois champs de `gh pr view`")
func parseViewDecodesFields() throws {
    let json = #"{"title": "Titre", "headRefOid": "abc123", "body": "Corps"}"#
    let parsed = try parsePRView(json)
    #expect(parsed.title == "Titre")
    #expect(parsed.headOid == "abc123")
    #expect(parsed.body == "Corps")

    #expect(throws: PRParseError.self) { _ = try parsePRView("pas du json") }
    #expect(throws: PRParseError.self) { _ = try parsePRView(#"{"title": "T"}"#) }
}

// MARK: - validation textuelle de l'adresse (S-3, B-2)

@Test("chemins-du-magasin-non-confines/AC-4 : la table des adresses de PR acceptées et refusées")
func prURLValidationTableIsExact() {
    let accepted = [
        "https://github.com/o/r/pull/1",
        "HTTPS://GitHub.COM/o/r/pull/12",
        "https://github.com/proprietaire/depot.git/pull/4294967296",
        "https://github.com/a-b_c.d/e-f_g.h/pull/1",
    ]
    for raw in accepted {
        #expect(validatedPRURL(raw) == raw, "« \(raw) » doit être rendue INCHANGÉE")
    }

    let refused = [
        "https://github.com/o/r/pull/1/",
        "https://github.com/o/r/pull/0",
        "https://github.com/o/r/pull/007",
        "https://github.com/o/r/pull/1?x=1",
        "https://github.com/o/r/pull/1#f",
        "https://gitlab.com/o/r/pull/1",
        "http://github.com/o/r/pull/1",
        "https://github.com/o/r/issues/1",
        "https://github.com/o//pull/1",
        "https://github.com/o/r/pull/1 ",
        "https://github.com:443/o/r/pull/1",
        "https://user@github.com/o/r/pull/1",
        "-R evil",
        "",
        "https://",
        "https://github.com/o/r/pull/",
        "https://gist.github.com/o/r/pull/1",
        "https://github.com.evil.test/o/r/pull/1",
        "https://github.com/o/r/pull/1%C2%A0",
        "https://github.com/o/r/pull/١٢",
        "https://github.com/o/r/pull/1/2",
    ]
    for raw in refused {
        #expect(validatedPRURL(raw) == nil, "« \(raw) » doit être refusée")
    }

    // La validation est TEXTUELLE : aucune de ces formes ne dépend de `URL(string:)`,
    // qui les normaliserait (§7).
    #expect(validatedPRURL("https://github.com/o/r/pull/1 ") == nil)
    #expect(URL(string: "https://github.com/o/r/pull/1 ") != nil, "URL() accepte ce que nous refusons")
}

@Test("chemins-du-magasin-non-confines/AC-4 : le refus porte le message d'erreur de la couche PR")
func invalidPRURLCarriesItsMessage() {
    let error = GhError.invalidPRURL(url: "https://gitlab.com/o/r/pull/1")
    #expect(error.userMessage.contains("l'adresse de PR est refusée"))
    #expect(error.userMessage.contains("https://gitlab.com/o/r/pull/1"))
    #expect(error.failureDetail == error.userMessage, "aucun second message : `failureDetail` retombe sur `userMessage`")
}
