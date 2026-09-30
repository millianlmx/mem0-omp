// La section « Mémoire » (BR-3) : l'en-tête (état du service, recherche, sommaire,
// rafraîchissement), la liste à gauche, le détail à droite.
//
// Aucun attribut macro n'est employé ici (`@State`, `@Preview` ne compilent pas sous
// les Command Line Tools) : l'état vit dans `MemoryModel` et les liens sont
// construits à la main (`Binding(get:set:)`), comme la sélection de la coque.
//
// Tous les textes affichés viennent de `MemoryText` : une erreur, un texte — la vue
// ne compose jamais un message, et un test peut donc les figer. Aucun contrôle
// d'écriture n'existe ici (S-2) : ni bouton, ni menu contextuel, ni raccourci.

import AppKit
import SwiftUI

struct MemoryView: ConsoleSectionView {
    static let section = ConsoleSection.memory

    @ObservedObject var model: MemoryModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        // Le premier chargement suit l'apparition de la section ; la requête en vol
        // est annulée quand elle disparaît (S-6 : aucun sondage périodique).
        .task { await model.refresh() }
        .onDisappear { model.suspend() }
    }

    // MARK: - En-tête

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: serviceText)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("memoire.service")

            HStack(spacing: 8) {
                TextField(MemoryText.searchPlaceholder, text: queryBinding)
                    .frame(maxWidth: 320)
                    .onSubmit { Task { await model.search() } }
                    .accessibilityIdentifier("memoire.search.query")

                Button {
                    Task { await model.search() }
                } label: {
                    Label(MemoryText.searchButton, systemImage: "magnifyingglass")
                }
                .disabled(!model.canSearch)
                .accessibilityIdentifier("memoire.search.submit")

                Button {
                    Task { await model.showSummary() }
                } label: {
                    Label(MemoryText.summaryButton, systemImage: "list.bullet")
                }
                .disabled(!model.canShowSummary)
                .accessibilityIdentifier("memoire.summary.button")

                Button {
                    Task { await model.refresh() }
                } label: {
                    Label(MemoryText.refresh, systemImage: "arrow.clockwise")
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(!model.canRefresh)
                .accessibilityIdentifier("memoire.refresh")

                Spacer()
            }
        }
        .padding(8)
    }

    /// Avant la première sonde, l'app ne SAIT rien : elle affiche l'adresse sans
    /// conclure. Ensuite, l'état littéral de S-6.2 (AC-7, AC-8).
    private var serviceText: String {
        guard model.prepared else { return model.address }
        return model.serviceAvailable
            ? MemoryText.serviceAvailable(model.address)
            : MemoryText.serviceUnavailable(model.address)
    }

    private var queryBinding: Binding<String> {
        Binding(
            get: { model.query },
            set: { model.updateQuery($0) }
        )
    }

    // MARK: - Corps : chaque état de la section

    @ViewBuilder private var content: some View {
        switch model.state {
        case .loading:
            VStack(spacing: 10) {
                ProgressView()
                Text(verbatim: MemoryText.loading)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .noProject:
            ContentUnavailableView(
                MemoryText.noProjectTitle,
                systemImage: "folder.badge.questionmark",
                description: Text(MemoryText.noProjectDescription)
            )

        case let .unavailable(address, detail):
            ContentUnavailableView(
                MemoryText.unavailableTitle,
                systemImage: "exclamationmark.triangle",
                description: Text(verbatim: unavailableDescription(address, detail))
            )

        case .summaryEmpty, .searchEmptyNoMatch, .searchEmptyNoScore, .searchEmptyBelowThreshold:
            Text(verbatim: emptyMessage)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()

        case let .summary(_, total, rows):
            pane(title: MemoryText.summaryCount(total), titleIdentifier: "memoire.summary.count", rows: rows)

        case let .search(query, rows):
            pane(title: MemoryText.searchResults(query), titleIdentifier: "memoire.search.results", rows: rows)
        }
    }

    /// « l'adresse et la DERNIÈRE erreur rencontrée » (S-6.3) : une ligne chacun,
    /// pour que ni l'une ni l'autre ne disparaisse.
    private func unavailableDescription(_ address: String, _ detail: String) -> String {
        detail.isEmpty ? address : "\(address)\n\(detail)"
    }

    private var emptyMessage: String {
        switch model.state {
        case let .summaryEmpty(scope): MemoryText.emptySummary(scope)
        case .searchEmptyNoMatch: MemoryText.noMatch
        case .searchEmptyNoScore: MemoryText.noSemanticScore
        case .searchEmptyBelowThreshold: MemoryText.belowThreshold(MemorySearch.threshold)
        default: ""
        }
    }

    // MARK: - Liste et détail

    private func pane(title: String, titleIdentifier: String, rows: [MemoryRow]) -> some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: title)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .padding(8)
                    .accessibilityIdentifier(titleIdentifier)

                List(selection: selection) {
                    ForEach(rows) { row in
                        MemoryRowView(row: row)
                            .tag(Optional(row.id))
                    }
                }
                .listStyle(.sidebar)
                .accessibilityIdentifier("memoire.list")
                .frame(minWidth: 220)
            }

            detailPane
        }
    }

    private var selection: Binding<String?> {
        Binding(
            get: { model.selectedId },
            set: { model.select(id: $0) }
        )
    }

    private var detailPane: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 0) {
                detailHeader
                Divider()
                detailBody
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 320)
        .accessibilityIdentifier("memoire.detail")
    }

    @ViewBuilder private var detailHeader: some View {
        if let row = model.selected {
            HStack(spacing: 8) {
                Text(verbatim: row.id)
                    .font(.headline)
                Spacer()
            }
            .padding(8)
        }
    }

    @ViewBuilder private var detailBody: some View {
        if let row = model.selected {
            if row.text.isEmpty {
                Text(verbatim: MemoryText.emptyRow)
                    .foregroundStyle(.secondary)
                    .padding(8)
            } else {
                // Le texte COMPLET, à l'identique : ni troncature, ni reformatage —
                // les lignes vides et les espaces de fin sont conservés (S-5).
                Text(verbatim: row.text)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .fixedSize(horizontal: true, vertical: false)
                    .padding(8)
            }
        } else {
            Text(verbatim: MemoryText.nothingSelected)
                .foregroundStyle(.secondary)
                .padding(8)
        }
    }
}

/// Une ligne de la liste : l'identifiant et l'APERÇU du texte (S-1, S-3).
private struct MemoryRowView: View {
    let row: MemoryRow

    var body: some View {
        let preview = MemoryText.preview(row.text)
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: row.id)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(verbatim: preview)
        }
        .accessibilityLabel("\(row.id) — \(preview)")
        .accessibilityIdentifier("memoire.list.row.\(row.id)")
    }
}
