// Le vocabulaire TRANSITOIRE de l'app iOS : les textes propres à cette coque et
// qui ne dureront pas. Il vit ici, dans l'app, et n'entre jamais dans le noyau
// partagé `ConsoleCore` — celui-ci ne porte que le vocabulaire DURABLE des deux
// coques (libellés de section, états vides, par exemple).
//
// Fichier de VOCABULAIRE de l'app (`*Text.swift`), comme `ConnectionText.swift` :
// la garde `design-ios/AC-5` (`test/design-ios.test.ts`) n'autorise un littéral
// alphabétique que dans ces fichiers-là, un identifiant technique (`"ios."`,
// `"-"`, un nom de symbole SF) — tout libellé en dur dans une vue fait rougir la
// garde.

enum IOSText {
    /// Le message du bandeau d'erreur, quand l'écran est ouvert par le crochet de
    /// recette `-ios.state error` (S-3).
    static let recipeError = "Impossible de lire les données de cet écran."
}
