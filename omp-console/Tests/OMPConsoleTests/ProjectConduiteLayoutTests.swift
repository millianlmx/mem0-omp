// Preuve de la mise en page du pilotage dans une petite fenêtre. Plantage mesuré
// le 2026-10-11 en recette réelle (`scripts/mac-recette-ui.sh`, surface
// projet-dialogue) : l'inspecteur reportait au partage de la fenêtre le minimum du
// pilotage, plus haut qu'elle, et la mise en page bouclait jusqu'à l'exception
// d'AppKit « Update Constraints in Window ». Une régression TUE le processus de
// test (signal 5) au lieu de rendre un échec : c'est le plantage de l'app.

import AppKit
import SwiftUI
import Testing
@testable import OMPConsole

/// Compte les passes de mise en page de la racine.
private final class CountingHostingView<Content: View>: NSHostingView<Content> {
    private(set) var layouts = 0

    override func layout() {
        layouts += 1
        super.layout()
    }
}

/// Un pilotage en direct ; `fullHeader` remplit l'en-tête : projet, avis long,
/// bandeau d'attente d'un dialogue.
@MainActor
private func liveConduite(fullHeader: Bool) async throws -> ProjectConsoleModel {
    let repo = try makeGitRepository()
    let fixture = StoreFixture()
    let transport = ScriptedServiceTransport()
    if fullHeader {
        emitProjectNotice(transport, message: (1...12).map {
            "Ligne \($0) d'un avis du pilote, assez longue pour se replier à cette largeur."
        }.joined(separator: "\n"))
        emitProjectDialog(
            transport,
            id: "d1",
            method: "select",
            title: "Quel périmètre pour la recette ?",
            options: ["Tout le dépôt", "Seulement src/"]
        )
    }
    keepProjectAlive(transport)
    stubProjectConduite(transport, repo: repo.path)
    let model = makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: fixture.root)
    model.start()
    await model.startConduite(repoRoot: repo, name: "atelier")
    if fullHeader {
        let key = ProjectPaths.key(forRoot: repo.path)
        fixture.publish(.projects, "\(key).json", object: projectObject(repoKey: key, current: 0))
        #expect(await awaitProject { model.project != nil && model.notice != nil && model.awaitingUser })
    }
    #expect(model.state == .live)
    return model
}

/// Le pilotage dans le détail d'une `NavigationSplitView`, comme dans
/// `ConsoleRootView`, sur une fenêtre jamais affichée dont le contenu mesure
/// `size`. Vrai si la mise en page se stabilise : 0,3 s sans passe, en moins de 5 s.
@MainActor
private func layoutSettles(_ model: ProjectConsoleModel, in size: CGSize) -> Bool {
    _ = NSApplication.shared
    let window = NSWindow(
        contentRect: NSRect(origin: .zero, size: size),
        styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    // Sans lui, `close()` sur-rend la fenêtre (patron de SetupViewTests).
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let host = CountingHostingView(rootView: NavigationSplitView {
        List { Text(verbatim: "Projet") }
    } detail: {
        ProjectConsoleView(model: model)
    })
    window.contentView = host
    window.setContentSize(size)
    let deadline = Date().addingTimeInterval(5)
    var seen = -1
    var quietSince = Date()
    while Date() < deadline {
        host.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        _ = RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.01))
        if host.layouts != seen {
            seen = host.layouts
            quietSince = Date()
        } else if Date().timeIntervalSince(quietSince) >= 0.3 {
            return true
        }
    }
    return false
}

@MainActor
@Test("Projet : le pilotage se met en page sans boucler dans la plus petite fenêtre")
func conduiteLayoutSettlesInSmallestWindow() async throws {
    let model = try await liveConduite(fullHeader: false)
    // La plus petite fenêtre de `ConsoleRootView` (760 × 480 pt de contenu).
    #expect(layoutSettles(model, in: CGSize(width: 760, height: 480)))
    model.stop()
}

@MainActor
@Test("Projet : un en-tête complet (projet, avis, attente) ne fait pas boucler la mise en page")
func conduiteLayoutSettlesWithFullHeader() async throws {
    let model = try await liveConduite(fullHeader: true)
    // Hauteur mesurée en plantage avant correction, alors que 610 et 800 tenaient.
    #expect(layoutSettles(model, in: CGSize(width: 1000, height: 700)))
    model.stop()
}
