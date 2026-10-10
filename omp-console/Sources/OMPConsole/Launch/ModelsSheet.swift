// La feuille d'édition des deux modèles d'une feature (S-5, B-3) et le sélecteur
// partagé des deux feuilles (« Nouvelle feature » et « Modèles »).
//
// L'état des choix vit dans `ActionsModel` (`@State` interdit sous les CLT) ; la
// feuille ne compose aucune phrase (textes dans `ActionsText`). Aucune écriture
// directe du magasin : « Appliquer » émet une commande `models` par le canal.

import ConsoleCore
import SwiftUI

/// Les deux sélecteurs `Modèle /req et /specs` / `Modèle /impl et /review`, alimentés par le
/// catalogue `omp models --json`. L'option de tête `défaut OMP (aucun modèle)`
/// vaut `nil` ; chaque autre option est libellée par son nom lisible
/// (`ModelCatalog.choiceLabels`, nom départagé pour les homonymes, sélecteur en
/// repli) et porte le sélecteur exact. Pendant le chargement ou en échec, la
/// liste se réduit à cette option — plus la valeur courante quand elle n'y
/// figure pas — et l'édition reste possible.
struct ModelSlotsPicker: View {
    let catalog: ModelCatalogState
    /// Les noms lisibles du catalogue (sélecteur → nom).
    let names: [String: String]
    @Binding var reqSpecs: String?
    @Binding var implReview: String?
    let onRetry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            picker(KanbanText.modelReqSpecs, selection: $reqSpecs, current: reqSpecs)
                .accessibilityIdentifier("models.reqSpecs")
            picker(KanbanText.modelImplReview, selection: $implReview, current: implReview)
                .accessibilityIdentifier("models.implReview")
            switch catalog {
            case .loading:
                Text(KanbanText.modelCatalogLoading)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("models.loading")
            case .failed(let reason):
                HStack(spacing: 8) {
                    Text(KanbanText.modelCatalogUnavailable(reason))
                        .font(.callout)
                        .foregroundStyle(.red)
                    Button(KanbanText.modelCatalogRetry) { onRetry() }
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
                ForEach(Self.options(catalog, including: current, names: names)) { option in
                    Text(verbatim: option.label)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .tag(Optional(option.selector))
                }
            }
            .labelsHidden()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Les options qui suivent le défaut (posé une seule fois, balisé `nil`) : les
    /// sélecteurs du catalogue chargé, puis la valeur COURANTE si elle n'y figure
    /// pas (catalogue indisponible) — la sélection reste visible. Chacune est
    /// libellée par `ModelCatalog.choiceLabels` et porte le sélecteur exact.
    static func options(_ catalog: ModelCatalogState, including value: String?, names: [String: String]) -> [ModelSlotOption] {
        var selectors: [String] = []
        if case .loaded(let loaded) = catalog { selectors = loaded }
        if let value, !value.isEmpty, !selectors.contains(value) { selectors.append(value) }
        let labels = ModelCatalog.choiceLabels(selectors, names: names)
        return selectors.map { ModelSlotOption(selector: $0, label: labels[$0] ?? $0) }
    }
}

/// Une option d'un sélecteur de modèle : le libellé affiché, le sélecteur transmis.
struct ModelSlotOption: Identifiable, Equatable {
    let selector: String
    let label: String
    var id: String { selector }
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
                names: actions.modelNames,
                reqSpecs: $actions.editModelReqSpecs,
                implReview: $actions.editModelImplReview,
                onRetry: { actions.loadModelCatalog() }
            )
            HStack(spacing: 8) {
                Spacer()
                Button(KanbanText.cancel) { dismiss() }
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
