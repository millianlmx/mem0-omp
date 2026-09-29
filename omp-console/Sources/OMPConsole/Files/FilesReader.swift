// Lecture du contenu d'un fichier de la cible, en LECTURE SEULE (S-5).
//
// Aucune API d'écriture n'est appelée : `Data(contentsOf:)` ouvre, lit et ferme —
// la date de modification et les octets du fichier sont inchangés. C'est ce que
// vérifie `FilesReadOnlyTests` sur une empreinte complète de la cible.

import Foundation

enum FilesContent: Sendable, Equatable {
    /// EXACTEMENT les octets du fichier décodés en UTF-8 (aucune troncature, aucune
    /// normalisation, aucune numérotation ajoutée).
    case text(String)
    case binary(bytes: Int)
    /// Le chemin n'existe pas sur le disque.
    case missing
    /// Erreur système (droits, EACCES, …) : le message est celui du système.
    case unreadable(String)
}

enum FilesReader {
    /// La fenêtre de détection d'un fichier binaire : un octet NUL dans les
    /// 8 192 premiers suffit à trancher sans lire un fichier de plusieurs Go.
    static let binaryProbeBytes = 8192

    static func read(path: String, fileManager: FileManager) -> FilesContent {
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return .missing
        }
        do {
            return classify(try Data(contentsOf: URL(fileURLWithPath: path)))
        } catch {
            return .unreadable(error.localizedDescription)
        }
    }

    /// Textuel = aucun NUL dans les 8 192 premiers octets ET décodage UTF-8 STRICT
    /// du fichier entier (une séquence invalide rend `nil`, jamais un remplacement
    /// silencieux).
    static func classify(_ data: Data) -> FilesContent {
        if data.prefix(binaryProbeBytes).contains(0) {
            return .binary(bytes: data.count)
        }
        guard let text = String(data: data, encoding: .utf8) else {
            return .binary(bytes: data.count)
        }
        return .text(text)
    }
}
