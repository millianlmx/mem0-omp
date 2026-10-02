// L'identité d'une visionneuse : la SESSION affichée, et son titre (S-4, S-5).
//
// L'identité est portée par `sessionFile` SEUL. Motif mesuré : un même run
// apparaît dans `running/` PUIS dans `history/` avec deux `id` DIFFÉRENTS
// (`reconcileStore` réécrit `id = historyIdFor(cwd, endedAt)`) ; c'est la session
// qui fait l'objet d'une visionneuse, pas l'entrée du magasin. La valeur est
// poussée dans la pile de la section Sessions (`ConsoleModel.sessionsPath`,
// `navigationDestination(for:)`), d'où `Hashable`.

import Foundation

/// La session poussée dans la section Sessions.
struct ViewerTarget: Hashable, Codable, Sendable {
    var sessionFile: String
    /// Le titre de la fenêtre : le nom de la feature, jamais un identifiant de
    /// session (audit HIG 2026-10-01). Figé à l'ouverture : il ne participe ni à
    /// l'égalité ni au hachage, donc renommer un run ne change pas l'identité de
    /// sa fenêtre.
    var title: String
    /// Le sous-titre de la fenêtre (« <étape> · <dépôt> »). Hors égalité et
    /// hachage comme `title` ; optionnel au décodage : une valeur restaurée sans la
    /// clé reste lisible.
    var subtitle: String? = nil

    static func == (lhs: ViewerTarget, rhs: ViewerTarget) -> Bool {
        lhs.sessionFile == rhs.sessionFile
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(sessionFile)
    }
}

/// Une étiquette courte et stable pour une session, tirée de son nom de fichier :
/// l'identifiant de session, pas la date. `2026-09-28T15-07-55-136Z_01a0e88e-….jsonl`
/// rend `01a0e88e`. Identité interne (identifiants d'accessibilité) : jamais un
/// texte affiché.
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
