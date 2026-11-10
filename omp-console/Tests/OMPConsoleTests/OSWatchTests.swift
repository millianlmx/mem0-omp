// « Voir et savoir » dans l'OS agentique, la logique pure des écrans partagés
// (ConsoleUI/OS) : le tri des fils par espace puis par lieu, les sélections de l'espace
// de travail (page d'un espace, fil d'une feature attendue), le regroupement des
// propositions par source et qui peut les accepter, les règles de palier en phrases, la
// tendance d'un chiffre et la saisie du budget d'un espace.

import ConsoleClient
import ConsoleCore
@testable import ConsoleUI
import Foundation
import Testing

private func run(_ id: String, repo: String, at: Double = 1) -> HarnessRun {
    HarnessRun(id: id, repo: repo, slug: id, title: id, request: id, state: "merged", createdAt: at, updatedAt: at)
}

private func request(_ id: String) throws -> WorkstationRequest {
    try JSONDecoder().decode(
        WorkstationRequest.self,
        from: JSONSerialization.data(withJSONObject: ["id": id, "instruction": id, "state": "done", "createdAt": 5, "updatedAt": 5, "by": "mac"])
    )
}

/// Un client sans serveur relié : en mémoire, il n'appelle personne.
@MainActor
private func unlinkedServer() -> HarnessModel {
    HarnessModel(transport: URLSessionHarnessTransport(), preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore())
}

private func proposal(_ id: String, source: String, action: String = "launch") -> HarnessProposal {
    HarnessProposal(id: id, source: source, title: id, action: action)
}

@Suite("Voir et savoir")
@MainActor
struct OSWatchTests {
    private let perso = HarnessSpace(id: "e1", name: "Perso", repos: ["demo"], poste: true)
    private let client = HarnessSpace(id: "e2", name: "Client", repos: ["boutique", "vitrine"])

    /// Trois features (deux espaces, un dépôt hors de tout espace) et une demande au poste.
    private func threads() throws -> [OSThread] {
        OSThreads.build(
            runs: [run("a", repo: "demo", at: 1), run("b", repo: "boutique", at: 2), run("c", repo: "ailleurs", at: 3)],
            inbox: nil,
            requests: [try request("p")]
        )
    }

    // MARK: Espace et lieu

    @Test("un espace ne garde que les fils de ses dépôts, et le poste s'il le porte")
    func spaceKeepsItsThreads() throws {
        let all = try threads()
        let spaces = [perso, client]
        let ofPerso = OSThreadScope.threads(all, spaceId: "e1", place: nil, spaces: spaces)
        #expect(Set(ofPerso.map(\.id)) == ["r:a", "w:p"])
        let ofClient = OSThreadScope.threads(all, spaceId: "e2", place: nil, spaces: spaces)
        #expect(ofClient.map(\.id) == ["r:b"])
    }

    @Test("sans espace retenu, ou avec un espace disparu, tous les fils restent")
    func noSpaceKeepsEverything() throws {
        let all = try threads()
        #expect(OSThreadScope.threads(all, spaceId: nil, place: nil, spaces: [perso, client]).count == 4)
        #expect(OSThreadScope.threads(all, spaceId: "supprimé", place: nil, spaces: [perso, client]).count == 4)
    }

    @Test("le lieu affine l'espace : un dépôt, ou le Poste")
    func placeNarrowsTheSpace() throws {
        let all = try threads()
        let spaces = [perso, client]
        #expect(OSThreadScope.threads(all, spaceId: "e1", place: "demo", spaces: spaces).map(\.id) == ["r:a"])
        #expect(OSThreadScope.threads(all, spaceId: "e1", place: OSWorkspace.postePlace, spaces: spaces).map(\.id) == ["w:p"])
        #expect(OSThreadScope.threads(all, spaceId: "e2", place: "demo", spaces: spaces).isEmpty, "un dépôt d'un autre espace")
        #expect(OSThreadScope.threads(all, spaceId: nil, place: "ailleurs", spaces: spaces).map(\.id) == ["r:c"])
    }

    @Test("les lieux proposés : tous les dépôts connus puis le Poste ; dans un espace, les siens seulement")
    func placesFollowTheSpace() throws {
        let all = try threads()
        #expect(OSThreadScope.places(repos: ["demo", "zeta"], threads: all, space: nil) == ["ailleurs", "boutique", "demo", "zeta", OSWorkspace.postePlace])
        #expect(OSThreadScope.places(repos: ["demo"], threads: all, space: perso) == ["demo", OSWorkspace.postePlace])
        #expect(OSThreadScope.places(repos: ["demo"], threads: all, space: client) == ["boutique", "vitrine"], "cet espace ne porte pas le poste")
        #expect(OSThreadScope.places(repos: [], threads: [], space: perso) == ["demo"], "aucun fil au poste : pas de lieu Poste")
    }

    // MARK: Espace de travail

    @Test("retenir un espace oublie un lieu qui n'est pas le sien")
    func choosingASpaceDropsAForeignPlace() {
        let workspace = OSWorkspace(server: unlinkedServer())
        workspace.place = "demo"
        workspace.choose(space: client)
        #expect(workspace.spaceId == "e2")
        #expect(workspace.place == nil)
        workspace.place = "boutique"
        workspace.choose(space: client)
        #expect(workspace.place == "boutique", "un dépôt de l'espace reste")
        workspace.place = OSWorkspace.postePlace
        workspace.choose(space: perso)
        #expect(workspace.place == OSWorkspace.postePlace, "le Poste reste dans l'espace qui le porte")
        workspace.choose(space: client)
        #expect(workspace.place == nil)
        workspace.choose(space: nil)
        #expect(workspace.spaceId == nil)
    }

    @Test("la sélection de la page d'un espace se relit ; un fil n'en est pas une")
    func spaceSelectionRoundTrips() {
        #expect(OSWorkspace.spaceId(of: OSWorkspace.space("e2")) == "e2")
        #expect(OSWorkspace.spaceId(of: "r:a") == nil)
        #expect(OSWorkspace.spaceId(of: OSWorkspace.knowledge) == nil)
        #expect(OSWorkspace.spaceId(of: nil) == nil)
    }

    @Test("le fil d'une feature attendue s'ouvre dès qu'il existe, et plus après")
    func pendingRunOpensWhenItsThreadExists() throws {
        let workspace = OSWorkspace(server: unlinkedServer())
        workspace.open(runId: "b", in: [])
        #expect(workspace.selection == OSWorkspace.now)
        #expect(workspace.pendingRunId == "b")
        workspace.settle(try threads())
        #expect(workspace.selection == "r:b")
        #expect(workspace.pendingRunId == nil)
        // Un autre fil ouvert entre-temps annule l'attente.
        workspace.open(runId: "inconnue", in: [])
        workspace.open("r:a")
        workspace.settle(try threads())
        #expect(workspace.selection == "r:a")
    }

    // MARK: Propositions

    @Test("les propositions se groupent par source dans l'ordre de lecture, les inconnues à la fin, sans groupe vide")
    func proposalsGroupBySource() {
        let groups = OSProposalGroups.build([
            proposal("1", source: "ci"), proposal("2", source: "issue"), proposal("3", source: "nouvelle"),
            proposal("4", source: "issue"), proposal("5", source: "audit"), proposal("6", source: "autre"),
        ])
        #expect(groups.map(\.source) == ["issue", "audit", "ci", ""])
        #expect(groups.map { $0.items.map(\.id) } == [["2", "4"], ["5"], ["1"], ["3", "6"]], "l'ordre du serveur est gardé dans un groupe")
        #expect(OSProposalGroups.build([]).isEmpty)
    }

    @Test("un opérateur lance ; appliquer un palier revient à l'admin ; signalement et Jira, à l'approbateur ; un lecteur ne fait rien")
    func proposalAcceptanceFollowsTheRole() {
        let issue = proposal("1", source: "issue")
        let tier = proposal("2", source: "autonomy", action: "apply")
        let signal = proposal("3", source: "signal", action: "confirm")
        let jira = proposal("4", source: "jira")
        let accepts = { (item: HarnessProposal, canAct: Bool, admin: Bool, approver: Bool) in
            OSProposalGroups.canAccept(item, canAct: canAct, isAdmin: admin, approver: approver)
        }
        #expect(accepts(issue, true, false, false))
        #expect(!accepts(issue, false, true, true), "un lecteur")
        #expect(!accepts(tier, true, false, true))
        #expect(accepts(tier, true, true, false))
        #expect(!accepts(signal, true, true, false))
        #expect(accepts(signal, true, false, true))
        #expect(!accepts(jira, true, true, false))
        #expect(accepts(jira, true, false, true))
    }

    // MARK: Paliers

    @Test("une règle de palier se dit en une phrase, ses conditions dessous")
    func tierRulesReadAsSentences() {
        let phrases = OSTiers.phrases([
            HarnessAutonomyRule(
                match: HarnessAutonomyMatch(kind: "bug", maxDiffLines: 80),
                require: HarnessAutonomyRequire(greenChecks: true),
                gates: HarnessAutonomyGates(specs: "auto", review: "human")
            ),
            HarnessAutonomyRule(match: HarnessAutonomyMatch(kind: "docs"), gates: HarnessAutonomyGates(specs: "auto", review: "auto")),
            HarnessAutonomyRule(match: HarnessAutonomyMatch(kind: "deps"), gates: HarnessAutonomyGates(specs: "human", review: "auto")),
            HarnessAutonomyRule(match: HarnessAutonomyMatch(kind: "feature")),
        ])
        #expect(phrases.map(\.text) == [
            OSWatchText.tier(kind: AutonomyText.kind("bug"), specsAlone: true, reviewAlone: false),
            OSWatchText.tier(kind: AutonomyText.kind("docs"), specsAlone: true, reviewAlone: true),
            OSWatchText.tier(kind: AutonomyText.kind("deps"), specsAlone: false, reviewAlone: true),
            OSWatchText.tier(kind: AutonomyText.kind("feature"), specsAlone: false, reviewAlone: false),
        ])
        #expect(Set(phrases.map(\.text)).count == 4, "quatre phrases distinctes")
        #expect(phrases[0].text.hasPrefix(AutonomyText.kind("bug")))
        #expect(phrases[0].conditions == AutonomyText.maxDiffLines(80) + " · " + AutonomyText.requires(AutonomyText.requireGreenChecks))
        #expect(phrases[1].conditions == nil, "sans condition : la phrase seule")
        #expect(phrases.map(\.id) == [0, 1, 2, 3])
    }

    @Test("« Appliquer » écrit le sens de la proposition ; un code inconnu ne s'applique pas")
    func tierProposalBecomesARule() throws {
        let raise = try #require(OSTiers.change(of: HarnessAutonomyProposal(repo: "demo", kind: "docs", gate: "review", direction: "raise", current: "human")))
        #expect(raise.kind == .docs)
        #expect(raise.gate == .review)
        #expect(raise.mode == .auto)
        let lower = try #require(OSTiers.change(of: HarnessAutonomyProposal(repo: "demo", kind: "bug", gate: "specs", direction: "lower", current: "auto")))
        #expect(lower.mode == .human)
        #expect(lower.gate == .specs)
        #expect(OSTiers.change(of: HarnessAutonomyProposal(repo: "demo", kind: "refonte", gate: "review", direction: "raise", current: "human")) == nil)
        #expect(OSTiers.change(of: HarnessAutonomyProposal(repo: "demo", kind: "bug", gate: "fusion", direction: "raise", current: "human")) == nil)
        #expect(OSTiers.change(of: HarnessAutonomyProposal(repo: "demo", kind: "bug", gate: "review", direction: "ailleurs", current: "human")) == nil)
    }

    // MARK: Chiffres et budget

    @Test("la tendance compare la valeur récente à la fenêtre longue, stable sous la tolérance, absente sans l'une des deux")
    func trendComparesRecentToLonger() {
        #expect(OSScoreTrend.of(0.8, against: 0.5, tolerance: 0.02) == .up)
        #expect(OSScoreTrend.of(0.3, against: 0.5, tolerance: 0.02) == .down)
        #expect(OSScoreTrend.of(0.51, against: 0.5, tolerance: 0.02) == .flat)
        #expect(OSScoreTrend.of(nil, against: 0.5, tolerance: 0.02) == nil)
        #expect(OSScoreTrend.of(0.5, against: nil, tolerance: 0.02) == nil)
    }

    @Test("le budget d'un espace : vide, un montant (virgule ou point), ou une saisie refusée")
    func spaceBudgetParses() {
        #expect(OSSpaceBudget.parse("") == .none)
        #expect(OSSpaceBudget.parse("  ") == .none)
        #expect(OSSpaceBudget.parse("20") == .amount(20))
        #expect(OSSpaceBudget.parse("12,5") == .amount(12.5))
        #expect(OSSpaceBudget.parse(" 7.25 ") == .amount(7.25))
        #expect(OSSpaceBudget.parse("0") == .invalid)
        #expect(OSSpaceBudget.parse("-3") == .invalid)
        #expect(OSSpaceBudget.parse("vingt") == .invalid)
    }
}
