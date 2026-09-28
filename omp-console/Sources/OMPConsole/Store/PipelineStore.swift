// Racine du magasin d'état partagé et noms de ses six répertoires (S-1).
//
// Parité avec `pipelineStateDir` (omp-mem0-req/store.ts:126-136) : la racine est
// résolue UNE fois pour la session, et le nom du répertoire d'un store EST son
// `rawValue` — une seconde liste de noms finirait par diverger de celle-ci.
//
// La couche est un LECTEUR (B-10, S-10) : ce fichier ne contient aucune API
// d'écriture et n'en contiendra pas.

import Foundation

/// Les six répertoires du magasin d'état. `commands/` est HORS PÉRIMÈTRE (specs) :
/// il ne fait pas partie du magasin lu par la salle de contrôle.
enum PipelineStore: String, CaseIterable, Sendable {
    case running
    case history
    case lots
    case projects
    case inbox
    case audit

    /// Bornes d'une passe de lecture (parité `RUNNING_READ_LIMIT` /
    /// `HISTORY_READ_LIMIT`, store.ts:107-109) : au-delà, la lecture synchrone
    /// coûterait un rafraîchissement par seconde sans rien montrer de plus.
    static let runningReadLimit = 200
    static let historyReadLimit = 20

    /// Racine du magasin : `MEM0_PIPELINE_STATE_DIR` quand la variable porte un
    /// chemin exploitable (`~` développé, chemin ABSOLU retenu), sinon
    /// `<home>/.omp/agent/pipeline`. Un chemin RELATIF est ignoré — il dépendrait
    /// du cwd, donc de la session. Les deux entrées sont injectables (tests).
    static func stateDir(
        env: [String: String] = ProcessInfo.processInfo.environment,
        home: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) -> String {
        let raw = (env["MEM0_PIPELINE_STATE_DIR"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if raw == "~" { return home }
        if raw.hasPrefix("~/") { return joinPath(home, String(raw.dropFirst(2))) }
        if raw.hasPrefix("/") { return raw }
        return joinPath(home, ".omp/agent/pipeline")
    }

    /// Le répertoire d'un store dans une racine donnée.
    static func directory(_ store: PipelineStore, stateDir: String) -> String {
        joinPath(stateDir, store.rawValue)
    }
}

/// `path.join` de Node : le séparateur n'est jamais doublé, jamais absent.
func joinPath(_ base: String, _ name: String) -> String {
    if base.isEmpty { return name }
    return base.hasSuffix("/") ? base + name : base + "/" + name
}

/// Seuil UNIQUE de péremption (S-7) : `5 × LOT_TICK_MS` (`LOT_TICK_MS = 2000`,
/// lot.ts:985-994), la valeur que le dépôt donne aussi à `AUDIT_RELAY_STALE_MS`
/// (lot.ts:997). Un seul nom côté Swift : aucune entrée ne doit battre avec son
/// propre seuil, sinon un lot et son relais se périmeraient à des instants
/// différents alors que le dépôt les fait battre ensemble.
let lotOwnerStaleMs: Double = 10_000
