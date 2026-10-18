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

    /// Le nom lisible d'un sélecteur d'après le catalogue (correspondance
    /// EXACTE) ; le sélecteur tel quel quand le catalogue est absent, ne le
    /// connaît pas ou donne un nom blanc — jamais un nom inventé.
    public static func displayName(_ selector: String, names: [String: String]?) -> String {
        knownName(selector, names: names) ?? selector
    }

    // MARK: Niveaux de réflexion (model-selector-in-embedded-omp-session, S-5, S-6)

    /// L'ordre des niveaux de réflexion, du plus bas au plus haut. `auto` n'a pas
    /// de rang propre : il compte comme `high` (S-6).
    private static let levelRanks: [String: Int] = [
        "off": 0, "minimal": 1, "low": 2, "medium": 3, "high": 4, "xhigh": 5, "max": 6, "auto": 4,
    ]

    /// Les niveaux proposés pour un sélecteur : aucun quand le modèle n'a pas
    /// d'efforts (absent, vide) ; sinon `off` puis les efforts dans l'ordre du
    /// catalogue. `auto` n'est jamais proposé.
    public static func thinkingChoices(for selector: String, thinking: [String: [String]]) -> [String] {
        guard let efforts = thinking[selector], !efforts.isEmpty else { return [] }
        var choices = ["off"]
        for effort in efforts where effort != "off" && effort != "auto" && !choices.contains(effort) {
            choices.append(effort)
        }
        return choices
    }

    /// Le niveau du brouillon après un changement de modèle : le niveau courant
    /// s'il est proposé, sinon le plus haut niveau proposé qui ne le dépasse pas,
    /// sinon le premier proposé. `nil` quand aucun niveau n'est proposé.
    public static func retainedLevel(_ level: String?, offered: [String]) -> String? {
        guard let first = offered.first else { return nil }
        guard let level else { return first }
        if offered.contains(level) { return level }
        guard let rank = levelRanks[level] else { return first }
        let lower = offered.filter { (levelRanks[$0] ?? Int.max) <= rank }
        return lower.max { (levelRanks[$0] ?? 0) < (levelRanks[$1] ?? 0) } ?? first
    }

    /// Les libellés des options d'un sélecteur de modèle, par sélecteur
    /// (dédoublonné). Un sélecteur sans nom garde son sélecteur. Un nom porté
    /// par un seul sélecteur s'affiche seul ; un nom partagé est complété, pour
    /// tout le groupe, par le fournisseur s'il départage, sinon par l'id, sinon
    /// par le sélecteur entier : deux options ne se lisent jamais pareil.
    public static func choiceLabels(_ selectors: [String], names: [String: String]?) -> [String: String] {
        var labels: [String: String] = [:]
        var groups: [String: [String]] = [:]
        for selector in selectors where labels[selector] == nil {
            guard let name = knownName(selector, names: names) else {
                labels[selector] = selector
                continue
            }
            labels[selector] = name
            groups[name, default: []].append(selector)
        }
        for (name, group) in groups where group.count > 1 {
            let providers = group.map { parts($0).provider }
            let ids = group.map { parts($0).id }
            let complement: (String) -> String
            if Set(providers).count == group.count {
                complement = { parts($0).provider }
            } else if Set(ids).count == group.count {
                complement = { parts($0).id }
            } else {
                complement = { $0 }
            }
            for selector in group { labels[selector] = "\(name) (\(complement(selector)))" }
        }
        return labels
    }

    /// Le nom lisible du modèle d'une session (Statistiques) : par le sélecteur
    /// exact `provider/model` quand le fournisseur est connu, sinon par `model`
    /// tel quel, sinon `model`. Un id nu partagé entre fournisseurs n'est jamais
    /// deviné.
    public static func sessionModelName(model: String, provider: String?, names: [String: String]?) -> String {
        if let provider = provider?.trimmingCharacters(in: .whitespacesAndNewlines), !provider.isEmpty,
           let name = knownName("\(provider)/\(model)", names: names) {
            return name
        }
        return knownName(model, names: names) ?? model
    }

    /// Le nom non blanc du catalogue pour une clé exacte, ou `nil`.
    private static func knownName(_ selector: String, names: [String: String]?) -> String? {
        guard let name = names?[selector],
              !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return nil }
        return name
    }

    /// Le fournisseur (avant le premier « / ») et l'id (après) d'un sélecteur ;
    /// le sélecteur entier pour les deux quand il n'a pas de « / ».
    private static func parts(_ selector: String) -> (provider: String, id: String) {
        guard let slash = selector.firstIndex(of: "/") else { return (selector, selector) }
        return (String(selector[..<slash]), String(selector[selector.index(after: slash)...]))
    }
}
