// La section « Mémoire » (BR-3) : la recherche, le sommaire et le rafraîchissement
// dans la barre d'outils de la fenêtre ; la liste à gauche, le détail à droite.
//
// Aucun attribut macro n'est employé ici (`@State`, `@Preview` ne compilent pas sous
// les Command Line Tools) : l'état vit dans `MemoryModel` et les liens sont
// construits à la main (`Binding(get:set:)`), comme la sélection de la coque.
//
// Tous les textes affichés viennent de `MemoryText` : une erreur, un texte — la vue
// ne compose jamais un message. Aucun contrôle d'écriture n'existe ici (S-2) : ni
// bouton, ni menu contextuel, ni raccourci ; « Copier » ne touche que le
// presse-papiers.

import AppKit
import SwiftUI

struct MemoryView: ConsoleSectionView {
    static let section = ConsoleSection.memory

    @ObservedObject var model: MemoryModel

    var body: some View {
        VStack(spacing: 0) {
            // Le prérequis système manquant est NOMMÉ au-dessus de la liste (S-6,
            // AC-6) : lecture seule, aucun geste — oMLX n'est ni installé ni
            // configuré par l'app.
            if let banner = model.omlxBanner {
                omlxBannerView(banner)
            }
            content
        }
        // Le champ de recherche standard, dans la barre d'outils : Retour lance
        // la recherche, la croix (ou un champ vidé) ramène au sommaire.
        .searchable(text: queryBinding, placement: .toolbar, prompt: Text(MemoryText.searchPrompt))
        .onSubmit(of: .search) { Task { await model.search() } }
        .toolbar { toolbarContent }
        // Le premier chargement suit l'apparition de la section ; la requête en
        // vol est annulée quand elle disparaît (S-6 : aucun sondage périodique).
        .task { await model.refresh() }
        .onDisappear { model.suspend() }
    }

    // MARK: - Prérequis oMLX (S-6, AC-6)

    /// Le bandeau d'un prérequis système manquant : la phrase porte le sens, la
    /// teinte orange ne fait que le souligner (jamais rouge — ce n'est pas une
    /// erreur de l'app). Aucun bouton : l'app ne répare pas oMLX.
    private func omlxBannerView(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
            Text(verbatim: text)
            Spacer()
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleBanner(tint: .orange)
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .accessibilityIdentifier("memory.omlxBanner")
    }

    // MARK: - Barre d'outils

    /// Deux commandes sans rapport : `ToolbarSpacer(.fixed)` les sépare plutôt que
    /// de les fondre dans un même verre. Aucun `.buttonStyle` : le verre est celui
    /// du système.
    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Button {
                Task { await model.showSummary() }
            } label: {
                Label(MemoryText.summaryButton, systemImage: "list.bullet")
            }
            .help(MemoryText.summaryHelp)
            .disabled(!model.canShowSummary)
            .accessibilityIdentifier("memoire.summary.button")
        }
        ToolbarSpacer(.fixed, placement: .primaryAction)
        ToolbarItem(placement: .primaryAction) {
            Button {
                Task { await model.refresh() }
            } label: {
                Label(MemoryText.refresh, systemImage: "arrow.clockwise")
            }
            .help(MemoryText.refreshHelp)
            .keyboardShortcut("r", modifiers: .command)
            .disabled(!model.canRefresh)
            .accessibilityIdentifier("memoire.refresh")
        }
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
            // L'indisponibilité dit d'abord quoi faire ; l'adresse du service et la
            // dernière erreur (S-6.3) ne sont qu'un détail secondaire.
            ContentUnavailableView {
                Label(MemoryText.unavailableTitle, systemImage: "exclamationmark.triangle")
            } description: {
                Text(MemoryText.unavailableDescription)
            } actions: {
                Button(MemoryText.retry) { Task { await model.refresh() } }
                    .disabled(!model.canRefresh)
                Text(verbatim: MemoryText.unavailableDetail(address: address, error: detail))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                    .accessibilityIdentifier("memoire.unavailable.detail")
            }

        case let .summaryEmpty(scope):
            ContentUnavailableView(
                MemoryText.emptySummaryTitle,
                systemImage: "brain",
                description: Text(MemoryText.emptySummary(scope))
            )

        case .searchEmptyNoMatch:
            ContentUnavailableView(
                MemoryText.noResultTitle,
                systemImage: "magnifyingglass",
                description: Text(MemoryText.noMatch)
            )

        case .searchEmptyBelowThreshold:
            ContentUnavailableView(
                MemoryText.noResultTitle,
                systemImage: "magnifyingglass",
                description: Text(MemoryText.belowThreshold)
            )

        case .searchEmptyNoScore:
            ContentUnavailableView(
                MemoryText.searchUnsupportedTitle,
                systemImage: "exclamationmark.magnifyingglass",
                description: Text(MemoryText.noSemanticScore)
            )

        case let .summary(_, total, rows):
            pane(title: MemoryText.summaryCount(total), titleIdentifier: "memoire.summary.count", rows: rows)

        case let .search(query, rows):
            pane(title: MemoryText.searchResults(query), titleIdentifier: "memoire.search.results", rows: rows)
        }
    }

    // MARK: - Liste et détail

    private func pane(title: String, titleIdentifier: String, rows: [MemoryRow]) -> some View {
        HSplitView {
            VStack(alignment: .leading, spacing: 0) {
                Text(verbatim: title)
                    .font(.headline)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .accessibilityIdentifier(titleIdentifier)

                // L'horloge de RENDU des dates relatives (S-18 R7) : la minute suffit
                // à « il y a 4 minutes », et aucune date n'est figée au chargement.
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    let nowMs = context.date.timeIntervalSince1970 * 1000
                    List(selection: selection) {
                        ForEach(rows) { row in
                            MemoryRowView(row: row, nowMs: nowMs)
                                .tag(Optional(row.id))
                        }
                    }
                    .listStyle(.inset)
                    .accessibilityIdentifier("memoire.list")
                }
            }
            .frame(minWidth: 260, idealWidth: 320)

            detailPane
        }
    }

    private var selection: Binding<String?> {
        Binding(
            get: { model.selectedId },
            set: { model.select(id: $0) }
        )
    }

    @ViewBuilder private var detailPane: some View {
        Group {
            if let row = model.selected {
                MemoryDetailView(row: row, scope: model.scope)
            } else {
                Text(verbatim: MemoryText.nothingSelected)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 320)
        .accessibilityIdentifier("memoire.detail")
    }
}

/// Le détail d'un souvenir (S-18 R7, S-19 R2) : un vrai titre, la ligne de contexte
/// (date relative · étiquettes), le texte COMPLET rendu en Markdown et
/// sélectionnable, le bouton « Copier » ; l'identifiant, la portée et la
/// pertinence restent repliés sous « Détails techniques ».
private struct MemoryDetailView: View {
    let row: MemoryRow
    let scope: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                if row.text.isEmpty {
                    Text(verbatim: MemoryText.emptyRow)
                        .foregroundStyle(.secondary)
                } else {
                    MarkdownBlocksView(markdown: row.text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                technicalDetails
            }
            .padding(20)
            .frame(maxWidth: 720, alignment: .leading)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var header: some View {
        let title = MemoryText.title(row.text)
        return HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: title.isEmpty ? MemoryText.emptyRow : title)
                    .font(.title3.bold())
                    .textSelection(.enabled)
                    .accessibilityIdentifier("memoire.detail.title")
                TimelineView(.periodic(from: .now, by: 60)) { context in
                    let subtitle = MemoryText.subtitle(row: row, nowMs: context.date.timeIntervalSince1970 * 1000)
                    if !subtitle.isEmpty {
                        Text(verbatim: subtitle)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            Spacer(minLength: 0)
            Button {
                let pasteboard = NSPasteboard.general
                pasteboard.clearContents()
                pasteboard.setString(row.text, forType: .string)
            } label: {
                Label(MemoryText.copy, systemImage: "doc.on.doc")
            }
            .help(MemoryText.copyHelp)
            .disabled(row.text.isEmpty)
            .accessibilityIdentifier("memoire.detail.copy")
        }
    }

    private var technicalDetails: some View {
        DisclosureGroup(MemoryText.technicalDetails) {
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent(MemoryText.identifierLabel) {
                    Text(verbatim: row.id)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                }
                if let scope {
                    LabeledContent(MemoryText.scopeLabel) {
                        Text(verbatim: scope)
                            .textSelection(.enabled)
                    }
                }
                if let score = row.semanticScore {
                    LabeledContent(MemoryText.scoreLabel) {
                        Text(verbatim: MemoryText.decimal(score))
                            .monospacedDigit()
                    }
                }
            }
            .padding(.top, 6)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .accessibilityIdentifier("memoire.detail.technical")
    }
}

/// Une ligne de la liste (S-19 R2) : le TITRE court du souvenir
/// (`MemoryText.title`) sur au plus deux lignes, puis UNE ligne de contexte (date
/// relative · étiquettes) composée par `MemoryText.subtitle`. Le texte complet
/// n'est lu que dans le détail.
private struct MemoryRowView: View {
    let row: MemoryRow
    let nowMs: Double

    var body: some View {
        let subtitle = MemoryText.subtitle(row: row, nowMs: nowMs)
        let title = MemoryText.title(row.text)
        VStack(alignment: .leading, spacing: 3) {
            Text(verbatim: title.isEmpty ? MemoryText.emptyRow : title)
                .font(.body.weight(.medium))
                .foregroundStyle(title.isEmpty ? .secondary : .primary)
                .lineLimit(2)
                .truncationMode(.tail)
            if !subtitle.isEmpty {
                Text(verbatim: subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("memoire.list.row.\(row.id)")
    }
}
