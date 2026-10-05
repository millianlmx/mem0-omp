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
    ) -> Result<URL, SessionHostError> {
        let searched = candidates(environment: environment, paths: paths, manifest: manifest)
        for candidate in searched where FileManager.default.isExecutableFile(atPath: candidate) {
            return .success(URL(fileURLWithPath: candidate))
        }
        let override = environment[overrideKey].flatMap { $0.isEmpty ? nil : $0 }
        return .failure(.binaryNotFound(searched: searched, override: override))
    }
}
