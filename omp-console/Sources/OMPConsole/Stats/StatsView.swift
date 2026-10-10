// La fenêtre « Statistiques » (S-5 de `statistiques`, S-17 de
// omp-console-redesign) : un tableau de bord en LECTURE SEULE — un sélecteur de
// projet (dans la barre d'outils, S-12, seul à nommer le projet : pas de
// sous-titre qui le répète ; présent dans le tableau ET dans l'état « Aucune
// donnée », d'où l'on change de projet), quatre tuiles de totaux, les tokens par
// feature en deux panneaux, un tableau triable des exécutions, la note des
// features masquées.
//
// Le tableau de bord DÉFILE verticalement (S-4 de
// statistiques-etat-vide-et-non-defilables) : les graphiques sont bornés en
// hauteur et la table montre toutes ses lignes, sans défilement vertical
// interne, pour que sa dernière ligne soit atteignable à toute taille de fenêtre.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) : interdits sous les Command
// Line Tools seuls. `@ObservedObject` est une vraie property wrapper, donc
// autorisée ; le tri du tableau vit dans le modèle (`sortOrder`).
//
// L'horloge de rendu est limitée aux durées des exécutions VIVANTES (S-5 de
// statistiques-etat-vide-et-non-defilables) : seules la tuile « Temps passé » et
// les cellules « Durée » de ces exécutions sont des `StatsLiveText`, dont la
// `TimelineView(.periodic)` recalcule la durée depuis l'instant du tic — une
// exécution qui attend une réponse fait monter sa durée sans qu'un octet soit
// écrit. Le reste du tableau de bord n'est réévalué que quand le modèle publie ;
// sans exécution vivante, aucune `TimelineView` n'existe et rien ne se redessine.

import Charts
import ConsoleCore
import SwiftUI

struct StatsView: View {
    @ObservedObject var model: StatsModel
    /// Les noms lisibles du catalogue : la colonne « Modèle » nomme chaque modèle,
    /// l'id en repli.
    let modelNames: [String: String]

    /// Identifiants d'accessibilité : ce que la sonde AX relève.
    static let projectIdentifier = "stats.project"
    static let stateIdentifier = "stats.state"
    static let emptyIdentifier = "stats.empty"
    static let aggregateIdentifier = "stats.aggregate"
    static let chartIdentifier = "stats.chart"
    static let hiddenIdentifier = "stats.hidden"
    static func runIdentifier(_ tag: String) -> String { "stats.run.\(tag)" }
    /// La cellule « Durée » d'une exécution : la sonde AX y relève la durée.
    static func durationIdentifier(_ tag: String) -> String { "stats.duration.\(tag)" }
    /// Le `ScrollView` du tableau de bord : la sonde AX y lit la barre verticale.
    static let boardIdentifier = "stats.board"

    var body: some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .onAppear { model.start() }
            .onDisappear { model.stop() }
            .toolbar {
                if let board = model.state.shownBoard {
                    // À droite, avec les autres commandes de la fenêtre : en
                    // `.principal`, il poussait « Nouvelle feature » au centre.
                    ToolbarItem(placement: .primaryAction) {
                        projectPicker(board)
                    }
                }
            }
    }

    /// Le sélecteur de projet, présent quand un projet est affiché : tableau ou
    /// état « Aucune donnée ».
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
    private var content: some View {
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
            boardView(board)
        }
    }

    /// Le tableau de bord : tuiles, graphique, tableau, note des features
    /// masquées, dans un défilement vertical. Totaux, barres et lignes sont
    /// calculés à l'instant de CETTE évaluation — qui n'a lieu que quand le modèle
    /// publie ; seules les valeurs vivantes avancent ensuite, par `StatsLiveText`.
    private func boardView(_ board: StatsBoard) -> some View {
        let nowMs = Date().timeIntervalSince1970 * 1000
        let totals = projectTotals(board.project, nowMs: nowMs)
        let bars = StatsPresentation.bars(board.project, nowMs: nowMs)
        let rows = StatsPresentation.rows(board.project, nowMs: nowMs, names: modelNames)
        let features = board.project.features.map(\.slug)
        let liveStarts = statsLiveStarts(board.project)
        return ScrollView(.vertical) {
            boardContent(
                board,
                totals: totals,
                bars: bars,
                rows: rows,
                features: features,
                liveStarts: liveStarts
            )
        }
        .accessibilityIdentifier(Self.boardIdentifier)
    }

    private func boardContent(
        _ board: StatsBoard,
        totals: StatsTotals,
        bars: [StatsBar],
        rows: [StatsRow],
        features: [String],
        liveStarts: [String: Double]
    ) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 180), spacing: 12)], spacing: 12) {
                tile(StatsText.sentTokens, systemImage: "arrow.up.circle") {
                    Text(ConsoleFormat.tokens(totals.input))
                }
                tile(StatsText.receivedTokens, systemImage: "arrow.down.circle") {
                    Text(ConsoleFormat.tokens(totals.output))
                }
                tile(StatsText.timeSpent, systemImage: "clock") {
                    // Avance à la seconde SEULEMENT s'il y a une exécution vivante
                    // horodatée : sinon, un `Text` figé, sans horloge.
                    if liveStarts.isEmpty {
                        Text(ConsoleFormat.duration(ms: totals.durationMs))
                    } else {
                        StatsLiveText { nowMs in
                            projectTotals(board.project, nowMs: nowMs).durationMs
                        }
                    }
                }
                tile(StatsText.turns, systemImage: "arrow.triangle.2.circlepath") {
                    Text("\(totals.turns)")
                }
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
            runsTable(rows, liveStarts: liveStarts)

            if board.project.hiddenPlanFeatures > 0 {
                Text(StatsText.hidden(board.project.hiddenPlanFeatures))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(Self.hiddenIdentifier)
            }
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .topLeading)
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
            .frame(height: StatsLayout.chartHeight(features: features.count))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func tile<Value: View>(
        _ title: String,
        systemImage: String,
        @ViewBuilder value: () -> Value
    ) -> some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 6) {
                Label(title, systemImage: systemImage)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                value()
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
    private func runsTable(_ rows: [StatsRow], liveStarts: [String: Double]) -> some View {
        Table(
            rows.sorted(using: model.sortOrder),
            sortOrder: Binding(
                get: { model.sortOrder },
                set: { model.sortOrder = $0 }
            )
        ) {
            TableColumn(StatsText.columnFeature, value: \.feature) { row in
                Text(row.feature)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier(Self.runIdentifier(row.tag))
            }
            .width(min: 100, ideal: 150)
            TableColumn(StatsText.columnStep, value: \.phaseOrder) { row in
                Text(row.phaseTitle)
                    .lineLimit(1)
            }
            .width(min: 80, ideal: 110)
            TableColumn(StatsText.columnModel, value: \.model) { row in
                Text(row.model)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(row.model)
            }
            .width(min: 110, ideal: 170)
            TableColumn(StatsText.columnDuration, value: \.durationMs) { row in
                // Seule la durée d'une exécution vivante horodatée avance ; le tri
                // garde la `durationMs` de la dernière publication du modèle.
                Group {
                    if let first = liveStarts[row.id] {
                        StatsLiveText { nowMs in max(0, nowMs - first) }
                    } else {
                        Text(row.durationText)
                    }
                }
                .lineLimit(1)
                .monospacedDigit()
                .accessibilityIdentifier(Self.durationIdentifier(row.tag))
            }
            .width(min: 80, ideal: 110)
            TableColumn(StatsText.columnTurns, value: \.turns) { row in
                Text("\(row.turns)")
                    .lineLimit(1)
                    .monospacedDigit()
            }
            .width(min: 40, ideal: 60)
            TableColumn(StatsText.columnTokens, value: \.tokens) { row in
                Text(row.tokensText)
                    .lineLimit(1)
                    .monospacedDigit()
            }
            .width(min: 60, ideal: 80)
            TableColumn(StatsText.columnState) { row in
                StatusBadge(status: row.status)
                    .lineLimit(1)
                    .help(row.unreadableReason ?? "")
            }
            .width(min: 90, ideal: 110)
        }
        .alternatingRowBackgrounds(.disabled)
        // Dans un `ScrollView` vertical, une Table sans hauteur explicite
        // s'écrase à 0 (Doc-4 a) : elle prend la hauteur de TOUTES ses lignes.
        .frame(height: StatsLayout.tableHeight(rows: rows.count))
    }
}

/// Les hauteurs du tableau de bord défilant. MESURÉ 2026-10-10 macOS 27.2
/// (Doc-4) : une `Table` de style `.inset` à lignes automatiques — aucune doc Apple
/// ne fixe ces valeurs, la recette AX les revérifie.
private enum StatsLayout {
    /// En-tête de colonnes de la table.
    static let tableHeader: CGFloat = 28
    /// Marges haute (5 pt) et basse (10 pt) du style `.inset`.
    static let tableInsets: CGFloat = 15
    /// Une ligne : 27 pt, imposés par la pastille `StatusBadge` de la colonne
    /// « État » (une ligne de texte seul, `.lineLimit(1)`, en mesure 24).
    static let tableRow: CGFloat = 27
    /// La place d'une barre de défilement horizontale permanente quand la largeur
    /// manque (19 pt à la taille minimale de la fenêtre).
    static let horizontalScroller: CGFloat = 19
    /// Une barre du graphique, et la marge de son axe.
    static let chartRow: CGFloat = 28
    /// Au-delà, les barres s'amincissent au lieu de pousser la table hors de vue.
    static let chartMaxHeight: CGFloat = 240

    static func tableHeight(rows: Int) -> CGFloat {
        tableHeader + tableInsets + tableRow * CGFloat(rows) + horizontalScroller
    }

    static func chartHeight(features: Int) -> CGFloat {
        min(chartRow * CGFloat(max(1, features)) + chartRow, chartMaxHeight)
    }
}

/// Une durée VIVANTE : la seule partie du tableau de bord sous horloge (S-5 de
/// statistiques-etat-vide-et-non-defilables). La `TimelineView` ne réévalue que
/// son contenu à chaque tic (Doc-3, MESURÉ : le corps parent n'est pas
/// réévalué) ; la durée se RECALCULE depuis l'instant du tic, jamais par
/// incrément, car `.periodic` peut tourner plus lentement que demandé.
private struct StatsLiveText: View {
    /// La durée en millisecondes à l'instant `nowMs`.
    let durationMs: (Double) -> Double

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            Text(ConsoleFormat.duration(ms: durationMs(context.date.timeIntervalSince1970 * 1000)))
        }
    }
}
