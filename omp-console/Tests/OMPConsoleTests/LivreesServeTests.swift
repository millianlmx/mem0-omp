// Banc de recette de pipelines-livrees-statut-pr-faux-et-doub (BR-4) : la VRAIE
// pile Mac (`RemoteStack`, même `KanbanModel` que l'app) sert une COPIE du magasin
// réel, avec le lecteur `gh` RÉEL, pour qu'un simulateur iOS appairé montre la
// voie « Livrées » sur données réelles (captures avant/après).
//
// DÉSACTIVÉ par défaut : aucune étape de `.github/workflows/check.yml` ni
// `scripts/swift-app.sh` ne pose `MEM0_LIVREES_RECIPE`, la CI le rapporte
// « skipped ». Il ne juge rien : il imprime `PORT`, un `CODE` d'appairage frais
// toutes les 90 s, puis chaque carte de « Livrées » (`<id>\t<titre>\t<pastille>`)
// après la première relecture et à chaque changement des faits de PR.
//
//   cp -R ~/.omp/agent/pipeline /tmp/livrees-store
//   cd omp-console && MEM0_LIVREES_RECIPE=1 swift test --scratch-path .build-recipe --no-parallel \
//     --filter recetteLivreesServeLeMagasinReel -Xswiftc -plugin-path \
//     -Xswiftc "$(dirname "$(xcrun --find swift)")/../lib/swift/host/plugins/testing"
//
// Variables : `MEM0_LIVREES_STORE` (magasin servi, défaut `/tmp/livrees-store` —
// jamais l'original) ; `MEM0_LIVREES_OFFLINE=1` (lecteur résolu avec
// `OMP_CONSOLE_GH_BINARY=/nonexistent` : aucun fait, AC-4) ; `MEM0_LIVREES_SECONDS`
// (durée de service, défaut 1800). Sous un tube, swift-test tamponne la sortie :
// lancer le banc sous un pty.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

private let livreesRecipeArmed = ProcessInfo.processInfo.environment["MEM0_LIVREES_RECIPE"] != nil

/// Une ligne lisible par la revue, imprimée tout de suite (le banc tourne longtemps).
private func livreesSay(_ line: String) {
    print(line)
    fflush(stdout)
}

/// Les cartes de « Livrées » telles que l'app Mac les dérive.
@MainActor
private func livreesLines(_ state: KanbanBoardState) -> [String] {
    guard case let .board(board) = state else { return ["ETAT \(state)"] }
    let delivered = board.lanes.first { $0.lane == .livrees }?.cards ?? []
    return delivered.map { card in
        "\(card.id)\t\(KanbanCardPresentation.title(card))\t\(ConsoleStatus.of(card: card).text)"
    }
}

@MainActor
@Test(
    "pipelines-livrees-statut-pr-faux-et-doub/AC-1, AC-3, AC-4, AC-6, AC-8 : recette — la pile Mac sert le magasin réel et l'état GitHub réel des PR",
    .enabled(if: livreesRecipeArmed)
)
/// Le NOM de la fonction porte « recette » : `swift test --filter` filtre sur
/// l'identifiant du test, pas sur son titre affiché.
func recetteLivreesServeLeMagasinReel() async throws {
    let environment = ProcessInfo.processInfo.environment
    let store = environment["MEM0_LIVREES_STORE"] ?? "/tmp/livrees-store"
    let original = (NSHomeDirectory() as NSString).appendingPathComponent(".omp/agent/pipeline")
    try #require(
        URL(fileURLWithPath: store).standardizedFileURL.path != URL(fileURLWithPath: original).standardizedFileURL.path,
        "le banc sert une COPIE du magasin, jamais l'original"
    )
    try #require(FileManager.default.fileExists(atPath: store), "magasin absent : cp -R ~/.omp/agent/pipeline \(store)")
    let offline = environment["MEM0_LIVREES_OFFLINE"] == "1"
    let seconds = Double(environment["MEM0_LIVREES_SECONDS"] ?? "") ?? 1800

    // Le lecteur RÉEL (registre de production), ou `gh` introuvable.
    var ghEnvironment = environment
    if offline { ghEnvironment["OMP_CONSOLE_GH_BINARY"] = "/nonexistent" }
    let book = KanbanModel.ghBook(environment: ghEnvironment)

    // L'horloge du banc suit l'horloge murale : la borne des 7 jours se mesure à
    // aujourd'hui, pas à l'instant figé des fixtures.
    let clock = MutableRemoteClock(Date().timeIntervalSince1970 * 1000)
    let stack = try await RemoteStack.make(stateDir: store, clock: clock, prStates: book)
    defer {
        stack.kanban.stop()
        stack.stop()
    }
    stack.kanban.start()
    livreesSay("MAGASIN \(store)")
    livreesSay("GH \(offline ? "introuvable (MEM0_LIVREES_OFFLINE)" : "réel")")
    livreesSay("PORT \(stack.port)")

    let start = Date()
    var nextCode = Date.distantPast
    var printedFacts: [String: PullRequestFact]?
    var sawFirstRead = false
    while Date().timeIntervalSince(start) < seconds {
        clock.advance(ms: Date().timeIntervalSince1970 * 1000 - clock.nowMs)
        if Date() >= nextCode {
            livreesSay("CODE \(try stack.registry.generateCode().value)")
            nextCode = Date().addingTimeInterval(90)
        }
        // « Après la première relecture » : le registre a lu (ou ne lira jamais,
        // sans `gh`) et l'ardoise est dérivée.
        let loaded = stack.kanban.state != .loading
        let settled = !stack.kanban.prRefreshing && (offline || !book.facts.isEmpty || sawFirstRead)
        if stack.kanban.prRefreshing { sawFirstRead = true }
        if loaded, settled, printedFacts != book.facts {
            printedFacts = book.facts
            let lines = livreesLines(stack.kanban.state)
            livreesSay("LIVREES \(lines.count) carte(s), \(book.facts.count) fait(s) de PR")
            for line in lines { livreesSay(line) }
            livreesSay("FIN-LIVREES")
        }
        try await Task.sleep(nanoseconds: 500_000_000)
    }
}
