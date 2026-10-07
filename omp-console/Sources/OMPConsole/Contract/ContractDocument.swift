// La LECTURE DISQUE du contrat, côté coque macOS (S-3) : le socle pur vit dans
// `ConsoleCore/Contract/ContractDocument.swift` ; ne restent ici que la lecture du
// fichier et sa traduction pour la feuille.
//
// `FilesReader` est un adaptateur au système de fichiers LOCAL, absent d'iOS : il
// reste donc déclaré par la coque.

import ConsoleCore
import Foundation

extension ContractDocument {
    /// La lecture du contrat, traduite pour la feuille (S-3) : une entrée par
    /// titre requis de `titles(for:)`, présente ou non. Aucune borne de taille —
    /// un contrat de plus de 100 000 caractères est lu et rendu en entier.
    static func read(path: String, moment: ContractMoment, fileManager: FileManager) -> ContractContent {
        switch FilesReader.read(path: path, fileManager: fileManager) {
        case .text(let markdown):
            return content(markdown: markdown, moment: moment)
        case .missing:
            return .missing
        case .binary(let bytes):
            return .unreadable(.notText(bytes: bytes))
        case .unreadable(let reason):
            return .unreadable(.error(reason))
        }
    }
}
