// Preuves de la feuille d'appairage (S-5, S-6, S-14 ; BR-9) : le code affiché est
// celui que le service accepte (AC-4, sans terminal), les cinq états de la zone
// code, les états de la liste des appareils, la présentation pure du code et les
// identifiants d'accessibilité.
//
// Les états et les textes se prouvent sans rendre de SwiftUI (ce que la vue LIT) ;
// la feuille se rend en plus dans une vraie `NSWindow` hors écran (`NSHostingView`),
// ce qui exécute ses `ViewBuilder` sur le modèle réel et prouve que « Fermer »
// (action par défaut) répond à ↩.

import AppKit
import Foundation
import SwiftUI
import Testing

@testable import OMPConsole
import ConsoleCore

// MARK: - Fixtures

/// Une horloge que le test fait avancer sans dormir (patron `StoreClock`).
private final class PairingClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Double

    init(_ start: Double) { value = start }

    var nowMs: Double {
        get { lock.lock(); defer { lock.unlock() }; return value }
        set { lock.lock(); value = newValue; lock.unlock() }
    }

    var clock: RemoteClock { RemoteClock { [self] in nowMs } }
}

/// Un registre jetable : fichier temporaire, jetons en mémoire.
@MainActor
private final class PairingFixture {
    let root: URL
    let clock: PairingClock
    let registry: DeviceRegistry

    init(nowMs: Double = 1_000_000) {
        root = URL(fileURLWithPath: (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("omp-console-pairing-\(UUID().uuidString)"))
        clock = PairingClock(nowMs)
        registry = DeviceRegistry(
            file: root.appendingPathComponent("devices.json"),
            store: InMemoryDeviceTokenStore(),
            clock: clock.clock
        )
    }

    deinit { try? FileManager.default.removeItem(at: root) }
}

/// Rend une vue dans une `NSWindow` hors écran et laisse SwiftUI s'installer
/// (patron `SetupViewTests` ; `isReleasedWhenClosed = false` : sans lui, `close()`
/// sur-rend la fenêtre et le test suivant meurt).
@MainActor
private func pairingWindow(_ view: some View) -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 560, height: 420),
        styleMask: [.titled, .closable],
        backing: .buffered,
        defer: false
    )
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: view)
    _ = RunLoop.main.run(until: Date().addingTimeInterval(0.25))
    return window
}

@MainActor
private func pressReturn(on window: NSWindow) -> Bool {
    guard let event = NSEvent.keyEvent(
        with: .keyDown,
        location: .zero,
        modifierFlags: [],
        timestamp: ProcessInfo.processInfo.systemUptime,
        windowNumber: window.windowNumber,
        context: nil,
        characters: "\r",
        charactersIgnoringModifiers: "\r",
        isARepeat: false,
        keyCode: 36
    ) else { return false }
    return window.performKeyEquivalent(with: event)
}

// MARK: - AC-4 : le code affiché est celui du service

@MainActor
@Test("api-distante-du-console/AC-4 : la coque affiche un code et un appareil peut s'appairer sans terminal")
func pairingSheetCodeMatchesTheService() async throws {
    let fixture = PairingFixture()
    let model = PairingModel(registry: fixture.registry, clock: fixture.clock.clock)
    await fixture.registry.load()

    // « Générer un code » : le code affiché EST celui que le service tient.
    model.generate()
    let active = try #require(model.code)
    #expect(active.value.count == ConsoleAPI.Service.pairingCodeLength)
    #expect(fixture.registry.pairing.current?.value == active.value, "le service tient le code affiché")
    #expect(model.countdown == "02:00")

    // Le code AFFICHÉ est groupé `XXXX-XXXX` ; privé de ses tirets, c'est celui
    // qu'un appareil distant saisit.
    let displayed = PairingPresentation.grouped(active.value)
    #expect(displayed.count == 9)
    #expect(displayed.filter { $0 != "-" } == active.value)
    #expect(model.error == nil)

    // Appairage SANS terminal : le service accepte ce code et inscrit l'appareil.
    let paired = try await fixture.registry.pair(
        code: displayed.replacingOccurrences(of: "-", with: ""),
        name: "iPhone de test"
    )
    #expect(paired.device.name == "iPhone de test")
    #expect(fixture.registry.devices.count == 1)
    #expect(fixture.registry.pairing.current == nil, "un code est à usage unique")

    // L'appareil apparaît AUSSITÔT dans la liste de la feuille (S-6).
    let zone = PairingSheet.devicesZone(isLoaded: true, loadError: nil, devices: fixture.registry.devices)
    guard case .devices(let devices) = zone else {
        Issue.record("un appareil appairé doit rendre la liste")
        return
    }
    #expect(devices.map(\.name) == ["iPhone de test"])
}

// MARK: - Les cinq états de la zone code (S-5)

@MainActor
@Test("PairingSheet : les cinq états de la zone code — aucun, actif, expiré, service coupé, service en échec")
func codeZoneStates() async throws {
    let fixture = PairingFixture()
    let model = PairingModel(registry: fixture.registry, clock: fixture.clock.clock)
    await fixture.registry.load()
    let running = RemoteServiceState.running(address: "192.168.1.12:8787")

    // aucun
    model.refresh()
    #expect(model.code == nil)
    #expect(PairingSheet.codeZone(enabled: true, state: running, code: model.code, countdown: model.countdown) == .none)
    #expect(PairingText.noCode == "Aucun code actif.")

    // actif : le code et son compte à rebours.
    model.generate()
    let active = try #require(model.code)
    #expect(PairingSheet.codeZone(enabled: true, state: running, code: model.code, countdown: model.countdown)
        == .active(code: active.value, countdown: "02:00"))

    // expiré : retour à aucun, SANS message d'erreur.
    fixture.clock.nowMs += Double(ConsoleAPI.Service.pairingCodeTTLSeconds) * 1000
    model.refresh()
    #expect(model.code == nil)
    #expect(model.countdown == nil)
    #expect(model.error == nil)
    #expect(PairingSheet.codeZone(enabled: true, state: running, code: model.code, countdown: model.countdown) == .none)

    // service coupé : zone remplacée, bouton désactivé.
    let off = PairingSheet.codeZone(enabled: false, state: .off, code: nil, countdown: nil)
    #expect(off == .serviceOff)
    #expect(off.isGeneratable == false)
    #expect(PairingText.serviceOff == "Le service est coupé.")

    // service en échec et service refusé : le message d'état, bouton désactivé.
    let failed = PairingSheet.codeZone(
        enabled: true, state: .failed(reason: "port occupé"), code: nil, countdown: nil
    )
    #expect(failed == .serviceUnavailable("Échec : port occupé"))
    #expect(failed.isGeneratable == false)
    let denied = PairingSheet.codeZone(enabled: true, state: .denied(reason: "x"), code: nil, countdown: nil)
    #expect(denied == .serviceUnavailable("Accès au réseau local refusé à OMP Console."))
    #expect(denied.isGeneratable == false)
}

// MARK: - Les états de la liste des appareils (S-6)

@MainActor
@Test("api-distante-du-console/S-6 : les états de la liste — chargement, erreur, vide, succès, révocation en cours")
func devicesZoneStates() {
    // chargement : le registre n'est pas encore lu.
    #expect(PairingSheet.devicesZone(isLoaded: false, loadError: nil, devices: []) == .loading)
    #expect(PairingText.devicesLoading == "Chargement des appareils…")

    // erreur : le message vient du registre, jamais d'un second littéral.
    let reason = "fichier illisible (devices.json)"
    #expect(PairingSheet.devicesZone(isLoaded: true, loadError: reason, devices: []) == .unreadable(reason: reason))
    #expect(PairingText.registryUnreadable(reason: reason) == DeviceRegistry.loadMessage(reason))
    #expect(PairingText.registryUnreadable(reason: reason) == "Le registre des appareils est illisible : \(reason)")

    // vide
    #expect(PairingSheet.devicesZone(isLoaded: true, loadError: nil, devices: []) == .empty)
    #expect(PairingText.devicesEmpty == "Aucun appareil appairé.")

    // succès
    let device = DeviceRecord(id: UUID(), name: "iPhone", pairedAtMs: 1_000, lastSeenAtMs: 2_000)
    #expect(PairingSheet.devicesZone(isLoaded: true, loadError: nil, devices: [device]) == .devices([device]))

    // révocation en cours : « Révocation… », désactivé.
    #expect(PairingSheet.revokeControl(inProgress: true)
        == PairingRevokeControl(label: "Révocation…", disabled: true))
    #expect(PairingSheet.revokeControl(inProgress: false)
        == PairingRevokeControl(label: "Révoquer", disabled: false))
    #expect(PairingText.revoke == "Révoquer")
    #expect(PairingText.revoking == "Révocation…")
}

// MARK: - États et textes du service (S-14)

@MainActor
@Test("api-distante-du-console/S-14 : chaque état du service a son mot et son action")
func serviceStatusStates() {
    #expect(PairingSheet.serviceStatus(.off) == ConsoleStatus(text: "Coupé", tone: .neutral))
    #expect(PairingSheet.serviceStatus(.starting) == ConsoleStatus(text: "Démarrage…", tone: .info))
    #expect(PairingSheet.serviceStatus(.running(address: "192.168.1.12:8787"))
        == ConsoleStatus(text: "Actif — 192.168.1.12:8787", tone: .success))
    #expect(PairingSheet.serviceStatus(.denied(reason: "x"))
        == ConsoleStatus(text: "Accès au réseau local refusé à OMP Console.", tone: .attention))
    #expect(PairingText.openLocalNetworkSettings == "Ouvrir Réglages Système")
    #expect(PairingSheet.localNetworkSettingsURL
        == "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
    #expect(PairingSheet.serviceStatus(.failed(reason: "port occupé"))
        == ConsoleStatus(text: "Échec : port occupé", tone: .danger))
    #expect(PairingText.retry == "Réessayer")
    #expect(PairingText.toggle == "Service d'API distante")
    #expect(PairingText.title == "API distante")
    #expect(PairingText.close == "Fermer")
    #expect(PairingText.menuItem == "Appairage…")
}

// MARK: - Présentation pure du code

@Test("PairingPresentation groupe le code en XXXX-XXXX et décompte le temps restant")
func pairingPresentationIsPure() {
    #expect(PairingPresentation.grouped("ABCD2345") == "ABCD-2345")
    #expect(PairingPresentation.grouped("ABCDEF") == "ABCD-EF")
    #expect(PairingPresentation.grouped("") == "")
    #expect(PairingPresentation.countdown(expiresAtMs: 120_000, nowMs: 0) == "02:00")
    #expect(PairingPresentation.countdown(expiresAtMs: 120_000, nowMs: 61_000) == "00:59")
    #expect(PairingPresentation.countdown(expiresAtMs: 120_000, nowMs: 119_000) == "00:01")
    #expect(PairingPresentation.countdown(expiresAtMs: 120_000, nowMs: 120_000) == "00:00")
    #expect(PairingPresentation.countdown(expiresAtMs: 120_000, nowMs: 200_000) == "00:00")
    #expect(PairingText.codeExpiry("01:30") == "Code expiré dans 01:30")
}

// MARK: - Identifiants d'accessibilité

@Test("PairingSheet : les identifiants d'accessibilité de la feuille sont stables")
func accessibilityIdentifiers() {
    #expect(PairingAccessibility.sheet == "pairing.sheet")
    #expect(PairingAccessibility.toggle == "pairing.toggle")
    #expect(PairingAccessibility.generate == "pairing.generate")
    #expect(PairingAccessibility.code == "pairing.code")
    #expect(PairingAccessibility.codeExpiry == "pairing.codeExpiry")
    #expect(PairingAccessibility.address == "pairing.address")
    #expect(PairingAccessibility.devices == "pairing.devices")
    #expect(PairingAccessibility.devicesRetry == "pairing.devices.retry")
    #expect(PairingAccessibility.retry == "pairing.retry")
    #expect(PairingAccessibility.openLocalNetworkSettings == "pairing.openLocalNetworkSettings")
    #expect(PairingAccessibility.close == "pairing.close")
    let id = UUID(uuidString: "AABBCCDD-0000-1111-2222-333344445555")!
    #expect(PairingAccessibility.revoke(id) == "pairing.devices.revoke.aabbccdd-0000-1111-2222-333344445555")
}

// MARK: - Politique de feuille

@MainActor
@Test("MainSheetPolicy présente l'appairage après le contrat et avant la bienvenue")
func policyPlacesPairingAfterContractBeforeWelcome() {
    let available = OmpStatus.available(URL(fileURLWithPath: "/usr/local/bin/omp"))
    func policy(contract: ContractSheet?, pairing: Bool) -> MainSheet? {
        MainSheetPolicy.sheet(
            omp: available, setup: .ready, setupDismissed: false, board: .loading, welcomeSeen: true,
            welcomeRequested: true, launchFormShown: false, answerCardID: nil, contract: contract, pairing: pairing
        )
    }
    let sheet = ContractSheet(slug: "c", moment: .besoins, path: "/w/c.md", content: .missing)
    #expect(MainSheet.pairing.id == "pairing")
    #expect(policy(contract: nil, pairing: true) == .pairing)
    // Le contrat passe avant l'appairage ; la bienvenue vient après.
    #expect(policy(contract: sheet, pairing: true) == .contract(sheet))
    #expect(policy(contract: nil, pairing: false) == .welcome)
    // La préparation passe avant tout.
    #expect(MainSheetPolicy.sheet(
        omp: .missing, setup: .ready, setupDismissed: false, board: .loading, welcomeSeen: true,
        welcomeRequested: true, launchFormShown: false, answerCardID: nil, contract: nil, pairing: true
    ) == .setup)
}

// MARK: - La feuille se rend réellement

@MainActor
@Test("PairingSheet : la feuille se rend sur le modèle réel et ↩ active « Générer un code »")
func pairingSheetRendersAndCloses() async {
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }
    let listener = RecordingListener()
    let remote = makeRemoteServiceModel(defaults: defaults, listener: listener)
    await remote.startIfEnabled()
    remote.requestPairingSheet()
    #expect(remote.sheetShown)

    // Rendue dans une vraie fenêtre : les `ViewBuilder` s'exécutent sur le modèle
    // réel (aucune capture d'écran — le rendu graphique se juge à l'œil).
    let window = pairingWindow(
        PairingSheet(remote: remote, pairing: remote.pairing, registry: remote.registry)
    )
    defer { window.close() }
    #expect(window.contentView != nil)

    // ↩ active le bouton focalisé — « Générer un code » — et ne ferme plus la
    // feuille : « Fermer » n'est plus l'action par défaut (S-5).
    #expect(pressReturn(on: window))
    #expect(remote.sheetShown, "↩ ne referme plus la feuille")
    #expect(remote.pairing.code != nil, "↩ active « Générer un code »")
}
