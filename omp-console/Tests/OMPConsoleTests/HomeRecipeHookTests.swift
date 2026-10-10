// Le crochet de recette macOS `-home.recipe` (S-8 de
// accueil-en-cours-melange-pause-et-compte) : il n'est actif que sous une racine
// de support déplacée, et ses trois ardoises donnent les comptes attendus par la
// recette de preuve. Sous recette, `KanbanModel` et `AlertsModel` posent l'ardoise
// sans s'abonner au magasin ni livrer de notification.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Des préférences jetables portant (ou non) la clé `home.recipe`.
private func recipeDefaults(_ value: String?) -> UserDefaults {
    let suite = "home-recipe-hook-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    if let value { defaults.set(value, forKey: HomeRecipe.defaultsKey) }
    return defaults
}

private let movedRoot = [AppPaths.supportRootEnvironmentKey: "/tmp/omp-console-recette/support"]

private func counts(_ state: KanbanBoardState) -> HomeCounts? {
    guard case .board(let board) = state else { return nil }
    return HomePresentation.counts(board)
}

@Test("accueil-en-cours-melange-pause-et-compte/S-8 : -home.recipe n'agit que sous OMP_CONSOLE_SUPPORT_ROOT non vide")
func homeRecipeNeedsAMovedSupportRoot() {
    let dashboard = recipeDefaults("dashboard")
    #expect(HomeRecipe.current(defaults: dashboard, environment: [:]) == nil)
    #expect(HomeRecipe.current(defaults: dashboard, environment: [AppPaths.supportRootEnvironmentKey: ""]) == nil)
    #expect(HomeRecipe.current(defaults: dashboard, environment: movedRoot) == .dashboard)
    #expect(HomeRecipe.current(defaults: recipeDefaults("menuBar"), environment: movedRoot) == .menuBar)
    #expect(HomeRecipe.current(defaults: recipeDefaults("pausedOnly"), environment: movedRoot) == .pausedOnly)
    // Valeur inconnue ou absente : aucune recette.
    #expect(HomeRecipe.current(defaults: recipeDefaults("inconnue"), environment: movedRoot) == nil)
    #expect(HomeRecipe.current(defaults: recipeDefaults(nil), environment: movedRoot) == nil)
}

@Test("accueil-en-cours-melange-pause-et-compte/S-8 : chaque recette pose l'ardoise de la fixture et ses comptes")
func homeRecipeBoardsGiveTheirCounts() {
    #expect(HomeRecipe.dashboard.board == HomeParity.board)
    #expect(counts(HomeRecipe.dashboard.board) == HomeCounts(attention: 5, running: 2))
    #expect(counts(HomeRecipe.menuBar.board) == HomeCounts(attention: 1, running: 2))
    #expect(counts(HomeRecipe.pausedOnly.board) == .zero)
}

@MainActor
@Test("accueil-en-cours-melange-pause-et-compte/S-8 : sous recette, l'Accueil et l'item de barre suivent l'ardoise sans magasin")
func recipeBoardFeedsBothModels() async {
    let fixture = StoreFixture(stores: [])
    let kanban = KanbanModel(
        hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }),
        prStates: PullRequestStateBook(reader: nil),
        recipeBoard: HomeRecipe.dashboard.board
    )
    defer { kanban.stop() }
    kanban.start()
    #expect(kanban.state == HomeParity.board)

    let deliverer = RecorderAlertDeliverer()
    let alerts = AlertsModel(
        hub: StoreHub(stateDir: fixture.root, nowMs: { fixtureT0 }),
        ledgerPath: fixtureLedgerPath(fixture),
        deliverer: deliverer,
        isWindowFrontmost: { false },
        nowMs: { fixtureT0 },
        recipeBoard: HomeRecipe.menuBar.board
    )
    defer { alerts.stop() }
    alerts.start()
    #expect(alerts.status == AlertsStatus.from(boardState: HomeParity.menuBarBoard))
    // Un magasin absent aurait donné `.storeAbsent` : la recette n'a pas été
    // remplacée par un instantané, et aucune notification n'est partie.
    try? await Task.sleep(nanoseconds: 200_000_000)
    #expect(kanban.state == HomeParity.board)
    #expect(alerts.status == AlertsStatus.from(boardState: HomeParity.menuBarBoard))
    #expect(deliverer.messages.isEmpty)
}
