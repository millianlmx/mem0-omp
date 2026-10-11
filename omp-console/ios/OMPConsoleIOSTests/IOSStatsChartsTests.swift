// Les preuves Swift des graphiques de Statistiques (ios-statistiques-et-graphe-accessibles,
// S-2 et S-3) : les barres suivent les features listées avec les valeurs exactes des
// cartes, les cartes dessous gardent leurs chaînes, aucun graphique n'est monté sans
// donnée, et le descripteur d'accessibilité de chaque graphique porte titre, axes et
// séries en français.

@testable import OMPConsoleIOS
import Accessibility
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
@Suite("ios-statistiques-et-graphe-accessibles — les graphiques de Statistiques")
struct IOSStatsChartsTests {
    private func feature(
        slug: String,
        input: Int = 0,
        output: Int = 0,
        cacheRead: Int? = nil,
        cacheWrite: Int? = nil,
        turns: Int = 0,
        durationMs: Double,
        liveRuns: Int = 0,
        model: String? = nil
    ) -> RemoteStatsFeature {
        RemoteStatsFeature(
            slug: slug,
            input: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            turns: turns,
            durationMs: durationMs,
            liveRuns: liveRuns,
            model: model
        )
    }

    private func payload(
        projectKey: String? = "k",
        features: [RemoteStatsFeature],
        projects: [RemoteStatsProject] = [RemoteStatsProject(key: "k", label: "depot")],
        hiddenPlanFeatures: Int = 0
    ) -> RemoteStatsPayload {
        RemoteStatsPayload(
            projectKey: projectKey,
            project: projectKey == nil ? "" : "depot",
            projects: projects,
            features: features,
            hiddenPlanFeatures: hiddenPlanFeatures
        )
    }

    /// Le relevé `recette-pleine`, lu par le VRAI modèle de la recette
    /// `-stats.recipe pleine` : celui que montrent les captures (S-8).
    private func fullRecipePayload() async throws -> RemoteStatsPayload {
        let model = IOSStatsRecipe.pleine.model()
        model.reload(trigger: .appeared)
        for _ in 0..<400 {
            if let payload = model.payload { return payload }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return try #require(model.payload)
    }

    /// Les catégories (axe des features) des points d'une série. Le SDK marque
    /// `AXDataPointValue.category` et `.number` `NS_REFINED_FOR_SWIFT` sans leur
    /// donner d'accesseur Swift (AXAudiograph.h, SDK iOS 27.0) : ils ne se lisent
    /// que sous leur nom importé `__category` / `__number`.
    private func categories(_ series: AXDataSeriesDescriptor) -> [String] {
        series.dataPoints.map(\.xValue.__category)
    }

    /// Les valeurs (axe numérique) des points d'une série.
    private func numbers(_ series: AXDataSeriesDescriptor) -> [Double?] {
        series.dataPoints.map { $0.yValue?.__number }
    }

    // MARK: - AC-2

    @Test("ios-statistiques-et-graphe-accessibles/AC-2 : les barres suivent les features listées, avec les durées et les tokens exacts des cartes")
    func statsChartsFollowTheListedFeatures() async throws {
        let full = try await fullRecipePayload()
        let elapsed = 5_000.0

        let durations = IOSStatsChartData.durationBars(full, elapsedMs: elapsed)
        #expect(durations.map(\.feature) == IOSStatsText.recipeFeatures)
        #expect(durations.map(\.series) == [StatsPresentation.timeSpent, StatsPresentation.timeSpent])
        // durationMs + liveRuns × elapsed : la seconde feature a un run vivant.
        #expect(durations.map(\.value) == [754_000, 211_000 + 1 * elapsed])
        #expect(durations.map(\.value) == full.features.map { $0.durationMs + Double($0.liveRuns) * elapsed })

        let tokens = IOSStatsChartData.tokenBars(full)
        let specs = IOSStatsText.recipeFeatures[0]
        let impl = IOSStatsText.recipeFeatures[1]
        #expect(tokens.map(\.feature) == [specs, specs, impl, impl])
        #expect(tokens.map(\.series) == [
            StatsPresentation.sentTokens, StatsPresentation.receivedTokens,
            StatsPresentation.sentTokens, StatsPresentation.receivedTokens,
        ])
        #expect(tokens.map(\.value) == [182_400, 9_310, 96_050, 4_120])
        // Chaque segment est identifié par sa feature ET sa série.
        #expect(Set(tokens.map(\.id)).count == tokens.count)
        #expect(tokens[0].id == specs + "/" + StatsPresentation.sentTokens)

        // Le cache compte dans « Tokens envoyés », comme sur la carte.
        let cached = payload(features: [feature(slug: "c", input: 76, output: 40_233, cacheRead: 33_206, cacheWrite: 15_936, durationMs: 0)])
        #expect(IOSStatsChartData.tokenBars(cached).map(\.value) == [49_218, 40_233])

        // Les titres et les identifiants des deux sections.
        #expect(StatsPresentation.durationChartTitle == "Durée par feature")
        #expect(StatsPresentation.tokensChartTitle == "Tokens par feature")
        #expect(StatsAccessibility.durationChart == "ios.stats.chart.duration")
        #expect(StatsAccessibility.tokensChart == "ios.stats.chart.tokens")
        #expect(IOSStatsChartData.showsDuration(full, elapsedMs: elapsed))
        #expect(IOSStatsChartData.showsTokens(full))
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-2 : les cartes sous les graphiques gardent les mêmes nombres")
    func statsChartsKeepTheCardNumbers() async throws {
        let full = try await fullRecipePayload()
        let elapsed = 5_000.0

        let cards = IOSStatsContent.cards(full, elapsedMs: elapsed)
        #expect(cards.map(\.title) == IOSStatsText.recipeFeatures)
        let labels = [
            StatsPresentation.columnModel,
            StatsPresentation.timeSpent,
            StatsPresentation.turns,
            StatsPresentation.sentTokens,
            StatsPresentation.receivedTokens,
        ]
        #expect(cards.map { $0.lines.map(\.label) } == [labels, labels])
        #expect(cards[0].lines.map(\.value) == [
            IOSStatsText.recipeModel,
            ConsoleFormat.duration(ms: 754_000),
            "14",
            ConsoleFormat.tokens(182_400),
            ConsoleFormat.tokens(9_310),
        ])
        #expect(cards[1].lines.map(\.value) == [
            IOSStatsText.recipeModel,
            ConsoleFormat.duration(ms: 216_000),
            "6",
            ConsoleFormat.tokens(96_050),
            ConsoleFormat.tokens(4_120),
        ])

        let total = IOSStatsContent.totalCard(full, elapsedMs: elapsed)
        #expect(total.title == IOSStatsText.total)
        #expect(total.lines.map(\.label) == [
            StatsPresentation.timeSpent,
            StatsPresentation.turns,
            StatsPresentation.sentTokens,
            StatsPresentation.receivedTokens,
        ])
        #expect(total.lines.map(\.value) == [
            ConsoleFormat.duration(ms: 970_000),
            "20",
            ConsoleFormat.tokens(278_450),
            ConsoleFormat.tokens(13_430),
        ])
        #expect(IOSStatsContent.hiddenMention(full) == nil)
    }

    // MARK: - AC-4

    @Test("ios-statistiques-et-graphe-accessibles/AC-4 : sans feature ou aux valeurs toutes nulles, aucun graphique n'est monté")
    func statsChartsHideWithoutData() {
        // Aucune feature listée (état vide).
        let none = payload(features: [], hiddenPlanFeatures: 2)
        #expect(!IOSStatsChartData.showsDuration(none, elapsedMs: 10_000))
        #expect(!IOSStatsChartData.showsTokens(none))
        #expect(IOSStatsChartData.durationBars(none, elapsedMs: 0).isEmpty)
        #expect(IOSStatsChartData.tokenBars(none).isEmpty)

        // Des features aux valeurs toutes nulles, sans run vivant.
        let zeros = payload(features: [feature(slug: "a", durationMs: 0), feature(slug: "b", durationMs: 0)])
        #expect(!IOSStatsChartData.showsDuration(zeros, elapsedMs: 10_000))
        #expect(!IOSStatsChartData.showsTokens(zeros))

        // Une feature nulle parmi d'autres garde sa catégorie, barre de longueur nulle.
        let mixed = payload(features: [feature(slug: "a", input: 3, durationMs: 0), feature(slug: "b", durationMs: 2_000)])
        #expect(IOSStatsChartData.showsDuration(mixed, elapsedMs: 0))
        #expect(IOSStatsChartData.durationBars(mixed, elapsedMs: 0).map(\.value) == [0, 2_000])
        #expect(IOSStatsChartData.showsTokens(mixed))
        #expect(IOSStatsChartData.tokenBars(mixed).map(\.value) == [3, 0, 0, 0])

        // Une feature vivante à durée nulle : le graphique des durées apparaît dès
        // que sa durée dépasse 0, les tokens restent masqués.
        let live = payload(features: [feature(slug: "a", durationMs: 0, liveRuns: 1)])
        #expect(!IOSStatsChartData.showsDuration(live, elapsedMs: 0))
        #expect(IOSStatsChartData.showsDuration(live, elapsedMs: 1_000))
        #expect(!IOSStatsChartData.showsTokens(live))
        // Un écart non fini ou négatif est borné à zéro, comme sur la carte.
        #expect(!IOSStatsChartData.showsDuration(live, elapsedMs: -5))
        #expect(!IOSStatsChartData.showsDuration(live, elapsedMs: .nan))
    }

    // MARK: - AC-3

    @Test("ios-statistiques-et-graphe-accessibles/AC-3 : le descripteur « Durée par feature » nomme ses axes et donne la durée exacte de chaque feature")
    func statsChartsDescribeDurationPerFeature() async throws {
        let full = try await fullRecipePayload()
        let elapsed = 5_000.0
        let descriptor = IOSStatsChartDescriptor(kind: .duration, payload: full, elapsedMs: elapsed).makeChartDescriptor()

        #expect(descriptor.title == "Durée par feature")
        #expect(descriptor.summary == nil)
        let xAxis = try #require(descriptor.xAxis as? AXCategoricalDataAxisDescriptor)
        #expect(xAxis.title == "Feature")
        #expect(xAxis.categoryOrder == IOSStatsText.recipeFeatures)
        let yAxis = try #require(descriptor.yAxis)
        #expect(yAxis.title == "Durée")
        #expect(yAxis.range == 0...754_000)
        #expect(yAxis.gridlinePositions.isEmpty)
        #expect(yAxis.valueDescriptionProvider(754_000) == ConsoleFormat.duration(ms: 754_000))

        #expect(descriptor.series.count == 1)
        let series = try #require(descriptor.series.first)
        #expect(series.name == "Temps passé")
        #expect(!series.isContinuous)
        #expect(categories(series) == IOSStatsText.recipeFeatures)
        #expect(numbers(series) == [754_000, 211_000 + elapsed])
        // Une seule source : les points valent les barres dessinées.
        #expect(numbers(series) == IOSStatsChartData.durationBars(full, elapsedMs: elapsed).map(\.value))

        // Sans feature : un descripteur valide, catégories et points vides, range 0...1.
        let empty = IOSStatsChartDescriptor(kind: .duration, payload: payload(features: []), elapsedMs: 0).makeChartDescriptor()
        #expect((empty.xAxis as? AXCategoricalDataAxisDescriptor)?.categoryOrder == [])
        #expect(empty.yAxis?.range == 0...1)
        #expect(empty.series.first?.dataPoints.isEmpty == true)
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-3 : le descripteur « Tokens par feature » a deux séries, envoyés (cache compris) et reçus, un point exact par feature")
    func statsChartsDescribeStackedTokens() throws {
        let p = payload(features: [
            feature(slug: "a", input: 76, output: 40_233, cacheRead: 33_206, cacheWrite: 15_936, durationMs: 0),
            feature(slug: "b", input: 5, output: 1, durationMs: 1_000, liveRuns: 1),
        ])
        let descriptor = IOSStatsChartDescriptor(kind: .tokens, payload: p, elapsedMs: 3_000).makeChartDescriptor()

        #expect(descriptor.title == "Tokens par feature")
        let xAxis = try #require(descriptor.xAxis as? AXCategoricalDataAxisDescriptor)
        #expect(xAxis.title == "Feature")
        #expect(xAxis.categoryOrder == ["a", "b"])
        let yAxis = try #require(descriptor.yAxis)
        #expect(yAxis.title == "Tokens")
        // La plus longue barre empilée : 49 218 envoyés + 40 233 reçus.
        #expect(yAxis.range == 0...89_451)
        #expect(yAxis.valueDescriptionProvider(89_451) == ConsoleFormat.tokens(89_451))

        #expect(descriptor.series.map(\.name) == ["Tokens envoyés", "Tokens reçus"])
        #expect(descriptor.series.allSatisfy { !$0.isContinuous })
        for series in descriptor.series {
            #expect(categories(series) == ["a", "b"])
        }
        #expect(numbers(descriptor.series[0]) == [49_218, 5])
        #expect(numbers(descriptor.series[1]) == [40_233, 1])
    }
}
