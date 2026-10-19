import Foundation
import Testing
import UIKit

/// Les faits du bundle CONSTRUIT (ios-identite-app) : les tests sont hébergés par
/// l'app (`TEST_HOST`), donc `Bundle.main` est le `.app` lui-même, avec son
/// Info.plist généré et son `Assets.car` compilé. Ils échouent si le catalogue
/// d'actifs ou les réglages du projet régressent, quel que soit le texte des
/// fichiers sources que lisent les gardes Node.
@Suite("ios-identite-app — icône, accent, message réseau et écran de lancement du bundle")
struct IOSIdentiteTests {
    private var info: [String: Any] { Bundle.main.infoDictionary ?? [:] }

    /// `CFBundleIcons[~ipad].CFBundlePrimaryIcon.CFBundleIconName`, écrit par actool.
    /// Lu dans l'Info.plist BRUT du bundle : `infoDictionary` résout les clés
    /// `~ipad` selon l'appareil et retire `CFBundleIcons~ipad` sur iPhone.
    private func primaryIconName(_ key: String) throws -> String? {
        let url = try #require(Bundle.main.url(forResource: "Info", withExtension: "plist"))
        let raw = try PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any]
        let icons = raw?[key] as? [String: Any]
        let primary = icons?["CFBundlePrimaryIcon"] as? [String: Any]
        return primary?["CFBundleIconName"] as? String
    }

    @Test("ios-identite-app/AC-1, AC-3 — l'icône compilée est l'AppIcon du catalogue, sur iPhone comme sur iPad (CFBundleIcons et CFBundleIcons~ipad)")
    func appIconIsDeclared() throws {
        #expect(try primaryIconName("CFBundleIcons") == "AppIcon")
        #expect(try primaryIconName("CFBundleIcons~ipad") == "AppIcon")
    }

    @Test("ios-identite-app/AC-4 — l'AccentColor compilée vaut UIColor.systemBlue (±1/255) en clair, sombre et contraste élevé")
    func accentColorIsSystemBlue() throws {
        #expect(info["NSAccentColorName"] as? String == "AccentColor")
        let accent = try #require(UIColor(named: "AccentColor", in: .main, compatibleWith: nil))

        let cases: [(label: String, style: UIUserInterfaceStyle, contrast: UIAccessibilityContrast)] = [
            ("clair", .light, .normal),
            ("sombre", .dark, .normal),
            ("clair + contraste élevé", .light, .high),
            ("sombre + contraste élevé", .dark, .high),
        ]
        for (label, style, contrast) in cases {
            let traits = UITraitCollection { traits in
                traits.userInterfaceStyle = style
                traits.accessibilityContrast = contrast
            }
            let actual = components(accent.resolvedColor(with: traits))
            let expected = components(UIColor.systemBlue.resolvedColor(with: traits))
            let gap = zip(actual, expected).map { abs($0 - $1) }.max() ?? 1
            #expect(gap <= 1.0 / 255.0, "\(label) : AccentColor \(actual) ≠ systemBlue \(expected)")
        }
    }

    @Test("ios-identite-app/AC-7 — le message « Réseau local » du bundle commence par « OMP Console se connecte à votre Mac », vouvoie et ne dit ni « coque » ni « macOS »")
    func localNetworkMessageSpeaksToTheUser() {
        let message = info["NSLocalNetworkUsageDescription"] as? String ?? ""
        #expect(message == "OMP Console se connecte à votre Mac sur le réseau local pour afficher et piloter vos pipelines.")
        #expect(message.hasPrefix("OMP Console se connecte à votre Mac"))
        #expect(!message.localizedCaseInsensitiveContains("coque"))
        #expect(!message.localizedCaseInsensitiveContains("macos"))
        #expect(message.contains("votre") && message.contains("vos"))
        #expect(!message.contains("'"))
        #expect(info["NSBonjourServices"] as? [String] == ["_ompconsole._tcp"])
        // Le Mac se joint en HTTP, au LAN comme par Tailscale (100.64/10, hors du
        // « réseau local » d'ATS). `NSAllowsLocalNetworking` présent ferait ignorer
        // `NSAllowsArbitraryLoads` par iOS : l'adresse Tailscale échouerait en -1022.
        let transport = info["NSAppTransportSecurity"] as? [String: Any]
        #expect(transport?["NSAllowsArbitraryLoads"] as? Bool == true)
        #expect(transport?["NSAllowsLocalNetworking"] == nil)
    }

    @Test("ios-identite-app/AC-8 — l'écran de lancement est le UILaunchScreen vide généré par Xcode : fond système, sans couleur, image, barre ni storyboard")
    func launchScreenUsesSystemBackground() throws {
        let launch = try #require(info["UILaunchScreen"] as? [String: Any])
        for key in ["UIColorName", "UIImageName", "UINavigationBar", "UITabBar", "UIToolbar"] {
            #expect(launch[key] == nil, "UILaunchScreen porte \(key)")
        }
        #expect(info["UILaunchStoryboardName"] == nil)
    }

    /// Composantes sRGB (rouge, vert, bleu, alpha) d'une couleur déjà résolue.
    private func components(_ color: UIColor) -> [CGFloat] {
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return [red, green, blue, alpha]
    }
}
