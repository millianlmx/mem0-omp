// Preuves de la langue des écrans (feature localisation-apps) : une clé se lit en
// anglais dans la table anglaise, en français par défaut ; la langue suit le bundle
// principal seulement s'il se déclare localisé ; les formateurs suivent la langue.
// La garde node `test/console/localisation-apps.test.ts` prouve, elle, que chaque
// clé des sources a sa traduction.

import Foundation
import Testing
@testable import ConsoleCore

@Test("localisation-apps : une clé se lit en anglais dans la table anglaise, telle quelle en français")
func keyResolvesInEnglishAndFrench() {
    #expect(L10n.text("Tous les projets", language: "en") == "All Projects")
    #expect(L10n.text("Tous les projets", language: "fr") == "Tous les projets")
    #expect(L10n.format("Lu à %@", arguments: ["14:05"], language: "en") == "Read at 14:05")
    #expect(L10n.format("Lu à %@", arguments: ["14:05"], language: "fr") == "Lu à 14:05")
    #expect(L10n.format("%lld fichiers", arguments: [3], language: "en") == "3 files")
    // Une clé inconnue de la table se rend telle quelle, jamais vide.
    #expect(L10n.text("Clé absente de la table", language: "en") == "Clé absente de la table")
}

@Test("localisation-apps : le bundle de ressources de ConsoleCore porte la table anglaise, et le français n'en a pas")
func englishTableShipsInTheResourceBundle() {
    #expect(L10n.table("en") != nil)
    #expect(L10n.table("fr") == nil)
}

@Test("localisation-apps : la langue suit le bundle principal s'il se déclare localisé, le français sinon")
func languageFollowsADeclaredHost() {
    #expect(L10n.resolvedLanguage(declared: ["fr", "en"], preferred: ["en-GB", "fr"]) == "en")
    #expect(L10n.resolvedLanguage(declared: ["fr", "en"], preferred: ["fr-CA", "en"]) == "fr")
    #expect(L10n.resolvedLanguage(declared: ["fr", "en"], preferred: ["de", "en"]) == "en")
    #expect(L10n.resolvedLanguage(declared: ["fr", "en"], preferred: ["de"]) == "fr")
    // Un hôte qui ne se déclare pas localisé (lanceur de tests, outil) parle français.
    #expect(L10n.resolvedLanguage(declared: [], preferred: ["en"]) == "fr")
    #expect(L10n.resolvedLanguage(declared: ["en"], preferred: ["en"]) == "fr")
    #expect(L10n.languageCode("en_US") == "en")
    #expect(L10n.languageCode("fr-FR") == "fr")
    #expect(L10n.languageCode("Base") == "base")
}

@Test("localisation-apps : le lanceur de la suite parle français, la langue de développement que les autres tests figent")
func testHostSpeaksFrench() {
    #expect(L10n.language == "fr")
    #expect(ConsoleFormat.locale.identifier == "fr_FR")
    #expect(MemoryText.allProjects == "Tous les projets")
}

@Test("localisation-apps : les formateurs suivent la langue — fr_FR en français, la locale anglaise de l'appareil en anglais")
func formatLocaleFollowsTheLanguage() {
    let us = Locale(identifier: "en_US")
    let gb = Locale(identifier: "en_GB")
    let france = Locale(identifier: "fr_FR")
    #expect(ConsoleFormat.formatLocale(for: "fr", current: us).identifier == "fr_FR")
    #expect(ConsoleFormat.formatLocale(for: "fr", current: Locale(identifier: "fr_CA")).identifier == "fr_FR")
    #expect(ConsoleFormat.formatLocale(for: "en", current: gb).identifier == "en_GB")
    #expect(ConsoleFormat.formatLocale(for: "en", current: france).identifier == "en_US")
}

@Test("localisation-apps : un compte prend le pluriel anglais — 0 au pluriel, 1 seul au singulier")
func countUsesTheLanguagePlural() {
    #expect(ConsoleFormat.count(0, "memory", "memories", language: "en") == "0 memories")
    #expect(ConsoleFormat.count(1, "memory", "memories", language: "en") == "1 memory")
    #expect(ConsoleFormat.count(2, "memory", "memories", language: "en") == "2 memories")
    #expect(ConsoleFormat.count(0, "souvenir", "souvenirs", language: "fr") == "0 souvenir")
    #expect(ConsoleFormat.takesSingular(1, language: "en"))
    #expect(!ConsoleFormat.takesSingular(0, language: "en"))
    #expect(ConsoleFormat.takesSingular(0, language: "fr"))
}
