// Preuves de l'onglet « Appareils » du panneau Réglages (reglages-mac-appareils,
// et les preuves encore vraies de api-distante-du-console et
// mac-feuille-appairage-debordante) : le code affiché est celui que le service
// accepte, les états de la zone code et de la liste, le cadre fixe où seule la
// liste défile, la révocation confirmée ou annulée, service actif ou coupé.
//
// Les états et les textes se prouvent sans rendre de SwiftUI (ce que la vue LIT) ;
// l'onglet se rend en plus dans une vraie `NSWindow` hors écran (`NSHostingView`),
// ce qui exécute ses `ViewBuilder` sur le modèle réel. Sous `swift test`, SwiftUI
// ne construit PAS l'arbre d'accessibilité d'une `NSHostingView` : la vue rendue se
// mesure par `fittingSize` et sa vraie `NSScrollView`, ses mots par les fonctions
// pures qu'elle rend. La lecture AX du panneau ouvert par le menu est la recette
// `scripts/mac-appairage-recette.sh`.

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
        contentRect: NSRect(x: 0, y: 0, width: PairingLayout.width, height: PairingLayout.height),
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

// MARK: - api-distante-du-console/AC-4 : le code affiché est celui du service

@MainActor
@Test("api-distante-du-console/AC-4 : la coque affiche un code et un appareil peut s'appairer sans terminal")
func pairingCodeMatchesTheService() async throws {
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
        name: "iPhone de test",
        deviceKey: nil
    )
    #expect(paired.device.name == "iPhone de test")
    #expect(fixture.registry.devices.count == 1)
    #expect(fixture.registry.pairing.current == nil, "un code est à usage unique")

    // L'appareil apparaît AUSSITÔT dans la liste de l'onglet (S-6).
    let zone = DevicesSettingsView.devicesZone(isLoaded: true, loadError: nil, devices: fixture.registry.devices)
    guard case .devices(let devices) = zone else {
        Issue.record("un appareil appairé doit rendre la liste")
        return
    }
    #expect(devices.map(\.name) == ["iPhone de test"])
}

// MARK: - Les états de la zone code (S-5)

@MainActor
@Test("DevicesSettingsView : les six états de la zone code — aucun, actif, expiré, service coupé, service en échec, refusé")
func codeZoneStates() async throws {
    let fixture = PairingFixture()
    let model = PairingModel(registry: fixture.registry, clock: fixture.clock.clock)
    await fixture.registry.load()
    let running = RemoteServiceState.running(address: "192.168.1.12:8787")
    func zone() -> PairingCodeZone {
        DevicesSettingsView.codeZone(
            enabled: true, state: running, code: model.code, countdown: model.countdown, expired: model.expired
        )
    }

    // aucun
    model.refresh()
    #expect(model.code == nil)
    #expect(model.expired == false)
    #expect(zone() == .none)
    #expect(zone().offersGenerate && zone().isGeneratable)
    #expect(PairingText.noCode == "Aucun code actif.")

    // actif : le code et son compte à rebours.
    model.generate()
    let active = try #require(model.code)
    #expect(zone() == .active(code: active.value, countdown: "02:00"))
    #expect(zone().offersGenerate && zone().isGeneratable)

    // expiré : « Code expiré », sans code, sans décompte, SANS message d'erreur.
    fixture.clock.nowMs += Double(ConsoleAPI.Service.pairingCodeTTLSeconds) * 1000
    model.refresh()
    #expect(model.code == nil)
    #expect(model.countdown == nil)
    #expect(model.error == nil)
    #expect(model.expired)
    #expect(zone() == .expired)
    #expect(zone().isGeneratable, "un code expiré se remplace par « Générer un code »")

    // Le service coupé prime sur l'échéance.
    #expect(DevicesSettingsView.codeZone(enabled: false, state: .off, code: nil, countdown: nil, expired: true) == .serviceOff)

    // service coupé : la zone ne dit que « Le service est coupé. » — aucun bouton.
    let off = DevicesSettingsView.codeZone(enabled: false, state: .off, code: nil, countdown: nil, expired: false)
    #expect(off == .serviceOff)
    #expect(off.offersGenerate == false, "service coupé, « Générer un code » n'est pas rendu")
    #expect(off.isGeneratable == false)
    #expect(PairingText.serviceOff == "Le service est coupé.")

    // service en échec et service refusé : le message d'état, bouton rendu mais désactivé.
    let failed = DevicesSettingsView.codeZone(
        enabled: true, state: .failed(reason: "port occupé"), code: nil, countdown: nil, expired: true
    )
    #expect(failed == .serviceUnavailable("Échec : port occupé"))
    #expect(failed.offersGenerate)
    #expect(failed.isGeneratable == false)
    let denied = DevicesSettingsView.codeZone(
        enabled: true, state: .denied(reason: "x"), code: nil, countdown: nil, expired: false
    )
    #expect(denied == .serviceUnavailable("Accès au réseau local refusé à OMP Console."))
    #expect(denied.offersGenerate)
    #expect(denied.isGeneratable == false)
}

// MARK: - Les états de la liste des appareils (S-6)

@MainActor
@Test("api-distante-du-console/S-6 : les états de la liste — chargement, erreur, vide, succès, révocation en cours")
func devicesZoneStates() {
    // chargement : le registre n'est pas encore lu.
    #expect(DevicesSettingsView.devicesZone(isLoaded: false, loadError: nil, devices: []) == .loading)
    #expect(PairingText.devicesLoading == "Chargement des appareils…")

    // erreur : le message vient du registre, jamais d'un second littéral.
    let reason = "fichier illisible (devices.json)"
    #expect(DevicesSettingsView.devicesZone(isLoaded: true, loadError: reason, devices: []) == .unreadable(reason: reason))
    #expect(PairingText.registryUnreadable(reason: reason) == DeviceRegistry.loadMessage(reason))
    #expect(PairingText.registryUnreadable(reason: reason) == "Le registre des appareils est illisible : \(reason)")

    // vide
    #expect(DevicesSettingsView.devicesZone(isLoaded: true, loadError: nil, devices: []) == .empty)
    #expect(PairingText.devicesEmpty == "Aucun appareil appairé.")

    // succès
    let device = DeviceRecord(id: UUID(), name: "iPhone", pairedAtMs: 1_000, lastSeenAtMs: 2_000)
    #expect(DevicesSettingsView.devicesZone(isLoaded: true, loadError: nil, devices: [device]) == .devices([device]))

    // révocation en cours : « Révocation… », désactivé.
    #expect(DevicesSettingsView.revokeControl(inProgress: true, name: "iPhone").label == "Révocation…")
    #expect(DevicesSettingsView.revokeControl(inProgress: true, name: "iPhone").disabled)
    #expect(DevicesSettingsView.revokeControl(inProgress: false, name: "iPhone").label == "Révoquer")
    #expect(DevicesSettingsView.revokeControl(inProgress: false, name: "iPhone").disabled == false)
    #expect(PairingText.revoke == "Révoquer")
    #expect(PairingText.revoking == "Révocation…")
}

// MARK: - États et textes du service (S-14)

@MainActor
@Test("api-distante-du-console/S-14 : chaque état du service a son mot et son action")
func serviceStatusStates() {
    #expect(DevicesSettingsView.serviceStatus(.off) == ConsoleStatus(text: "Coupé", tone: .neutral))
    #expect(DevicesSettingsView.serviceStatus(.starting) == ConsoleStatus(text: "Démarrage…", tone: .info))
    #expect(DevicesSettingsView.serviceStatus(.running(address: "192.168.1.12:8787"))
        == ConsoleStatus(text: "Actif", tone: .success))
    #expect(DevicesSettingsView.serviceStatus(.denied(reason: "x"))
        == ConsoleStatus(text: "Accès au réseau local refusé à OMP Console.", tone: .attention))
    #expect(PairingText.openLocalNetworkSettings == "Ouvrir Réglages Système")
    #expect(DevicesSettingsView.localNetworkSettingsURL
        == "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
    #expect(DevicesSettingsView.serviceStatus(.failed(reason: "port occupé"))
        == ConsoleStatus(text: "Échec : port occupé", tone: .danger))
    #expect(PairingText.retry == "Réessayer")
    #expect(PairingText.toggle == "Accès depuis l'iPhone et l'iPad")
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
    #expect(PairingText.codeExpiry("01:30") == "Expire dans 01:30")
    #expect(PairingText.codeExpired == "Code expiré")
}

// MARK: - Identifiants d'accessibilité

@Test("DevicesSettingsView : les identifiants d'accessibilité de l'onglet sont stables")
func accessibilityIdentifiers() {
    #expect(PairingAccessibility.panel == "settings.devices")
    #expect(PairingAccessibility.toggle == "pairing.toggle")
    #expect(PairingAccessibility.generate == "pairing.generate")
    #expect(PairingAccessibility.code == "pairing.code")
    #expect(PairingAccessibility.codeExpiry == "pairing.codeExpiry")
    #expect(PairingAccessibility.address == "pairing.address")
    #expect(PairingAccessibility.devices == "pairing.devices")
    #expect(PairingAccessibility.devicesList == "pairing.devices.list")
    #expect(PairingAccessibility.devicesRetry == "pairing.devices.retry")
    #expect(PairingAccessibility.retry == "pairing.retry")
    #expect(PairingAccessibility.openLocalNetworkSettings == "pairing.openLocalNetworkSettings")
    #expect(PairingAccessibility.generateError == "pairing.generate.error")
    let id = UUID(uuidString: "AABBCCDD-0000-1111-2222-333344445555")!
    #expect(PairingAccessibility.revoke(id) == "pairing.devices.revoke.aabbccdd-0000-1111-2222-333344445555")
}

// MARK: - L'onglet se rend réellement

@MainActor
@Test("DevicesSettingsView : l'onglet se rend sur le modèle réel et ↩ active « Générer un code »")
func devicesSettingsRendersAndReturnGenerates() async {
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }
    let listener = RecordingListener()
    let remote = makeRemoteServiceModel(defaults: defaults, listener: listener)
    await remote.startIfEnabled()

    // Rendue dans une vraie fenêtre : les `ViewBuilder` s'exécutent sur le modèle
    // réel (aucune capture d'écran — le rendu graphique se juge à l'œil).
    let window = pairingWindow(
        DevicesSettingsView(remote: remote, pairing: remote.pairing, registry: remote.registry)
    )
    defer { window.close() }
    #expect(window.contentView != nil)

    // ↩ active le bouton focalisé et action par défaut — « Générer un code ».
    #expect(remote.pairing.code == nil)
    #expect(pressReturn(on: window))
    #expect(remote.pairing.code != nil, "↩ active « Générer un code »")
}

// MARK: - L'onglet rendu dans son cadre fixe

/// Le 10 octobre 2026 à 21:54, heure de Paris.
private let pairedAt1054PM: Double = 1_791_662_040_000

/// `count` lignes HÉRITÉES (sans `deviceKey`) toutes nommées « iPhone », comme les
/// doublons du poste : la première au 10/10/2026 21:54, les suivantes une minute
/// plus tôt chacune.
private func legacyDevices(_ count: Int) -> [DeviceRecord] {
    (0..<count).map { index in
        let at = pairedAt1054PM - Double(index) * 60_000
        return DeviceRecord(id: UUID(), name: "iPhone", pairedAtMs: at, lastSeenAtMs: at)
    }
}

/// L'onglet rendu sur le modèle RÉEL, service démarré (doublure de listener),
/// registre relu depuis un `devices.json` jetable, dans une fenêtre hors écran
/// taillée au cadre fixe de l'onglet — ce que la scène `Settings` lui donne.
@MainActor
private final class RenderedDevicesSettings {
    let remote: RemoteServiceModel
    let listener = RecordingListener()
    let hosting: NSHostingView<DevicesSettingsView>
    let window: NSWindow
    private let suite: String
    private let defaults: UserDefaults
    private let dir: String

    init(devices: [DeviceRecord]) async throws {
        (suite, defaults) = remoteDefaultsSuite()
        dir = remoteTempDir("omp-console-devices-settings")
        let file = URL(fileURLWithPath: dir, isDirectory: true).appendingPathComponent("devices.json")
        try JSONEncoder().encode(DeviceFile(devices: devices)).write(to: file)
        remote = makeRemoteServiceModel(defaults: defaults, listener: listener, dir: dir)
        await remote.startIfEnabled()
        hosting = NSHostingView(rootView: DevicesSettingsView(
            remote: remote, pairing: remote.pairing, registry: remote.registry
        ))
        _ = NSApplication.shared
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: PairingLayout.width, height: PairingLayout.height),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        settle()
    }

    func settle() {
        _ = RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    }

    func close() {
        window.close()
        defaults.removePersistentDomain(forName: suite)
        try? FileManager.default.removeItem(atPath: dir)
    }

    /// La zone code que la vue rend en ce moment.
    var codeZone: PairingCodeZone {
        DevicesSettingsView.codeZone(
            enabled: remote.enabled, state: remote.state, code: remote.pairing.code,
            countdown: remote.pairing.countdown, expired: remote.pairing.expired
        )
    }

    /// La liste que la vue rend en ce moment.
    var devicesZone: PairingDevicesZone {
        DevicesSettingsView.devicesZone(
            isLoaded: remote.registry.isLoaded, loadError: remote.registry.loadError, devices: remote.registry.devices
        )
    }

    /// La vue défilante réelle de la liste des appareils.
    var devicesScrollView: NSScrollView? {
        func find(_ view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.lazy.compactMap(find).first
        }
        return find(hosting)
    }

    /// Le cadre de la liste dans l'onglet.
    var listFrame: NSRect? {
        devicesScrollView.map { $0.convert($0.bounds, to: hosting) }
    }
}

/// Le geste confirmé d'une ligne : « Révoquer », puis « Révoquer » du dialogue —
/// exactement les appels des boutons de la vue.
@MainActor
private func revokeConfirmed(_ id: UUID, prompt: PairingRevokePrompt, pairing: PairingModel) async {
    prompt.request(id)
    if let confirmed = prompt.confirm() { await pairing.revoke(confirmed) }
}

// MARK: - reglages-mac-appareils

@MainActor
@Test("reglages-mac-appareils/AC-1 : le panneau Réglages a un seul onglet, « Appareils », symbole ipad.and.iphone, et se rend sur le modèle réel")
func settingsPanelHasOneDevicesTab() async throws {
    #expect(PairingText.devicesTab == "Appareils")
    #expect(PairingText.devicesTabSymbol == "ipad.and.iphone")
    #expect(NSImage(systemSymbolName: PairingText.devicesTabSymbol, accessibilityDescription: nil) != nil,
            "le symbole SF de l'onglet existe")
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }
    let remote = makeRemoteServiceModel(defaults: defaults, listener: RecordingListener())
    await remote.startIfEnabled()
    let hosting = NSHostingView(rootView: ConsoleSettingsView(remote: remote))
    let size = hosting.fittingSize
    // Le panneau contient l'onglet à son cadre fixe (plus la barre d'onglets).
    #expect(size.width >= PairingLayout.width - 0.5, "panneau \(size)")
    #expect(size.height >= PairingLayout.height - 0.5, "panneau \(size)")
    let window = pairingWindow(ConsoleSettingsView(remote: remote))
    defer { window.close() }
    #expect(window.contentView != nil)
}

@MainActor
@Test("reglages-mac-appareils/AC-3 : service actif, l'interrupteur est activé, un code s'obtient et s'affiche, la liste est présente")
func activeServiceOffersACodeAndTheList() async throws {
    let tab = try await RenderedDevicesSettings(devices: legacyDevices(2))
    defer { tab.close() }

    // Service actif : interrupteur activé, état « Actif ».
    #expect(tab.remote.enabled, "l'interrupteur est activé")
    #expect(tab.remote.state.isRunning)
    #expect(DevicesSettingsView.serviceStatus(tab.remote.state).text == "Actif")
    #expect(tab.remote.address != nil, "l'adresse est affichée sous la zone code")

    // « Générer un code » est rendu et actif ; le presser donne un code affiché.
    #expect(tab.codeZone == .none)
    #expect(tab.codeZone.offersGenerate && tab.codeZone.isGeneratable)
    tab.remote.pairing.generate()
    tab.settle()
    let code = try #require(tab.remote.pairing.code)
    // Horloge réelle : le décompte a pu avancer pendant le rendu ; il est affiché.
    let countdown = try #require(tab.remote.pairing.countdown)
    #expect(tab.codeZone == .active(code: code.value, countdown: countdown))
    #expect(PairingPresentation.grouped(code.value).count == 9, "affiché XXXX-XXXX")

    // La liste des appareils est présente, rendue en vraie vue défilante.
    #expect(tab.devicesZone == .devices(tab.remote.registry.devices))
    #expect(tab.remote.registry.devices.count == 2)
    #expect(tab.devicesScrollView != nil, "la liste est rendue")
}

@MainActor
@Test("reglages-mac-appareils/AC-4 : couper l'interrupteur arrête le service, retire le code, et garde la liste avec « Révoquer »")
func turningOffKeepsTheRevocableList() async throws {
    let tab = try await RenderedDevicesSettings(devices: legacyDevices(2))
    defer { tab.close() }
    tab.remote.pairing.generate()
    #expect(tab.remote.pairing.code != nil)

    // Le geste de l'interrupteur.
    await tab.remote.setEnabled(false)
    tab.settle()

    // Le service s'arrête.
    #expect(tab.listener.stopCount == 1)
    #expect(tab.remote.state == .off)
    #expect(DevicesSettingsView.serviceStatus(tab.remote.state).text == "Coupé")
    // Aucun code n'est plus proposé ni affiché.
    #expect(tab.remote.pairing.code == nil)
    #expect(tab.codeZone == .serviceOff)
    #expect(tab.codeZone.offersGenerate == false, "« Générer un code » n'est plus rendu")
    // La liste reste affichée, un « Révoquer » actif par appareil.
    #expect(tab.devicesZone == .devices(tab.remote.registry.devices))
    #expect(tab.devicesScrollView != nil, "la liste reste rendue service coupé")
    for device in tab.remote.registry.devices {
        let control = DevicesSettingsView.revokeControl(
            inProgress: tab.remote.pairing.revoking.contains(device.id), name: device.name
        )
        #expect(control.label == "Révoquer")
        #expect(control.disabled == false)
    }
}

@MainActor
@Test("reglages-mac-appareils/AC-6 : avec 12 appareils, l'onglet garde 560 × 560, en-tête et code restent en place, la liste défile jusqu'au dernier, révocable")
func twelveDevicesScrollInsideTheFixedFrame() async throws {
    let one = try await RenderedDevicesSettings(devices: legacyDevices(1))
    defer { one.close() }
    let twelve = try await RenderedDevicesSettings(devices: legacyDevices(12))
    defer { twelve.close() }

    // Le cadre est fixe quel que soit le nombre d'appareils.
    #expect(PairingLayout.width == 560 && PairingLayout.height == 560)
    for tab in [one, twelve] {
        #expect(tab.hosting.fittingSize == NSSize(width: 560, height: 560), "cadre \(tab.hosting.fittingSize)")
    }

    // La liste commence au même endroit avec 1 ou 12 appareils : l'en-tête et la
    // zone code au-dessus d'elle gardent leur place, entièrement dans le cadre.
    let shortList = try #require(one.listFrame)
    let tallList = try #require(twelve.listFrame)
    #expect(abs(shortList.minY - tallList.minY) <= 0.5 && abs(shortList.height - tallList.height) <= 0.5,
            "liste à 1 : \(shortList), à 12 : \(tallList)")
    #expect(twelve.hosting.bounds.contains(tallList), "la liste tient dans le cadre")
    #expect(tallList.height < PairingLayout.height - 120, "en-tête et zone code restent hors de la liste")

    // 12 lignes dépassent la zone visible : la liste défile jusqu'en bas.
    let scroll = try #require(twelve.devicesScrollView)
    let document = try #require(scroll.documentView)
    let clip = scroll.contentView
    #expect(document.frame.height > clip.bounds.height, "12 lignes dépassent la zone visible")
    let bottom = document.isFlipped ? max(0, document.frame.height - clip.bounds.height) : 0
    clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: bottom))
    scroll.reflectScrolledClipView(clip)
    twelve.settle()
    let visible = clip.documentVisibleRect
    if document.isFlipped {
        #expect(abs(visible.maxY - document.frame.height) <= 0.5, "visible \(visible), document \(document.frame)")
    } else {
        #expect(abs(visible.minY) <= 0.5, "visible \(visible), document \(document.frame)")
    }
    // Seule la liste a bougé : son cadre et l'onglet sont inchangés.
    let afterScroll = try #require(twelve.listFrame)
    #expect(abs(afterScroll.minY - tallList.minY) <= 0.5 && abs(afterScroll.height - tallList.height) <= 0.5)
    #expect(twelve.hosting.fittingSize == NSSize(width: 560, height: 560))

    // La dernière ligne se révoque : 11 lignes restent.
    let last = try #require(twelve.remote.registry.devices.last)
    #expect(DevicesSettingsView.revokeControl(inProgress: false, name: last.name).disabled == false)
    await revokeConfirmed(last.id, prompt: PairingRevokePrompt(), pairing: twelve.remote.pairing)
    twelve.settle()
    #expect(twelve.remote.registry.devices.count == 11)
    #expect(!twelve.remote.registry.devices.contains { $0.id == last.id })
}

@MainActor
@Test("reglages-mac-appareils/AC-7 : « Révoquer » puis confirmer retire l'appareil, dont l'ancien appairage est refusé (401)")
func confirmedRevocationRemovesTheDevice() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }
    let token = try await stack.pair(name: "iPhone 17e")
    let device = try #require(stack.registry.devices.first)
    #expect(try await stack.call("GET", "/v1/devices", token: token).status == 200, "appairé, il joint le Mac")

    let pairing = PairingModel(registry: stack.registry, clock: stack.clock.clock)
    let prompt = PairingRevokePrompt()
    prompt.request(device.id)
    #expect(prompt.pending == device.id, "le dialogue de CET appareil est ouvert")
    #expect(PairingText.revokeConfirmTitle(name: device.name) == "Révoquer iPhone 17e ?")
    let confirmed = try #require(prompt.confirm())
    #expect(prompt.pending == nil, "le dialogue se ferme")
    await pairing.revoke(confirmed)

    // La ligne disparaît, l'ancien jeton ne s'authentifie plus.
    #expect(!stack.registry.devices.contains { $0.id == device.id })
    #expect(DevicesSettingsView.devicesZone(isLoaded: true, loadError: nil, devices: stack.registry.devices) == .empty)
    #expect(stack.registry.authenticate(token) == nil)
    #expect(try await stack.call("GET", "/v1/devices", token: token).status == 401)
}

@MainActor
@Test("reglages-mac-appareils/AC-8 : « Révoquer » puis annuler laisse l'appareil dans la liste, toujours appairé")
func cancelledRevocationKeepsTheDevice() async throws {
    let stack = try await RemoteStack.make()
    defer { stack.stop() }
    let token = try await stack.pair(name: "iPad")
    let device = try #require(stack.registry.devices.first)

    let prompt = PairingRevokePrompt()
    prompt.request(device.id)
    prompt.request(device.id)
    #expect(prompt.pending == device.id, "un double clic n'ouvre qu'un dialogue")
    prompt.cancel()
    #expect(prompt.pending == nil, "« Annuler » ferme le dialogue")
    #expect(prompt.confirm() == nil, "une confirmation après l'annulation est sans effet")

    #expect(stack.registry.devices.map(\.id) == [device.id])
    #expect(stack.registry.authenticate(token)?.id == device.id)
    #expect(try await stack.call("GET", "/v1/devices", token: token).status == 200)
}

@MainActor
@Test("reglages-mac-appareils/AC-9 : service coupé, révoquer un appareil et confirmer le retire de la liste")
func revocationWorksWithTheServiceOff() async throws {
    let devices = legacyDevices(2)
    let tab = try await RenderedDevicesSettings(devices: devices)
    defer { tab.close() }
    await tab.remote.setEnabled(false)
    tab.settle()
    #expect(tab.remote.state == .off)
    #expect(tab.devicesZone == .devices(devices))

    await revokeConfirmed(devices[0].id, prompt: PairingRevokePrompt(), pairing: tab.remote.pairing)
    tab.settle()
    #expect(tab.remote.registry.devices.map(\.id) == [devices[1].id])
    #expect(tab.devicesZone == .devices([devices[1]]))
    #expect(tab.remote.state == .off, "la révocation ne rallume pas le service")
}

// MARK: - mac-feuille-appairage-debordante : contrôles encore vrais dans l'onglet

@MainActor
@Test("mac-feuille-appairage-debordante/AC-6 : une ligne héritée « iPhone » se révoque à la main, les autres restent")
func legacyRowIsRevokedByHand() async throws {
    let legacy = legacyDevices(3)
    let tab = try await RenderedDevicesSettings(devices: legacy)
    defer { tab.close() }
    let registry = tab.remote.registry

    // Un appareil corrigé s'appaire : les lignes héritées ne sont pas touchées.
    let code = try registry.generateCode().value
    _ = try await registry.pair(code: code, name: "iPad Pro 13 pouces (M5)", deviceKey: "cle-ipad")
    #expect(registry.devices.count == 4)
    #expect(Set(registry.devices.filter { $0.deviceKey == nil }.map(\.id)) == Set(legacy.map(\.id)))

    // « Révoquer » confirmé sur une ligne héritée la supprime.
    await revokeConfirmed(legacy[2].id, prompt: PairingRevokePrompt(), pairing: tab.remote.pairing)
    tab.settle()
    #expect(registry.devices.map(\.id).contains(legacy[2].id) == false)
    #expect(registry.devices.count == 3)
    guard case .devices(let rows) = tab.devicesZone else {
        Issue.record("l'onglet doit encore rendre la liste")
        return
    }
    let keyed = registry.devices.filter { $0.deviceKey != nil }.map(\.id)
    #expect(Set(rows.map(\.id)) == Set([legacy[0].id, legacy[1].id] + keyed))
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-7 : chaque « Révoquer » nomme l'appareil de sa ligne pour l'accessibilité")
func revokeButtonsNameTheirDevice() {
    #expect(DevicesSettingsView.revokeControl(inProgress: false, name: "iPad Pro 13 pouces (M5)")
        == PairingRevokeControl(label: "Révoquer", accessibilityLabel: "Révoquer iPad Pro 13 pouces (M5)", disabled: false))
    #expect(DevicesSettingsView.revokeControl(inProgress: true, name: "iPhone 17e")
        == PairingRevokeControl(label: "Révocation…", accessibilityLabel: "Révocation de iPhone 17e…", disabled: true))
    #expect(PairingText.revokeAccessibility(name: "iPhone") == "Révoquer iPhone")
    #expect(PairingText.revokingAccessibility(name: "iPhone") == "Révocation de iPhone…")
    // Plusieurs lignes : chaque libellé contient le nom de SA ligne, aucun n'est le seul mot.
    for name in ["iPad Pro 13 pouces (M5)", "iPhone 17e", "iPhone"] {
        let label = DevicesSettingsView.revokeControl(inProgress: false, name: name).accessibilityLabel
        #expect(label.contains(name))
        #expect(label != PairingText.revoke)
    }
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-8 : la ligne d'un appareil dit le jour, le mois, l'année et l'heure de l'appairage")
func pairedOnShowsTheFullDate() throws {
    let paris = try #require(TimeZone(identifier: "Europe/Paris"))
    #expect(PairingText.pairedOn(ConsoleFormat.dateTime(ms: pairedAt1054PM, timeZone: paris))
        == "Appairé le 10 oct. 2026 à 21:54")
    #expect(PairingText.lastSeen("il y a 4 minutes") == "Dernière activité il y a 4 minutes")
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-9 : service démarré, l'adresse n'est plus répétée par l'état du service")
func serviceAddressAppearsOnce() async throws {
    let tab = try await RenderedDevicesSettings(devices: legacyDevices(1))
    defer { tab.close() }
    // Service démarré : l'adresse est connue (la zone code l'affiche, `pairing.address`)…
    let address = try #require(tab.remote.address)
    #expect(tab.remote.state == .running(address: address))
    // … et l'état du service ne la répète plus.
    #expect(DevicesSettingsView.serviceStatus(tab.remote.state) == ConsoleStatus(text: "Actif", tone: .success))
    #expect(!DevicesSettingsView.serviceStatus(tab.remote.state).text.contains(address))
    #expect(PairingText.active == "Actif")
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-10 : la zone code rend « Expire dans mm:ss », puis « Code expiré » sans décompte")
func codeExpiryIsRenderedThenExpired() {
    #expect(PairingText.codeExpiry("02:00") == "Expire dans 02:00")
    #expect(PairingText.codeExpired == "Code expiré")
    let running = RemoteServiceState.running(address: "a")
    #expect(DevicesSettingsView.codeZone(enabled: true, state: running, code: nil, countdown: nil, expired: true) == .expired)
    #expect(DevicesSettingsView.codeZone(enabled: true, state: running, code: nil, countdown: nil, expired: false) == .none)
    let code = PairingCode(value: "ABCD2345", createdAtMs: 0, expiresAtMs: 120_000, failedAttempts: 0)
    #expect(DevicesSettingsView.codeZone(enabled: true, state: running, code: code, countdown: "01:58", expired: false)
        == .active(code: "ABCD2345", countdown: "01:58"))
    #expect(PairingCodeZone.expired.isGeneratable)
}
