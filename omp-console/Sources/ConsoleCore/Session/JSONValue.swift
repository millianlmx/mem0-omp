// La valeur JSON générique, extraite de `SessionModel.swift` : elle est le socle
// partagé entre le lecteur de sessions et les modèles du magasin d'état (qui la
// manipulent tous deux), donc elle vit dans `ConsoleCore`.

/// Valeur JSON générique. Les arguments d'un appel d'outil sont exposés tels
/// quels, en dictionnaire : `JSONSerialization` ne garantit aucun ordre de clés
/// (Doc-4), donc aucun ordre n'est promis ici — c'est le rendu qui trie.
public indirect enum JSONValue: Equatable, Sendable {
    case object([String: JSONValue])
    case array([JSONValue])
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
}
