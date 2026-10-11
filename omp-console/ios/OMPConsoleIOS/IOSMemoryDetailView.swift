// La feuille d'un souvenir (BR-3) : le texte INTÉGRAL affiché tel qu'il est
// stocké (`Text(verbatim:)`, aucun rendu Markdown), la ligne de contexte (date
// relative puis étiquettes), et les données techniques repliées sous « Détails
// techniques ».
//
// Rendu en formulaire groupé natif (ios-listes-groupees-natives, S-7) : une
// section pour la ligne de contexte et le texte, une section de liens (mode
// graphe seulement), une section pour les détails techniques — séparateurs et
// en-têtes du système, aucun filet tracé à la main.
//
// Lecture seule : aucun bouton d'écriture, aucune copie. La fermeture : le bouton
// « Fermer » de la barre, ou le geste système de la feuille.
//
// Les faits affichés sont des fonctions PURES (testables sans rendre la vue) : le
// texte, la ligne de contexte, la portée et la pertinence.

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

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if hasSubtitle {
                        header
                    }
                    Text(verbatim: Self.text(row))
                        .font(.body)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .foregroundStyle(isBlank ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                }
                if !links.isEmpty {
                    linksSection
                }
                Section {
                    technicalDetails
                }
            }
            .formStyle(.grouped)
            .accessibilityIdentifier(IOSMemoryAccessibility.detail)
            .navigationTitle(IOSMemoryText.detailTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    // Forme 44 pt mesurée (D-4) : le bouton de barre par défaut n'a que 36 pt.
                    Button {
                        dismiss()
                    } label: {
                        Text(ConnectionText.close)
                            .padding(.horizontal, 8)
                            .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(IOSMemoryAccessibility.close)
                }
            }
        }
        .iosPageSheet()
    }

    // MARK: - Les liens (mode graphe, S-5)

    /// Les lignes de liens : la nature en clair (une proximité par son libellé, sans
    /// score) et l'autre extrémité (son libellé de nœud, ou son identifiant à défaut).
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

    /// Une rangée par lien, sous l'en-tête natif « Liens ».
    private var linksSection: some View {
        Section {
            ForEach(Self.linkLines(links, from: row.id, labels: labels), id: \.self) { line in
                Text(verbatim: line)
                    .multilineTextAlignment(.leading)
            }
        } header: {
            Text(verbatim: IOSMemoryText.links)
                .textCase(nil)
        }
    }

    // MARK: - Faits PURS (les cinq faits de S-5)

    /// Le texte STOCKÉ tel quel, `MemoryText.emptyRow` s'il est blanc.
    static func text(_ row: RemoteMemoryRow) -> String {
        isBlank(row.text) ? MemoryText.emptyRow : row.text
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var isBlank: Bool { Self.isBlank(row.text) }

    /// La ligne de contexte : date relative puis étiquettes, segments absents omis.
    static func subtitle(_ row: RemoteMemoryRow, nowMs: Double) -> String {
        MemoryText.subtitle(updatedAt: row.updatedAt, tags: row.tags, nowMs: nowMs)
    }

    /// Les segments de la ligne de contexte, un par ligne aux tailles
    /// d'accessibilité : date relative puis étiquettes, segments absents omis.
    /// Joints par `MemoryText.separator`, ils redonnent `subtitle(_:nowMs:)`.
    static func subtitleSegments(_ row: RemoteMemoryRow, nowMs: Double) -> [String] {
        var segments: [String] = []
        if let ms = MemoryText.updatedAtMs(row.updatedAt) {
            segments.append(ConsoleFormat.relative(ms: ms, nowMs: nowMs))
        }
        if !row.tags.isEmpty {
            segments.append(MemoryText.tagList(row.tags))
        }
        return segments
    }

    /// La portée : celle de la ligne, sinon celle du sommaire, sinon « Sans projet ».
    static func scopeText(_ row: RemoteMemoryRow, scope: String?) -> String {
        MemoryText.scopeLabel(row.agentId ?? scope)
    }

    /// La pertinence, seulement quand la ligne en porte une (le sommaire n'en a pas).
    static func scoreText(_ row: RemoteMemoryRow) -> String? {
        row.score.map(MemoryText.decimal)
    }

    // MARK: - Rendu

    /// Vrai quand la ligne de contexte a au moins un segment : sans date ni
    /// étiquette, la section n'a pas de rangée vide.
    private var hasSubtitle: Bool {
        !Self.subtitle(row, nowMs: Date().timeIntervalSince1970 * 1000).isEmpty
    }

    private var header: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            Text(verbatim: Self.subtitle(row, nowMs: context.date.timeIntervalSince1970 * 1000))
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.leading)
        }
    }

    /// Repliées par défaut : chaque fait technique est une rangée du groupe.
    private var technicalDetails: some View {
        DisclosureGroup(MemoryText.technicalDetails) {
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
        .font(.callout)
        .foregroundStyle(.secondary)
    }
}
