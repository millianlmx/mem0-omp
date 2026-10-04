// Preuves de S-5, BR-5 : la présentation de la feuille est une fonction PURE de
// l'état — lignes (à venir / en cours / terminée / échouée), boutons et bandeau se
// lisent sans rendre une vue.
//
// Le clavier (BR-4/BR-5 : ↩ sur le bouton proéminent, ⎋ = Fermer partout) se
// prouve lui sur la VRAIE vue, rendue dans une `NSWindow` hors écran : les
// raccourcis sont des objets de contrôle, pas des fonctions de présentation.

import AppKit
import Foundation
import SwiftUI
import Testing
@testable import OMPConsole

// MARK: - Harnais clavier (BR-5)

/// Rend une vue dans une `NSWindow` hors écran et laisse SwiftUI installer ses
/// raccourcis. MESURÉ le 2026-10-04 : sans cette passe de boucle d'exécution,
/// `performKeyEquivalent` ne voit AUCUN raccourci de la vue (et une `NSHostingView`
/// seule, sans fenêtre, n'en voit aucun non plus) ; la fenêtre n'a pas besoin
/// d'être visible, d'être key, ni l'app active. `isReleasedWhenClosed = false` :
/// sans lui, `close()` sur-rend la fenêtre et le test suivant meurt en
/// `objc_release` (SIGSEGV mesuré).
@MainActor
private func shortcutWindow(_ view: some View) -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 520, height: 420),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
    )
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: view)
    _ = RunLoop.main.run(until: Date().addingTimeInterval(0.25))
    return window
}

/// Presse une touche dans la fenêtre ; vrai si un raccourci l'a consommée.
@MainActor
private func press(_ characters: String, keyCode: UInt16, on window: NSWindow) -> Bool {
    guard let event = NSEvent.keyEvent(
        with: .keyDown,
        location: .zero,
        modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window.windowNumber,
        context: nil,
        characters: characters,
        charactersIgnoringModifiers: characters,
        isARepeat: false,
        keyCode: keyCode
    ) else { return false }
    return window.performKeyEquivalent(with: event)
}

@MainActor
private func pressReturn(on window: NSWindow) -> Bool {
    press("\r", keyCode: 36, on: window)
}

@MainActor
private func pressEscape(on window: NSWindow) -> Bool {
    press("\u{1b}", keyCode: 53, on: window)
}

/// Un modèle dont chaque machine réussit sans rien faire ; `install` est la porte
/// d'entrée des états « en cours » (attente) et « échoué » (jeté).
@MainActor
private func setupModel(
    install: @escaping @MainActor (@escaping @MainActor (ComponentInstallStep) -> Void) async throws -> Void = { _ in },
    autoPrepare: Bool = false
) -> SetupModel {
    SetupModel(
        install: install,
        migrate: { _ in },
        ensureStack: { _ in },
        probeOMLX: { .unknown },
        autoPrepare: autoPrepare
    )
}

/// Une porte d'attente : la machine en cours reste suspendue jusqu'à `open()`.
@MainActor
private final class KeyboardGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false

    func wait() async {
        if opened { return }
        await withCheckedContinuation { self.continuation = $0 }
    }

    func open() {
        opened = true
        continuation?.resume()
        continuation = nil
    }
}

@MainActor
private final class CallCounter { var count = 0 }

/// Attend qu'une condition devienne vraie (au plus `timeout` secondes), en
/// rendant la main — jamais de blocage du fil principal.
@MainActor
private func waitFor(_ timeout: Double = 5, _ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition() && Date() < deadline {
        await Task.yield()
        try? await Task.sleep(nanoseconds: 10_000_000)
    }
    #expect(condition())
}

@Test("all-in-one-app/AC-2 : les lignes suivent l'état (à venir, en cours, terminée, échouée)")
func rowsFollowState() {
    // Au repos : tout est à venir.
    let idle = SetupPresentation.rows(state: .idle, omlx: .unknown)
    #expect(idle.map(\.kind) == [.components, .migration, .stack, .prerequisites])
    #expect(idle.map(\.status) == [.upcoming, .upcoming, .upcoming, .upcoming])

    // Téléchargement d'OMP : la ligne Composants est en cours, avec son détail et
    // sa progression déterminée.
    let downloading = SetupPresentation.rows(state: .preparing(.omp(downloaded: 25, total: 100)), omlx: .unknown)
    #expect(downloading.map(\.status) == [.running, .upcoming, .upcoming, .upcoming])
    #expect(downloading[0].detail == "Téléchargement d'OMP — 25 %")
    #expect(downloading[0].fraction == 0.25)

    // Téléchargement sans taille connue : progression indéterminée.
    let unknown = SetupPresentation.rows(state: .preparing(.podman(downloaded: 0, total: 0)), omlx: .unknown)
    #expect(unknown[0].detail == "Téléchargement de Podman…")
    #expect(unknown[0].fraction == nil)

    // Pile : composants et migration terminés, la pile en cours.
    let stack = SetupPresentation.rows(state: .preparing(.containers), omlx: .unknown)
    #expect(stack.map(\.status) == [.done, .done, .running, .upcoming])
    #expect(stack[2].detail == "Démarrage de la pile mémoire…")

    // Vérification des prérequis : les trois premières lignes sont terminées.
    let prerequisites = SetupPresentation.rows(state: .preparing(.prerequisites), omlx: .unknown)
    #expect(prerequisites.map(\.status) == [.done, .done, .done, .running])

    // Prêt : tout est terminé, et la ligne Prérequis porte le mot oMLX.
    let ready = SetupPresentation.rows(state: .ready, omlx: .unauthorized)
    #expect(ready.map(\.status) == [.done, .done, .done, .done])
    #expect(ready[3].detail == "Jeton refusé (401)")
    #expect(SetupPresentation.rows(state: .ready, omlx: .reachable)[3].detail == "Disponible")

    // Échec de la migration : Composants terminé, Migration échouée, le reste à venir.
    let failed = SetupPresentation.rows(state: .failed(.migration(.copyFailed(detail: "disque plein"))), omlx: .unknown)
    #expect(failed.map(\.status) == [.done, .failed, .upcoming, .upcoming])
    #expect(failed[1].detail == "La copie de la base mémoire existante a échoué : disque plein")

    // Échec des composants : aucune ligne n'est marquée terminée à tort.
    let failingComponents = SetupPresentation.rows(state: .failed(.components(.unsupportedMac)), omlx: .unknown)
    #expect(failingComponents.map(\.status) == [.failed, .upcoming, .upcoming, .upcoming])
    #expect(failingComponents[0].detail == "Ce Mac n'est pas pris en charge (arm64 requis).")

    // Échec de la pile : seules les deux premières lignes sont terminées.
    let failingStack = SetupPresentation.rows(state: .failed(.stack(.portBusy(port: 6333))), omlx: .unknown)
    #expect(failingStack.map(\.status) == [.done, .done, .failed, .upcoming])
}

@Test("all-in-one-app/AC-2 : « Réessayer » n'apparaît que sur l'échec, « Fermer » est proéminent sinon")
func buttonsFollowState() {
    #expect(SetupPresentation.showsRetry(.failed(.components(.unsupportedMac))))
    #expect(!SetupPresentation.showsRetry(.idle))
    #expect(!SetupPresentation.showsRetry(.preparing(.health)))
    #expect(!SetupPresentation.showsRetry(.ready))

    #expect(SetupPresentation.closeIsProminent(.idle))
    #expect(SetupPresentation.closeIsProminent(.preparing(.health)))
    #expect(SetupPresentation.closeIsProminent(.ready))
    #expect(!SetupPresentation.closeIsProminent(.failed(.components(.unsupportedMac))))

    #expect(SetupPresentation.showsDone(.ready))
    #expect(!SetupPresentation.showsDone(.preparing(.health)))
    #expect(!SetupPresentation.showsDone(.failed(.stack(.healthTimeout(seconds: 180)))))
}

@Test("all-in-one-app/AC-2 : le bandeau de l'Accueil ne paraît qu'après « Fermer », et dit l'étape ou l'échec")
func bannerFollowsDismissedState() {
    // Feuille visible : aucun bandeau, c'est la feuille qui porte l'état.
    #expect(SetupText.banner(state: .preparing(.machine), dismissed: false) == nil)
    #expect(SetupText.banner(state: .failed(.components(.unsupportedMac)), dismissed: false) == nil)

    // Fermée pendant la préparation : le bandeau dit l'étape courante.
    #expect(SetupText.banner(state: .preparing(.machine), dismissed: true)
        == "Préparation en cours — Préparation de la machine de conteneurs…")
    #expect(SetupText.banner(state: .preparing(.omp(downloaded: 40, total: 100)), dismissed: true)
        == "Préparation en cours — Téléchargement d'OMP — 40 %")

    // Fermée après un échec : le bandeau dit la cause.
    #expect(SetupText.banner(state: .failed(.stack(.healthTimeout(seconds: 180))), dismissed: true)
        == "Préparation incomplète. La mémoire n'a pas répondu dans le délai imparti (180 s).")
    #expect(SetupText.banner(state: .failed(.components(.checksum(component: "Podman"))), dismissed: true)
        == "Préparation incomplète. « Podman » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue.")

    // Terminée ou jamais commencée : rien à dire.
    #expect(SetupText.banner(state: .ready, dismissed: true) == nil)
    #expect(SetupText.banner(state: .idle, dismissed: true) == nil)
    #expect(SetupText.banner(state: .ready, dismissed: false) == nil)
}

// MARK: - AC-2 : le clavier suit le bouton proéminent (BR-4/BR-5)

@MainActor
@Test("all-in-one-app/AC-2 : ↩ déclenche le bouton proéminent et ⎋ ferme — dans tous les états")
func keyboardFollowsProminentButton() async {
    // Au repos : le proéminent est « Fermer » — ↩ ET ⎋ la ferment.
    let idle = setupModel()
    let idleWindow = shortcutWindow(SetupView(setup: idle))
    #expect(pressReturn(on: idleWindow))
    #expect(idle.dismissed)
    idle.present()
    #expect(pressEscape(on: idleWindow))
    #expect(idle.dismissed)
    idleWindow.close()

    // En cours : la chaîne est suspendue à la porte, la même paire reste liée.
    let gate = KeyboardGate()
    let busy = setupModel(install: { _ in await gate.wait() })
    Task { await busy.prepare() }
    await waitFor { busy.state == .preparing(.omp(downloaded: 0, total: 0)) }
    let busyWindow = shortcutWindow(SetupView(setup: busy))
    #expect(pressReturn(on: busyWindow))
    #expect(busy.dismissed)
    busy.present()
    #expect(pressEscape(on: busyWindow))
    #expect(busy.dismissed)

    // Terminée : idem (la feuille se ferme par la politique, mais si elle est
    // visible les deux touches restent liées).
    gate.open()
    await waitFor { busy.state == .ready }
    busy.present()
    #expect(pressReturn(on: busyWindow))
    #expect(busy.dismissed)
    busy.present()
    #expect(pressEscape(on: busyWindow))
    #expect(busy.dismissed)
    busyWindow.close()

    // Échouée : le proéminent est « Réessayer » — ↩ relance la chaîne SANS
    // fermer, et ⎋ ferme quand même.
    let calls = CallCounter()
    let failing = setupModel(install: { _ in
        calls.count += 1
        throw ComponentInstallError.unsupportedMac
    })
    Task { await failing.prepare() }
    await waitFor { failing.state == .failed(.components(.unsupportedMac)) }
    let failedWindow = shortcutWindow(SetupView(setup: failing))
    #expect(pressReturn(on: failedWindow))
    #expect(!failing.dismissed)
    await waitFor { calls.count == 2 }
    #expect(failing.dismissed == false)
    #expect(pressEscape(on: failedWindow))
    #expect(failing.dismissed)
    failedWindow.close()
}
