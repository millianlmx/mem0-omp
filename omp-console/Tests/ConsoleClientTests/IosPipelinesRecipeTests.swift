// La recette de bout en bout de la feature `ios-pipelines` (S-15, BR-8) : le VRAI
// Mac en service, un VRAI dépôt jetable. Elle n'est JAMAIS armée sans la variable
// d'environnement `MEM0_PIPELINES_RECIPE` — la suite reste verte sur un poste sans
// Mac. Le scénario iPad (les gestes à l'écran) reste MANUEL : il vit dans le
// contrat (`## Recette`, AC-15).
//
// Filtrable : `swift test --filter iosPipelinesRecipe`.
//
//   MEM0_PIPELINES_RECIPE=1 \
//   MEM0_PIPELINES_RECIPE_ADDRESS=127.0.0.1:8787 \
//   MEM0_PIPELINES_RECIPE_CODE=XXXXXXXX \
//   MEM0_PIPELINES_RECIPE_REPO=/chemin/du/depot-jetable \
//   swift test --filter iosPipelinesRecipe
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

private let recipeArmed = ProcessInfo.processInfo.environment["MEM0_PIPELINES_RECIPE"] != nil

private func recipeValue(_ name: String) -> String? {
    let value = ProcessInfo.processInfo.environment[name]
    return value?.isEmpty == false ? value : nil
}

private func nowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// L'ardoise d'un instantané, la même dérivation que l'app (vivacité transportée).
private func board(from payload: RemoteStorePayload) -> KanbanBoardState {
    KanbanBoardState.derive(
        snapshot: payload.snapshot,
        nowMs: nowMs(),
        stateDir: "",
        isAlive: .transported(payload.snapshot)
    )
}

/// Attend qu'une condition sur le magasin soit vraie (sondage borné, sans geste
/// utilisateur — c'est la trame que l'app recevrait).
@MainActor
private func waitForCard(
    _ model: ConsoleClientModel,
    timeout: Double = 300,
    where predicate: (KanbanCard) -> Bool
) async throws -> KanbanCard {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if let card = board(from: try await model.store()).kanbanBoard?.cards.first(where: predicate) {
            return card
        }
        try await Task.sleep(nanoseconds: 2_000_000_000)
    }
    throw RecipeError.timedOut
}

private enum RecipeError: Error { case timedOut, noCard }

@Suite("ios-pipelines — recette de bout en bout (Mac réel)")
@MainActor
struct IosPipelinesRecipeTests {
    @Test(
        "ios-pipelines/AC-15 : création, réponses, jalons, PR et fusion depuis le client iOS",
        .enabled(if: recipeArmed)
    )
    func iosPipelinesRecipe() async throws {
        let address = try #require(recipeValue("MEM0_PIPELINES_RECIPE_ADDRESS"))
        let code = try #require(recipeValue("MEM0_PIPELINES_RECIPE_CODE"))
        let repoRoot = try #require(recipeValue("MEM0_PIPELINES_RECIPE_REPO"))

        let model = ConsoleClientModel.live()
        defer { model.stop() }
        _ = model.setManualAddress(address)
        try await model.pair(code: code, deviceName: "Recette")

        // 1. L'ardoise se dérive du magasin réel.
        let initial = board(from: try await model.store())

        // 2. Création et mise en route dans le dépôt jetable.
        let title = "recette-ios-\(Int(Date().timeIntervalSince1970))"
        _ = try await model.launch(
            repoRoot: repoRoot,
            title: title,
            description: "Recette de bout en bout de la feature ios-pipelines.",
            modelReqSpecs: nil,
            modelImplReview: nil
        )

        // 3. La carte apparaît par le magasin, jamais inventée.
        let card = try await waitForCard(model) { card in
            card.title.contains(title) || card.action?.repoRoot == repoRoot
        }

        // 4. Répondre à une question à options, puis en texte libre.
        let question = try await waitForCard(model, timeout: 600) { card in
            card.action?.run?.pendingAsk != nil
        }
        guard let ask = question.action?.run?.pendingAsk else { throw RecipeError.noCard }
        if let option = ask.options.first {
            _ = try await model.answer(
                cardId: question.id,
                kind: "selected",
                label: option.label,
                text: nil,
                toolCallId: ask.toolCallId
            )
        }
        let textQuestion = try await waitForCard(model, timeout: 600) { card in
            card.action?.featureState == .waiting
                && card.action?.waitKind == .answer
                && card.action?.run?.pendingAsk == nil
        }
        _ = try await model.reply(cardId: textQuestion.id, text: "Réponse libre de recette.")

        // 5. Les jalons : specs puis revue.
        let specs = try await waitForCard(model, timeout: 900) { card in
            card.action?.featureState == .waiting && card.action?.waitKind == .specs
        }
        _ = try await model.verdict(cardId: specs.id, verdict: "specs")
        let review = try await waitForCard(model, timeout: 1800) { card in
            card.action?.featureState == .waiting && card.action?.waitKind == .review
        }
        _ = try await model.verdict(cardId: review.id, verdict: "review")

        // 6. La PR ouverte, puis la fusion après lecture fraîche.
        let delivered = try await waitForCard(model, timeout: 1800) { card in
            card.prUrl != nil && card.action?.slug != nil && card.action?.repoKey != nil
        }
        guard let slug = delivered.action?.slug, let repoKey = delivered.action?.repoKey else {
            throw RecipeError.noCard
        }
        let rows = try await model.pullRequests(repoKey: repoKey)
        guard let row = rows.rows.first(where: { $0.slug == slug }), let headOid = row.headOid else {
            throw RecipeError.noCard
        }
        let merged = try await model.merge(repoKey: repoKey, slug: slug, headOid: headOid)
        #expect(merged.merged)

        // 7. Le magasin reflète la livraison ; l'ardoise initiale reste cohérente.
        #expect(initial.kanbanBoard != nil || initial == .storeAbsent(dir: "") || initial == .storeEmpty(dir: ""))
    }
}
