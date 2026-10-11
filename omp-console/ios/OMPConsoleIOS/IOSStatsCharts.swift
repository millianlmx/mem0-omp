// Les deux graphiques en tête de l'écran Statistiques (ios-statistiques-et-graphe-accessibles,
// S-2, S-3) : « Durée par feature » et « Tokens par feature », en barres
// horizontales Swift Charts, au patron de `StatsView.tokenChart` du Mac.
//
// Les VALEURS viennent d'une seule source pure, `IOSStatsChartData`, que lisent à la
// fois les barres et le descripteur d'accessibilité (`IOSStatsChartDescriptor`,
// rotor Graphique et Graphiques audio de VoiceOver) ; elles sont celles des cartes
// de feature dessous (`totals(elapsedMs:)` de `ConsoleClient`), jamais une somme
// refaite ici. Un graphique dont toutes les valeurs sont nulles n'est pas monté :
// aucun axe sans barre.
//
// Aucun littéral alphabétique ici : les mots viennent de `StatsPresentation`
// (ConsoleCore) et les identifiants d'`IOSStatsText.swift`.

import Accessibility
import Charts
import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI

/// Une barre (ou un segment de barre empilée) d'un graphique : la feature, sa série
/// et sa valeur exacte (millisecondes ou tokens).
struct IOSStatsBar: Equatable, Identifiable {
    /// Le slug de la feature, catégorie de l'axe vertical.
    let feature: String
    /// `StatsPresentation.timeSpent`, `.sentTokens` ou `.receivedTokens`.
    let series: String
    let value: Double

    var id: String { feature + "/" + series }
}

/// Les données PURES des deux graphiques, dans l'ordre du relevé (S-2).
enum IOSStatsChartData {
    /// Une barre « Temps passé » par feature, `elapsedMs` après la réception du
    /// relevé : la durée d'un run vivant avance comme la ligne de la carte.
    static func durationBars(_ payload: RemoteStatsPayload, elapsedMs: Double) -> [IOSStatsBar] {
        payload.features.map { feature in
            IOSStatsBar(
                feature: feature.slug,
                series: StatsPresentation.timeSpent,
                value: feature.totals(elapsedMs: elapsedMs).durationMs
            )
        }
    }

    /// Deux segments par feature, envoyés (cache compris) puis reçus, comme les
    /// lignes de la carte ; les tokens n'avancent pas avec le temps.
    static func tokenBars(_ payload: RemoteStatsPayload) -> [IOSStatsBar] {
        payload.features.flatMap { feature in
            let totals = feature.totals(elapsedMs: 0)
            return [
                IOSStatsBar(feature: feature.slug, series: StatsPresentation.sentTokens, value: Double(totals.sent)),
                IOSStatsBar(feature: feature.slug, series: StatsPresentation.receivedTokens, value: Double(totals.output)),
            ]
        }
    }

    /// La longueur de la barre empilée de chaque feature (envoyés + reçus), dans
    /// l'ordre du relevé.
    static func tokenSums(_ payload: RemoteStatsPayload) -> [Double] {
        payload.features.map { feature in
            let computed = feature.totals(elapsedMs: 0)
            return Double(computed.sent + computed.output)
        }
    }

    /// Le graphique des durées est monté dès qu'une durée dépasse 0 au tic courant.
    static func showsDuration(_ payload: RemoteStatsPayload, elapsedMs: Double) -> Bool {
        durationBars(payload, elapsedMs: elapsedMs).contains { $0.value > 0 }
    }

    /// Le graphique des tokens est monté dès qu'une somme envoyés + reçus dépasse 0.
    static func showsTokens(_ payload: RemoteStatsPayload) -> Bool {
        tokenSums(payload).contains { $0 > 0 }
    }
}

/// Le descripteur d'accessibilité d'un graphique (S-3) : titre, axe des features,
/// axe des valeurs et une série par couleur, chaque point portant la valeur exacte.
struct IOSStatsChartDescriptor: AXChartDescriptorRepresentable {
    enum Kind: Equatable { case duration, tokens }

    let kind: Kind
    let payload: RemoteStatsPayload
    let elapsedMs: Double

    func makeChartDescriptor() -> AXChartDescriptor {
        let features = AXCategoricalDataAxisDescriptor(
            title: StatsPresentation.columnFeature,
            categoryOrder: payload.features.map(\.slug)
        )
        switch kind {
        case .duration:
            let bars = IOSStatsChartData.durationBars(payload, elapsedMs: elapsedMs)
            let maximum = bars.map(\.value).max() ?? 0
            return AXChartDescriptor(
                title: StatsPresentation.durationChartTitle,
                summary: nil,
                xAxis: features,
                yAxis: AXNumericDataAxisDescriptor(
                    title: StatsPresentation.columnDuration,
                    range: 0...max(1, maximum),
                    gridlinePositions: [],
                    valueDescriptionProvider: { ConsoleFormat.duration(ms: $0) }
                ),
                additionalAxes: [],
                series: [Self.series(StatsPresentation.timeSpent, bars)]
            )
        case .tokens:
            let bars = IOSStatsChartData.tokenBars(payload)
            let maximum = IOSStatsChartData.tokenSums(payload).max() ?? 0
            return AXChartDescriptor(
                title: StatsPresentation.tokensChartTitle,
                summary: nil,
                xAxis: features,
                yAxis: AXNumericDataAxisDescriptor(
                    title: StatsPresentation.columnTokens,
                    range: 0...max(1, maximum),
                    gridlinePositions: [],
                    valueDescriptionProvider: { ConsoleFormat.tokens(Int($0)) }
                ),
                additionalAxes: [],
                series: [
                    Self.series(StatsPresentation.sentTokens, bars),
                    Self.series(StatsPresentation.receivedTokens, bars),
                ]
            )
        }
    }

    /// Une série discrète : un point par barre de la série nommée, dans l'ordre.
    private static func series(_ name: String, _ bars: [IOSStatsBar]) -> AXDataSeriesDescriptor {
        AXDataSeriesDescriptor(
            name: name,
            isContinuous: false,
            dataPoints: bars.filter { $0.series == name }.map { AXDataPoint(x: $0.feature, y: $0.value) }
        )
    }
}

/// Les sections des graphiques, montées par l'état tableau avant les sections de
/// feature : 0, 1 ou 2 `Section` selon les données (S-2). Aucune interaction
/// tactile ; VoiceOver lit les barres et le descripteur.
struct IOSStatsChartSections: View {
    let payload: RemoteStatsPayload
    /// Le temps écoulé depuis la réception du relevé à un instant donné (ms),
    /// celui du modèle de l'écran.
    let elapsedMs: @MainActor (Double) -> Double

    /// La hauteur d'une ligne de barre, qui suit Dynamic Type.
    @ScaledMetric(relativeTo: .body) private var barHeight: CGFloat = 28

    private var features: [String] { payload.features.map(\.slug) }

    var body: some View {
        // La présence d'une section se décide au rendu, comme les titres des
        // cartes ; seules les barres des durées sont réévaluées à chaque tic.
        let now = elapsedMs(Date.now.timeIntervalSince1970 * 1000)
        if IOSStatsChartData.showsDuration(payload, elapsedMs: now) {
            Section {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    durationChart(elapsedMs: elapsedMs(context.date.timeIntervalSince1970 * 1000))
                }
            } header: {
                Text(StatsPresentation.durationChartTitle)
                    .textCase(nil)
                    .accessibilityIdentifier(StatsAccessibility.durationChart)
            }
        }
        if IOSStatsChartData.showsTokens(payload) {
            Section {
                tokensChart(elapsedMs: now)
            } header: {
                Text(StatsPresentation.tokensChartTitle)
                    .textCase(nil)
                    .accessibilityIdentifier(StatsAccessibility.tokensChart)
            }
        }
    }

    /// « Durée par feature » : une barre par feature.
    private func durationChart(elapsedMs: Double) -> some View {
        Chart(IOSStatsChartData.durationBars(payload, elapsedMs: elapsedMs)) { bar in
            BarMark(
                x: .value(bar.series, bar.value),
                y: .value(StatsPresentation.columnFeature, bar.feature)
            )
            .foregroundStyle(Color(uiColor: IOSDataPalette.duration))
        }
        .chartYScale(domain: features)
        .chartYAxis { featureAxis }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let ms = value.as(Double.self) {
                        Text(ConsoleFormat.duration(ms: ms)).monospacedDigit()
                    }
                }
            }
        }
        .frame(height: barHeight * CGFloat(features.count + 1))
        .accessibilityChartDescriptor(IOSStatsChartDescriptor(kind: .duration, payload: payload, elapsedMs: elapsedMs))
    }

    /// « Tokens par feature » : une barre empilée par feature, envoyés puis reçus,
    /// avec la légende automatique (une ligne de hauteur de plus).
    private func tokensChart(elapsedMs: Double) -> some View {
        Chart(IOSStatsChartData.tokenBars(payload)) { bar in
            BarMark(
                x: .value(StatsPresentation.columnTokens, bar.value),
                y: .value(StatsPresentation.columnFeature, bar.feature)
            )
            .foregroundStyle(by: .value(StatsPresentation.columnTokens, bar.series))
        }
        .chartForegroundStyleScale(
            domain: [StatsPresentation.sentTokens, StatsPresentation.receivedTokens],
            range: [Color(uiColor: IOSDataPalette.sentTokens), Color(uiColor: IOSDataPalette.receivedTokens)]
        )
        .chartYScale(domain: features)
        .chartYAxis { featureAxis }
        .chartXAxis {
            AxisMarks(values: .automatic(desiredCount: 3)) { value in
                AxisGridLine()
                AxisValueLabel {
                    if let tokens = value.as(Double.self) {
                        Text(ConsoleFormat.tokens(Int(tokens)))
                    }
                }
            }
        }
        .frame(height: barHeight * CGFloat(features.count + 2))
        .accessibilityChartDescriptor(IOSStatsChartDescriptor(kind: .tokens, payload: payload, elapsedMs: elapsedMs))
    }

    /// Les features sur l'axe vertical, à gauche, hors de la zone de tracé.
    private var featureAxis: some AxisContent {
        AxisMarks(preset: .extended, position: .leading) { _ in
            AxisValueLabel()
        }
    }
}
