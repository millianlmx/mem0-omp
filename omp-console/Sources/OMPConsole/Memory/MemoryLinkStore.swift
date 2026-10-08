// Les liens MANUELS entre souvenirs (S-11) : un artefact de la vue, persisté dans
// un fichier local — jamais écrit dans mem0, donc jamais visible des agents.
//
// La lecture est TOLÉRANTE borne par borne (patron `AlertLedger`) : un fichier
// absent, illisible, non JSON, d'une autre version ou dont une entrée est mal
// typée vaut un ensemble VIDE (ou amputé de ses seules entrées invalides) — jamais
// une exception remontée à l'utilisateur, jamais un lien inventé.
//
// L'écriture est ATOMIQUE (`.atomic`) : un arrêt en pleine écriture ne peut pas
// laisser un fichier tronqué, donc jamais une perte silencieuse des liens déjà
// enregistrés.

import ConsoleCore
import Foundation

// `MemoryLink` vit désormais dans `ConsoleCore` (`MemoryGraphFacts.swift`) : l'app
// iOS en a besoin, et ne lie pas cette cible. Ce fichier garde le MAGASIN disque.

enum MemoryLinkStore {
    /// Le nom de fichier FIXE du registre (S-11), sous la racine de support.
    static let fileName = "memory-links.json"
    /// La version du format ; une autre version vaut un registre vide.
    static let version = 1

    /// La forme canonique d'une paire : `nil` si les deux extrémités sont le même
    /// souvenir, ou si l'une d'elles est vide (un id vide ne désigne aucun
    /// souvenir, donc un tel lien ne serait jamais dessiné).
    static func normalized(_ one: String, _ other: String) -> MemoryLink? {
        let left = one.trimmingCharacters(in: .whitespacesAndNewlines)
        let right = other.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !left.isEmpty, !right.isEmpty, left != right else { return nil }
        return left < right ? MemoryLink(a: left, b: right) : MemoryLink(a: right, b: left)
    }

    /// Les liens d'un fichier, dans l'ordre du fichier ; absent ou invalide ⇒ vide.
    static func load(_ url: URL) -> Set<MemoryLink> {
        guard let data = try? Data(contentsOf: url),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              (root["version"] as? Int) == version,
              let entries = root["links"] as? [Any] else {
            return []
        }
        var links: Set<MemoryLink> = []
        for entry in entries {
            guard let object = entry as? [String: Any],
                  let a = object["a"] as? String,
                  let b = object["b"] as? String,
                  let link = normalized(a, b) else { continue }
            links.insert(link)
        }
        return links
    }

    /// Réécrit le registre COMPLET, atomiquement ; le répertoire est créé s'il
    /// manque. Rend `false` si l'écriture a échoué — la fiche le dit alors à
    /// l'utilisateur, jamais un silence.
    @discardableResult
    static func save(_ links: Set<MemoryLink>, to url: URL) -> Bool {
        let directory = url.deletingLastPathComponent()
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let object: [String: Any] = [
            "version": version,
            "links": links.sorted().map { ["a": $0.a, "b": $0.b] },
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .prettyPrinted]) else {
            return false
        }
        do {
            try data.write(to: url, options: [.atomic])
            return true
        } catch {
            return false
        }
    }

    /// Les liens dont les DEUX extrémités existent encore : un lien orphelin (un
    /// souvenir supprimé, par l'app ou par un agent) ne survit pas au rechargement.
    static func prune(_ links: Set<MemoryLink>, keeping ids: Set<String>) -> Set<MemoryLink> {
        links.filter { ids.contains($0.a) && ids.contains($0.b) }
    }
}
