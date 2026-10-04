// La feuille d'édition des deux modèles d'une feature (S-5, B-3) et le sélecteur
// partagé des deux feuilles (« Nouvelle feature » et « Modèles »).
//
// L'état des choix vit dans `ActionsModel` (`@State` interdit sous les CLT) ; la
// feuille ne compose aucune phrase (textes dans `ActionsText`). Aucune écriture
// directe du magasin : « Appliquer » émet une commande `models` par le canal.

import SwiftUI

/// Les deux sélecteurs `Modèle req+specs` / `Modèle impl+review`, alimentés par le
/// catalogue `omp models --json`. L'option de tête `défaut OMP (aucun modèle)`
/// vaut `nil`. Pendant le chargement ou en échec, la liste se réduit à cette
/// option — plus la valeur courante quand elle n'y figure pas — et l'édition reste
/// possible.
struct ModelSlotsPicker: View {
    let catalog: ModelCatalogState
    @Binding var reqSpecs: String?
    @Binding var implReview: String?
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            picker(ActionsText.modelReqSpecsField, selection: $reqSpecs, current: reqSpecs)
                .accessibilityIdentifier("models.reqSpecs")
            picker(ActionsText.modelImplReviewField, selection: $implReview, current: implReview)
                .accessibilityIdentifier("models.implReview")
            switch catalog {
            case .loading:
                Text(ActionsText.modelCatalogLoading)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("models.loading")
            case .failed(let reason):
                HStack(spacing: 8) {
                    Text(ActionsText.modelCatalogUnavailable(reason))
                        .font(.callout)
                        .foregroundStyle(.red)
                    Button(ActionsText.modelCatalogRetry) { onRetry() }
                        .accessibilityIdentifier("models.retry")
                }
                .accessibilityIdentifier("models.failure")
            case .loaded:
                EmptyView()
            }
        }
    }

    @ViewBuilder
    private func picker(_ label: String, selection: Binding<String?>, current: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.headline)
            Picker(label, selection: selection) {
                Text(ModelCatalog.defaultChoice).tag(Optional<String>.none)
                ForEach(options(including: current), id: \.self) { selector in
                    Text(verbatim: selector)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .tag(Optional(selector))
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// `défaut` en tête, les sélecteurs du catalogue, puis la valeur COURANTE si
    /// elle n'y figure pas (catalogue indisponible) — la sélection reste visible.
    private func options(including value: String?) -> [String] {
        var list = ModelCatalog.choices(catalog)
        if let value, !value.isEmpty, !list.contains(value) { list.append(value) }
        return list
    }
}

/// La feuille d'édition des modèles de la feature d'une carte, ouverte par le menu
/// contextuel de carte (`Modifier les modèles…`) ou par le bouton `Modifier…` de
/// l'inspecteur. Titre `Modèles de <slug>`, sélecteurs pré-positionnés sur les
/// valeurs courantes résolues, `Annuler` / `Appliquer`.
struct ModelsSheet: View {
    let card: KanbanCard
    @ObservedObject var actions: ActionsModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let slug = card.action?.slug ?? card.title
        VStack(alignment: .leading, spacing: 14) {
            Text(ActionsText.modelsSheetTitle(slug))
                .font(.title2)
                .bold()
            ModelSlotsPicker(
                catalog: actions.modelCatalog,
                reqSpecs: $actions.editModelReqSpecs,
                implReview: $actions.editModelImplReview,
                onRetry: { actions.loadModelCatalog() }
            )
            HStack(spacing: 8) {
                Spacer()
                Button(ActionsText.cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("models.cancel")
                Button(ActionsText.applyModelChanges) { apply() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("models.apply")
            }
        }
        .padding(20)
        .frame(width: 480)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("models.sheet")
    }

    /// Émet la commande `models` puis ferme la feuille. Une carte sans lot (pas de
    /// slug) ne peut rien éditer : la feuille se ferme simplement.
    private func apply() {
        defer { dismiss() }
        guard let action = card.action, let slug = action.slug, let repoRoot = action.repoRoot else { return }
        actions.setModels(
            repoRoot: repoRoot,
            slug: slug,
            modelReqSpecs: actions.editModelReqSpecs,
            modelImplReview: actions.editModelImplReview
        )
    }
}
