// Résolution du binaire `omp` à héberger (S-1, AC-14).
//
// Le seul ordre de recherche admis est celui de S-1, et il n'est PAS modifiable
// par l'utilisateur : une app lancée par le Finder hérite du `PATH` de launchd
// (`/usr/bin:/bin:/usr/sbin:/sbin`) et ne verrait donc jamais `~/.bun/bin`, où
// omp 18.4.1 est installé sur le poste de référence (D1). Les trois emplacements
// de repli couvrent les installations mesurées.
//
// La variable d'environnement `OMP_CONSOLE_OMP_BINARY` est l'échappatoire : quand
// elle est posée et non vide, elle est le SEUL candidat (un chemin explicite ne
// doit jamais être contourné par une découverte fortuite). C'est aussi elle qui
// sert aux preuves locales pour simuler un poste sans `omp` (S-10).

import Foundation

enum OmpBinaryResolver {
    static let overrideKey = "OMP_CONSOLE_OMP_BINARY"

    /// Candidats dans l'ordre exact de S-1 : override seul, sinon chaque entrée
    /// de `PATH` puis `/omp`, puis les trois emplacements d'installation connus.
    static func candidates(environment: [String: String]) -> [String] {
        if let override = environment[overrideKey], !override.isEmpty {
            return [override]
        }

        var candidates: [String] = []
        if let path = environment["PATH"] {
            for entry in path.split(separator: ":", omittingEmptySubsequences: true) {
                candidates.append("\(entry)/omp")
            }
        }
        candidates.append("/omp")

        if let home = environment["HOME"], !home.isEmpty {
            candidates.append("\(home)/.bun/bin/omp")
        }
        candidates.append("/opt/homebrew/bin/omp")
        candidates.append("/usr/local/bin/omp")
        return candidates
    }

    /// Le premier candidat qui est un fichier EXÉCUTABLE gagne (S-1). Un fichier
    /// présent mais non exécutable ne gagne jamais, et c'est `isExecutableFile`
    /// qui tranche — pas `fileExists`.
    static func resolve(environment: [String: String]) -> Result<URL, SessionHostError> {
        let searched = candidates(environment: environment)
        for candidate in searched where FileManager.default.isExecutableFile(atPath: candidate) {
            return .success(URL(fileURLWithPath: candidate))
        }
        let override = environment[overrideKey].flatMap { $0.isEmpty ? nil : $0 }
        return .failure(.binaryNotFound(searched: searched, override: override))
    }
}
