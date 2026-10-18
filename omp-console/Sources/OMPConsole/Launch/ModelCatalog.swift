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

import ConsoleCore
import Foundation

/// L'échec du chargement du catalogue : un motif pour l'utilisateur (le texte
/// `modèles indisponibles — <motif>` est composé par `KanbanText`).
struct ModelCatalogError: Error, Equatable, Sendable {
    let reason: String
}

/// Le catalogue lu d'UNE sortie de `omp models --json` : les sélecteurs triés,
/// leurs noms lisibles (clés ⊂ `selectors`) et, pour les modèles qui raisonnent,
/// leurs efforts supportés (model-selector-in-embedded-omp-session S-5).
struct ModelCatalogListing: Equatable, Sendable {
    let selectors: [String]
    let names: [String: String]
    /// Sélecteur → efforts dans l'ordre du catalogue ; entrée ABSENTE quand
    /// `thinking` vaut `null`, manque ou est vide.
    let thinking: [String: [String]]

    init(selectors: [String], names: [String: String], thinking: [String: [String]] = [:]) {
        self.selectors = selectors
        self.names = names
        self.thinking = thinking
    }
}

// `ModelCatalogState` et `ModelCatalog.defaultChoice`/`choices(_:)` vivent dans
// `ConsoleCore` (`Kanban/ModelCatalog.swift`) : les deux coques les emploient.
// La coque macOS garde ICI la lecture de `omp models --json`.
extension ModelCatalog {
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

    /// Le nom lisible de chaque sélecteur de `{"models":[{"selector": …, "name": …}]}`
    /// (feature ios-fiche-carte-pipelines, D-4). Une entrée dont `selector` ou
    /// `name` n'est pas une chaîne non blanche est ignorée ; `name` est gardé
    /// tel quel ; pour un sélecteur en double la PREMIÈRE entrée gagne. Même
    /// garde de forme que `selectors(fromJSON:)` : `nil` quand le JSON est
    /// illisible ou sans tableau `models`.
    static func names(fromJSON data: Data) -> [String: String]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return nil }
        guard let object = root as? [String: Any], let models = object["models"] as? [[String: Any]] else {
            return nil
        }
        var names: [String: String] = [:]
        for model in models {
            guard let selector = model["selector"] as? String,
                  !selector.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  let name = model["name"] as? String,
                  !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { continue }
            if names[selector] == nil { names[selector] = name }
        }
        return names
    }

    /// Les efforts supportés de chaque sélecteur de `{"models":[{"selector": …,
    /// "thinking": ["low", …]}]}` : un tableau de chaînes non vide ; une entrée
    /// dont `thinking` est `null`, absent ou vide n'a pas de clé. Pour un sélecteur
    /// en double la PREMIÈRE entrée gagne. `nil` quand le JSON est illisible ou
    /// sans tableau `models`.
    static func thinking(fromJSON data: Data) -> [String: [String]]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) else { return nil }
        guard let object = root as? [String: Any], let models = object["models"] as? [[String: Any]] else {
            return nil
        }
        var thinking: [String: [String]] = [:]
        var seen = Set<String>()
        for model in models {
            guard let selector = model["selector"] as? String,
                  !selector.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  seen.insert(selector).inserted else { continue }
            guard let efforts = model["thinking"] as? [Any] else { continue }
            let levels = efforts.compactMap { $0 as? String }
            if !levels.isEmpty { thinking[selector] = levels }
        }
        return thinking
    }
}

/// Le chargement de `omp models --json` (S-5). Le binaire est résolu par
/// `OmpBinaryResolver`, l'environnement de l'enfant par `OmpEnvironment.child`
/// (patron `HomeModel`), et le lancement passe par `ProcessRunner` avec un délai
/// de garde.
enum ModelCatalogLoader {
    /// Le délai de garde du lancement (S-5).
    static let timeout: Double = 15

    /// Le chargement complet : sélecteurs ET noms lus de la MÊME sortie d'un
    /// seul lancement de `omp models --json`.
    static func loadListing() async -> Result<ModelCatalogListing, ModelCatalogError> {
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
        let data = Data(run.stdout.utf8)
        guard let selectors = ModelCatalog.selectors(fromJSON: data),
              let names = ModelCatalog.names(fromJSON: data),
              let thinking = ModelCatalog.thinking(fromJSON: data) else {
            return .failure(ModelCatalogError(reason: "réponse illisible"))
        }
        return .success(ModelCatalogListing(selectors: selectors, names: names, thinking: thinking))
    }
}
