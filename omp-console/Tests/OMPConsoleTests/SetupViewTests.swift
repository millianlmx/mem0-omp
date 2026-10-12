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
        migrate: { _ in .alreadyDone },
        switchOver: { _, _ in },
        ensureAgent: { _ in },
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
    #expect(idle.map(\.kind) == [.components, .migration, .service, .prerequisites])
    #expect(idle.map(\.status) == [.upcoming, .upcoming, .upcoming, .upcoming])

    // Téléchargement d'OMP : la ligne Composants est en cours, SANS détail — le
    // détail et la barre vivent dans le bloc de progression.
    let downloading = SetupPresentation.rows(state: .preparing(.omp(downloaded: 25, total: 100)), omlx: .unknown, blocking: false)
    #expect(downloading.map(\.status) == [.running, .upcoming, .upcoming, .upcoming])
    #expect(downloading[0].detail == nil)
    #expect(downloading.allSatisfy { $0.technicalDetail == nil })

    // Service mémoire : composants et migration terminés, le service en cours.
    let service = SetupPresentation.rows(state: .preparing(.agent), omlx: .unknown, blocking: false)
    #expect(service.map(\.status) == [.done, .done, .running, .upcoming])
    #expect(service[2].detail == nil)

    // Vérification des prérequis : les trois premières lignes sont terminées.
    let prerequisites = SetupPresentation.rows(state: .preparing(.prerequisites), omlx: .unknown, blocking: false)
    #expect(prerequisites.map(\.status) == [.done, .done, .done, .running])

    // Prêt : tout est terminé, et la ligne Prérequis porte le mot oMLX.
    let ready = SetupPresentation.rows(state: .ready, omlx: .unauthorized, blocking: false)
    #expect(ready.map(\.status) == [.done, .done, .done, .done])
    #expect(ready[3].detail == "Clé refusée")
    #expect(SetupPresentation.rows(state: .ready, omlx: .reachable, blocking: false)[3].detail == "Disponible")

    // Échec de la migration : Composants terminé, Migration échouée avec la phrase
    // claire et le détail technique à part, le reste à venir.
    let failed = SetupPresentation.rows(state: .failed(.migration(.historyCopyFailed(detail: "disque plein"))), omlx: .unknown, blocking: false)
    #expect(failed.map(\.status) == [.done, .failed, .upcoming, .upcoming])
    #expect(failed[1].detail == "\(SetupText.failureHistoryCopy) \(SetupText.failureRetryGesture)")
    #expect(failed[1].technicalDetail == "disque plein")
    #expect(failed.filter { $0.status != .failed }.allSatisfy { $0.technicalDetail == nil })

    // Échec des composants : aucune ligne n'est marquée terminée à tort.
    let failingComponents = SetupPresentation.rows(state: .failed(.components(.unsupportedMac)), omlx: .unknown, blocking: false)
    #expect(failingComponents.map(\.status) == [.failed, .upcoming, .upcoming, .upcoming])
    #expect(failingComponents[0].detail == "Ce Mac n’est pas pris en charge (arm64 requis).")
    #expect(failingComponents[0].technicalDetail == nil)

    // Échec du service mémoire : seules les deux premières lignes sont terminées.
    let failingStack = SetupPresentation.rows(
        state: .failed(.agent(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711)))),
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
    #expect(!SetupPresentation.showsDone(state: .failed(.agent(.healthTimeout(seconds: 30, log: ""))), blocking: false))
}

/// Un état de chaque sorte, pour parcourir la table du pied.
private let preparingStates: [SetupState] = [
    .preparing(.omp(downloaded: 0, total: 0)),
    .preparing(.migrationImport),
    .preparing(.agent),
    .preparing(.prerequisites),
]
private let failedStates: [SetupState] = [
    .failed(.components(.unsupportedMac)),
    .failed(.agent(.healthTimeout(seconds: 30, log: ""))),
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
        == ["Installer", "Réessayer", "Quitter", "Fermer", "Basculer quand même"])
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
        == SetupProgress(label: "Téléchargement d’OMP — 40 %", fraction: 0.4))

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
        == SetupProgress(label: "Téléchargement d’OMP…", fraction: nil))
    #expect(SetupPresentation.progress(state: .preparing(.ompInstall))
        == SetupProgress(label: "Installation d’OMP…", fraction: nil))
    #expect(SetupPresentation.progress(state: .preparing(.agent))
        == SetupProgress(label: "Démarrage du service mémoire…", fraction: nil))
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
         "Ce Mac n’est pas pris en charge (arm64 requis).", nil),
        (.components(.network(component: "OMP", detail: "NSURLErrorDomain -1009")),
         "Pas de réseau : « OMP » n’a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez.", "NSURLErrorDomain -1009"),
        (.components(.checksum(component: "OMP")),
         "« OMP » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue.", nil),
        (.components(.install(component: "OMP", detail: "chmod refusé")),
         "L’installation de « OMP » a échoué.", "chmod refusé"),
        (.migration(.historyCopyFailed(detail: "disque plein")),
         "\(SetupText.failureHistoryCopy) \(SetupText.failureRetryGesture)", "disque plein"),
        (.migration(.machineFailed(detail: "libkrun absent")),
         "\(SetupText.failureLegacyMachine) \(SetupText.failureRetryGesture)", "libkrun absent"),
        (.migration(.importFailed(code: 1, detail: "base verrouillée")),
         "\(SetupText.failureImport) \(SetupText.failureRetryGesture)", "code 1\u{00A0}: base verrouillée"),
        (.agent(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))),
         SetupText.failureMessage(.agent(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711)))),
         "Geste\u{00A0}: arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)"),
        (.agent(.launchctlFailed(command: "bootstrap", detail: "boom")),
         "\(SetupText.failureAgentLaunch) \(SetupText.failureRetryGesture)", "bootstrap\u{00A0}: boom"),
        (.agent(.healthTimeout(seconds: 30, log: "")),
         "\(SetupText.failureAgentHealth) \(SetupText.failureRetryGesture)", nil),
        (.agent(.installationFailed(detail: "disque plein")),
         "\(SetupText.failureAgentIdentity) \(SetupText.failureRetryGesture)", "disque plein"),
    ]
    for (failure, summary, detail) in table {
        #expect(SetupText.failureSummary(failure) == summary)
        #expect(SetupText.failureDetail(failure) == detail)
        // La phrase claire ne porte jamais le détail technique.
        if let detail { #expect(!SetupText.failureSummary(failure).contains(detail)) }
    }

    // Les échecs de la migration et du service mémoire (S-5 d'omp-console-sans-podman) :
    // la phrase de la feuille est la conséquence suivie du geste, sans commande,
    // port ni pid.
    for failure: SetupFailure in [
        .migration(.stopFailed(detail: "socket fermé")),
        .migration(.machineFailed(detail: "libkrun absent")),
        .agent(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))),
        .agent(.launchctlFailed(command: "bootstrap", detail: "boom")),
    ] {
        let summary = SetupText.failureSummary(failure)
        #expect(summary.hasPrefix(SetupText.failureConsequence(failure)))
        for token in ["Podman", "podman", "bootstrap", "6333", "8321", "4711", "mem0-", "lsof"] {
            #expect(!summary.contains(token))
        }
    }

    // Un détail vide ou fait de blancs n'ouvre aucun « Afficher le détail ».
    for blank in ["", "   ", "\n\t \n"] {
        #expect(SetupText.failureDetail(.components(.install(component: "OMP", detail: blank))) == nil)
        #expect(SetupText.failureDetail(.components(.network(component: "OMP", detail: blank))) == nil)
        #expect(SetupText.failureDetail(.migration(.historyCopyFailed(detail: blank))) == nil)
        #expect(SetupText.failureDetail(.migration(.stopFailed(detail: blank))) == nil)
        #expect(SetupText.failureDetail(.agent(.installationFailed(detail: blank))) == nil)
        #expect(SetupText.failureDetail(.migration(.machineFailed(detail: blank))) == nil)
        #expect(SetupText.failureDetail(.agent(.healthTimeout(seconds: 30, log: blank))) == nil)
        #expect(SetupText.failureDetail(.agent(.launchctlFailed(command: "bootstrap", detail: blank))) == nil)
    }

    // Le bandeau de l'Accueil et l'API distante gardent leur phrase complète.
    #expect(SetupText.failureMessage(.components(.install(component: "OMP", detail: "chmod refusé")))
        == "L’installation de « OMP » a échoué : chmod refusé")
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
    let oneLine = await failedSheetHeight(detail: "chmod refusé")
    let forty = await failedSheetHeight(detail: long)
    #expect(oneLine == forty)
    #expect(forty > 0 && forty < 600)
}

@Test("all-in-one-app/AC-2 : le bandeau de l'Accueil ne paraît qu'après « Fermer », et dit l'étape ou l'échec")
func bannerFollowsDismissedState() {
    // Feuille visible : aucun bandeau, c'est la feuille qui porte l'état.
    #expect(SetupText.banner(state: .preparing(.agent), dismissed: false) == nil)
    #expect(SetupText.banner(state: .failed(.components(.unsupportedMac)), dismissed: false) == nil)

    // Fermée pendant la préparation : le bandeau dit l'étape courante.
    #expect(SetupText.banner(state: .preparing(.agent), dismissed: true)
        == "Préparation en cours — Démarrage du service mémoire…")
    #expect(SetupText.banner(state: .preparing(.omp(downloaded: 40, total: 100)), dismissed: true)
        == "Préparation en cours — Téléchargement d’OMP — 40 %")

    // Fermée après un échec : le bandeau dit la cause.
    #expect(SetupText.banner(state: .failed(.agent(.healthTimeout(seconds: 30, log: ""))), dismissed: true)
        == "Préparation incomplète. Le service mémoire n’a pas répondu\u{00A0}: les souvenirs sont indisponibles.")
    #expect(SetupText.banner(state: .failed(.components(.checksum(component: "OMP"))), dismissed: true)
        == "Préparation incomplète. « OMP » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue.")

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

// MARK: - omp-console-sans-podman (S-3, S-5)

@Test("omp-console-sans-podman/AC-5 : la feuille d'un port occupé nomme le programme et propose Réessayer")
func portConflictNamesProgramAndOffersRetry() {
    let failure = SetupFailure.agent(.portConflict(port: 8321, owner: .foreign(process: "nc", pid: 4711)))
    let state = SetupState.failed(failure)

    let rows = SetupPresentation.rows(state: state, omlx: .unknown, blocking: false)
    #expect(rows.map(\.status) == [.done, .done, .failed, .upcoming])
    let failedRow = rows.first { $0.status == .failed }
    #expect(failedRow?.kind == .service)

    let summary = SetupText.failureSummary(failure)
    #expect(summary == "Le programme «\u{00A0}nc\u{00A0}» occupe la place réservée à la mémoire\u{00A0}: celle-ci ne peut pas démarrer. Quittez-le, puis réessayez.")
    #expect(failedRow?.detail == summary)
    let banner = SetupText.banner(state: state, dismissed: true) ?? ""
    #expect(banner == "Préparation incomplète. Le programme «\u{00A0}nc\u{00A0}» occupe la place réservée à la mémoire\u{00A0}: celle-ci ne peut pas démarrer.")
    for text in [summary, banner] {
        #expect(!text.contains("8321"))
        #expect(!text.contains("4711"))
        #expect(forbiddenTokens(in: text).isEmpty, "texte : \(text)")
    }

    #expect(SetupPresentation.footer(state: state, blocking: false)
        == SetupFooter(leading: [], trailing: [.retry, .close], prominent: .retry, disabled: []))
    #expect(SetupPresentation.diagnostic(state: state)
        == "Le port 8321 est déjà tenu par un autre programme (nc, pid 4711)\u{00A0}: la mémoire ne peut pas démarrer.\nGeste\u{00A0}: arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)")

    // Propriétaire inconnu : la conséquence générique et le geste commun.
    let unknown = SetupFailure.agent(.portConflict(port: 8321, owner: .unknown(detail: "lsof illisible")))
    #expect(SetupText.failureSummary(unknown) == SetupText.failurePortOther + " " + SetupText.failureRetryGesture)
    #expect(forbiddenTokens(in: SetupText.failureSummary(unknown)).isEmpty)
}

@Test("omp-console-sans-podman/AC-8 : chaque échec du service mémoire s'affiche lisible avec son geste")
func agentFailuresReadableWithGesture() {
    let retry = SetupText.failureRetryGesture
    let table: [(MemoryAgentError, String)] = [
        (.binaryMissing(path: "/Applications/OMP Console.app/Contents/Resources/mem0-rs"),
         "Le service mémoire manque dans l’app\u{00A0}: les souvenirs sont indisponibles. Réinstallez OMP Console."),
        (.launchctlFailed(command: "bootstrap", detail: "Input/output error"),
         "Le service mémoire n’a pas pu être lancé\u{00A0}: les souvenirs sont indisponibles. \(retry)"),
        (.plistWriteFailed(path: "/Users/x/Library/LaunchAgents/com.omp.console.mem0.plist", detail: "permission refusée"),
         "Le service mémoire n’a pas pu être lancé\u{00A0}: les souvenirs sont indisponibles. \(retry)"),
        (.healthTimeout(seconds: 30, log: "panic: qdrant"),
         "Le service mémoire n’a pas répondu\u{00A0}: les souvenirs sont indisponibles. \(retry)"),
        (.installationFailed(detail: "disque plein"),
         "L’identité de la mémoire n’a pas pu être écrite\u{00A0}: les souvenirs sont indisponibles. \(retry)"),
        (.portConflict(port: 8321, owner: .unknown(detail: "lsof illisible")),
         "La place réservée à la mémoire est occupée\u{00A0}: celle-ci ne peut pas démarrer. \(retry)"),
    ]
    #expect(retry == "Réessayez\u{00A0}; si l’échec revient, copiez le diagnostic pour le signaler.")
    for (error, expected) in table {
        let failure = SetupFailure.agent(error)
        let summary = SetupText.failureSummary(failure)
        #expect(summary == expected)
        #expect(forbiddenTokens(in: summary).isEmpty, "phrase : \(summary)")
        let rows = SetupPresentation.rows(state: .failed(failure), omlx: .unknown, blocking: false)
        #expect(rows.first { $0.status == .failed }?.kind == .service)
        #expect(SetupPresentation.footer(state: .failed(failure), blocking: false)
            == SetupFooter(leading: [], trailing: [.retry, .close], prominent: .retry, disabled: []))
    }

    #expect(SetupText.failureDiagnostic(.agent(.healthTimeout(seconds: 30, log: "ligne 1\nligne 2")), logPath: "/tmp/mem0-rs.log")
        == "Le service mémoire n’a pas répondu dans le délai imparti (30 s).\nJournal\u{00A0}: /tmp/mem0-rs.log\nligne 1\nligne 2")
}

private func reject(_ element: String, _ id: String, _ raison: String, _ detail: String) -> ImportReject {
    ImportReject(element: element, id: id, raison: raison, detail: detail)
}

@Test("omp-console-sans-podman/AC-9 : les rejets se groupent par raison, du plus fréquent au plus rare, et le détail liste chaque élément")
func rejectedGroupedByReason() {
    let report = ImportReport(rejects: [
        reject("souvenir", "a1", "texte_absent", "payload.data vide"),
        reject("souvenir", "a2", "vecteur_absent", "point sans vecteur"),
        reject("souvenir", "a3", "texte_absent", "payload.data vide"),
        reject("historique", "h1", "code_mystere", "inconnu"),
        reject("souvenir", "a4", "dimension", "768 ≠ 1024"),
        reject("souvenir", "a5", "vecteur_absent", "point sans vecteur"),
    ], totalRejected: 6)
    // 2 × texte absent, 2 × vecteur absent (égalité ⇒ libellé), puis les uniques
    // par libellé ; le code inconnu reste brut.
    #expect(SetupText.rejectedSummary(report)
        == "L’import a laissé de côté 6 éléments\u{00A0}: texte absent (2), vecteur absent (2), code_mystere (1), dimension inattendue (1).")
    #expect(SetupText.rejectedDetail(report) == """
        souvenir a1 — texte absent (payload.data vide)
        souvenir a2 — vecteur absent (point sans vecteur)
        souvenir a3 — texte absent (payload.data vide)
        historique h1 — code_mystere (inconnu)
        souvenir a4 — dimension inattendue (768 ≠ 1024)
        souvenir a5 — vecteur absent (point sans vecteur)
        """)

    let single = ImportReport(rejects: [reject("historique", "h9", "historique_orphelin", "mémoire absente")], totalRejected: 1)
    #expect(SetupText.rejectedSummary(single) == "L’import a laissé de côté 1 élément\u{00A0}: historique orphelin (1).")
    #expect(SetupText.rejectedDetail(single) == "historique h9 — historique orphelin (mémoire absente)")
    #expect(SetupText.rejectionReason("champ_invalide") == "champ invalide")
}

@Test("omp-console-sans-podman/AC-9 : la feuille des rejets propose Basculer quand même sans raccourci, Réessayer proéminent et Fermer")
func awaitingSwitchSheet() {
    let report = ImportReport(
        rejects: [reject("souvenir", "a1", "vecteur_absent", "point sans vecteur")],
        totalRejected: 1,
        raw: "{\"agents\":[]}"
    )
    let state = SetupState.awaitingSwitch(report)

    #expect(SetupPresentation.footer(state: state, blocking: false)
        == SetupFooter(leading: [], trailing: [.switchAnyway, .retry, .close], prominent: .retry, disabled: []))
    #expect(SetupPresentation.label(.switchAnyway) == "Basculer quand même")

    let rows = SetupPresentation.rows(state: state, omlx: .unknown, blocking: false)
    #expect(rows.map(\.kind) == [.components, .migration, .service, .prerequisites])
    #expect(rows.map(\.status) == [.done, .awaiting, .upcoming, .upcoming])
    #expect(rows[1].detail == SetupText.rejectedSummary(report))
    #expect(rows[1].technicalDetail == SetupText.rejectedDetail(report))
    #expect(rows[1].note == SetupText.rejectedChoice)
    #expect(SetupText.rejectedChoice
        == "«\u{00A0}Basculer quand même\u{00A0}» démarre la nouvelle mémoire sans eux\u{00A0}; l’ancienne reste intacte sur ce Mac. «\u{00A0}Réessayer\u{00A0}» relance l’import.")
    #expect(SetupPresentation.progress(state: state) == nil)
    #expect(!SetupPresentation.showsDone(state: state, blocking: false))
    #expect(SetupPresentation.diagnostic(state: state) == "{\"agents\":[]}")
    #expect(SetupText.banner(state: state, dismissed: true)
        == "Préparation incomplète. L’import de l’ancienne mémoire attend votre choix sur le Mac.")
}

@Test("omp-console-sans-podman/AC-6 : les étapes de migration et du service mémoire ont leur ligne et leur libellé")
func migrationAndServiceStepsHaveRowAndLabel() {
    let table: [(SetupStep, SetupRow.Kind, String)] = [
        (.migrationStart, .migration, "Démarrage de l’ancienne mémoire…"),
        (.migrationImport, .migration, "Reprise des souvenirs de l’ancienne mémoire…"),
        (.migrationStop, .migration, "Arrêt de l’ancienne mémoire…"),
        (.agent, .service, "Démarrage du service mémoire…"),
        (.health, .service, "Attente de la mémoire…"),
        (.ompInstall, .components, "Installation d’OMP…"),
        (.prerequisites, .prerequisites, "Vérification des prérequis…"),
    ]
    for (step, kind, label) in table {
        #expect(step.row == kind)
        #expect(SetupText.stepDetail(step) == label)
        #expect(SetupPresentation.progress(state: .preparing(step)) == SetupProgress(label: label, fraction: nil))
        let rows = SetupPresentation.rows(state: .preparing(step), omlx: .unknown, blocking: false)
        #expect(rows.first { $0.status == .running }?.kind == kind)
    }
    #expect(SetupText.body
        == "OMP Console installe OMP, reprend si besoin l’ancienne mémoire, puis démarre son service mémoire. Cette étape n’a lieu qu’une fois.")
    #expect(SetupRow.Kind.allCases.map(SetupPresentation.title)
        == ["Composants", "Migration de la mémoire", "Service mémoire", "Prérequis"])
}
