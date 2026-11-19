// Le code d'appairage du serveur de pipelines (`harness.sh pair`) et le réglage
// partagé `~/.omp/harness.json` : les mêmes que lit le plugin `omp-mem0-req`
// (`decodePairing`, `resolveTarget`), pour qu'une seule saisie relie tout.

import Foundation

/// `omp1:` puis, en base64url, quatre lignes : l'adresse du harness, son jeton,
/// l'adresse de la mémoire partagée et son jeton (ces deux dernières vides quand
/// le serveur n'en publie pas). Le code APPROBATEUR (`harness.sh approver`) porte
/// une 5e ligne : le jeton approbateur, le seul qui approuve, refuse ou règle le poste.
public struct HarnessPairing: Equatable, Sendable {
    public var address: String
    /// Le jeton ORDINAIRE (ligne 2) : celui que lisent omp et l'extension.
    public var token: String
    public var memoryAddress: String
    public var memoryToken: String
    /// Le jeton approbateur (ligne 5), `nil` pour un code ordinaire. Il ne quitte jamais
    /// le trousseau de l'app : `writeShared` ne l'écrit pas.
    public var approverToken: String?

    public static let prefix = "omp1:"

    /// Le jeton des appels de l'app : l'approbateur quand le code en porte un.
    public var appToken: String { approverToken ?? token }

    /// Le code décodé, ou `nil` si le texte n'en est pas un.
    public static func decode(_ raw: String) -> HarnessPairing? {
        let text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(prefix) else { return nil }
        var payload = String(text.dropFirst(prefix.count))
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while payload.count % 4 != 0 { payload.append("=") }
        guard let data = Data(base64Encoded: payload), let decoded = String(data: data, encoding: .utf8) else { return nil }
        let lines = decoded.components(separatedBy: "\n")
        let field = { (index: Int) in index < lines.count ? lines[index] : "" }
        guard let address = HarnessModel.normalizedAddress(field(0)), !field(1).isEmpty, !field(1).contains(" ") else { return nil }
        let approver = field(4)
        guard !approver.contains(" ") else { return nil }
        return HarnessPairing(
            address: address, token: field(1), memoryAddress: field(2), memoryToken: field(3),
            approverToken: approver.isEmpty ? nil : approver
        )
    }

    /// `~/.omp/harness.json` (`{ "url", "token" }`), écrit par `/pair` ou `harness.sh
    /// connect` : le serveur de cette machine quand l'app n'en a pas enregistré.
    public static func sharedSettings(home: URL) -> (address: String, token: String)? {
        let file = home.appendingPathComponent(".omp/harness.json")
        guard let data = try? Data(contentsOf: file),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let url = object["url"] as? String, let address = HarnessModel.normalizedAddress(url),
              let token = object["token"] as? String, !token.isEmpty
        else { return nil }
        return (address, token)
    }

    /// Écrit l'appairage là où le lisent les plugins d'omp et l'app (comme `/pair`) :
    /// `~/.omp/harness.json`, dont les correspondances `repos` sont gardées, et
    /// `~/.omp/mem0.json` quand le code porte une mémoire. En 0600. Le jeton écrit est
    /// TOUJOURS l'ordinaire : toute session omp lit ce fichier, l'approbateur n'y entre pas.
    public func writeShared(home: URL) throws {
        let directory = home.appendingPathComponent(".omp", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let harnessFile = directory.appendingPathComponent("harness.json")
        var harness = (try? Data(contentsOf: harnessFile))
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        harness["url"] = address
        harness["token"] = token
        try Self.writePrivate(harness, to: harnessFile)
        if !memoryAddress.isEmpty {
            try Self.writePrivate(["url": memoryAddress, "token": memoryToken], to: directory.appendingPathComponent("mem0.json"))
        }
    }

    private static func writePrivate(_ object: [String: Any], to file: URL) throws {
        var data = try JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        data.append(0x0A)
        try data.write(to: file, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    }
}
