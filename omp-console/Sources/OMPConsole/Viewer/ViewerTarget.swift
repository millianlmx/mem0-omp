// L'identité d'une fenêtre de visionneuse : la SESSION affichée, et le titre de la
// fenêtre (S-4, S-5).
//
// L'identité est portée par `sessionFile` SEUL. Motif mesuré : un même run
// apparaît dans `running/` PUIS dans `history/` avec deux `id` DIFFÉRENTS
// (`reconcileStore` réécrit `id = historyIdFor(cwd, endedAt)`) ; c'est la session
// qui fait l'objet d'une fenêtre, pas l'entrée du magasin. `WindowGroup(for:)`
// ramène au premier plan la fenêtre qui présente déjà la MÊME valeur, donc
// l'égalité par `sessionFile` rend vrai « une fenêtre par session » sans registre
// à tenir — et « une seconde fenêtre pour un autre run ».

import Foundation

/// La valeur présentée par une fenêtre de visionneuse. `Hashable` ET `Codable`
/// sont exigés par `WindowGroup(for:)` (Documentation §1).
struct ViewerTarget: Hashable, Codable, Sendable {
    var sessionFile: String
    /// Figé à l'ouverture : il ne participe ni à l'égalité ni au hachage, donc
    /// renommer un run ne change pas l'identité de sa fenêtre.
    var title: String

    static func == (lhs: ViewerTarget, rhs: ViewerTarget) -> Bool {
        lhs.sessionFile == rhs.sessionFile
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(sessionFile)
    }
}

/// Une étiquette courte et stable pour une session, tirée de son nom de fichier :
/// l'identifiant de session, pas la date. `2026-09-28T15-07-55-136Z_01a0e88e-….jsonl`
/// rend `01a0e88e`.
func sessionTag(forSessionFile path: String) -> String {
    let name = ((path as NSString).lastPathComponent as NSString).deletingPathExtension
    let tail: String
    if let separator = name.lastIndex(of: "_") {
        tail = String(name[name.index(after: separator)...])
    } else {
        tail = name
    }
    let tag = String(tail.prefix(8))
    return tag.isEmpty ? "session" : tag
}
