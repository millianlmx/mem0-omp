// Les preuves Swift des rangées lues par VoiceOver (BR-1 : la liste racine ;
// BR-2 : l'écran Sessions et sa recette `phases`).
//
// Chaque test PORTE l'id d'acceptation qu'il prouve. Les libellés attendus se
// composent par interpolation, avec les mots lus par symbole (`IOSHomeText`,
// `ConsoleSection`) et jamais recopiés.

import ConsoleCore
import Testing

@testable import OMPConsoleIOS

@MainActor
@Suite("ios-accessibilite-rangees-et-sessions — rangées lues par VoiceOver")
struct IOSRowAccessibilityTests {
    // MARK: - Liste racine (BR-1)

    /// Le badge visible puis le libellé de la rangée, comme le fait `RootView`.
    private static func rowLabel(
        _ section: ConsoleSection, selection: ConsoleSection?, attentionCount: Int
    ) -> (badge: Int, label: String) {
        let badge = IOSHomeContent.rowBadge(
            for: section, selection: selection, attentionCount: attentionCount)
        return (badge, IOSHomeText.sectionRowLabel(section.title, badge: badge))
    }

    @Test("ios-accessibilite-rangees-et-sessions/AC-2 : le libellé d'une rangée racine annonce le badge visible, et lui seul")
    func sectionRowLabelFollowsShownBadge() {
        let pending = IOSHomeText.rowPending
        let home = ConsoleSection.home.title
        let kanban = ConsoleSection.kanban.title

        let shown = Self.rowLabel(.home, selection: .home, attentionCount: 2)
        #expect(shown.badge == 2)
        #expect(shown.label == "\(home), 2 \(pending)")

        // Accueil non sélectionnée (racine iPhone) : pas de badge, donc pas d'annonce.
        let unselected = Self.rowLabel(.home, selection: nil, attentionCount: 2)
        #expect(unselected.badge == 0)
        #expect(unselected.label == home)

        let none = Self.rowLabel(.home, selection: .home, attentionCount: 0)
        #expect(none.badge == 0)
        #expect(none.label == home)

        let other = Self.rowLabel(.kanban, selection: .kanban, attentionCount: 2)
        #expect(other.badge == 0)
        #expect(other.label == kanban)

        let many = Self.rowLabel(.home, selection: .home, attentionCount: 120)
        #expect(many.label == "\(home), 120 \(pending)")
    }

    // MARK: - Écran Sessions (BR-2)

    private static let startedAtMs: Double = 1_790_762_400_000

    /// Un run terminé, construit comme `SessionList.make` : le sous-titre de la
    /// ligne vient de `RunChoice.subtitle(phase:repo:)`, ou manque (`subtitle: nil`).
    private static func choice(
        title: String, repo: String, phase: PipelinePhase, withSubtitle: Bool = true
    ) -> RunChoice {
        let sessionFile = "/sessions/" + title + ".jsonl"
        return RunChoice(
            id: sessionFile,
            sessionFile: sessionFile,
            label: repo + "/" + title,
            repo: repo,
            featureTitle: title,
            startedAtMs: startedAtMs,
            phase: phase,
            state: .ended(.done),
            isStale: false,
            target: ViewerTarget(
                sessionFile: sessionFile,
                title: title,
                subtitle: withSubtitle ? RunChoice.subtitle(phase: phase, repo: repo) : nil
            )
        )
    }

    @Test("ios-accessibilite-rangees-et-sessions/AC-3 : le libellé d'une session dit nom, état, étape, dépôt et heure, dans l'ordre de la rangée")
    func sessionRowLabelSaysWhatRowShows() {
        let run = Self.choice(title: "ma-feature", repo: "alpha", phase: .review)
        let expected = [
            "ma-feature",
            ConsoleStatus.of(run: run).text,
            PhaseText.title(.review),
            "alpha",
            ConsoleFormat.time(ms: Self.startedAtMs),
        ].joined(separator: IOSSessionText.rowLabelSeparator)
        #expect(IOSSessionText.rowLabel(run) == expected)
    }

    @Test("ios-accessibilite-rangees-et-sessions/AC-4 : un dépôt vide ou une ligne d'étape absente ne laisse ni champ vide ni séparateur orphelin")
    func sessionRowLabelSkipsWhatRowHides() {
        let separator = IOSSessionText.rowLabelSeparator
        let time = ConsoleFormat.time(ms: Self.startedAtMs)

        let emptyRepo = Self.choice(title: "t", repo: "", phase: .impl)
        let status = ConsoleStatus.of(run: emptyRepo).text
        let withoutRepo = ["t", status, PhaseText.title(.impl), time].joined(separator: separator)
        #expect(IOSSessionText.rowLabel(emptyRepo) == withoutRepo)

        let noSubtitle = Self.choice(title: "t", repo: "alpha", phase: .impl, withSubtitle: false)
        #expect(IOSSessionText.rowLabel(noSubtitle) == ["t", status, time].joined(separator: separator))

        let blankRepo = Self.choice(title: "t", repo: "  ", phase: .impl)
        #expect(IOSSessionText.rowLabel(blankRepo) == withoutRepo)

        for run in [emptyRepo, noSubtitle, blankRepo] {
            let label = IOSSessionText.rowLabel(run)
            #expect(!label.contains(separator + separator))
            #expect(!label.hasPrefix(separator))
            #expect(!label.hasSuffix(separator))
            #expect(!label.contains("·"))
        }
    }

    @Test("ios-accessibilite-rangees-et-sessions/AC-5 : la recette phases montre une session par étape, d'identités distinctes")
    func phasesRecipeShowsEveryPhase() throws {
        let resolved = IOSSessionsRecipe.resolve([IOSSessionText.recipeFlag, IOSSessionText.recipePhases])
        #expect(resolved == .phases)
        let phases = try #require(resolved)

        let choices = phases.list.choices
        #expect(Set(choices.map(\.phase)) == Set(PipelinePhase.allCases))
        #expect(Set(choices.map(\.id)).count == PipelinePhase.allCases.count)
        #expect(choices.allSatisfy { $0.state == .ended(.done) })
        #expect(phases.thread == nil)

        // La recette `liste` ne change pas : une session, au fichier d'avant.
        let liste = IOSSessionsRecipe.liste.list.choices
        #expect(liste.count == 1)
        #expect(liste.first?.sessionFile.contains("parity-session-1.jsonl") == true)
    }
}
