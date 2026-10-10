// L'empreinte des sources embarquées de la pile (S-7, BR-6).
//
// `mem0-stack/mem0-http/STACK_FINGERPRINT` est un fichier VERSIONNÉ, écrit par
// `scripts/stack-fingerprint.ts` (seul écrivain) à partir des quatre sources
// embarquées (Dockerfile, http_server.py, memory_config.py, test_api.py). L'app
// embarque ce fichier dans son bundle et en dérive l'étiquette de SON image :
// sources inchangées ⇒ même étiquette ⇒ aucune reconstruction ; source modifiée
// sans empreinte régénérée ⇒ le test `stack/AC-24` échoue.
//
// La lecture est TOLÉRANTE (convention `MemoryJSON`) : un contenu absent, vide ou
// manifestement trop court rend `nil`, et l'appelant refuse alors de construire
// une image dont il ne saurait pas prouver l'origine.

import Foundation

enum StackSources {
    /// Le nom du fichier d'empreinte, à la racine du contexte de build embarqué.
    static let fingerprintFileName = "STACK_FINGERPRINT"

    /// L'empreinte lue dans `<context>/STACK_FINGERPRINT`, `nil` si le fichier est
    /// absent, vide ou n'est pas au moins 12 caractères hexadécimaux (la norme est
    /// 64). La casse est normalisée en minuscules : l'étiquette d'image ne doit
    /// pas dépendre de la casse du fichier.
    static func embeddedFingerprint(context: URL) -> String? {
        let url = context.appendingPathComponent(fingerprintFileName)
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard value.count >= 12, value.allSatisfy({ $0.isASCII && $0.isHexDigit }) else { return nil }
        return value
    }

    /// L'étiquette de l'image construite depuis ces sources :
    /// `<repository>:<12 premiers caractères de l'empreinte>` — `nil` sans
    /// empreinte exploitable.
    static func embeddedTag(repository: String, context: URL) -> String? {
        guard let fingerprint = embeddedFingerprint(context: context) else { return nil }
        return "\(repository):\(fingerprint.prefix(12))"
    }
}
