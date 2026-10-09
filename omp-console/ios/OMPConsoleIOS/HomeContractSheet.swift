// La feuille Contrat de l'Accueil iOS (S-14) : elle lit le contrat de la carte à
// l'ouverture (aucun cache) et affiche chaque section requise VERBATIM, ou le
// message d'une section absente, d'un fichier absent ou illisible.
//
// Le découpage vient de `IOSHomeContent.contract(...)` (fonctions partagées de
// `ConsoleCore`) : mêmes sections, mêmes bornes que macOS. Aucune ligne
// « Chemin », aucun rendu Markdown par blocs (périmètre borné de S-14).

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

    private var moment: ContractMoment? {
        ContractDocument.moment(for: card)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
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
            .navigationTitle(ContractText.title(slug: IOSHomeContent.contractSlug(card)))
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
                    VStack(alignment: .leading, spacing: 6) {
                        Text(section.title).font(.headline)
                        if let text = section.text {
                            Text(verbatim: text).font(.body)
                        } else {
                            Text(ContractText.sectionMissing(title: section.title))
                                .font(.body)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            case .missing:
                Text(ContractText.missingFile).font(.body)
            case .unreadable(let reason):
                Text(ContractText.unreadable(reason: reason)).font(.body)
            }
        }
        .accessibilityIdentifier(IOSHomeAccessibility.contractBody)
    }

    private func load() async {
        guard let moment else { return }
        if let recipePayload {
            content = IOSHomeContent.contract(with: recipePayload, moment: moment)
            return
        }
        do {
            let payload = try await client.contract(cardId: card.id)
            content = IOSHomeContent.contract(with: payload, moment: moment)
        } catch {
            failure = IOSHomeContent.failure(error)
        }
    }
}
