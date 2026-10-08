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
    /// Les liens incidents du graphe (mode graphe) ; vide pour le mode liste, qui
    /// rend alors exactement ce qu'il rendait (B-4).
    let links: [MemoryGraphLink]
    /// Les libellés des nœuds du graphe, pour nommer l'autre extrémité d'un lien.
    let labels: [MemoryGraphNodeID: String]

    init(
        row: RemoteMemoryRow,
        scope: String?,
        links: [MemoryGraphLink] = [],
        labels: [MemoryGraphNodeID: String] = [:]
    ) {
        self.row = row
        self.scope = scope
        self.links = links
        self.labels = labels
    }

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
                if !links.isEmpty {
                    Divider()
                    linksBlock
                }
                technicalDetails
            }
            .padding(IOSMetrics.margin(sizeClass))
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier(IOSMemoryAccessibility.detail)
    }

    // MARK: - Les liens (mode graphe, S-5)

    /// Les lignes de liens : la nature, l'autre extrémité (son libellé de nœud, ou
    /// son identifiant à défaut) et, pour une proximité, son score.
    static func linkLines(_ links: [MemoryGraphLink], from id: String, labels: [MemoryGraphNodeID: String]) -> [String] {
        links.compactMap { link in
            let other: MemoryGraphNodeID? = link.a.memoryId == id ? link.b : (link.b.memoryId == id ? link.a : nil)
            guard let other else { return nil }
            let name: String
            switch other {
            case let .tag(tag): name = MemoryText.tagLabel(tag)
            case let .memory(memory): name = labels[other] ?? memory
            }
            let score: Double?
            if case let .semantic(value) = link.kind { score = value } else { score = nil }
            return IOSMemoryText.linkLine(kind: link.kind, other: name, score: score)
        }
    }

    private var linksBlock: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: IOSMemoryText.links)
                .font(.headline)
                .foregroundStyle(.secondary)
            ForEach(Self.linkLines(links, from: row.id, labels: labels), id: \.self) { line in
                Text(verbatim: line)
                    .multilineTextAlignment(.leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
