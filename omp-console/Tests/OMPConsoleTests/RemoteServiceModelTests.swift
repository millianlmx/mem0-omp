// Preuves de l'interrupteur persistant du service d'API distante (S-14, BR-9) :
// actif par défaut, la bascule OFF arrête le listener (donc l'annonce Bonjour),
// un échec laisse l'interrupteur sur ON, et la préférence survit à la relance.
//
// Le listener est une DOUBLURE du protocole `RemoteListening` : aucun socket réel
// n'est ouvert, et l'arrêt du service est observable (`stopCount`).

import Foundation
import Testing

@testable import OMPConsole
import ConsoleCore

// MARK: - Doublure du listener

/// Un listener de doublure : il compte les démarrages et les arrêts, et peut
/// échouer ou être refusé au démarrage.
@MainActor
final class RecordingListener: RemoteListening {
    private(set) var state: RemoteServiceState = .off
    var onState: ((RemoteServiceState) -> Void)?
    private(set) var address: String? = "192.168.1.12:8787"
    private(set) var startCount = 0
    private(set) var stopCount = 0

    /// Posé, il fait échouer `start` et laisse le service dans cet état.
    var startFailure: RemoteServiceState?

    func start(port: Int) async throws {
        startCount += 1
        if let startFailure {
            state = startFailure
            throw RecordingListenerFailure()
        }
        state = .running(address: address ?? "127.0.0.1:0")
        onState?(state)
    }

    func stop() {
        stopCount += 1
        state = .off
        onState?(state)
    }
}

struct RecordingListenerFailure: Error {}

// MARK: - Fixture

/// Une racine jetable pour le magasin, le registre et la pile.
@MainActor
func remoteTempDir(_ prefix: String = "omp-console-remote") -> String {
    let dir = (NSTemporaryDirectory() as NSString).appendingPathComponent("\(prefix)-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
    return dir
}

/// Un `RemoteServiceModel` complet, sur une doublure de listener et un magasin
/// jetable — les modèles de l'app sont ceux de la coque, jamais des mocks.
@MainActor
func makeRemoteServiceModel(
    defaults: UserDefaults,
    listener: RecordingListener,
    registry: DeviceRegistry? = nil,
    port: Int = 0,
    dir: String = remoteTempDir()
) -> RemoteServiceModel {
    let host = SessionHost()
    let hub = StoreHub(stateDir: dir)
    // Jamais le vrai trousseau : sans registre fourni, la doublure en mémoire.
    let store = registry ?? DeviceRegistry(
        file: URL(fileURLWithPath: dir, isDirectory: true).appendingPathComponent("devices.json"),
        store: InMemoryDeviceTokenStore(),
        clock: .live
    )
    let model = RemoteServiceModel(
        paths: AppPaths(supportRoot: URL(fileURLWithPath: dir, isDirectory: true)),
        defaults: defaults,
        clock: .live,
        port: port,
        environment: [:],
        storeHub: hub,
        kanban: KanbanModel(hub: hub),
        actions: ActionsModel(),
        session: SessionConsoleModel(host: host, defaults: defaults),
        project: makeProjectModel(
            host: host,
            stateDir: dir,
            presence: StubPresence(),
            attention: RecordingAttention(),
            prService: StubPRService()
        ),
        registry: store,
        makeListener: { _ in listener }
    )
    // S-14 : le harnais représente une app dont la préparation est terminée. Le
    // test de la porte de préparation (`testStartIsDeferredUntilSetupIsReady`)
    // repasse la fermeture à `false` pour la prouver.
    model.isSetupReady = { true }
    return model
}

/// Une suite de préférences jetable, effacée en fin de test.
@MainActor
func remoteDefaultsSuite() -> (suite: String, defaults: UserDefaults) {
    let suite = "omp-console-remote-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    return (suite, defaults)
}

// MARK: - AC-18

@MainActor
@Test("api-distante-du-console/AC-18 : couper l'interrupteur arrête le service et l'annonce Bonjour")
func switchOffStopsTheService() async {
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }
    let listener = RecordingListener()
    let model = makeRemoteServiceModel(defaults: defaults, listener: listener)

    // L'interrupteur est ACTIF PAR DÉFAUT : la préférence est absente.
    #expect(model.enabled)
    #expect(defaults.object(forKey: RemoteServiceModel.enabledKey) == nil)
    #expect(model.state == .off)

    await model.startIfEnabled()
    #expect(listener.startCount == 1)
    #expect(model.state == .running(address: "192.168.1.12:8787"))

    // Couper : le listener est arrêté — l'annonce Bonjour disparaît avec lui.
    await model.setEnabled(false)
    #expect(listener.stopCount == 1)
    #expect(model.state == .off)
    #expect(model.address == nil)
    #expect(model.enabled == false)
    #expect(defaults.object(forKey: RemoteServiceModel.enabledKey) as? Bool == false)

    // Rallumer repart sur le même port, un nouveau démarrage.
    await model.setEnabled(true)
    #expect(listener.startCount == 2)
    #expect(model.state.isRunning)
}

// MARK: - AC-19

@MainActor
@Test("api-distante-du-console/AC-19 : le serveur coupé le reste après relance")
func serverStaysOffAcrossRelaunch() async {
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }

    let first = RecordingListener()
    let model = makeRemoteServiceModel(defaults: defaults, listener: first)
    await model.setEnabled(false)
    #expect(model.enabled == false)

    // Relance : le modèle est reconstruit sur LES MÊMES préférences.
    let second = RecordingListener()
    let relaunched = makeRemoteServiceModel(defaults: defaults, listener: second)
    #expect(relaunched.enabled == false, "la préférence a survécu")
    #expect(relaunched.state == .off)

    // Même sollicité, il ne démarre pas : aucune annonce Bonjour.
    await relaunched.startIfEnabled()
    #expect(second.startCount == 0)
    #expect(relaunched.state == .off)
}

// MARK: - Échec, refus, démarrage différé

@MainActor
@Test("api-distante-du-console/S-14 : un échec de démarrage laisse l'interrupteur sur ON et montre la raison")
func testFailureKeepsTheSwitchOnAndShowsTheReason() async {
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }
    let listener = RecordingListener()
    listener.startFailure = .failed(reason: "port 8787 déjà utilisé")
    let model = makeRemoteServiceModel(defaults: defaults, listener: listener)

    await model.startIfEnabled()
    #expect(model.enabled, "jamais un retour silencieux à OFF qui mentirait sur la préférence")
    #expect(model.state == .failed(reason: "port 8787 déjà utilisé"))
    #expect(defaults.object(forKey: RemoteServiceModel.enabledKey) == nil, "aucune préférence écrite")
    #expect(PairingText.failed(reason: "port 8787 déjà utilisé") == "Échec : port 8787 déjà utilisé")
    #expect(PairingSheet.serviceStatus(model.state)
        == ConsoleStatus(text: "Échec : port 8787 déjà utilisé", tone: .danger))
}

@MainActor
@Test("api-distante-du-console/S-14 : un refus du réseau local montre l'action des Réglages Système")
func testDeniedStateShowsTheSettingsAction() async {
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }
    let listener = RecordingListener()
    listener.startFailure = .denied(reason: "kDNSServiceErr_PolicyDenied")
    let model = makeRemoteServiceModel(defaults: defaults, listener: listener)

    await model.startIfEnabled()
    #expect(model.state.isDenied)
    #expect(model.enabled, "l'interrupteur reste sur ON")
    #expect(PairingSheet.serviceStatus(model.state)
        == ConsoleStatus(text: "Accès au réseau local refusé à OMP Console.", tone: .attention))
    #expect(PairingText.openLocalNetworkSettings == "Ouvrir Réglages Système")
    #expect(PairingSheet.localNetworkSettingsURL
        == "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")
}

@MainActor
@Test("api-distante-du-console/S-14 : rien ne démarre tant que la préparation des composants n'est pas terminée")
func testStartIsDeferredUntilSetupIsReady() async {
    let (suite, defaults) = remoteDefaultsSuite()
    defer { defaults.removePersistentDomain(forName: suite) }
    let listener = RecordingListener()
    let model = makeRemoteServiceModel(defaults: defaults, listener: listener)

    // Construire le modèle ne démarre RIEN : le démarrage attend l'appel de
    // `onAppear` / `SetupModel.onReady`.
    #expect(listener.startCount == 0)
    #expect(model.state == .off)

    // La préparation n'est PAS terminée : `startIfEnabled` ne démarre pas, ne
    // touche ni la préférence ni l'état.
    model.isSetupReady = { false }
    await model.startIfEnabled()
    #expect(listener.startCount == 0, "aucun listener tant que la préparation n'est pas prête")
    #expect(model.state == .off)
    #expect(model.enabled, "la préférence reste vraie — l'interrupteur est manipulable")

    // L'interrupteur manipulé pendant la préparation ne démarre pas non plus : la
    // préférence sera respectée au démarrage différé.
    await model.setEnabled(true)
    #expect(listener.startCount == 0)

    // La préparation devient prête : le démarrage différé a lieu, une seule fois.
    model.isSetupReady = { true }
    await model.startIfEnabled()
    await model.startIfEnabled()
    #expect(listener.startCount == 1)
    #expect(model.state.isRunning)
}
