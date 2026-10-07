import ConsoleCore
import SwiftUI
import Testing

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
}
