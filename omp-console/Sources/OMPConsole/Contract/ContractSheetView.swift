// La feuille Contrat (S-7) : l'en-tête (titre, sous-titre, chemin lu), le corps
// défilant — un `MarkdownBlocksView` par section requise, dans l'ordre de
// `titles(for:)` — puis « Fermer » (action par défaut, Échap et ↩).
//
// Aucun état de chargement (la lecture précède la présentation, `ContractModel`)
// et aucun état vide possible : chaque état a son message (S-5). La feuille
// n'écrit AUCUN fichier et ne valide rien — le geste de validation reste sur sa
// surface.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) : sous les Command Line
// Tools seuls, ces macros n'existent pas.

import ConsoleCore
import SwiftUI

struct ContractSheetView: View {
    let sheet: ContractSheet

    /// La fermeture passe par le chemin des autres feuilles : `dismiss` remet
    /// l'élément à `nil`, et la racine efface l'état (`ContractModel.close`).
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            bodyContent
            footer
        }
        .padding(20)
        .frame(minWidth: 520, idealWidth: 640, minHeight: 440, idealHeight: 620)
        // Conteneur : le corps et le bouton gardent leurs propres identifiants.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("contract.sheet")
    }

    // MARK: - En-tête

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ContractText.title(slug: sheet.slug))
                .font(.title2.bold())
                .textSelection(.enabled)
            Text(ContractText.subtitle(sheet.moment))
                .font(.callout)
                .foregroundStyle(.secondary)
            // Le chemin réellement lu : toujours montré, en détail technique.
            HStack(spacing: 6) {
                Text(ContractText.pathLabel)
                Text(ConsoleFormat.path(sheet.path))
                    .textSelection(.enabled)
            }
            .font(.caption)
            .foregroundStyle(.tertiary)
        }
    }

    // MARK: - Corps

    /// Une entrée par section requise, présente ou non : les sections s'affichent
    /// une à une dans l'ordre de `titles(for:)`, et une section absente cède sa
    /// place à son message.
    @ViewBuilder
    private var bodyContent: some View {
        switch sheet.content {
        case .sections(let sections):
            sectionsScroll(sections)
        case .missing:
            messageBody(ContractText.missingFile)
        case .unreadable(.notText(let bytes)):
            messageBody(ContractText.notText(bytes: bytes))
        case .unreadable(.error(let reason)):
            messageBody(ContractText.unreadable(reason: reason))
        }
    }

    /// Le patron de `FilesView.MarkdownDocumentView` : un `MarkdownBlocksView` par
    /// section dans une `LazyVStack`, largeur de lecture bornée — le texte va
    /// jusqu'au bout, sans troncature ni ellipse.
    private func sectionsScroll(_ sections: [ContractSection]) -> some View {
        ScrollView(.vertical) {
            LazyVStack(alignment: .leading, spacing: 18) {
                ForEach(sections.indices, id: \.self) { index in
                    sectionView(sections[index])
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 4)
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("contract.sheet.body")
    }

    @ViewBuilder
    private func sectionView(_ section: ContractSection) -> some View {
        if let text = section.text {
            // Le texte est VERBATIM, ligne du titre comprise : le titre de la
            // section se rend comme un titre Markdown.
            MarkdownBlocksView(blocks: MarkdownDocument.blocks(text))
        } else {
            message(ContractText.sectionMissing(title: section.title))
        }
    }

    /// Le corps d'un état sans sections : le message, sous le même identifiant
    /// que le corps défilant — jamais de feuille sans `contract.sheet.body`.
    private func messageBody(_ text: String) -> some View {
        VStack(alignment: .leading) {
            message(text)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier("contract.sheet.body")
    }

    private func message(_ text: String) -> some View {
        Text(verbatim: text)
            .foregroundStyle(.secondary)
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Pied

    private var footer: some View {
        HStack {
            Spacer()
            Button(ContractText.close) { dismiss() }
                .keyboardShortcut(.defaultAction)
                .accessibilityIdentifier("contract.sheet.close")
        }
    }
}
