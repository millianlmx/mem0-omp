// Preuves de la surface « Projet » (BR-3) : les dérivations pures de la vue.
// Aucune fenêtre n'est ouverte.

import Testing
@testable import OMPConsole

@Test("une URL de PR non http(s) n'est pas cliquable")
func projectPRLinkRequiresHTTPS() {
    #expect(ProjectPlanRowView.linkURL("https://exemple.test/pull/1") != nil)
    #expect(ProjectPlanRowView.linkURL("http://example.com/1") != nil)
    #expect(ProjectPlanRowView.linkURL("socle-1") == nil)
}
