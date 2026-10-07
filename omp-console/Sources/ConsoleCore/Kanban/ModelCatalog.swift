// Le catalogue des modèles connus d'OMP (S-5, S-14) : la PARTIE partagée par les
// deux coques — l'état d'une feuille et la liste affichée d'un état. Le
// CHARGEMENT (résolution du binaire `omp`, `ProcessRunner`, lecture JSON) vit
// dans la coque macOS (`Sources/OMPConsole/Launch/ModelCatalog.swift`), car l'app
// iOS ne lance jamais `omp` : elle reçoit la liste du Mac par `GET /v1/models`.
//
// Aucun modèle n'est inventé : `selector` vaut `provider/id` et rien d'autre.

import Foundation

/// L'état du catalogue dans une feuille : en cours, liste des sélecteurs, ou
/// échec au motif du chargeur (ou du serveur distant).
public enum ModelCatalogState: Equatable, Sendable {
    case loading
    case loaded([String])
    case failed(String)
}

public enum ModelCatalog {
    /// L'option de tête des deux listes : un groupe laissé sur le défaut OMP.
    public static let defaultChoice = "défaut OMP (aucun modèle)"

    /// La liste affichée d'un état : `defaultChoice` en tête, puis les sélecteurs
    /// du catalogue chargé (aucun pendant le chargement ou en échec).
    public static func choices(_ state: ModelCatalogState) -> [String] {
        var choices = [defaultChoice]
        if case .loaded(let selectors) = state { choices.append(contentsOf: selectors) }
        return choices
    }
}
