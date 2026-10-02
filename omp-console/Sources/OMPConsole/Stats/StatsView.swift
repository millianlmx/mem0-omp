// La fenêtre « Statistiques » (S-5 de `statistiques`, S-17 de
// omp-console-redesign) : un tableau de bord en LECTURE SEULE — un sélecteur de
// projet (dans la barre d'outils, S-12, seul à nommer le projet : pas de
// sous-titre qui le répète), quatre tuiles de totaux, les tokens par feature en
// deux panneaux, un tableau triable des exécutions, la note des features masquées.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) : interdits sous les Command
// Line Tools seuls. `@ObservedObject` est une vraie property wrapper, donc
// autorisée ; le tri du tableau vit dans le modèle (`sortOrder`).
//
// L'horloge de rendu est `TimelineView(.periodic)` (Doc-4) : les durées et les
// totaux se recalculent à l'instant de rendu, donc une exécution vivante qui
// attend une réponse fait monter sa durée sans qu'un octet soit écrit.

import Charts
import SwiftUI

struct StatsView: View {
    @ObservedObject var model: StatsModel

    /// Identifiants d'accessibilité : ce que la sonde AX relève.
    static let projectIdentifier = "stats.project"
    static let stateIdentifier = "stats.state"
    static let emptyIdentifier = "stats.empty"
    static let aggregateIdentifier = "stats.aggregate"
    static let chartIdentifier = "stats.chart"
    static let hiddenIdentifier = "stats.hidden"
    static func runIdentifier(_ tag: String) -> String { "stats.run.\(tag)" }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            content(nowMs: context.date.timeIntervalSince1970 * 1000)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear { model.start() }
        .onDisappear { model.stop() }
        // Hors du `TimelineView` : la barre d'outils n'est pas reconstruite à
        // chaque seconde de l'horloge de rendu.
        .toolbar {
            if case .board(let board) = model.state {
                // À droite, avec les autres commandes de la fenêtre : en
                // `.principal`, il poussait « Nouvelle feature » au centre.
                ToolbarItem(placement: .primaryAction) {
                    projectPicker(board)
                }
            }
        }
    }

    /// Le sélecteur de projet, présent seulement quand un tableau est affiché.
    private func projectPicker(_ board: StatsBoard) -> some View {
        Picker(
            "Projet",
            // Le projet AFFICHÉ fait foi : une clé choisie qui ne désigne aucun
            // projet retombe sur le premier, et le sélecteur le dit.
            selection: Binding(
                get: { board.project.repoKey },
                set: { model.selectProject($0) }
            )
        ) {
            ForEach(model.projects) { project in
                Text(project.label).tag(project.id)
            }
        }
        // MESURÉ (2026-10-01, sonde /tmp/pickerprobe) : la barre d'outils impose un
        // style d'étiquette « icône seule » ; un Picker aux options texte s'y dessine
        // alors VIDE. Le titre seul rend le projet choisi lisible.
        .labelStyle(.titleOnly)
        .accessibilityIdentifier(Self.projectIdentifier)
    }

    @ViewBuilder
    private func content(nowMs: Double) -> some View {
        switch model.state {
        case .loading:
            VStack(spacing: 8) {
                ProgressView()
                Text(StatsText.loading)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(Self.stateIdentifier)
        case .storeAbsent(let dir):
            ContentUnavailableView(
                StatsText.noStatsTitle,
                systemImage: "chart.bar.xaxis",
                description: Text(StatsText.storeAbsent(dir: dir))
            )
            .accessibilityIdentifier(Self.stateIdentifier)
        case .noProject:
            ContentUnavailableView(
                StatsText.noProjectTitle,
                systemImage: "chart.bar.xaxis",
                description: Text(StatsText.noProject)
            )
            .accessibilityIdentifier(Self.stateIdentifier)
        case .empty:
            ContentUnavailableView(StatsText.empty, systemImage: "chart.bar.xaxis")
                .accessibilityIdentifier(Self.emptyIdentifier)
        case .board(let board):
            boardView(board, nowMs: nowMs)
        }
    }

    /// Le tableau de bord : tuiles, graphique, tableau, note des features masquées.
    private func boardView(_ board: StatsBoard, nowMs: Double) -> some View {
        let totals = projectTotals(board.project, nowMs: nowMs)
        let bars = StatsPresentation.bars(board.project, nowMs: nowMs)
        let rows = StatsPresentation.rows(board.project, nowMs: nowMs)
        let features = board.project.features.map(\.slug)
        return VStack(alignment: .leading, spacing: 18) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                tile(StatsText.sentTokens, systemImage: "arrow.up.circle", value: ConsoleFormat.tokens(totals.input))
                tile(StatsText.receivedTokens, systemImage: "arrow.down.circle", value: ConsoleFormat.tokens(totals.output))
                tile(StatsText.timeSpent, systemImage: "clock", value: ConsoleFormat.duration(ms: totals.durationMs))
                tile(StatsText.turns, systemImage: "arrow.triangle.2.circlepath", value: "\(totals.turns)")
            }
            .accessibilityIdentifier(Self.aggregateIdentifier)

            Text(StatsText.chartTitle)
                .font(.headline)
            // Deux panneaux, chacun à SA propre échelle : sur un axe commun, les
            // tokens envoyés (souvent cent fois moins nombreux que les reçus)
            // devenaient des barres invisibles (capture C13 de l'audit HIG).
            HStack(alignment: .top, spacing: 24) {
                tokenChart(
                    StatsText.sentTokens,
                    bars: bars.filter { $0.kind == StatsText.sentKind },
                    features: features,
                    color: .blue
                )
                tokenChart(
                    StatsText.receivedTokens,
                    bars: bars.filter { $0.kind == StatsText.receivedKind },
                    features: features,
                    color: .green
                )
            }
            .accessibilityIdentifier(Self.chartIdentifier)

            Text(StatsText.tableTitle)
                .font(.headline)
            runsTable(rows)

            if board.project.hiddenPlanFeatures > 0 {
                Text(StatsText.hidden(board.project.hiddenPlanFeatures))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(Self.hiddenIdentifier)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    /// Un panneau du graphique : une série, ses barres horizontales par feature.
    /// Les noms de feature et les graduations sont des étiquettes d'AXE, hors de la
    /// zone de tracé : rien ne chevauche le quadrillage.
    private func tokenChart(_ title: String, bars: [StatsBar], features: [String], color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Chart(bars) { bar in
                BarMark(
                    x: .value(title, bar.tokens),
                    y: .value(StatsText.columnFeature, bar.feature)
                )
                .foregroundStyle(color)
            }
            .chartYScale(domain: features)
            .chartYAxis {
                AxisMarks(preset: .extended, position: .leading) { _ in
                    AxisValueLabel()
                }
            }
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 3)) { value in
                    AxisGridLine()
                    AxisValueLabel {
                        if let tokens = value.as(Int.self) {
                            Text(ConsoleFormat.tokens(tokens))
                        }
                    }
                }
            }
            .frame(height: CGFloat(max(1, features.count)) * 28 + 28)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tile(_ title: String, systemImage: String, value: String) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Label(title, systemImage: systemImage)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.system(size: 28, weight: .semibold, design: .rounded).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Les exécutions, triables par en-tête de colonne ; un tri vide garde l'ordre
    /// de S-1. Sans fond alterné : sous les lignes réelles, l'espace restant restait
    /// rayé de lignes VIDES (capture C13).
    private func runsTable(_ rows: [StatsRow]) -> some View {
        Table(
            rows.sorted(using: model.sortOrder),
            sortOrder: Binding(
                get: { model.sortOrder },
                set: { model.sortOrder = $0 }
            )
        ) {
            TableColumn(StatsText.columnFeature, value: \.feature) { row in
                Text(row.feature)
                    .truncationMode(.middle)
                    .accessibilityIdentifier(Self.runIdentifier(row.tag))
            }
            .width(min: 100, ideal: 150)
            TableColumn(StatsText.columnStep, value: \.phaseOrder) { row in
                Text(row.phaseTitle)
            }
            .width(min: 80, ideal: 110)
            TableColumn(StatsText.columnModel, value: \.model) { row in
                Text(row.model)
                    .truncationMode(.middle)
                    .help(row.model)
            }
            .width(min: 110, ideal: 170)
            TableColumn(StatsText.columnDuration, value: \.durationMs) { row in
                Text(row.durationText)
                    .monospacedDigit()
            }
            .width(min: 80, ideal: 110)
            TableColumn(StatsText.columnTurns, value: \.turns) { row in
                Text("\(row.turns)")
                    .monospacedDigit()
            }
            .width(min: 40, ideal: 60)
            TableColumn(StatsText.columnTokens, value: \.tokens) { row in
                Text(row.tokensText)
                    .monospacedDigit()
            }
            .width(min: 60, ideal: 80)
            TableColumn(StatsText.columnState) { row in
                StatusBadge(status: row.status)
                    .help(row.unreadableReason ?? "")
            }
            .width(min: 90, ideal: 110)
        }
        .alternatingRowBackgrounds(.disabled)
        .frame(minHeight: 140)
    }
}
