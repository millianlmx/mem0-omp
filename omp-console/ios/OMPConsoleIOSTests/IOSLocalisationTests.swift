import ConsoleCore
import Foundation
import Testing

/// Les faits du bundle CONSTRUIT : les tests sont hébergés par l'app (`TEST_HOST`),
/// donc `Bundle.main` est le `.app` lui-même, avec son Info.plist généré. Ils
/// échouent si le réglage du projet (`developmentRegion`, `CFBundleLocalizations`,
/// `INFOPLIST_KEY_CFBundleDisplayName`) régresse, quel que soit le texte du
/// pbxproj.
@Suite("localisation-apps — langue et nom du bundle iOS")
struct IOSLocalisationTests {
    @Test("localisation-apps — le bundle iOS est localisé : région de développement fr, localisations fr et en, l'anglais choisi sur un appareil réglé en anglais (appui de AC-4)")
    func appIsLocalizedInEnglish() {
        let bundle = Bundle.main
        #expect(bundle.developmentLocalization == "fr")
        #expect(bundle.object(forInfoDictionaryKey: "CFBundleDevelopmentRegion") as? String == "fr")
        #expect(bundle.localizations.contains("fr"))
        #expect(bundle.localizations.contains("en"))
        #expect(Bundle.preferredLocalizations(from: bundle.localizations, forPreferences: ["en-US", "en"]).first == "en")
        #expect(Bundle.preferredLocalizations(from: bundle.localizations, forPreferences: ["fr-FR", "fr"]).first == "fr")
        #expect(L10n.resolvedLanguage(declared: bundle.localizations, preferred: ["en-US"]) == "en")
        #expect(L10n.resolvedLanguage(declared: bundle.localizations, preferred: ["de-DE"]) == "fr")
    }

    @Test("localisation-apps — la table anglaise de ConsoleCore est embarquée dans l'app, et la suite tourne en français (appui de AC-1)")
    func englishTableIsEmbedded() {
        #expect(L10n.text("Tous les projets", language: "en") == "All Projects")
        #expect(L10n.format("Lu à %@", arguments: ["14:05"], language: "en") == "Read at 14:05")
        // `-testLanguage fr` (scripts/ios-build.sh) et la TestAction du schéma : les
        // phrases figées par les autres tests sont françaises.
        #expect(L10n.language == "fr")
        #expect(MemoryText.allProjects == "Tous les projets")
    }

    @Test("accessibilite-et-localisation-ios-residu — l'icône est légendée « OMP Console » (CFBundleDisplayName), le nom de produit reste OMPConsoleIOS (appui de AC-7)")
    func homeScreenNameIsOMPConsole() {
        let info = Bundle.main.infoDictionary ?? [:]
        #expect(info["CFBundleDisplayName"] as? String == "OMP Console")
        #expect(info["CFBundleName"] as? String == "OMPConsoleIOS")
        #expect(Bundle.main.bundleIdentifier == "com.omp.console.ios")
    }
}
