// Résolution du binaire `omp` à héberger (S-4, BR-4) : UN SEUL candidat, le
// composant que l'app a installé elle-même.
//
// Ce fichier ne consulte PLUS rien du système : ni `PATH`, ni `~/.bun/bin`, ni
// `/opt/homebrew/bin`, ni `/usr/local/bin`, ni la préférence `omp.chosenPath`
// (supprimée avec la feuille « OMP est requis »). C'est la garantie de B-3 :
// l'app n'utilise que ses composants.
//
// `OMP_CONSOLE_OMP_BINARY` reste l'échappatoire de test (S-1) : quand elle est
// posée et non vide, elle est le SEUL candidat — un chemin explicite ne doit
// jamais être contourné par une découverte fortuite. C'est aussi elle qui sert
// aux recettes pour pointer un omp de secours.

import Combine
import Foundation

enum OmpBinaryResolver {
    static let overrideKey = "OMP_CONSOLE_OMP_BINARY"

    /// Les candidats, dans l'ordre exact de S-4 : l'override seul, sinon le
    /// binaire du composant de l'app.
    static func candidates(environment: [String: String], paths: AppPaths, manifest: ComponentManifest) -> [String] {
        if let override = environment[overrideKey], !override.isEmpty {
            return [override]
        }
        return [paths.ompDir(manifest.ompVersion).appendingPathComponent("omp").path]
    }

    /// Le premier candidat qui est un fichier EXÉCUTABLE gagne. Un fichier présent
    /// mais non exécutable ne gagne jamais — c'est `isExecutableFile` qui tranche,
    /// pas `fileExists` : une préparation le réinstallera.
    static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        paths: AppPaths = .standard(),
        manifest: ComponentManifest = .current
    ) -> Result<URL, OmpBinaryError> {
        let searched = candidates(environment: environment, paths: paths, manifest: manifest)
        for candidate in searched where FileManager.default.isExecutableFile(atPath: candidate) {
            return .success(URL(fileURLWithPath: candidate))
        }
        let override = environment[overrideKey].flatMap { $0.isEmpty ? nil : $0 }
        return .failure(.binaryNotFound(searched: searched, override: override))
    }
}

/// Ce qu'un modèle peut afficher d'une erreur, sans connaître son type exact.
protocol UserFacingError: Error {
    var userMessage: String { get }
}

/// L'échec de résolution du binaire `omp` (préparation des composants, terminal).
enum OmpBinaryError: UserFacingError, Equatable, Sendable {
    case binaryNotFound(searched: [String], override: String?)

    var userMessage: String {
        switch self {
        case .binaryNotFound(let searched, let override):
            var message = "Binaire `omp` introuvable (cherché : \(searched.joined(separator: ", ")))."
            if let override { message += " Chemin demandé : \(override)" }
            return message
        }
    }
}

/// OMP trouvé (le binaire du composant de l'app), ou introuvable : l'app affiche
/// alors sa préparation et propose « Réessayer » (S-5).
enum OmpStatus: Equatable, Sendable {
    case available(URL)
    case missing
}

/// La présence d'OMP, revérifiée quand la préparation des composants s'achève.
@MainActor
final class OmpPresenceModel: ObservableObject {
    typealias Resolver = ([String: String]) -> Result<URL, OmpBinaryError>

    @Published private(set) var omp: OmpStatus

    private let resolve: Resolver
    private let environment: () -> [String: String]

    init(
        resolve: Resolver? = nil,
        environment: @escaping () -> [String: String] = { ProcessInfo.processInfo.environment }
    ) {
        let resolve = resolve ?? { env in
            OmpBinaryResolver.resolve(environment: env, paths: .standard(environment: env))
        }
        self.resolve = resolve
        self.environment = environment
        self.omp = Self.status(resolve(environment()))
    }

    var canLaunch: Bool {
        if case .available = omp { return true }
        return false
    }

    func recheck() {
        omp = Self.status(resolve(environment()))
    }

    private static func status(_ result: Result<URL, OmpBinaryError>) -> OmpStatus {
        switch result {
        case .success(let url): .available(url)
        case .failure: .missing
        }
    }
}
