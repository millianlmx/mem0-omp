// Preuves de la surface « Projet » (BR-3) : déclaration de section et textes
// exacts. Aucune fenêtre n'est ouverte — les textes sont des constantes pures.

import Testing
@testable import OMPConsole

@MainActor
@Test("la section « Projet » est celle de la coque")
func projectSectionIsDeclared() {
    #expect(ProjectView.section == .project)
}

@MainActor
@Test("les textes exacts de la vue « Projet »")
func projectTextsAreExact() {
    #expect(ProjectViewText.emptyTitle == "Aucune conduite en cours.")
    #expect(ProjectViewText.emptyHelp == "Choisissez un dépôt pour conduire un projet de bout en bout depuis l'app.")
    #expect(ProjectViewText.notGitRepository == "Ce dossier n'est pas un dépôt git.")
    #expect(ProjectViewText.waitingBanner == "Le projet attend votre réponse.")
    #expect(ProjectViewText.docMissing == "PROJECT.md n'est pas encore publié.")
    #expect(ProjectViewText.projectMissing == "Projet introuvable dans le magasin d'état.")
    #expect(ProjectViewText.sessionStarting == "Lancement de la session…")
    #expect(ProjectViewText.sessionClosing == "Arrêt de la session…")
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
