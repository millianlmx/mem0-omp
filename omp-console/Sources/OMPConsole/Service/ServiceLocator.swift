// Localisation du service OMP (S-10, Doc-4) : l'app lit l'enregistrement que le
// service a publié dans `<état>/service.json`, vérifie que son pid vit, et rend
// l'URL de base de l'API et le jeton — ou une erreur typée « service arrêté ».
//
// L'app ne lance JAMAIS de process `omp` : ce fichier ne fait que lire un
// enregistrement et tester la vivacité d'un pid. La forme du fichier est figée
// par `omp-mem0-req/serviceState.ts` (version=1, pid, port, token 32 hex,
// startedAt, stateDir, sessionFile) ; ce qui n'y répond pas est ignoré comme un
// fichier absent.

import ConsoleCore
import Darwin
import Foundation

/// L'échec de localisation, en liste close : le service n'est pas là.
enum ServiceUnavailable: UserFacingError, Equatable, Sendable {
    case stopped

    /// L'unique texte affiché pour un service absent (S-10) : les trois surfaces
    /// le montrent tel quel.
    var userMessage: String { "service arrêté" }
}

/// L'endpoint d'un service vivant : tout ce qu'il faut à un client.
struct ServiceEndpoint: Equatable, Sendable {
    let baseURL: URL
    let token: String
    let pid: Int32
    let port: Int
    /// Le magasin d'état DU SERVICE (il peut différer de celui de l'app).
    let stateDir: String
}

enum ServiceLocator {
    /// Le nom du fichier d'enregistrement, dans le magasin d'état (`SERVICE_FILE`).
    static let fileName = "service.json"

    /// La version de forme connue : une autre valeur n'est jamais lue.
    static let version = 1

    /// `MEM0_PIPELINE_STATE_DIR` (défaut `~/.omp/agent/pipeline`) : MÊME règle que
    /// le magasin que l'app lit déjà (`PipelineStore.stateDir`).
    static func stateDir(
        env: [String: String] = ProcessInfo.processInfo.environment,
        home: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) -> String {
        PipelineStore.stateDir(env: env, home: home)
    }

    /// Le chemin de l'enregistrement dans une racine d'état.
    static func filePath(stateDir: String) -> String {
        joinPath(stateDir, fileName)
    }

    /// L'endpoint VIVANT du service, ou `nil`. `nil` couvre : fichier absent,
    /// illisible, hors schéma, version inconnue, port invalide, pid mort.
    static func endpoint(
        stateDir: String = ServiceLocator.stateDir(),
        alive: (Int32) -> Bool = { kill($0, 0) == 0 }
    ) -> ServiceEndpoint? {
        guard let data = FileManager.default.contents(atPath: filePath(stateDir: stateDir)) else { return nil }
        guard let json = JSONValue.parse(data), case .object(let object) = json else { return nil }
        return asEndpoint(object, alive: alive)
    }

    /// L'endpoint, ou l'erreur typée `ServiceUnavailable` (S-10).
    static func locate(
        stateDir: String = ServiceLocator.stateDir(),
        alive: (Int32) -> Bool = { kill($0, 0) == 0 }
    ) throws -> ServiceEndpoint {
        guard let endpoint = endpoint(stateDir: stateDir, alive: alive) else {
            throw ServiceUnavailable.stopped
        }
        return endpoint
    }

    /// La forme EXACTE d'un enregistrement : un champ obligatoire manquant ou mal
    /// typé rend `nil`, jamais une valeur devinée.
    static func asEndpoint(_ object: [String: JSONValue], alive: (Int32) -> Bool) -> ServiceEndpoint? {
        guard case .number(let version)? = object["version"], Int(version) == Self.version else { return nil }
        guard let pidValue = object["pid"]?.numberValue, pidValue > 0, pidValue < Double(Int32.max) else { return nil }
        let pid = Int32(pidValue)
        guard alive(pid) else { return nil }
        guard let portValue = object["port"]?.numberValue, portValue >= 1, portValue <= 65535 else { return nil }
        let port = Int(portValue)
        guard let token = object["token"]?.stringValue, isToken(token) else { return nil }
        guard let stateDir = object["stateDir"]?.stringValue, stateDir.hasPrefix("/") else { return nil }
        guard let url = URL(string: "http://127.0.0.1:\(port)/v1") else { return nil }
        return ServiceEndpoint(baseURL: url, token: token, pid: pid, port: port, stateDir: stateDir)
    }

    /// Un jeton : 32 hexadécimaux (16 octets d'aléa, `newServiceToken` de
    /// serviceState.ts).
    static func isToken(_ value: String) -> Bool {
        value.count == 32 && value.allSatisfy { $0.isHexDigit }
    }
}
