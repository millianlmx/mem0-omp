// Preuves de la surface « Projet » (BR-3) : les textes dérivés d'une valeur
// construite par le test. Aucune fenêtre n'est ouverte — ces textes sont des
// fonctions pures.

import Testing
@testable import OMPConsole

@MainActor
@Test("les textes exacts de la vue « Projet »")
func projectTextsAreExact() {
    #expect(
        ProjectViewText.refusal(name: "Alpha", path: "/tmp/alpha")
            == "Une conduite est déjà en cours sur « Alpha » (/tmp/alpha). Clore la conduite courante avant d'en démarrer une autre."
    )
    #expect(ProjectViewText.doneBanner(m: 3, n: 4) == "Projet terminé — 3/4 feature(s) fusionnée(s).")
}

@Test("une URL de PR non http(s) n'est pas cliquable")
func projectPRLinkRequiresHTTPS() {
    #expect(ProjectPlanRowView.linkURL("https://exemple.test/pull/1") != nil)
    #expect(ProjectPlanRowView.linkURL("http://example.com/1") != nil)
    #expect(ProjectPlanRowView.linkURL("socle-1") == nil)
}
