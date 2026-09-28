// La recette manuelle du lecteur (S-7) : hors suite, hors CI.
//
// Le paquet ne vend aucun produit exécutable (Doc-5), donc le véhicule de la
// recette est ce test, DÉSACTIVÉ par défaut. Aucune étape de
// `.github/workflows/check.yml` ni `scripts/swift-app.sh` ne pose
// `MEM0_SESSION_RECIPE` : la CI le rapporte « skipped » et ne l'exécute jamais.

import Foundation
import Testing

@testable import OMPConsole

@Test(
    "lecteur-de-sessions-omp/AC-12 : recette manuelle — lecture et rendu d'une vraie session",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_SESSION_RECIPE"] != nil)
)
/// Le nom de la FONCTION doit porter « recette » : `swift test --filter` filtre sur
/// l'identifiant du test (module et nom de fonction), pas sur son titre affiché.
func recetteManuelleRendUneVraieSession() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let input = environment["MEM0_SESSION_RECIPE"], !input.isEmpty else {
        Issue.record("MEM0_SESSION_RECIPE est vide : la recette ne sait pas quelle session lire")
        return
    }
    guard let output = environment["MEM0_SESSION_RECIPE_OUT"], !output.isEmpty else {
        Issue.record("MEM0_SESSION_RECIPE_OUT est requis avec MEM0_SESSION_RECIPE : c'est le chemin du rendu à écrire")
        return
    }

    let reader = SessionReader(path: input)
    let delta = reader.read()
    let rendered = renderConversation(reader.conversation)
    try rendered.write(toFile: output, atomically: true, encoding: .utf8)

    // La recette ne juge pas le contenu : elle produit le rendu pour la revue et
    // annonce les comptes que la revue doit confronter au fichier.
    print(
        "recette : \(input) → \(output) ; "
            + "\(reader.conversation.entries.count) entrées, "
            + "\(reader.conversation.skipped.count) ignorées, "
            + "\(rendered.utf8.count) octets de rendu, "
            + "issue=\(String(describing: delta.issue))"
    )
}
