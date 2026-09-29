// La recette manuelle du spectateur : hors suite, hors CI (S-1, BR-1).
//
// Le paquet ne vend aucun produit exécutable en dehors du bundle .app, donc le
// véhicule de la recette est ce test, DÉSACTIVÉ par défaut : ni
// `.github/workflows/check.yml` ni `scripts/swift-app.sh` ne posent
// `MEM0_VIEWER_RECIPE`, la CI le rapporte donc « skipped ».
//
// Elle journalise les FAITS ESSENTIELS d'une VRAIE session et les octets relus :
// c'est ce que la revue confronte à la session de référence et au TUI.

import Foundation
import Testing

@testable import OMPConsole

@Test(
    "visionneuse-de-session/AC-3 : recette manuelle — faits essentiels d'une vraie session",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_VIEWER_RECIPE"] != nil)
)
/// Le nom de la FONCTION doit porter « recette » : `swift test --filter` filtre sur
/// l'identifiant du test (module et nom de fonction), pas sur son titre affiché.
func recetteManuelleJournaliseLesFaitsDUneVraieSession() throws {
    let environment = ProcessInfo.processInfo.environment
    guard let input = environment["MEM0_VIEWER_RECIPE"], !input.isEmpty else {
        Issue.record("MEM0_VIEWER_RECIPE est vide : la recette ne sait pas quelle session lire")
        return
    }
    guard let output = environment["MEM0_VIEWER_RECIPE_OUT"], !output.isEmpty else {
        Issue.record("MEM0_VIEWER_RECIPE_OUT est requis avec MEM0_VIEWER_RECIPE : c'est le chemin du journal à écrire")
        return
    }

    let reader = SessionReader(path: input)
    let delta = reader.read()
    var builder = SessionRowBuilder()
    builder.append(delta.added)

    var journal: [String] = [
        "session: \(input)",
        "entrées: \(reader.conversation.entries.count) · ignorées: \(reader.conversation.skipped.count) · octets lus: \(delta.bytesRead)",
        "lignes: \(builder.rows.count)",
    ]
    for row in builder.rows {
        journal.append(journalLine(row))
    }
    try (journal.joined(separator: "\n") + "\n").write(toFile: output, atomically: true, encoding: .utf8)

    print("recette : \(input) → \(output) ; \(builder.rows.count) lignes, \(delta.bytesRead) octets lus")
}

/// Une ligne de journal par fait : la forme la plus courte qui porte tout ce que
/// AC-3 exige de retrouver.
private func journalLine(_ row: SessionRow) -> String {
    switch row.kind {
    case .user(let content):
        return "\(row.id) user « \(content.text) »"
    case .assistant(let content):
        let thinking = content.thinking.map { " (réflexion \($0.count) car.)" } ?? ""
        return "\(row.id) agent « \(content.text) »\(thinking)"
    case .toolCall(let content):
        let status = content.result.map { $0.isError ? "erreur" : "ok" } ?? "en attente"
        let ask = content.ask.map { span in
            " ask[" + span.questions.map { question in
                question.question + " → " + question.options.map(\.label).joined(separator: " | ")
            }.joined(separator: " ; ") + "]"
        } ?? ""
        return "\(row.id) appel \(content.name)(\(content.target)) ⇒ \(status) args=\(content.argumentsJSON)\(ask)"
    case .toolResult(let content):
        return "\(row.id) résultat autonome \(content.name ?? "outil") « \(content.text) » diff=\(content.diff == nil ? "non" : "oui")"
    case .marker(.compaction(let summary, let tokens)):
        return "\(row.id) compaction \(tokens.map(String.init) ?? "?") « \(summary) »"
    case .marker(.branchSummary(let summary, let fromId)):
        return "\(row.id) branche \(fromId) « \(summary) »"
    }
}
