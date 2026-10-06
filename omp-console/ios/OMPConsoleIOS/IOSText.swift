/// Le vocabulaire TRANSITOIRE de l'app iOS : les textes propres à cette coque et
/// qui ne dureront pas. Il vit ici, dans l'app, et n'entre jamais dans le noyau
/// partagé `ConsoleCore` — celui-ci ne porte que le vocabulaire DURABLE des deux
/// coques (libellés de section, par exemple).
enum IOSText {
    /// Le libellé d'attente des sept écrans, déclaré UNE seule fois dans tout le
    /// dépôt : les écrans d'attente le lisent, aucun ne le recopie.
    static let waiting = "Cet écran arrive dans un prochain segment."
}
