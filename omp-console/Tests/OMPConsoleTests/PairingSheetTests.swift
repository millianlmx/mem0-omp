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
        name: "iPhone de test",
        deviceKey: nil
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

// MARK: - Les six états de la zone code (S-5)

@MainActor
@Test("PairingSheet : les six états de la zone code — aucun, actif, expiré, service coupé, service en échec, refusé")
func codeZoneStates() async throws {
    let fixture = PairingFixture()
    let model = PairingModel(registry: fixture.registry, clock: fixture.clock.clock)
    await fixture.registry.load()
    let running = RemoteServiceState.running(address: "192.168.1.12:8787")
    func zone() -> PairingCodeZone {
        PairingSheet.codeZone(
            enabled: true, state: running, code: model.code, countdown: model.countdown, expired: model.expired
        )
    }

    // aucun
    model.refresh()
    #expect(model.code == nil)
    #expect(model.expired == false)
    #expect(zone() == .none)
    #expect(PairingText.noCode == "Aucun code actif.")

    // actif : le code et son compte à rebours.
    model.generate()
    let active = try #require(model.code)
    #expect(zone() == .active(code: active.value, countdown: "02:00"))

    // expiré : « Code expiré », sans code, sans décompte, SANS message d'erreur.
    fixture.clock.nowMs += Double(ConsoleAPI.Service.pairingCodeTTLSeconds) * 1000
    model.refresh()
    #expect(model.code == nil)
    #expect(model.countdown == nil)
    #expect(model.error == nil)
    #expect(model.expired)
    #expect(zone() == .expired)
    #expect(zone().isGeneratable, "un code expiré se remplace par « Générer un code »")

    // Le service coupé ou indisponible prime sur l'échéance.
    #expect(PairingSheet.codeZone(enabled: false, state: .off, code: nil, countdown: nil, expired: true) == .serviceOff)

    // service coupé : zone remplacée, bouton désactivé.
    let off = PairingSheet.codeZone(enabled: false, state: .off, code: nil, countdown: nil, expired: false)
    #expect(off == .serviceOff)
    #expect(off.isGeneratable == false)
    #expect(PairingText.serviceOff == "Le service est coupé.")

    // service en échec et service refusé : le message d'état, bouton désactivé.
    let failed = PairingSheet.codeZone(
        enabled: true, state: .failed(reason: "port occupé"), code: nil, countdown: nil, expired: true
    )
    #expect(failed == .serviceUnavailable("Échec : port occupé"))
    #expect(failed.isGeneratable == false)
    let denied = PairingSheet.codeZone(
        enabled: true, state: .denied(reason: "x"), code: nil, countdown: nil, expired: false
    )
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

    // révocation en cours : « Révocation… », désactivé (libellés AX : AC-7).
    #expect(PairingSheet.revokeControl(inProgress: true, name: "iPhone").label == "Révocation…")
    #expect(PairingSheet.revokeControl(inProgress: true, name: "iPhone").disabled)
    #expect(PairingSheet.revokeControl(inProgress: false, name: "iPhone").label == "Révoquer")
    #expect(PairingSheet.revokeControl(inProgress: false, name: "iPhone").disabled == false)
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
        == ConsoleStatus(text: "Actif", tone: .success))
    #expect(PairingSheet.serviceStatus(.denied(reason: "x"))
        == ConsoleStatus(text: "Accès au réseau local refusé à OMP Console.", tone: .attention))
    #expect(PairingText.openLocalNetworkSettings == "Ouvrir Réglages Système")
    #expect(PairingSheet.localNetworkSettingsURL
        == "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
    #expect(PairingSheet.serviceStatus(.failed(reason: "port occupé"))
        == ConsoleStatus(text: "Échec : port occupé", tone: .danger))
    #expect(PairingText.retry == "Réessayer")
    #expect(PairingText.toggle == "Accès depuis l'iPhone et l'iPad")
    #expect(PairingText.title == "Appairage")
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
    #expect(PairingText.codeExpiry("01:30") == "Expire dans 01:30")
    #expect(PairingText.codeExpired == "Code expiré")
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
    #expect(PairingAccessibility.devicesList == "pairing.devices.list")
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

// MARK: - mac-feuille-appairage-debordante : la feuille rendue et ses textes
//
// Sous `swift test`, SwiftUI ne construit PAS l'arbre d'accessibilité d'une
// `NSHostingView` (aucun client AX : `accessibilityChildren()` est vide) : la
// feuille rendue se mesure par sa hauteur idéale et sa vraie `NSScrollView`, ses
// mots par les fonctions pures qu'elle rend. La lecture AX de la feuille ouverte
// par le menu est la recette `scripts/mac-appairage-recette.sh`.

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

/// La feuille rendue sur le modèle RÉEL, service démarré (doublure de listener),
/// registre relu depuis un `devices.json` jetable, dans une fenêtre hors écran
/// taillée à la hauteur idéale de la feuille — ce qu'AppKit donne à la feuille.
@MainActor
private final class RenderedPairingSheet {
    let remote: RemoteServiceModel
    let hosting: NSHostingView<PairingSheet>
    let window: NSWindow
    let ideal: NSSize
    private let suite: String
    private let defaults: UserDefaults
    private let dir: String

    init(devices: [DeviceRecord]) async throws {
        (suite, defaults) = remoteDefaultsSuite()
        dir = remoteTempDir("omp-console-pairing-sheet")
        let file = URL(fileURLWithPath: dir, isDirectory: true).appendingPathComponent("devices.json")
        try JSONEncoder().encode(DeviceFile(devices: devices)).write(to: file)
        remote = makeRemoteServiceModel(defaults: defaults, listener: RecordingListener(), dir: dir)
        await remote.startIfEnabled()
        remote.requestPairingSheet()
        hosting = NSHostingView(rootView: PairingSheet(remote: remote, pairing: remote.pairing, registry: remote.registry))
        ideal = hosting.fittingSize
        _ = NSApplication.shared
        window = NSWindow(
            contentRect: NSRect(origin: .zero, size: ideal),
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

    /// La vue défilante réelle de la liste des appareils.
    var devicesScrollView: NSScrollView? {
        func find(_ view: NSView) -> NSScrollView? {
            if let scroll = view as? NSScrollView { return scroll }
            return view.subviews.lazy.compactMap(find).first
        }
        return find(hosting)
    }
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-1 : avec 12 appareils, la feuille garde une hauteur bornée sous l'écran de 1 117 pt, et seule la liste est plafonnée")
func pairingSheetFitsTheScreenWithTwelveDevices() async throws {
    let one = try await RenderedPairingSheet(devices: legacyDevices(1))
    defer { one.close() }
    let twelve = try await RenderedPairingSheet(devices: legacyDevices(12))
    defer { twelve.close() }

    // La hauteur idéale (celle qu'AppKit donne à la feuille) est bornée quel que
    // soit le nombre d'appareils ; la liste n'est pas rembourrée pour un seul.
    #expect(PairingLayout.devicesMaxHeight == 320)
    #expect(twelve.ideal.height <= 720, "hauteur idéale \(twelve.ideal.height)")
    #expect(twelve.ideal.height - one.ideal.height <= PairingLayout.devicesMaxHeight)
    #expect(twelve.ideal.height > one.ideal.height, "la liste épouse son contenu")

    // La liste est une vraie vue défilante, plafonnée à 320 pt ; un appareil seul
    // la remplit sans vide.
    let tall = try #require(twelve.devicesScrollView, "la liste doit défiler")
    let tallDocument = try #require(tall.documentView)
    #expect(tall.frame.height <= PairingLayout.devicesMaxHeight + 0.5)
    #expect(tallDocument.frame.height > tall.contentView.bounds.height, "12 lignes dépassent le plafond")
    let short = try #require(one.devicesScrollView)
    let shortDocument = try #require(short.documentView)
    #expect(abs(short.contentView.bounds.height - shortDocument.frame.height) <= 0.5, "pas de rembourrage")

    // La vue défilante tient dans la feuille : en-tête au-dessus, pied en dessous.
    let listInSheet = tall.convert(tall.bounds, to: twelve.hosting)
    #expect(twelve.hosting.bounds.contains(listInSheet))
    #expect(listInSheet.height < twelve.hosting.bounds.height - 100, "en-tête, zone code et pied restent hors de la liste")
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-2 : la liste défile jusqu'à la 12e ligne sans déplacer le reste de la feuille")
func pairingSheetScrollsOnlyTheDevicesList() async throws {
    let sheet = try await RenderedPairingSheet(devices: legacyDevices(12))
    defer { sheet.close() }
    let scroll = try #require(sheet.devicesScrollView, "la liste doit être une vue défilante")
    let document = try #require(scroll.documentView)
    let clip = scroll.contentView
    let listBefore = scroll.convert(scroll.bounds, to: sheet.hosting)
    let idealBefore = sheet.hosting.fittingSize

    // Défile la liste jusqu'en bas.
    let bottom = document.isFlipped ? max(0, document.bounds.height - clip.bounds.height) : 0
    clip.scroll(to: NSPoint(x: clip.bounds.origin.x, y: bottom))
    scroll.reflectScrolledClipView(clip)
    sheet.settle()

    // La dernière ligne (bas du document) est dans la partie visible.
    let visible = clip.documentVisibleRect
    #expect(bottom > 0 || !document.isFlipped, "la liste a réellement défilé")
    if document.isFlipped {
        #expect(abs(visible.maxY - document.bounds.maxY) <= 0.5, "visible \(visible), document \(document.bounds)")
    } else {
        #expect(abs(visible.minY - document.bounds.minY) <= 0.5, "visible \(visible), document \(document.bounds)")
    }

    // Seule la liste a bougé : son cadre dans la feuille et la feuille elle-même
    // (donc le titre au-dessus et « Fermer » en dessous) sont inchangés.
    let listAfter = scroll.convert(scroll.bounds, to: sheet.hosting)
    #expect(abs(listAfter.minY - listBefore.minY) <= 0.5 && abs(listAfter.height - listBefore.height) <= 0.5)
    #expect(abs(sheet.hosting.fittingSize.height - idealBefore.height) <= 0.5)
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-6 : une ligne héritée « iPhone » se révoque à la main, les autres restent")
func legacyRowIsRevokedByHand() async throws {
    let legacy = legacyDevices(3)
    let sheet = try await RenderedPairingSheet(devices: legacy)
    defer { sheet.close() }
    let registry = sheet.remote.registry

    // Un appareil corrigé s'appaire : les lignes héritées ne sont pas touchées.
    let code = try registry.generateCode().value
    _ = try await registry.pair(code: code, name: "iPad Pro 13 pouces (M5)", deviceKey: "cle-ipad")
    #expect(registry.devices.count == 4)
    #expect(Set(registry.devices.filter { $0.deviceKey == nil }.map(\.id)) == Set(legacy.map(\.id)))

    // « Révoquer » sur une ligne héritée (le geste confirmé de la feuille) la supprime.
    await sheet.remote.pairing.revoke(legacy[2].id)
    sheet.settle()
    #expect(registry.devices.map(\.id).contains(legacy[2].id) == false)
    #expect(registry.devices.count == 3)
    guard case .devices(let rows) = PairingSheet.devicesZone(isLoaded: true, loadError: nil, devices: registry.devices) else {
        Issue.record("la feuille doit encore rendre la liste")
        return
    }
    let keyed = registry.devices.filter { $0.deviceKey != nil }.map(\.id)
    #expect(Set(rows.map(\.id)) == Set([legacy[0].id, legacy[1].id] + keyed))
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-7 : chaque « Révoquer » nomme l'appareil de sa ligne pour l'accessibilité")
func revokeButtonsNameTheirDevice() {
    #expect(PairingSheet.revokeControl(inProgress: false, name: "iPad Pro 13 pouces (M5)")
        == PairingRevokeControl(label: "Révoquer", accessibilityLabel: "Révoquer iPad Pro 13 pouces (M5)", disabled: false))
    #expect(PairingSheet.revokeControl(inProgress: true, name: "iPhone 17e")
        == PairingRevokeControl(label: "Révocation…", accessibilityLabel: "Révocation de iPhone 17e…", disabled: true))
    #expect(PairingText.revokeAccessibility(name: "iPhone") == "Révoquer iPhone")
    #expect(PairingText.revokingAccessibility(name: "iPhone") == "Révocation de iPhone…")
    // Plusieurs lignes : chaque libellé contient le nom de SA ligne, aucun n'est le seul mot.
    for name in ["iPad Pro 13 pouces (M5)", "iPhone 17e", "iPhone"] {
        let label = PairingSheet.revokeControl(inProgress: false, name: name).accessibilityLabel
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
    let sheet = try await RenderedPairingSheet(devices: legacyDevices(1))
    defer { sheet.close() }
    // Service démarré : l'adresse est connue (la zone code l'affiche, `pairing.address`)…
    let address = try #require(sheet.remote.address)
    #expect(sheet.remote.state == .running(address: address))
    // … et l'état du service ne la répète plus.
    #expect(PairingSheet.serviceStatus(sheet.remote.state) == ConsoleStatus(text: "Actif", tone: .success))
    #expect(!PairingSheet.serviceStatus(sheet.remote.state).text.contains(address))
    #expect(PairingText.active == "Actif")
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-10 : la zone code rend « Expire dans mm:ss », puis « Code expiré » sans décompte")
func codeExpiryIsRenderedThenExpired() {
    #expect(PairingText.codeExpiry("02:00") == "Expire dans 02:00")
    #expect(PairingText.codeExpired == "Code expiré")
    let running = RemoteServiceState.running(address: "a")
    #expect(PairingSheet.codeZone(enabled: true, state: running, code: nil, countdown: nil, expired: true) == .expired)
    #expect(PairingSheet.codeZone(enabled: true, state: running, code: nil, countdown: nil, expired: false) == .none)
    let code = PairingCode(value: "ABCD2345", createdAtMs: 0, expiresAtMs: 120_000, failedAttempts: 0)
    #expect(PairingSheet.codeZone(enabled: true, state: running, code: code, countdown: "01:58", expired: false)
        == .active(code: "ABCD2345", countdown: "01:58"))
    #expect(PairingCodeZone.expired.isGeneratable)
}

@MainActor
@Test("mac-feuille-appairage-debordante/AC-12 : le titre de la feuille est « Appairage », sans « API distante »")
func pairingSheetIsTitledAppairage() {
    #expect(PairingText.title == "Appairage")
    #expect(PairingText.toggle == "Accès depuis l'iPhone et l'iPad")
    #expect(PairingText.menuItem == "Appairage…")
    for text in [PairingText.title, PairingText.toggle] {
        #expect(!text.contains("API distante"))
    }
}
