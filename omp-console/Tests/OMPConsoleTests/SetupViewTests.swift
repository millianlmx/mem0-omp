// Preuves de S-5, BR-5 (all-in-one-app) et de S-1/S-2/S-5/S-6, BR-2
// (mac-omp-manquant-non-bloquant) : la présentation de la feuille est une
// fonction PURE de l'état et du mode — lignes, pied, bloc de progression, phrase
// d'échec et détail — qui se lit sans rendre une vue.
//
// Le clavier (↩ sur le proéminent actif ; ⎋ = « Fermer » en mode fermable
// seulement ; ⌘Q = « Quitter » en mode bloquant) se prouve lui sur la VRAIE vue,
// rendue dans une `NSWindow` hors écran : les raccourcis sont des objets de
// contrôle, pas des fonctions de présentation.

import AppKit
import Foundation
import SwiftUI
import Testing
@testable import OMPConsole
import ConsoleCore

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
private func press(
    _ characters: String,
    keyCode: UInt16,
    modifierFlags: NSEvent.ModifierFlags = [],
    on window: NSWindow
) -> Bool {
    guard let event = NSEvent.keyEvent(
        with: .keyDown,
        location: .zero,
        modifierFlags: modifierFlags,
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

@MainActor
private func pressCommandQ(on window: NSWindow) -> Bool {
    press("q", keyCode: 12, modifierFlags: .command, on: window)
}

/// OMP présent : la feuille est en mode fermable.
private let ompAvailable = OmpStatus.available(URL(fileURLWithPath: "/usr/local/bin/omp"))

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
    let idle = SetupPresentation.rows(state: .idle, omlx: .unknown, blocking: false)
    #expect(idle.map(\.kind) == [.components, .migration, .stack, .prerequisites])
    #expect(idle.map(\.status) == [.upcoming, .upcoming, .upcoming, .upcoming])

    // Téléchargement d'OMP : la ligne Composants est en cours, SANS détail — le
    // détail et la barre vivent dans le bloc de progression.
    let downloading = SetupPresentation.rows(state: .preparing(.omp(downloaded: 25, total: 100)), omlx: .unknown, blocking: false)
    #expect(downloading.map(\.status) == [.running, .upcoming, .upcoming, .upcoming])
    #expect(downloading[0].detail == nil)
    #expect(downloading.allSatisfy { $0.technicalDetail == nil })

    // Pile : composants et migration terminés, la pile en cours.
    let stack = SetupPresentation.rows(state: .preparing(.containers), omlx: .unknown, blocking: false)
    #expect(stack.map(\.status) == [.done, .done, .running, .upcoming])
    #expect(stack[2].detail == nil)

    // Vérification des prérequis : les trois premières lignes sont terminées.
    let prerequisites = SetupPresentation.rows(state: .preparing(.prerequisites), omlx: .unknown, blocking: false)
    #expect(prerequisites.map(\.status) == [.done, .done, .done, .running])

    // Prêt : tout est terminé, et la ligne Prérequis porte le mot oMLX.
    let ready = SetupPresentation.rows(state: .ready, omlx: .unauthorized, blocking: false)
    #expect(ready.map(\.status) == [.done, .done, .done, .done])
    #expect(ready[3].detail == "Jeton refusé (401)")
    #expect(SetupPresentation.rows(state: .ready, omlx: .reachable, blocking: false)[3].detail == "Disponible")

    // Échec de la migration : Composants terminé, Migration échouée avec la phrase
    // claire et le détail technique à part, le reste à venir.
    let failed = SetupPresentation.rows(state: .failed(.migration(.copyFailed(detail: "disque plein"))), omlx: .unknown, blocking: false)
    #expect(failed.map(\.status) == [.done, .failed, .upcoming, .upcoming])
    #expect(failed[1].detail == "La copie de la base mémoire existante a échoué.")
    #expect(failed[1].technicalDetail == "disque plein")
    #expect(failed.filter { $0.status != .failed }.allSatisfy { $0.technicalDetail == nil })

    // Échec des composants : aucune ligne n'est marquée terminée à tort.
    let failingComponents = SetupPresentation.rows(state: .failed(.components(.unsupportedMac)), omlx: .unknown, blocking: false)
    #expect(failingComponents.map(\.status) == [.failed, .upcoming, .upcoming, .upcoming])
    #expect(failingComponents[0].detail == "Ce Mac n'est pas pris en charge (arm64 requis).")
    #expect(failingComponents[0].technicalDetail == nil)

    // Échec de la pile : seules les deux premières lignes sont terminées.
    let failingStack = SetupPresentation.rows(
        state: .failed(.stack(.portConflict(port: 6333, owner: .foreign(process: "python3", pid: 4711)))),
        omlx: .unknown,
        blocking: false
    )
    #expect(failingStack.map(\.status) == [.done, .done, .failed, .upcoming])
}

@Test("mac-omp-manquant-non-bloquant/AC-1 : en mode bloquant, « prêt » se présente comme « au repos », sans « Préparation terminée. »")
func blockingReadyLooksIdle() {
    for omlx in [OMLXStatus.unknown, .reachable, .unauthorized] {
        #expect(SetupPresentation.rows(state: .ready, omlx: omlx, blocking: true)
            == SetupPresentation.rows(state: .idle, omlx: omlx, blocking: true))
    }
    #expect(SetupPresentation.footer(state: .ready, blocking: true)
        == SetupPresentation.footer(state: .idle, blocking: true))

    #expect(SetupPresentation.showsDone(state: .ready, blocking: false))
    #expect(!SetupPresentation.showsDone(state: .ready, blocking: true))
    #expect(!SetupPresentation.showsDone(state: .idle, blocking: false))
    #expect(!SetupPresentation.showsDone(state: .preparing(.health), blocking: false))
    #expect(!SetupPresentation.showsDone(state: .failed(.stack(.healthTimeout(seconds: 180))), blocking: false))
}

/// Un état de chaque sorte, pour parcourir la table du pied.
private let preparingStates: [SetupState] = [
    .preparing(.omp(downloaded: 0, total: 0)),
    .preparing(.podman(downloaded: 5, total: 10)),
    .preparing(.machine),
    .preparing(.prerequisites),
]
private let failedStates: [SetupState] = [
    .failed(.components(.unsupportedMac)),
    .failed(.stack(.healthTimeout(seconds: 180))),
]

@Test("mac-omp-manquant-non-bloquant/AC-1 : OMP absent, le pied n'a pas de « Fermer » — « Quitter » à gauche, « Réessayer » et « Installer » (↩) à droite")
func blockingFooterHasNoClose() {
    for state in [SetupState.idle, .ready] + failedStates {
        let footer = SetupPresentation.footer(state: state, blocking: true)
        #expect(footer == SetupFooter(leading: [.quit], trailing: [.retry, .install], prominent: .install, disabled: []))
    }
    // Pendant la préparation : même pied, « Installer » et « Réessayer » éteints,
    // aucun proéminent (↩ sans effet), « Quitter » reste actif.
    for state in preparingStates {
        let footer = SetupPresentation.footer(state: state, blocking: true)
        #expect(footer == SetupFooter(leading: [.quit], trailing: [.retry, .install], prominent: nil, disabled: [.retry, .install]))
    }
    for state in [SetupState.idle, .ready] + failedStates + preparingStates {
        let footer = SetupPresentation.footer(state: state, blocking: true)
        #expect(!(footer.leading + footer.trailing).contains(.close))
    }
    #expect(SetupAction.allCases.map(SetupPresentation.label)
        == ["Installer", "Réessayer", "Quitter", "Fermer", "Arrêter l'ancienne pile et reprendre"])
}

@Test("mac-omp-manquant-non-bloquant/AC-4 : OMP présent, le pied propose « Fermer » — seul et proéminent, ou après « Réessayer » sur l'échec")
func closableFooterOffersClose() {
    for state in [SetupState.idle, .ready] + preparingStates {
        #expect(SetupPresentation.footer(state: state, blocking: false)
            == SetupFooter(leading: [], trailing: [.close], prominent: .close, disabled: []))
    }
    for state in failedStates {
        #expect(SetupPresentation.footer(state: state, blocking: false)
            == SetupFooter(leading: [], trailing: [.retry, .close], prominent: .retry, disabled: []))
    }
}

@Test("mac-omp-manquant-non-bloquant/AC-9 : un téléchargement de taille connue donne une barre chiffrée qui croît avec l'avancement")
func determinateProgressFollowsDownload() {
    #expect(SetupPresentation.progress(state: .preparing(.omp(downloaded: 40, total: 100)))
        == SetupProgress(label: "Téléchargement d'OMP — 40 %", fraction: 0.4))
    #expect(SetupPresentation.progress(state: .preparing(.podman(downloaded: 30, total: 120)))
        == SetupProgress(label: "Téléchargement de Podman — 25 %", fraction: 0.25))

    // La part remplie croît avec `downloaded`, bornée à 1.
    let fractions = stride(from: Int64(0), through: 120, by: 12).map {
        SetupPresentation.progress(state: .preparing(.omp(downloaded: $0, total: 120)))?.fraction ?? -1
    }
    #expect(fractions.first == 0)
    #expect(fractions.last == 1)
    #expect(zip(fractions, fractions.dropFirst()).allSatisfy { $0 < $1 })
    #expect(SetupPresentation.progress(state: .preparing(.omp(downloaded: 200, total: 100)))?.fraction == 1)
}

@Test("mac-omp-manquant-non-bloquant/AC-10 : sans taille connue, la barre est indéterminée et nomme l'étape en cours ; aucun bloc hors préparation")
func indeterminateProgressNamesTheStep() {
    #expect(SetupPresentation.progress(state: .preparing(.omp(downloaded: 5, total: 0)))
        == SetupProgress(label: "Téléchargement d'OMP…", fraction: nil))
    #expect(SetupPresentation.progress(state: .preparing(.ompInstall))
        == SetupProgress(label: "Installation d'OMP…", fraction: nil))
    #expect(SetupPresentation.progress(state: .preparing(.machine))
        == SetupProgress(label: "Préparation de la machine de conteneurs…", fraction: nil))
    #expect(SetupPresentation.progress(state: .preparing(.prerequisites))
        == SetupProgress(label: "Vérification des prérequis…", fraction: nil))

    #expect(SetupPresentation.progress(state: .idle) == nil)
    #expect(SetupPresentation.progress(state: .ready) == nil)
    #expect(SetupPresentation.progress(state: .failed(.components(.unsupportedMac))) == nil)
}

@Test("mac-omp-manquant-non-bloquant/AC-11 : un échec se dit en une phrase claire, le détail technique à part (nil s'il est vide)")
func failureSplitsSummaryFromDetail() {
    let table: [(SetupFailure, String, String?)] = [
        (.components(.unsupportedMac),
         "Ce Mac n'est pas pris en charge (arm64 requis).", nil),
        (.components(.network(component: "OMP", detail: "NSURLErrorDomain -1009")),
         "Pas de réseau : « OMP » n'a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez.", "NSURLErrorDomain -1009"),
        (.components(.checksum(component: "Podman")),
         "« Podman » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue.", nil),
        (.components(.install(component: "Podman", detail: "pkgutil absent")),
         "L'installation de « Podman » a échoué.", "pkgutil absent"),
        (.legacy(.stopFailed(container: "mem0-qdrant", detail: "socket fermé")),
         "L'ancienne pile mémoire n'a pas pu être arrêtée.", "mem0-qdrant : socket fermé"),
        (.migration(.copyFailed(detail: "disque plein")),
         "La copie de la base mémoire existante a échoué.", "disque plein"),
        (.stack(.machineFailed(detail: "libkrun absent")),
         "La machine de conteneurs n'a pas démarré.", "libkrun absent"),
        (.stack(.portConflict(port: 6333, owner: .foreign(process: "python3", pid: 4711))),
         "Le port 6333 est déjà tenu par un autre programme (python3, pid 4711) : la pile mémoire ne peut pas démarrer.",
         "Geste : arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"),
        (.stack(.portConflict(port: 8321, owner: .legacyStack(container: "mem0-http"))),
         "Le port 8321 est déjà tenu par l'ancienne pile mémoire (conteneur mem0-http) : la pile mémoire ne peut pas démarrer.",
         "Geste : podman stop mem0-qdrant mem0-http"),
        (.stack(.containerFailed(name: "omp-console-qdrant", detail: "image absente")),
         "Un conteneur de la pile mémoire n'a pas démarré.", "omp-console-qdrant : image absente"),
        (.stack(.healthTimeout(seconds: 180)),
         "La mémoire n'a pas répondu dans le délai imparti (180 s).", nil),
        (.stack(.installationFailed(detail: "disque plein")),
         "L'identité d'installation de la pile n'a pas pu être écrite.", "disque plein"),
        (.stack(.podmanFailed(command: "machine start", detail: "boom")),
         "Podman a échoué.", "machine start : boom"),
    ]
    for (failure, summary, detail) in table {
        #expect(SetupText.failureSummary(failure) == summary)
        #expect(SetupText.failureDetail(failure) == detail)
        // La phrase claire ne porte jamais le détail technique.
        if let detail { #expect(!SetupText.failureSummary(failure).contains(detail)) }
    }

    // Un détail vide ou fait de blancs n'ouvre aucun « Afficher le détail ».
    for blank in ["", "   ", "\n\t \n"] {
        #expect(SetupText.failureDetail(.components(.install(component: "OMP", detail: blank))) == nil)
        #expect(SetupText.failureDetail(.components(.network(component: "OMP", detail: blank))) == nil)
        #expect(SetupText.failureDetail(.migration(.copyFailed(detail: blank))) == nil)
        #expect(SetupText.failureDetail(.legacy(.stopFailed(container: "mem0-qdrant", detail: blank))) == nil)
        #expect(SetupText.failureDetail(.stack(.installationFailed(detail: blank))) == nil)
        #expect(SetupText.failureDetail(.stack(.machineFailed(detail: blank))) == nil)
        #expect(SetupText.failureDetail(.stack(.containerFailed(name: "omp-console-qdrant", detail: blank))) == nil)
        #expect(SetupText.failureDetail(.stack(.podmanFailed(command: "machine start", detail: blank))) == nil)
    }

    // Le bandeau de l'Accueil et l'API distante gardent leur phrase complète.
    #expect(SetupText.failureMessage(.components(.install(component: "Podman", detail: "pkgutil absent")))
        == "L'installation de « Podman » a échoué : pkgutil absent")
}

/// La hauteur idéale de la feuille rendue pour un échec d'installation donné.
@MainActor
private func failedSheetHeight(detail: String) async -> CGFloat {
    let model = setupModel(install: { _ in
        throw ComponentInstallError.install(component: "OMP", detail: detail)
    })
    await model.prepare()
    let host = NSHostingView(rootView: SetupView(setup: model, omp: .missing, quit: {}))
    return host.fittingSize.height
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-11 : replié, le détail ne change pas la hauteur de la feuille, quelle que soit sa longueur")
func collapsedDetailKeepsSheetHeight() async {
    let long = (1...40).map { String(format: "Ligne %02d du détail technique.", $0) }.joined(separator: "\n")
    let oneLine = await failedSheetHeight(detail: "pkgutil absent")
    let forty = await failedSheetHeight(detail: long)
    #expect(oneLine == forty)
    #expect(forty > 0 && forty < 600)
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

// MARK: - Le clavier de la feuille (BR-2)

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-1 : feuille bloquante au repos — ↩ lance « Installer », ⎋ n'a aucun effet")
func blockingKeyboardInstallsAndIgnoresEscape() async {
    let calls = CallCounter()
    let gate = KeyboardGate()
    let model = setupModel(install: { _ in
        calls.count += 1
        await gate.wait()
    })
    let quits = CallCounter()
    let window = shortcutWindow(SetupView(setup: model, omp: .missing, quit: { quits.count += 1 }))

    // ⎋ : rien ne le consomme, la feuille n'est pas « fermée ».
    #expect(!pressEscape(on: window))
    #expect(!model.dismissed)
    #expect(model.state == .idle)

    // ↩ : « Installer » lance la préparation (l'installateur est appelé).
    #expect(pressReturn(on: window))
    await waitFor { calls.count == 1 }
    #expect(model.state == .preparing(.omp(downloaded: 0, total: 0)))
    #expect(!model.dismissed)
    #expect(quits.count == 0)
    gate.open()
    window.close()
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-1 : pendant la préparation en mode bloquant, ↩ et ⎋ restent sans effet")
func blockingKeyboardWhilePreparing() async {
    let calls = CallCounter()
    let gate = KeyboardGate()
    let model = setupModel(install: { _ in
        calls.count += 1
        await gate.wait()
    })
    model.startInstall()
    await waitFor { calls.count == 1 }
    let window = shortcutWindow(SetupView(setup: model, omp: .missing, quit: {}))

    // « Installer » et « Réessayer » éteints, aucun proéminent : ↩ n'est pas pris.
    #expect(!pressReturn(on: window))
    #expect(!pressEscape(on: window))
    #expect(!model.dismissed)
    #expect(calls.count == 1)
    gate.open()
    window.close()
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-2 : ⌘Q déclenche « Quitter » de la feuille bloquante, même pendant la préparation")
func blockingCommandQQuits() async {
    let quits = CallCounter()
    let idle = setupModel()
    let idleWindow = shortcutWindow(SetupView(setup: idle, omp: .missing, quit: { quits.count += 1 }))
    #expect(pressCommandQ(on: idleWindow))
    #expect(quits.count == 1)
    idleWindow.close()

    let gate = KeyboardGate()
    let busy = setupModel(install: { _ in await gate.wait() })
    busy.startInstall()
    await waitFor { busy.state == .preparing(.omp(downloaded: 0, total: 0)) }
    let busyWindow = shortcutWindow(SetupView(setup: busy, omp: .missing, quit: { quits.count += 1 }))
    #expect(pressCommandQ(on: busyWindow))
    #expect(quits.count == 2)
    gate.open()
    busyWindow.close()

    // En mode fermable, la feuille n'a pas de « Quitter » : ⌘Q revient au menu.
    let closable = setupModel()
    let closableWindow = shortcutWindow(SetupView(setup: closable, omp: ompAvailable, quit: { quits.count += 1 }))
    #expect(!pressCommandQ(on: closableWindow))
    #expect(quits.count == 2)
    closableWindow.close()
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-3 : « Réessayer » sans OMP laisse la feuille bloquante, sans « Fermer », ⎋ toujours sans effet")
func blockingRetryWithoutOmpStaysBlocking() async {
    let calls = CallCounter()
    let model = setupModel(install: { _ in calls.count += 1 })
    model.refreshOmp = { false }
    let window = shortcutWindow(SetupView(setup: model, omp: .missing, quit: {}))

    model.retry()
    model.retry()
    try? await Task.sleep(for: .milliseconds(100))
    #expect(model.retryMissed)
    #expect(calls.count == 0)
    #expect(model.state == .idle)
    let footer = SetupPresentation.footer(state: model.state, blocking: true)
    #expect(!(footer.leading + footer.trailing).contains(.close))
    #expect(!pressEscape(on: window))
    #expect(!model.dismissed)
    window.close()
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-4 : OMP présent, ↩ et ⎋ ferment la feuille dans tous les états ; sur l'échec ↩ relance la chaîne")
func closableKeyboardClosesEverywhere() async {
    // Au repos : le proéminent est « Fermer » — ↩ ET ⎋ la ferment.
    let idle = setupModel()
    let idleWindow = shortcutWindow(SetupView(setup: idle, omp: ompAvailable, quit: {}))
    #expect(pressReturn(on: idleWindow))
    #expect(idle.dismissed)
    idle.present()
    #expect(pressEscape(on: idleWindow))
    #expect(idle.dismissed)
    idleWindow.close()

    // En cours : la chaîne est suspendue à la porte, la même paire reste liée, et
    // fermer n'interrompt rien.
    let gate = KeyboardGate()
    let busy = setupModel(install: { _ in await gate.wait() })
    Task { await busy.prepare() }
    await waitFor { busy.state == .preparing(.omp(downloaded: 0, total: 0)) }
    let busyWindow = shortcutWindow(SetupView(setup: busy, omp: ompAvailable, quit: {}))
    #expect(pressReturn(on: busyWindow))
    #expect(busy.dismissed)
    busy.present()
    #expect(pressEscape(on: busyWindow))
    #expect(busy.dismissed)
    #expect(busy.state == .preparing(.omp(downloaded: 0, total: 0)))

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
    let failedWindow = shortcutWindow(SetupView(setup: failing, omp: ompAvailable, quit: {}))
    #expect(pressReturn(on: failedWindow))
    #expect(!failing.dismissed)
    await waitFor { calls.count == 2 }
    #expect(failing.dismissed == false)
    #expect(pressEscape(on: failedWindow))
    #expect(failing.dismissed)
    failedWindow.close()
}

// MARK: - AC-6 : la reprise de l'ancienne pile (BR-9)

/// Un modèle qui échoue sur le conflit de port legacy, avec une reprise fournie.
@MainActor
private func legacyConflictModel(
    takeover: @escaping @MainActor () async throws -> Void = {}
) -> SetupModel {
    SetupModel(
        install: { _ in },
        migrate: { _ in },
        ensureStack: { _ in
            throw MemoryStackError.portConflict(port: 8321, owner: .legacyStack(container: "mem0-http"))
        },
        probeOMLX: { .unknown },
        takeover: takeover,
        autoPrepare: false
    )
}

private let legacyConflictFailure = SetupFailure.stack(
    .portConflict(port: 8321, owner: .legacyStack(container: "mem0-http"))
)

@Test("bug-embedded-podman-machine/AC-6 : la reprise n'apparaît QUE sur un conflit tenu par l'ancienne pile")
func takeoverShownOnlyForLegacyConflict() {
    let legacy = SetupState.failed(legacyConflictFailure)
    let foreign = SetupState.failed(.stack(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))))

    #expect(SetupPresentation.showsTakeover(legacy))
    #expect(!SetupPresentation.showsTakeover(foreign))
    #expect(!SetupPresentation.showsTakeover(.failed(.components(.unsupportedMac))))
    #expect(!SetupPresentation.showsTakeover(.preparing(.health)))
    #expect(!SetupPresentation.showsTakeover(.ready))
    #expect(!SetupPresentation.showsTakeover(.idle))

    // Sur le conflit legacy, la reprise passe devant et porte ↩ ; « Réessayer »
    // reste visible et « Fermer » n'est plus proéminent.
    #expect(SetupPresentation.footer(state: legacy, blocking: false)
        == SetupFooter(leading: [], trailing: [.takeover, .retry, .close], prominent: .takeover, disabled: []))
    // Un conflit tenu par un autre programme garde le pied d'échec ordinaire.
    #expect(SetupPresentation.footer(state: foreign, blocking: false)
        == SetupFooter(leading: [], trailing: [.retry, .close], prominent: .retry, disabled: []))

    // Pendant l'action, les DEUX boutons restent affichés et DÉSACTIVÉS ; « Fermer »
    // garde ⎋ et reste la seule issue.
    #expect(SetupPresentation.showsTakeover(.preparing(.legacyStop)))
    #expect(SetupPresentation.footer(state: .preparing(.legacyStop), blocking: false)
        == SetupFooter(leading: [], trailing: [.takeover, .retry, .close], prominent: .takeover, disabled: [.takeover, .retry]))
    #expect(SetupPresentation.label(.takeover) == "Arrêter l'ancienne pile et reprendre")
}

@MainActor
@Test("bug-embedded-podman-machine/AC-6 : ↩ porte la REPRISE (pas « Réessayer »), ⎋ ferme, et l'action désactive les deux boutons")
func keyboardPrefersTakeoverAndEscapeCloses() async {
    let gate = KeyboardGate()
    let calls = CallCounter()
    let model = legacyConflictModel(takeover: {
        calls.count += 1
        await gate.wait()
    })

    Task { await model.prepare() }
    await waitFor { model.state == .failed(legacyConflictFailure) }

    let window = shortcutWindow(SetupView(setup: model, omp: ompAvailable, quit: {}))
    // ↩ déclenche la reprise : « Réessayer » n'a plus de raccourci dans ce cas.
    #expect(pressReturn(on: window))
    await waitFor { calls.count == 1 }
    await waitFor { model.state == .preparing(.legacyStop) }
    #expect(SetupPresentation.footer(state: model.state, blocking: false).disabled == [.takeover, .retry])

    // Un second ↩ n'atteint pas un bouton désactivé : le compteur ne bouge pas.
    _ = pressReturn(on: window)
    #expect(calls.count == 1)

    // ⎋ reste « Fermer », même pendant l'action.
    #expect(pressEscape(on: window))
    #expect(model.dismissed)

    gate.open()
    window.close()
}
