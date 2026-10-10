// La feuille Contrat de l'Accueil iOS (S-14) : elle lit le contrat de la carte à
// l'ouverture (aucun cache) et rend chaque section requise en Markdown, bloc par
// bloc, ou le message d'une section absente ou vide, d'un fichier absent ou
// illisible.
//
// Le découpage vient de `IOSHomeContent.contract(...)` (fonctions partagées de
// `ConsoleCore`) : mêmes sections, mêmes bornes que macOS. Le corps d'une section
// perd sa ligne « ## Titre » (`IOSHomeContent.contractBlocks`) : l'en-tête de la
// feuille suffit. La barre dit « Contrat » en ligne ; le nom complet de la
// feature est en tête du panneau, jamais tronqué. Aucune ligne « Chemin ».

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HomeContractSheet: View {
    let card: KanbanCard
    @ObservedObject var client: ConsoleClientModel
    /// La charge utile de recette (`-home.recipe contract`), ou aucune : une
    /// capture montre alors de vraies sections sans réseau.
    var recipePayload: RemoteContractPayload? = nil

    @Environment(\.dismiss) private var dismiss

    @State private var content: IOSContractContent?
    @State private var failure: String?
    /// Les blocs du corps de chaque section PRÉSENTE, par titre : calculés une
    /// fois, quand le contenu arrive. Un titre absent ⇔ section absente.
    @State private var blocks: [String: [MarkdownBlock]] = [:]

    private var moment: ContractMoment? {
        ContractDocument.moment(for: card)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(verbatim: IOSHomeContent.contractSlug(card))
                        .font(.title2.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier(IOSHomeAccessibility.contractFeature)
                    if let moment {
                        Text(ContractText.subtitle(moment))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    if let failure {
                        Text(failure)
                            .font(.callout)
                            .iosBanner(tone: .danger)
                    } else if let content {
                        contractBody(content)
                    } else {
                        HStack(spacing: 8) {
                            ProgressView()
                            Text(IOSHomeText.contractLoading).foregroundStyle(.secondary)
                        }
                        .accessibilityIdentifier(IOSHomeAccessibility.contractLoading)
                    }
                }
                .iosPanel()
            }
            .navigationTitle(IOSHomeText.contractNavigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(ContractText.close) { dismiss() }
                        .accessibilityIdentifier(IOSHomeAccessibility.contractClose)
                }
            }
            .accessibilityIdentifier(IOSHomeAccessibility.contractSheet)
        }
        .task { await load() }
    }

    @ViewBuilder
    private func contractBody(_ content: IOSContractContent) -> some View {
        VStack(alignment: .leading, spacing: 16) {
            switch content {
            case .sections(let sections):
                ForEach(sections, id: \.title) { section in
                    VStack(alignment: .leading, spacing: 10) {
                        Text(section.title)
                            .font(.title3.weight(.semibold))
                            .accessibilityAddTraits(.isHeader)
                        sectionBody(section)
                    }
                }
            case .missing:
                Text(IOSHomeContent.inlineMarkdown(ContractText.missingFile)).font(.body)
            case .unreadable:
                // La raison brute n'est jamais affichée (S-9 de
                // jargon-technique-expose-mac-et-ios) ; iOS n'a pas de copie.
                Text(ContractText.unreadable).font(.body)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(IOSHomeAccessibility.contractBody)
    }

    /// Le corps d'une section : ses blocs Markdown, ou le message d'une section
    /// vide ou absente.
    @ViewBuilder
    private func sectionBody(_ section: ContractSection) -> some View {
        if let sectionBlocks = blocks[section.title] {
            if sectionBlocks.isEmpty {
                Text(IOSHomeText.contractSectionEmpty)
                    .font(.body)
                    .foregroundStyle(.secondary)
            } else {
                IOSMarkdownView(blocks: sectionBlocks)
            }
        } else {
            Text(IOSHomeText.contractSectionMissing(title: section.title))
                .font(.body)
                .foregroundStyle(.secondary)
        }
    }

    private func load() async {
        guard let moment else { return }
        if let recipePayload {
            show(IOSHomeContent.contract(with: recipePayload, moment: moment))
            return
        }
        do {
            let payload = try await client.contract(cardId: card.id)
            show(IOSHomeContent.contract(with: payload, moment: moment))
        } catch {
            failure = IOSHomeContent.failure(error)
        }
    }

    /// Pose le contenu ET ses blocs, découpés une seule fois par chargement.
    private func show(_ loaded: IOSContractContent) {
        if case .sections(let sections) = loaded {
            blocks = Dictionary(
                sections.compactMap { section in
                    IOSHomeContent.contractBlocks(section).map { (section.title, $0) }
                },
                uniquingKeysWith: { _, last in last }
            )
        } else {
            blocks = [:]
        }
        content = loaded
    }
}
