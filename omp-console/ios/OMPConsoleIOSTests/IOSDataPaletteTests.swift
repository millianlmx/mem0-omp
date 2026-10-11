// Les preuves Swift de la palette adaptative (ios-statistiques-et-graphe-accessibles,
// S-4, BR-1) : chaque couleur de données change entre clair et sombre, et entre
// contraste normal et accru ; la teinte d'une portée du graphe sort toujours de la
// palette, jamais d'une valeur HSB.

@testable import OMPConsoleIOS
import ConsoleCore
import Testing
import UIKit

@Suite("ios-statistiques-et-graphe-accessibles — la palette adaptative")
struct IOSDataPaletteTests {
    /// Les composantes RGB d'une couleur résolue pour une apparence et un contraste.
    private func rgb(_ color: UIColor, _ style: UIUserInterfaceStyle, _ contrast: UIAccessibilityContrast) -> [CGFloat] {
        let traits = UITraitCollection(traitsFrom: [
            UITraitCollection(userInterfaceStyle: style),
            UITraitCollection(accessibilityContrast: contrast),
        ])
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        #expect(color.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha))
        return [red, green, blue]
    }

    /// Deux résolutions diffèrent quand l'écart dépasse 1/255 sur une composante.
    private func differ(_ a: [CGFloat], _ b: [CGFloat]) -> Bool {
        zip(a, b).contains { abs($0 - $1) > 1.0 / 255.0 }
    }

    private var everyColor: [(name: String, color: UIColor)] {
        [("duration", IOSDataPalette.duration),
         ("sentTokens", IOSDataPalette.sentTokens),
         ("receivedTokens", IOSDataPalette.receivedTokens)]
            + IOSDataPalette.scopes.enumerated().map { ("scopes[\($0.offset)]", $0.element) }
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-10 : paletteAdaptsToAppearanceAndContrast — chaque teinte varie en clair/sombre et en contraste accru")
    func paletteAdaptsToAppearanceAndContrast() {
        #expect(IOSDataPalette.scopes.count == 9)
        for (name, color) in everyColor {
            let lightNormal = rgb(color, .light, .normal)
            let lightHigh = rgb(color, .light, .high)
            let darkNormal = rgb(color, .dark, .normal)
            let darkHigh = rgb(color, .dark, .high)
            #expect(differ(lightNormal, lightHigh), "\(name) : clair normal = clair accru")
            #expect(differ(darkNormal, darkHigh), "\(name) : sombre normal = sombre accru")
            #expect(differ(lightNormal, darkNormal), "\(name) : clair normal = sombre normal")
        }
    }

    @Test("ios-statistiques-et-graphe-accessibles/AC-10 : graphScopeColorComesFromThePalette — la teinte d'une portée est toujours une couleur de la palette")
    func graphScopeColorComesFromThePalette() {
        let scopes = IOSDataPalette.scopes
        // Les portées de la fixture partagée, `nil` compris, par la teinte FNV-1a.
        let fixtureScopes = Set(MemoryGraphParity.facts.nodes.map(\.scope))
        #expect(fixtureScopes.count > 1)
        for scope in fixtureScopes {
            let color = IOSDataPalette.scope(hue: MemoryGraphStyle.hue(for: scope))
            #expect(scopes.contains { $0 === color }, "portée \(scope ?? "nil") hors palette")
        }
        // Les bornes : début, milieu, fin de cercle, 1 exactement, négatif, NaN.
        for hue in [0, 0.5, 0.999, 1, -0.1, .nan, .infinity] as [Double] {
            let color = IOSDataPalette.scope(hue: hue)
            #expect(scopes.contains { $0 === color }, "hue \(hue) hors palette")
        }
        #expect(IOSDataPalette.scope(hue: 0) === scopes[0])
        #expect(IOSDataPalette.scope(hue: 0.5) === scopes[4])
        #expect(IOSDataPalette.scope(hue: 0.999) === scopes[8])
        #expect(IOSDataPalette.scope(hue: 1) === scopes[8])
        #expect(IOSDataPalette.scope(hue: -0.1) === scopes[0])
        #expect(IOSDataPalette.scope(hue: .nan) === scopes[0])
    }
}
