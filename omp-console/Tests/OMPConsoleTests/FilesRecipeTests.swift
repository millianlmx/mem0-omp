// La recette manuelle de la visionneuse (BR-4) : hors suite, hors CI.
//
// Le paquet ne vend aucun produit exécutable, donc le véhicule de la recette est ce
// test, DÉSACTIVÉ par défaut : aucune étape de `.github/workflows/check.yml` ni
// `scripts/swift-app.sh` ne pose `MEM0_FILES_RECIPE`, donc la CI le rapporte
// « skipped » et ne l'exécute jamais.
//
// Il ne juge rien : il écrit, sur une VRAIE cible, ce que la section afficherait —
// le catalogue, l'arbre, le diff du premier fichier modifié et le contenu du premier
// fichier — pour que la revue confronte le rendu aux commandes git du poste.

import Foundation
import Testing

@testable import OMPConsole

@MainActor
@Test(
    "visionneuse-de-fichiers-et-diffs/AC-1 : recette manuelle — catalogue, arbre, diff et contenu d'une vraie cible",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_FILES_RECIPE"] != nil)
)
/// Le nom de la FONCTION doit porter « recette » : `swift test --filter` filtre sur
/// l'identifiant du test (module et nom de fonction), pas sur son titre affiché.
func recetteManuelleRendUneVraieCible() async throws {
    let environment = ProcessInfo.processInfo.environment
    guard let input = environment["MEM0_FILES_RECIPE"], !input.isEmpty else {
        Issue.record("MEM0_FILES_RECIPE est vide : la recette ne sait pas quelle cible lire")
        return
    }
    guard let output = environment["MEM0_FILES_RECIPE_OUT"], !output.isEmpty else {
        Issue.record("MEM0_FILES_RECIPE_OUT est requis avec MEM0_FILES_RECIPE : c'est le chemin du rendu à écrire")
        return
    }

    let target = canonicalPath(input)
    let suite = UserDefaults(suiteName: "omp-console-files-recette-\(UUID().uuidString)") ?? .standard
    suite.set(target, forKey: ProjectRoot.defaultsKey)
    let model = FilesModel(
        projectRoot: URL(fileURLWithPath: target),
        git: nil,
        store: StoreReader(),
        defaults: suite,
        fileManager: .default
    )
    await model.refresh()

    var report = ""
    func line(_ text: String) {
        report += text + "\n"
    }

    line("== cible active")
    if let chosen = model.target {
        line("\(chosen.label) — \(chosen.path) — branche \(chosen.branch ?? "—") — base \(chosen.base.label)")
    } else {
        line("aucune cible — erreur : \(model.errorMessage?.diagnostic ?? "aucune")")
    }
    line("")
    line("== catalogue (\(model.targets.count) cibles)")
    for listed in model.targets {
        line("\(listed.isPrimary ? "principal" : "worktree") \(listed.label) — \(listed.path) — base \(listed.base.label)")
    }
    line("")
    let entries = model.tree?.entries ?? []
    line("== arbre (\(entries.count) entrées)")
    for entry in entries {
        line("\(FilesText.badge(for: entry.kind) ?? "—") \(entry.path)")
    }
    line("")

    // Le fichier dont on montre le diff : un NON SUIVI d'abord (son diff est un ajout
    // complet, garanti non vide), sinon le premier des `trackedScanLimit` fichiers
    // suivis qui porte une différence. La borne est écrite dans le rendu : sur un
    // dépôt de plusieurs milliers de fichiers, demander un diff à git pour chacun
    // coûterait des minutes à une recette qui n'a rien de plus à prouver.
    let trackedScanLimit = 60
    var chosen: FilesEntry?
    var diffLines: [FilesDiffLine] = []
    var scanned = 0

    if let untracked = entries.first(where: { $0.kind == .untracked }) {
        if await openEntry(untracked, in: model), let diff = model.diff, !diff.isEmpty {
            chosen = untracked
            diffLines = diff.lines
        }
        scanned += 1
    }
    if chosen == nil {
        for entry in entries where entry.kind == .tracked {
            guard scanned < trackedScanLimit else { break }
            scanned += 1
            guard await openEntry(entry, in: model), let diff = model.diff, !diff.isEmpty else { continue }
            chosen = entry
            diffLines = diff.lines
            break
        }
    }

    if let chosen {
        line("== diff de \(chosen.path) [\(FilesText.badge(for: chosen.kind) ?? "—")] — base \(model.diffBase?.label ?? "—") (\(diffLines.count) lignes)")
        for diffLine in diffLines { line(diffLine.text) }
    } else {
        line("== aucun diff non vide dans les \(scanned) premiers fichiers examinés")
    }
    line("")

    // Le contenu du premier fichier de l'arbre : écrit tel quel, borné en LIGNES avec
    // la marque explicite de ce qui a été omis (le rendu n'est pas le produit).
    if let first = entries.first(where: { $0.kind != .deleted }) {
        _ = await openEntry(first, in: model)
        line("== contenu de \(first.path)")
        if let content = model.content {
            switch content {
            case let .text(text):
                let lines = text.split(separator: "\n", omittingEmptySubsequences: false)
                line("\(text.utf8.count) octets, \(lines.count) lignes")
                let limit = 200
                for lineText in lines.prefix(limit) { line(String(lineText)) }
                if lines.count > limit {
                    line("… \(lines.count - limit) lignes omises par la recette (jamais par le produit)")
                }
            case let .binary(bytes):
                line("binaire (\(bytes) octets)")
            case .missing:
                line("absent du disque")
            case let .unreadable(reason):
                line("illisible : \(reason)")
            }
        } else {
            line("aucun contenu publié")
        }
        line("")
    }

    line("== état")
    line("veille armée : \(model.notice?.diagnostic ?? "oui") — erreur : \(model.errorMessage?.diagnostic ?? "aucune")")

    try report.write(toFile: output, atomically: true, encoding: .utf8)
    print(
        "recette : \(target) → \(output) ; "
            + "\(model.targets.count) cibles, \(entries.count) entrées, "
            + "\(report.utf8.count) octets de rendu"
    )
}
