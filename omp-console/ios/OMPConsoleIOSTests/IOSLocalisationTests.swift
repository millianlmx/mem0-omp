import Foundation
import Testing

/// Les faits du bundle CONSTRUIT (accessibilite-et-localisation-ios-residu) : les
/// tests sont hébergés par l'app (`TEST_HOST`), donc `Bundle.main` est le `.app`
/// lui-même, avec son Info.plist généré. Ils échouent si le réglage du projet
/// (`developmentRegion`, `INFOPLIST_KEY_CFBundleDisplayName`) régresse, quel que soit
/// le texte du pbxproj.
@Suite("accessibilite-et-localisation-ios-residu — langue et nom du bundle")
struct IOSLocalisationTests {
    @Test("accessibilite-et-localisation-ios-residu — le bundle est français seulement : région de développement fr, aucune localisation en, fr choisi même sur un appareil réglé autrement (appui de AC-6)")
    func appIsFrenchOnly() {
        let bundle = Bundle.main
        #expect(bundle.developmentLocalization == "fr")
        #expect(bundle.object(forInfoDictionaryKey: "CFBundleDevelopmentRegion") as? String == "fr")
        #expect(!bundle.localizations.contains("en"))
        #expect(Bundle.preferredLocalizations(from: bundle.localizations, forPreferences: ["en-US", "en"]) == ["fr"])
    }

    @Test("accessibilite-et-localisation-ios-residu — l'icône est légendée « OMP Console » (CFBundleDisplayName), le nom de produit reste OMPConsoleIOS (appui de AC-7)")
    func homeScreenNameIsOMPConsole() {
        let info = Bundle.main.infoDictionary ?? [:]
        #expect(info["CFBundleDisplayName"] as? String == "OMP Console")
        #expect(info["CFBundleName"] as? String == "OMPConsoleIOS")
        #expect(Bundle.main.bundleIdentifier == "com.omp.console.ios")
    }
}
