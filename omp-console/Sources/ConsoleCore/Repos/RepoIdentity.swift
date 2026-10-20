// L'identité d'un dépôt (S-5 de orchestrator-living-in-a-vps) : l'URL de son
// `origin` ramenée à `github.com/<propriétaire>/<nom>`, en minuscules, sans `.git`.
// C'est ce qui permet de reconnaître LE MÊME dépôt sur le Mac et sur le VPS,
// dont les chemins diffèrent.
//
// Miroir EXACT de `normalizeRepoIdentity` (omp-mem0-req/handover.ts) : les deux
// lisent les mêmes vecteurs, `test/fixtures/repo-identity.json`.

import Foundation

public enum RepoIdentity {
    /// `nil` quand l'URL n'est pas une adresse GitHub reconnue (autre hôte, chemin
    /// local, forme inconnue, nom vide ou `.`/`..`).
    public static func normalize(_ url: String) -> String? {
        var text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasSuffix("/") { text.removeLast() }
        guard let (owner, rawName) = split(text) else { return nil }
        var name = rawName
        if name.lowercased().hasSuffix(".git") { name.removeLast(4) }
        guard isPart(owner), isPart(name), name != ".", name != ".." else { return nil }
        return "github.com/\(owner)/\(name)".lowercased()
    }

    /// Le dernier segment de l'identité : le nom d'affichage d'un dépôt.
    public static func shortName(_ identity: String) -> String {
        identity.split(separator: "/").last.map(String.init) ?? identity
    }

    /// `(propriétaire, nom)` selon l'une des trois formes admises ; `nil` sinon.
    /// Le propriétaire et le nom ne contiennent ni `/`, ni `:`, ni espace, ni `@`
    /// (forme HTTPS : pas d'identifiants dans l'URL).
    private static func split(_ text: String) -> (String, String)? {
        let forms: [(prefix: String, forbidden: Set<Character>)] = [
            ("git@github.com:", ["/", ":"]),
            ("https://github.com/", ["/", ":", "@"]),
            ("ssh://git@github.com/", ["/", ":"]),
        ]
        for form in forms {
            guard text.lowercased().hasPrefix(form.prefix) else { continue }
            let rest = text.dropFirst(form.prefix.count)
            let parts = rest.split(separator: "/", omittingEmptySubsequences: false)
            guard parts.count == 2 else { return nil }
            let forbidden = form.forbidden.union([" ", "\t", "\n", "\r"])
            for part in parts where part.isEmpty || part.contains(where: { forbidden.contains($0) }) { return nil }
            return (String(parts[0]), String(parts[1]))
        }
        return nil
    }

    private static func isPart(_ part: String) -> Bool {
        !part.isEmpty && part.unicodeScalars.allSatisfy {
            ($0.value >= 48 && $0.value <= 57) || ($0.value >= 65 && $0.value <= 90)
                || ($0.value >= 97 && $0.value <= 122) || $0 == "_" || $0 == "." || $0 == "-"
        }
    }
}
