// La lecture d'une variable d'environnement renommée (S-6) : le nouveau nom s'il
// est posé et non vide, sinon l'ancien nom (gardé pendant la version de
// transition) s'il est posé et non vide, sinon rien — le défaut du lecteur
// s'applique. Une variable posée mais VIDE est traitée comme absente.
//
// Même règle que `renamedEnv` des plugins TypeScript et que `lire_renomme` du
// service Rust : chaque lecture d'une variable renommée passe par ici.

public enum RenamedEnvironment {
    /// `environment[name]` s'il est non vide, sinon `environment[legacy]` s'il est
    /// non vide, sinon `nil`.
    public static func value(_ environment: [String: String], _ name: String, legacy: String) -> String? {
        if let current = environment[name], !current.isEmpty { return current }
        if let previous = environment[legacy], !previous.isEmpty { return previous }
        return nil
    }
}
