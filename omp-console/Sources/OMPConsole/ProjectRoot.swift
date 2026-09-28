// Le projet ouvert de l'app, résolu en UN seul endroit (S-1).
//
// La fenêtre « Session OMP » et la visionneuse de fichiers parlent du même projet :
// elles partagent donc la même clé `UserDefaults` et la même règle de résolution.
// Deux implémentations divergeraient au premier changement de règle — celle-ci est
// désormais l'unique.
//
// La règle est celle, mesurée, de `SessionConsoleModel.restoredProjectRoot` : une
// clé PRÉSENTE mais invalide (dossier supprimé) rend `nil` et ne déclenche PAS le
// repli sur le cwd — l'utilisateur a choisi, ce choix n'est jamais réécrit tout
// seul.

import Foundation

enum ProjectRoot {
    /// Clé PARTAGÉE avec la fenêtre « Session OMP » (même préférence).
    static let defaultsKey = "session.projectRoot"

    /// `nil` quand aucun projet n'est résolu : ni par la préférence, ni par le cwd.
    static func resolve(defaults: UserDefaults, fileManager: FileManager) -> URL? {
        if let path = defaults.string(forKey: defaultsKey) {
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), isDirectory.boolValue else {
                return nil
            }
            return URL(fileURLWithPath: path)
        }
        let cwd = URL(fileURLWithPath: fileManager.currentDirectoryPath)
        var isDirectory: ObjCBool = false
        guard fileManager.fileExists(atPath: cwd.path, isDirectory: &isDirectory), isDirectory.boolValue else {
            return nil
        }
        // Un fichier `.git` (worktree lié) compte autant qu'un dossier `.git`.
        guard fileManager.fileExists(atPath: cwd.appendingPathComponent(".git").path) else { return nil }
        return cwd
    }
}
