import ConsoleCore
import SwiftUI
import Testing
import UIKit

@testable import OMPConsoleIOS

/// Les preuves Swift du kit de design iOS (S-1, BR-2) : les six tons, les marges
/// par taille de classe et la cible tactile minimale. Chaque test porte l'id de
/// son critère, que `/review` retrouve par `grep`.
@Suite("design-ios — le kit de design iOS")
struct IOSDesignTests {
    @Test("design-ios/AC-8 : la cible tactile minimale est celle du HIG (44 pt)")
    func minimumTargetIsFortyFour() {
        #expect(IOSMetrics.minimumTarget == 44)
    }

    @Test("design-ios/AC-1 : les marges du kit suivent la taille de classe (16/24)")
    func marginFollowsSizeClass() {
        #expect(IOSMetrics.margin(.compact) == 16)
        #expect(IOSMetrics.margin(.regular) == 24)
        #expect(IOSMetrics.margin(nil) == 24)
    }

    @Test("ipad-clavier-et-largeur-de-lecture/AC-1 : la colonne de lecture (720 pt marges comprises) garde la surface sous 700 pt")
    func readableWidthKeepsTheColumnUnder700() {
        #expect(IOSMetrics.readableWidth == 720)
        #expect(IOSMetrics.readableWidth - 2 * IOSMetrics.regularMargin <= 700)
    }

    @Test("design-ios/AC-1 : les trois surfaces portent le rayon du tactile (12 pt)")
    func surfacesShareTactileRadius() {
        #expect(IOSSurface.panelRadius == 12)
        #expect(IOSSurface.cardRadius == 12)
        #expect(IOSSurface.bannerRadius == 12)
    }

    @Test("design-ios/AC-1 : les six tons portent la teinte et les deux valeurs onTint de macOS")
    func toneTintsMatchMacOS() {
        let expected: [(ConsoleTone, Color, Color)] = [
            (.neutral, .gray, .white),
            (.info, .blue, .white),
            (.attention, .orange, .white),
            (.success, .green, .white),
            (.danger, .red, .white),
            (.paused, .yellow, .black),
        ]
        for (tone, tint, onTint) in expected {
            #expect(tone.tint == tint, "\(tone)")
            #expect(tone.onTint == onTint, "\(tone)")
        }
    }

    @Test("ios-listes-groupees-natives/AC-7, AC-8 : la carte élevée se détache du fond groupé en clair comme en sombre ; la carte ordinaire garde le fond du panneau")
    func raisedCardStandsOutOfTheGroupedBackground() {
        let raised = IOSSurface.cardFill(raised: true)
        let background = UIColor.systemGroupedBackground
        for style in [UIUserInterfaceStyle.light, .dark] {
            #expect(luminance(raised, style) - luminance(background, style) >= 8, "\(style.rawValue)")
            #expect(rgb(IOSSurface.cardFill(raised: false), style) == rgb(.secondarySystemBackground, style))
        }
    }

    /// Les composantes 0-255 d'une couleur système résolue dans une apparence.
    private func rgb(_ color: UIColor, _ style: UIUserInterfaceStyle) -> [Double] {
        let resolved = color.resolvedColor(with: UITraitCollection(userInterfaceStyle: style))
        var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
        resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return [red, green, blue].map { Double(($0 * 255).rounded()) }
    }

    /// La luminance : 0,299 R + 0,587 G + 0,114 B.
    private func luminance(_ color: UIColor, _ style: UIUserInterfaceStyle) -> Double {
        let c = rgb(color, style)
        return 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    }
}
