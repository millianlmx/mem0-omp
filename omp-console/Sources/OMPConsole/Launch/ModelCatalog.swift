// Le catalogue des modèles connus d'OMP (S-5) : la sortie de `omp models --json`
// relue pour peupler les deux sélecteurs des feuilles « Nouvelle feature » et
// « Modèles ».
//
// Aucune dépendance à l'hôte : la console obtient la MÊME liste que les portes du
// plugin par la ligne de commande (Doc §1). `selector` vaut `provider/id` et rien
// d'autre — c'est exactement la valeur affichée et transmise, jamais retouchée.
//
// Le chargement est INJECTABLE : les tests fournissent une liste ou un échec sans
// lancer de process.

import Foundation

/// L'échec du chargement du catalogue : un motif pour l'utilisateur (le texte
/// `modèles indisponibles — <motif>` est composé par `ActionsText`).
struct ModelCatalogError: Error, Equatable, Sendable {
    let reason: String
}

/// L'état du catalogue dans une feuille : en cours, liste des sélecteurs, ou
/// échec au motif du chargeur.
enum ModelCatalogState: Equatable, Sendable {
    case loading
    case loaded([String])
    case failed(String)
}

enum ModelCatalog {
    /// L'option de tête des deux listes : un groupe laissé sur le défaut OMP.
    static let defaultChoice = "défaut OMP (aucun modèle)"

    /// Les sélecteurs de `{"models":[{"selector": …}]}` : une entrée sans
    /// `selector` non blanc est ignorée, les doublons sont retirés, l'ordre est
    /// croissant (comparaison de chaînes). `nil` quand le JSON est illisible ou
    /// n'a pas la forme attendue — c'est un échec, jamais une liste vide.
    static func selectors(fromJSON data: Data) -> [String]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return nil }
        guard let object = root as? [String: Any], let models = object["models"] as? [[String: Any]] else {
            return nil
        }
        var seen = Set<String>()
        var selectors: [String] = []
        for model in models {
            guard let selector = model["selector"] as? String,
                  !selector.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            if seen.insert(selector).inserted { selectors.append(selector) }
        }
        return selectors.sorted()
    }

    /// La liste affichée d'un état : `defaultChoice` en tête, puis les sélecteurs
    /// du catalogue chargé (aucun pendant le chargement ou en échec).
    static func choices(_ state: ModelCatalogState) -> [String] {
        var choices = [defaultChoice]
        if case .loaded(let selectors) = state { choices.append(contentsOf: selectors) }
        return choices
    }
}

/// Le chargement de `omp models --json` (S-5). Le binaire est résolu par
/// `OmpBinaryResolver`, l'environnement de l'enfant par `OmpEnvironment.child`
/// (patron `HomeModel`), et le lancement passe par `ProcessRunner` avec un délai
/// de garde.
enum ModelCatalogLoader {
    /// Le délai de garde du lancement (S-5).
    static let timeout: Double = 15

    /// Le chargeur réel. Un binaire absent, un code non nul ou une sortie
    /// illisible rendent le motif de l'échec.
    static func loadDefault() async -> Result<[String], ModelCatalogError> {
        let environment = ProcessInfo.processInfo.environment
        let binary: URL
        switch OmpBinaryResolver.resolve(environment: environment) {
        case .success(let url): binary = url
        case .failure: return .failure(ModelCatalogError(reason: "omp introuvable"))
        }
        let child = ProcessRunner.child(
            binary: binary,
            arguments: ["models", "--json"],
            cwd: URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
            environment: OmpEnvironment.child(base: environment, executable: binary),
            input: .nullDevice
        )
        let run: ProcessRun
        do {
            run = try await ProcessRunner.run(child, timeout: timeout)
        } catch {
            return .failure(ModelCatalogError(reason: "lancement impossible"))
        }
        guard run.code == 0 else {
            return .failure(ModelCatalogError(reason: "omp models a échoué (code \(run.code))"))
        }
        guard let selectors = ModelCatalog.selectors(fromJSON: Data(run.stdout.utf8)) else {
            return .failure(ModelCatalogError(reason: "réponse illisible"))
        }
        return .success(selectors)
    }
}
