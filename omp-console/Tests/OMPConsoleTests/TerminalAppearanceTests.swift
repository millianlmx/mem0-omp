// Preuves de la bascule clair ↔ sombre du Terminal (S-5 de mac-finitions-hig) :
// la palette d'une apparence, l'invariance des couleurs indexées, et le suivi du
// modèle — palette ET réponse OSC 11 — quand l'apparence de la vue change.
//
// L'apparence du système n'est jamais basculée : `NSWindow.appearance` sur une
// fenêtre jamais ordonnée déclenche le même `viewDidChangeEffectiveAppearance()`.

import AppKit
import Foundation
import Testing
@testable import OMPConsole

private func luminance(_ color: TerminalRGB) -> Int {
    Int(color.r) + Int(color.g) + Int(color.b)
}

@MainActor
private func makeAppearanceModel() -> TerminalConsoleModel {
    let suite = UserDefaults(suiteName: "terminal-appearance-\(UUID().uuidString)") ?? .standard
    return TerminalConsoleModel(defaults: suite, environment: [:], git: filesGit())
}

/// Le crochet de la vue est différé sur la file principale : le test doit LA
/// LIBÉRER (suspension), un `RunLoop.main.run` imbriqué ne la vide pas.
private func settle() async throws {
    try await Task.sleep(for: .milliseconds(200))
}

@MainActor
@Test("mac-finitions-hig/AC-6 : le fond, le texte et la réponse OSC 11 du terminal suivent l'apparence ; les couleurs indexées restent celles de Terminal.app")
func terminalPaletteFollowsTheAppearance() async throws {
    let light = try #require(NSAppearance(named: .aqua))
    let dark = try #require(NSAppearance(named: .darkAqua))

    // La palette d'une apparence : fond clair et texte sombre en clair, l'inverse en sombre.
    let lightPalette = TerminalPalette.live(for: light)
    let darkPalette = TerminalPalette.live(for: dark)
    #expect(luminance(lightPalette.defaultBackground) > luminance(darkPalette.defaultBackground))
    #expect(luminance(lightPalette.defaultForeground) < luminance(darkPalette.defaultForeground))
    #expect(luminance(lightPalette.defaultBackground) > luminance(lightPalette.defaultForeground))
    #expect(luminance(darkPalette.defaultBackground) < luminance(darkPalette.defaultForeground))

    // Les couleurs indexées (ANSI, cube, gris) et RVB ne dépendent pas de l'apparence.
    for index in 0...255 {
        let color = TerminalColor.indexed(UInt8(index))
        #expect(lightPalette.foreground(color) == darkPalette.foreground(color), "index \(index)")
        #expect(lightPalette.background(color) == darkPalette.background(color), "index \(index)")
    }
    #expect(lightPalette.foreground(.rgb(12, 34, 56)) == darkPalette.foreground(.rgb(12, 34, 56)))

    // Le modèle suit : palette et réponse OSC 11 viennent de la même source, à
    // chaque bascule, dans les deux sens.
    let model = makeAppearanceModel()
    for (appearance, expected) in [(light, lightPalette), (dark, darkPalette), (light, lightPalette)] {
        model.refreshPalette(for: appearance)
        #expect(model.palette == expected)
        #expect(model.palette.osc11Reply() == expected.osc11Reply())
    }

    // Bout en bout : la vue du terminal aligne le modèle sur son apparence
    // effective dès son installation dans une fenêtre (R4), puis à chaque
    // changement d'apparence de cette fenêtre, sans autre geste (R1).
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 320, height: 120),
        styleMask: [.titled, .closable, .resizable],
        backing: .buffered,
        defer: false
    )
    window.isReleasedWhenClosed = false
    let view = TerminalRenderView(frame: NSRect(x: 0, y: 0, width: 320, height: 120))
    view.onAppearanceChange = { model.refreshPalette(for: $0) }
    window.appearance = dark
    window.contentView = view
    try await settle()
    #expect(model.palette == darkPalette)

    window.appearance = light
    try await settle()
    #expect(model.palette == lightPalette)
    #expect(model.palette.osc11Reply() == lightPalette.osc11Reply())

    window.appearance = dark
    try await settle()
    #expect(model.palette == darkPalette)
    #expect(model.palette.osc11Reply() == darkPalette.osc11Reply())
}
