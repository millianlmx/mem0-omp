// Preuves de la surface « Projet » (BR-3) : les dérivations pures de la vue.
// Aucune fenêtre n'est ouverte.

import Testing
@testable import OMPConsole
import ConsoleCore

@Test("une URL de PR non http(s) n'est pas cliquable")
func projectPRLinkRequiresHTTPS() {
    #expect(httpURL("https://exemple.test/pull/1") != nil)
    #expect(httpURL("http://example.com/1") != nil)
    #expect(httpURL("socle-1") == nil)
}
