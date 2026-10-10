// L'identité d'UNE installation (S-4, BR-4) : un jeton aléatoire, tiré une fois,
// que l'app garde chez elle (`<stackRoot>/installation-token`, 0600) et qu'elle
// donne à SA pile (variable `OMP_INSTALLATION_TOKEN` du conteneur mem0-http). Le
// service le rend de façon ADDITIVE dans `/health` ; la sonde de l'app n'accepte
// comme « sa » pile qu'une réponse qui le porte.
//
// Sans ce jeton, un `200` nu sur 127.0.0.1:8321 suffisait : une autre pile (celle
// de `mem0-stack/`, un conteneur homonyme, n'importe quel service) passait pour la
// nôtre — c'est le bogue que B-4 nomme.
//
// L'écriture suit EXACTEMENT le patron de `StackEnvStore.write` (atomique, puis
// 0600) ; un fichier présent et conforme n'est JAMAIS réécrit, donc aucun
// conteneur n'est recréé sans raison.

import Foundation

enum InstallationTokenStore {
    /// Le nom du fichier sous `<stackRoot>` (`AppPaths.installationToken`).
    static let fileName = "installation-token"

    /// Un jeton valide : 64 caractères hexadécimaux MINUSCULES (32 octets).
    static func isValid(_ value: String) -> Bool {
        value.count == 64 && value.allSatisfy { character in
            character.isASCII && character.isHexDigit && !character.isUppercase
        }
    }

    /// Le jeton du fichier, `nil` s'il est absent, illisible ou non conforme.
    static func load(at url: URL) -> String? {
        guard let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .utf8)
        else { return nil }
        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return isValid(value) ? value : nil
    }

    /// Le jeton du fichier, ou un jeton neuf écrit en 0600. Le fichier est créé
    /// (dossier compris) au besoin ; un échec d'écriture est remonté — la
    /// préparation le traduit en `MemoryStackError.installationFailed` et
    /// n'émet AUCUNE commande de conteneur.
    static func loadOrCreate(at url: URL, fileManager: FileManager = .default) throws -> String {
        if let existing = load(at: url) { return existing }
        let token = generate()
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data((token + "\n").utf8).write(to: url, options: [.atomic])
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        return token
    }

    /// 32 octets du CSPRNG système (`SystemRandomNumberGenerator` est
    /// cryptographiquement sûr sur les plateformes Apple), en hexadécimal
    /// minuscule.
    static func generate() -> String {
        var generator = SystemRandomNumberGenerator()
        var bytes = [UInt8]()
        bytes.reserveCapacity(32)
        for _ in 0..<32 {
            bytes.append(UInt8.random(in: UInt8.min...UInt8.max, using: &generator))
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
