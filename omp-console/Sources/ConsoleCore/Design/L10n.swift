// La langue des écrans (feature localisation-apps) : le français, langue de
// développement, ou l'anglais quand l'appareil le préfère.
//
// La CLÉ d'un texte est sa phrase française, écrite telle quelle dans le
// `*Text.swift` qui la porte : `L10n.text("Tous les projets")`. La traduction
// anglaise vit dans UNE table, `Resources/en.lproj/Localizable.strings`, ressource
// de cette cible — la seule que les deux apps embarquent, donc la seule dont le
// bundle se résout partout (app Mac, app iOS et son widget, suites de tests). Le
// français n'a pas de table : une clé absente se rend telle quelle.
//
// Pourquoi une table `.strings` et pas un String Catalog : SwiftPM ne compile un
// `.xcstrings` qu'avec `xcstringstool`, livré avec Xcode seul, et son moteur natif
// le copie sans le compiler. Une table `.strings` est lue par Foundation telle
// quelle, sous tous les moteurs et avec les seuls Command Line Tools.
//
// Pourquoi la langue est DÉCIDÉE ici plutôt que laissée au bundle : le choix
// implicite de Foundation suit les préférences du PROCESSUS, et un lanceur de tests
// (`swift test`) tourne dans la langue du poste — la suite, qui fige des phrases
// françaises, changerait de langue avec la machine de CI. La règle : la langue est
// celle que retient le bundle principal (`preferredLocalizations`, qui honore la
// langue choisie pour l'app dans les Réglages) SEULEMENT s'il se déclare localisé
// (`fr` parmi ses `localizations`, ce que font les deux apps par
// `CFBundleLocalizations`) ; tout autre hôte — lanceur de tests, outil en ligne de
// commande — parle français.

import Foundation

public enum L10n {
    /// Les langues livrées, la langue de développement d'abord.
    public static let supportedLanguages = ["fr", "en"]
    /// La langue de développement : celle des clés, et le repli de tout le reste.
    public static let developmentLanguage = "fr"

    /// La langue effective de ce processus, décidée une fois, au premier texte lu.
    public static let language: String = resolvedLanguage(
        declared: Bundle.main.localizations,
        preferred: Bundle.main.preferredLocalizations
    )

    /// La langue d'un hôte qui déclare `declared` et préfère, dans l'ordre,
    /// `preferred` : la première préférée qui est livrée, si l'hôte se déclare
    /// localisé (`fr` parmi `declared`) ; le français sinon.
    public static func resolvedLanguage(declared: [String], preferred: [String]) -> String {
        guard declared.contains(where: { languageCode($0) == developmentLanguage }) else {
            return developmentLanguage
        }
        for identifier in preferred {
            let code = languageCode(identifier)
            if supportedLanguages.contains(code) { return code }
        }
        return developmentLanguage
    }

    /// Le code de langue d'un identifiant de localisation : « en-GB » → « en »,
    /// « fr_FR » → « fr », « Base » → « base ».
    public static func languageCode(_ identifier: String) -> String {
        let head = identifier.split(whereSeparator: { $0 == "-" || $0 == "_" }).first
        return (head.map(String.init) ?? identifier).lowercased()
    }

    /// Le texte de `key` (sa phrase française) dans `language` ; la clé elle-même
    /// quand la langue n'a pas de table ou que la table ne la connaît pas.
    /// `StaticString` : une clé est toujours un littéral, que la garde node
    /// `localisation-apps` retrouve dans les sources et dans la table.
    public static func text(_ key: StaticString, language: String = L10n.language) -> String {
        lookup(key.description, language: language)
    }

    /// Une phrase à trous : la clé porte des spécificateurs `%@` (texte) et `%lld`
    /// (entier), dans le même ordre que `arguments` ; une traduction peut les
    /// réordonner (`%2$@`).
    public static func format(_ key: StaticString, _ arguments: CVarArg...) -> String {
        format(key, arguments: arguments, language: L10n.language)
    }

    /// `format(_:_:)` dans une langue donnée.
    public static func format(_ key: StaticString, arguments: [CVarArg], language: String) -> String {
        String(
            format: lookup(key.description, language: language),
            locale: ConsoleFormat.formatLocale(for: language),
            arguments: arguments
        )
    }

    /// La table `<language>.lproj` du bundle de ressources de `ConsoleCore`.
    static func table(_ language: String) -> Bundle? {
        guard language != developmentLanguage,
              let url = Bundle.module.url(forResource: language, withExtension: "lproj") else { return nil }
        return Bundle(url: url)
    }

    private static func lookup(_ key: String, language: String) -> String {
        guard let table = table(language) else { return key }
        return table.localizedString(forKey: key, value: key, table: nil)
    }
}
