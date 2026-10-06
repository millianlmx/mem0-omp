// Ce que la coque garde des textes de la feuille Contrat : le sous-titre (qui
// nomme `ContractMoment`) et le message de fichier absent (qui nomme
// `FilesModel.contractRelativePath`). Les autres messages vivent dans
// `ConsoleCore/Contract/ContractText.swift`.
//
// `missingFile` est un accesseur CALCULÉ : une extension ne peut pas porter de
// propriété stockée (D4). Le texte rendu est identique.

import ConsoleCore

extension ContractText {
    /// Ce qui est à valider, dans les mots des sections requises (S-2) : la liste
    /// des titres vient de `ContractDocument.titles(for:)`, jamais d'un second
    /// littéral.
    static func subtitle(_ moment: ContractMoment) -> String {
        "À valider : \(ContractDocument.titles(for: moment).joined(separator: " et "))."
    }

    /// Fichier absent : le chemin relatif vient de `FilesModel`, jamais d'un
    /// second littéral.
    static var missingFile: String {
        "Aucun contrat pour cette feature : le fichier `\(FilesModel.contractRelativePath)` n'existe pas encore."
    }
}
