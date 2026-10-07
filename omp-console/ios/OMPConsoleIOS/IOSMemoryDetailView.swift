// La feuille d'un souvenir (BR-3) : le texte INTÉGRAL rendu par le parseur
// partagé, la ligne de contexte (date relative puis étiquettes), et les données
// techniques repliées sous « Détails techniques ».
//
// Lecture seule : aucun bouton d'écriture, aucune copie, aucun lien de graphe. La
// fermeture est le geste système de la feuille, qui n'a pas besoin d'un bouton.
//
// Les faits affichés sont des fonctions PURES (testables sans rendre la vue) : le
// titre, la ligne de contexte, la portée et la pertinence.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSMemoryDetailView: View {
    let row: RemoteMemoryRow
    /// La portée du sommaire, quand la ligne ne porte pas la sienne.
    let scope: String?

    @Environment(\.horizontalSizeClass) private var sizeClass

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                Divider()
                if blocks.isEmpty {
                    Text(verbatim: MemoryText.emptyRow)
                        .foregroundStyle(.secondary)
                } else {
                    IOSMarkdownView(blocks: blocks)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                technicalDetails
            }
            .padding(IOSMetrics.margin(sizeClass))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier(IOSMemoryAccessibility.detail)
    }

    // MARK: - Faits PURS (les cinq faits de S-5)

    /// Le titre court du souvenir, replié sur `MemoryText.emptyRow` quand son
    /// texte est blanc.
    static func heading(_ row: RemoteMemoryRow) -> String {
        let title = MemoryText.title(row.text)
        return title.isEmpty ? MemoryText.emptyRow : title
    }

    /// La ligne de contexte : date relative puis étiquettes, segments absents omis.
    static func subtitle(_ row: RemoteMemoryRow, nowMs: Double) -> String {
        MemoryText.subtitle(updatedAt: row.updatedAt, tags: row.tags, nowMs: nowMs)
    }

    /// La portée : celle de la ligne, sinon celle du sommaire, sinon « Sans projet ».
    static func scopeText(_ row: RemoteMemoryRow, scope: String?) -> String {
        MemoryText.scopeLabel(row.agentId ?? scope)
    }

    /// La pertinence, seulement quand la ligne en porte une (le sommaire n'en a pas).
    static func scoreText(_ row: RemoteMemoryRow) -> String? {
        row.score.map(MemoryText.decimal)
    }

    /// Le texte INTÉGRAL découpé par le parseur partagé ; aucun bloc pour un texte
    /// blanc (la vue affiche alors `MemoryText.emptyRow`).
    static func blocks(of row: RemoteMemoryRow) -> [MarkdownBlock] {
        row.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : MarkdownDocument.blocks(row.text)
    }

    private var blocks: [MarkdownBlock] { Self.blocks(of: row) }

    // MARK: - Rendu

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(verbatim: Self.heading(row))
                .font(.title2)
                .multilineTextAlignment(.leading)
            TimelineView(.periodic(from: .now, by: 60)) { context in
                let subtitle = Self.subtitle(row, nowMs: context.date.timeIntervalSince1970 * 1000)
                if !subtitle.isEmpty {
                    Text(verbatim: subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.leading)
                }
            }
        }
    }

    private var technicalDetails: some View {
        DisclosureGroup(MemoryText.technicalDetails) {
            VStack(alignment: .leading, spacing: 6) {
                LabeledContent(MemoryText.identifierLabel) {
                    Text(verbatim: row.id)
                        .font(.callout.monospaced())
                }
                LabeledContent(MemoryText.scopeLabel) {
                    Text(verbatim: Self.scopeText(row, scope: scope))
                }
                if let score = Self.scoreText(row) {
                    LabeledContent(MemoryText.scoreLabel) {
                        Text(verbatim: score)
                            .monospacedDigit()
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
        }
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}
