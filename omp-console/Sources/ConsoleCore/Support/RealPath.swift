// Le chemin RÉEL d'un chemin, partagé par le magasin d'état et la coque.
//
// Il vivait dans `KanbanModels.swift` (coque) ; `StoreRuns.swift` le nomme, et il
// part dans `ConsoleCore` — donc la déclaration déménage ici plutôt que d'exister
// en deux exemplaires (règle : un symbole, une définition).

import Darwin

/// `realpathOr` (git.ts:35-41) : le chemin RÉEL, sinon le chemin reçu tel quel —
/// un chemin absent n'est pas une erreur, c'est « worktree introuvable », et une
/// comparaison de préfixes doit porter sur des chemins réels (`/tmp` →
/// `/private/tmp` sous macOS).
public func realpathOr(_ path: String) -> String {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    guard realpath(path, &buffer) != nil else { return path }
    let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
    return String(decoding: bytes, as: UTF8.self)
}
