// Le registre persisté des évènements déjà notifiés (BR-2, S-7).
//
// Un seul fichier JSON, relu au démarrage et réécrit à chaque clé neuve : c'est lui
// qui garantit « au plus une notification par évènement », y compris après relance
// de l'app (AC-5). Aucune purge, aucun TTL : une clé ne revient jamais.
//
// La lecture est TOLÉRANTE borne par borne (patron `StoreModels.swift`) : un fichier
// absent, illisible, non JSON, d'une autre version ou au champ `notified` mal typé
// vaut un registre VIDE — jamais une exception remontée à l'utilisateur.

import Foundation

struct AlertLedger: Sendable {
    /// Le nom de fichier FIXE du registre (S-7).
    static let fileName = "notified-alerts.json"

    let path: String
    /// Les clés déjà notifiées, et l'instant de leur notification. Seules les CLÉS
    /// font foi.
    private(set) var notified: [String: Double]

    init(path: String) {
        self.path = path
        self.notified = AlertLedger.load(path: path)
    }

    /// L'emplacement par défaut : `MEM0_CONSOLE_ALERTS_DIR` quand la variable porte un
    /// chemin exploitable (`~` développé, chemin ABSOLU retenu, même règle que
    /// `PipelineStore.stateDir`), sinon `~/Library/Application Support/com.omp.console/`.
    /// Un chemin relatif est ignoré — il dépendrait du cwd.
    static func defaultPath(
        env: [String: String] = ProcessInfo.processInfo.environment,
        home: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) -> String {
        let raw = (env["MEM0_CONSOLE_ALERTS_DIR"] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let directory: String
        if raw == "~" {
            directory = home
        } else if raw.hasPrefix("~/") {
            directory = joinPath(home, String(raw.dropFirst(2)))
        } else if raw.hasPrefix("/") {
            directory = raw
        } else {
            directory = joinPath(home, "Library/Application Support/com.omp.console")
        }
        return joinPath(directory, fileName)
    }

    func contains(_ key: String) -> Bool {
        notified[key] != nil
    }

    /// Ajoute les clés ABSENTES seulement (une clé déjà connue garde son instant) et
    /// rend `true` si AU MOINS UNE clé est neuve — la seule condition d'écriture.
    @discardableResult
    mutating func record(keys: [String], nowMs: Double) -> Bool {
        var changed = false
        for key in keys where notified[key] == nil {
            notified[key] = nowMs.isFinite ? nowMs : 0
            changed = true
        }
        return changed
    }

    /// Réécrit le registre COMPLET, atomiquement ; le répertoire est créé s'il
    /// manque. Rend `false` si l'écriture a échoué — l'échec est silencieux pour
    /// l'utilisateur (une notification en double à la relance est préférable à une
    /// app cassée) mais rendu à l'appelant.
    @discardableResult
    func save() -> Bool {
        let directory = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
        let object: [String: Any] = ["version": 1, "notified": notified]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return false
        }
        do {
            try data.write(to: URL(fileURLWithPath: path), options: [.atomic])
            return true
        } catch {
            return false
        }
    }

    /// Lecture tolérante : tout ce qui n'est pas `{"version":1,"notified":{…}}` vaut
    /// un registre vide. Une valeur non finie vaut 0.
    static func load(path: String) -> [String: Double] {
        guard let data = FileManager.default.contents(atPath: path),
              let root = JSONValue.parse(data),
              case .object(let object) = root,
              isVersion1(object["version"]),
              case .object(let notified)? = object["notified"] else {
            return [:]
        }
        var result: [String: Double] = [:]
        for (key, value) in notified {
            result[key] = asNumber(value) ?? 0
        }
        return result
    }
}
