// Les preuves Swift du client iOS à deux machines (S-6 et S-10 de
// orchestrator-living-in-a-vps) : l'app tient un client Mac et un client VPS, appairés
// indépendamment. Chaque test monte de VRAIS `ConsoleClientModel` sur des transports
// scriptés qui enregistrent la requête, l'adresse et le jeton : aucun réseau, aucun
// trousseau réel, aucune horloge murale (les attentes suivent les publications).
//
// L'identifiant qualifié d'AC-11 est porté par le test ConsoleCore `UnifiedRepos`, celui
// d'AC-12 par ConsoleClientTests : les tests d'ici n'en portent pas.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

/// Un transport qui enregistre chaque appel (méthode, chemin, adresse, jeton) et ouvre le
/// flux par un `hello` annonçant `kind` ; `nil` : la machine est muette (le flux échoue).
final class MachineRecordingTransport: ClientTransport, @unchecked Sendable {
    struct Call: Equatable {
        let method: String
        let path: String
        let address: String
        let token: String?
    }

    private let lock = NSLock()
    private var recorded: [Call] = []
    private var continuations: [AsyncThrowingStream<Data, Error>.Continuation] = []
    private let kind: String?
    private let responder: @Sendable (ClientHTTPRequest) -> ClientHTTPResponse

    init(kind: String?, _ responder: @escaping @Sendable (ClientHTTPRequest) -> ClientHTTPResponse = { _ in
        ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
    }) {
        self.kind = kind
        self.responder = responder
    }

    var calls: [Call] { lock.withLock { recorded } }

    func send(_ request: ClientHTTPRequest, to endpoint: ClientEndpoint, token: String?) async throws -> ClientHTTPResponse {
        lock.withLock { recorded.append(Call(method: request.method, path: request.path, address: endpoint.address, token: token)) }
        return responder(request)
    }

    func stream(
        _ request: ClientHTTPRequest,
        to endpoint: ClientEndpoint,
        token: String?
    ) async throws -> AsyncThrowingStream<Data, Error> {
        lock.withLock { recorded.append(Call(method: request.method, path: request.path, address: endpoint.address, token: token)) }
        guard let kind else { throw ClientError.transport(.unreachable("machine muette")) }
        let (stream, continuation) = AsyncThrowingStream<Data, Error>.makeStream()
        let hello = #"{"protocolVersion":\#(ConsoleAPI.protocolVersion),"machine":{"kind":"\#(kind)","name":"test"}}"#
        continuation.yield(Data("event: hello\ndata: \(hello)\n\n".utf8))
        lock.withLock { continuations.append(continuation) }
        return stream
    }
}

@MainActor
enum TwoMachines {
    static let macAddress = "192.168.1.5:8787"
    static let vpsAddress = "100.64.0.1:8787"

    /// Un client de `slot`, appairé (`device` + jeton `token`), adressé à `address`.
    static func client(
        slot: ClientMachineSlot,
        transport: MachineRecordingTransport,
        address: String,
        token: String
    ) -> ConsoleClientModel {
        ConsoleClientModel(
            transport: transport,
            discovery: SilentDiscovery(),
            preferences: InMemoryClientPreferences([
                slot.deviceIdKey: "device-\(slot.rawValue)",
                slot.manualAddressKey: address,
            ]),
            tokens: CountingTokenStore(["device-\(slot.rawValue)": token]),
            pacer: ImmediatePacer(),
            pathSource: SilentPathSource(),
            deviceName: "iPhone",
            searchPacer: ImmediatePacer(),
            slot: slot
        )
    }

    /// L'état d'un Mac éteint : appairé, adressé, mais le flux ne s'ouvre pas.
    static func isMacAbsent(_ state: ClientState) -> Bool {
        if case .macAbsent = state { return true }
        return false
    }

    /// Le VPS a répondu au `hello` : joint, ou refusé parce qu'il est l'autre machine.
    static func isSettledVps(_ state: ClientState) -> Bool {
        if case .wrongMachine = state { return true }
        return isConnected(state)
    }

    static func isConnected(_ state: ClientState) -> Bool {
        if case .connected = state { return true }
        return false
    }

    /// Les deux clients : le Mac éteint, le VPS joint et annonçant `vpsKind`.
    static func macAbsentAndVps(
        vpsKind: String = "vps",
        vps: @escaping @Sendable (ClientHTTPRequest) -> ClientHTTPResponse = { _ in
            ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
        }
    ) async -> (clients: MachineClients, mac: MachineRecordingTransport, vps: MachineRecordingTransport) {
        let macTransport = MachineRecordingTransport(kind: nil)
        let vpsTransport = MachineRecordingTransport(kind: vpsKind, vps)
        let mac = client(slot: .mac, transport: macTransport, address: macAddress, token: "jeton-mac")
        let vpsClient = client(slot: .vps, transport: vpsTransport, address: vpsAddress, token: "jeton-vps")
        let clients = MachineClients(mac: mac, vps: vpsClient, preferences: InMemoryClientPreferences())
        mac.start()
        vpsClient.start()
        await ClientDoubles.until(mac, state: isMacAbsent)
        await ClientDoubles.until(vpsClient, state: isSettledVps)
        return (clients, macTransport, vpsTransport)
    }
}

@MainActor
@Suite("orchestrator-living-in-a-vps — le client iOS à deux machines")
struct IOSDeuxMachinesTests {
    private static let reposJSON = #"""
    {"rows":[
      {"repoKey":"depot-vps","repoRoot":"/srv/depot","name":"depot","identity":"github.com/millian/depot"},
      {"repoKey":"seul-vps","repoRoot":"/srv/seul","name":"seul"}
    ]}
    """#

    @Test("le Mac éteint et le VPS appairé : le geste d'une carte du VPS part vers le VPS, avec le jeton du VPS et l'identifiant de carte du VPS")
    func vpsCardGestureGoesToTheVps() async throws {
        let (clients, mac, vps) = await TwoMachines.macAbsentAndVps()
        #expect(clients.availability(of: .mac) == .unreachable)
        #expect(clients.availability(of: .vps) == .reachable)
        #expect(clients.activeMachine == .vps, "Mac éteint : les écrans mono-machine parlent au VPS")

        let send = IOSHomeGestureModel.live(clients)
        try await send(IOSHomeGestureKey(cardId: "vps:feature7", gesture: .acceptReview))
        try await send(IOSHomeGestureKey(cardId: "vps:feature7", gesture: .resume))

        let gestures = vps.calls.filter { $0.path.hasPrefix("/v1/cards") }
        #expect(gestures.map(\.method) == ["POST", "POST"])
        #expect(gestures.map(\.path) == ["/v1/cards/feature7/verdict", "/v1/cards/feature7/resume"])
        #expect(gestures.allSatisfy { $0.address == TwoMachines.vpsAddress && $0.token == "jeton-vps" })
        #expect(mac.calls.allSatisfy { !$0.path.hasPrefix("/v1/cards") }, "rien d'une carte du VPS ne part vers le Mac")
        #expect(mac.calls.allSatisfy { $0.token == nil || $0.token == "jeton-mac" })
    }

    @Test("une carte du Mac garde son identifiant et part vers le Mac, même quand un VPS est configuré")
    func macCardKeepsItsIdAndMachine() async {
        let macTransport = MachineRecordingTransport(kind: "mac")
        let vpsTransport = MachineRecordingTransport(kind: "vps")
        let mac = TwoMachines.client(slot: .mac, transport: macTransport, address: TwoMachines.macAddress, token: "jeton-mac")
        let vps = TwoMachines.client(slot: .vps, transport: vpsTransport, address: TwoMachines.vpsAddress, token: "jeton-vps")
        let clients = MachineClients(mac: mac, vps: vps, preferences: InMemoryClientPreferences())

        let macCard = clients.target(forCardId: "feature-3")
        #expect(macCard.machine == .mac && macCard.client === mac && macCard.cardId == "feature-3")
        let vpsCard = clients.target(forCardId: "vps:feature-3")
        #expect(vpsCard.machine == .vps && vpsCard.client === vps && vpsCard.cardId == "feature-3")
        #expect(clients.client(for: .mac) === mac)
        #expect(clients.client(for: .vps) === vps)
    }

    @Test("le modèle de l'écran Dépôts : Mac éteint, les dépôts du VPS sont pilotables et « Confier au Mac » dit pourquoi il est grisé")
    func reposModelWithMacAbsent() async {
        let (clients, _, vps) = await TwoMachines.macAbsentAndVps(vps: { request in
            request.path == "/v1/repos"
                ? ClientDoubles.response(status: 200, json: Self.reposJSON)
                : ClientDoubles.response(status: 202, json: #"{"accepted":true}"#)
        })
        await clients.repos.refresh()
        // Une lecture lancée par le changement de disponibilité peut être en vol : on attend la publication.
        for await lines in clients.repos.$lines.values where !lines.isEmpty { break }
        #expect(vps.calls.contains { $0.method == "GET" && $0.path == "/v1/repos" && $0.token == "jeton-vps" })

        let rows = IOSReposContent.rows(clients.repos.lines, busy: []) { _ in nil }
        #expect(rows.map(\.name) == ["depot", "seul"])
        #expect(rows.allSatisfy { $0.badges == [.vps] }, "chaque ligne est marquée de sa machine")
        #expect(rows.allSatisfy { $0.status == nil && !$0.canCancel && !$0.canRetry }, "les dépôts du VPS restent pilotables")
        #expect(rows.map(\.paths) == [
            [IOSReposPath(machine: .vps, text: "/srv/depot")],
            [IOSReposPath(machine: .vps, text: "/srv/seul")],
        ])
        // Le geste « Confier au Mac » : désactivé, avec le motif de S-6.
        let offers = rows.flatMap(\.offers)
        #expect(offers.allSatisfy { $0.to == .mac && $0.from == .vps && !$0.isEnabled })
        #expect(offers.first?.disabledReason == "Mac injoignable")
        #expect(IOSReposContent.boardBanners(clients) == [.mac])
        #expect(ReposText.machineBanner(.mac) == "Mac injoignable")
    }

    @Test("l'état d'une ligne et ses gestes suivent S-6 : conflit, bascule en cours, bascule à terminer, injoignable")
    func rowStatusTexts() {
        func row(_ identity: String?, _ key: String, handover: RepoHandover? = nil) -> RepoRow {
            RepoRow(repoKey: key, repoRoot: "/r/\(key)", name: key, identity: identity, handover: handover)
        }
        let both = "github.com/o/depot"
        // Conflit : connu des deux machines sans bascule.
        let conflict = UnifiedRepos.merge(mac: .reachable([row(both, "m")]), vps: .reachable([row(both, "v")]))
        let conflictRows = IOSReposContent.rows(conflict, busy: []) { _ in nil }
        #expect(conflictRows.first?.status == "Connu des deux machines sans bascule\u{00A0}: confiez-le à l’une d’elles.")
        #expect(conflictRows.first?.badges == [.mac, .vps])
        #expect(conflictRows.first?.offers.count == 2)
        // Bascule gelée : « Bascule vers le VPS en cours » et « Annuler la bascule ».
        let frozen = UnifiedRepos.merge(
            mac: .reachable([row(both, "m", handover: RepoHandover(id: "h1", to: .vps, state: .frozen))]),
            vps: .reachable([row(both, "v")])
        )
        let frozenRows = IOSReposContent.rows(frozen, busy: []) { _ in nil }
        #expect(frozenRows.first?.status == "Bascule vers le VPS en cours")
        #expect(frozenRows.first?.canCancel == true && frozenRows.first?.canRetry == false)
        #expect(frozenRows.first?.offers.isEmpty == true, "aucun geste « Confier » pendant la bascule")
        // Bascule à terminer : « Réessayer ».
        let toFinish = UnifiedRepos.merge(
            mac: .reachable([row(both, "m", handover: RepoHandover(id: "h1", to: .vps, state: .frozen))]),
            vps: .reachable([row(both, "v")]),
            toFinish: [both]
        )
        let toFinishRows = IOSReposContent.rows(toFinish, busy: []) { _ in nil }
        #expect(toFinishRows.first?.status == "Bascule à terminer")
        #expect(toFinishRows.first?.canRetry == true && toFinishRows.first?.canCancel == false)
        // Mac injoignable : « Mac injoignable » sur ses dépôts, et le geste est grisé.
        let unreachable = UnifiedRepos.merge(mac: .unreachable(lastKnown: [row(both, "m")]), vps: .notConfigured)
        let unreachableRows = IOSReposContent.rows(unreachable, busy: []) { _ in nil }
        #expect(unreachableRows.first?.status == "Mac injoignable")
        #expect(unreachableRows.first?.offers.first?.disabledReason == "Le VPS n’est pas appairé")
        // Une bascule qui s'exécute grise la ligne.
        #expect(IOSReposContent.rows(conflict, busy: [both]) { _ in nil }.first?.busy == true)
    }

    @Test("l'adresse saisie est celle de l'autre machine : l'état wrongMachine, le texte exact et aucun geste émis")
    func wrongMachineLocksTheVpsSlot() async {
        let (clients, _, vps) = await TwoMachines.macAbsentAndVps(vpsKind: "mac")
        let state = clients.vps.state
        #expect(state == .wrongMachine(expected: .vps, actual: .mac))
        #expect(ConnectionText.state(state, machine: .vps) == "Cette adresse est le Mac, pas le VPS")
        #expect(ConnectionText.sheetState(state, machine: .vps) == "Cette adresse est le Mac, pas le VPS")
        #expect(IOSConnectionStatus.of(clients.vps) == .disconnected(.wrongMachine(expected: .vps, actual: .mac)))
        #expect(!IOSConnectionStatus.of(clients.vps).gesturesEnabled)
        #expect(IOSConnectionStateText.cause(.wrongMachine(expected: .vps, actual: .mac)) == "Cette adresse est le Mac, pas le VPS")
        #expect(IOSConnectionStateText.title(for: .wrongMachine(expected: .vps, actual: .mac)) == "Pas de connexion au VPS")
        #expect(clients.availability(of: .vps) == .unreachable)

        // Aucun geste n'est émis : seul le flux a été ouvert.
        let before = vps.calls.count
        let send = IOSHomeGestureModel.live(clients)
        _ = try? await send(IOSHomeGestureKey(cardId: "vps:feature1", gesture: .resume))
        #expect(vps.calls.count == before, "aucune requête n'est émise vers la machine verrouillée")
        #expect(!vps.calls.contains { $0.path.hasPrefix("/v1/cards") })

        // L'inverse : le Mac qui répond « vps ».
        #expect(ConnectionText.state(.wrongMachine(expected: .mac, actual: .vps)) == "Cette adresse est le VPS, pas le Mac")
    }

    @Test("la feuille Connexion, section VPS : adresse Tailscale au port par défaut 8787, appairage sur le VPS, clés et libellés du VPS")
    func vpsSectionPairsOnTheVpsEndpoint() async {
        let transport = MachineRecordingTransport(kind: "vps") { request in
            request.path == ConsoleAPI.Service.basePath + "/pair"
                ? ClientDoubles.response(
                    status: 200,
                    json: #"{"deviceId":"V1V2","token":"jeton-secret","protocolVersion":\#(ConsoleAPI.protocolVersion)}"#
                )
                : ClientDoubles.response(status: 404, json: #"{"error":{"code":"not_found"}}"#)
        }
        let preferences = InMemoryClientPreferences()
        let model = ConsoleClientModel(
            transport: transport,
            discovery: SilentDiscovery(),
            preferences: preferences,
            tokens: CountingTokenStore(),
            pacer: ImmediatePacer(),
            pathSource: SilentPathSource(),
            deviceName: "iPhone",
            searchPacer: ImmediatePacer(),
            slot: .vps
        )
        // Le port par défaut est 8787 ; l'adresse est celle du slot VPS.
        _ = model.setManualAddress("100.64.0.9")
        #expect(preferences.string(forKey: "client.vps.manualAddress") == "100.64.0.9:8787")
        #expect(preferences.string(forKey: ClientPreferenceKey.manualAddress) == nil, "le slot Mac n'est pas touché")

        let outcome = await ConnectionSheet.attemptPairing(model, code: "abcd-efgh", machine: .vps)
        #expect(outcome == .paired)
        #expect(preferences.string(forKey: "client.vps.deviceId") == "V1V2".lowercased())
        #expect(preferences.string(forKey: ClientPreferenceKey.deviceId) == nil)
        let pair = transport.calls.first { $0.path == ConsoleAPI.Service.basePath + "/pair" }
        #expect(pair?.address == "100.64.0.9:8787")

        // Les libellés de la section « VPS ».
        #expect(ConnectionText.sectionHeader(.vps) == "VPS")
        #expect(ConnectionText.sectionHeader(.mac) == "Mac")
        #expect(ConnectionText.addressPlaceholder(.vps) == "Adresse Tailscale du VPS")
        #expect(ConnectionText.addressPlaceholder(.mac) == ConnectionText.addressField)
        #expect(ConnectionText.forgetLabel(.vps) == "Oublier ce VPS")
        #expect(ConnectionText.forgetLabel(.mac) == "Oublier ce Mac")
        #expect(ConnectionText.codeHelpText(.vps).contains("VPS"))
        #expect(ConnectionText.pairingFailure(.refused, machine: .vps) == "Code refusé — demandez un code frais au VPS.")
    }

    @Test("les libellés d'état du slot VPS : injoignable, injoignable avec l'adresse, version de protocole incompatible")
    func vpsStateLabels() {
        let endpoint = ClientEndpoint.manual(host: "100.64.0.1", port: 8787)
        #expect(ConnectionText.sheetState(.macAbsent(endpoint: endpoint), machine: .vps) == "VPS injoignable")
        #expect(ConnectionText.state(.macAbsent(endpoint: endpoint), machine: .vps) == "VPS injoignable — 100.64.0.1:8787")
        #expect(
            ConnectionText.state(.incompatibleProtocol(local: 3, remote: 2), machine: .vps)
                == "Version de protocole incompatible (app 3, VPS 2)"
        )
        #expect(
            ConnectionText.state(.incompatibleProtocol(local: 3, remote: nil), machine: .vps)
                == "Version de protocole incompatible (app 3, VPS inconnu)"
        )
        // Le Mac garde ses libellés d'origine.
        #expect(ConnectionText.state(.macAbsent(endpoint: endpoint)) == "Mac injoignable — 100.64.0.1:8787")
        #expect(ConnectionText.state(.incompatibleProtocol(local: 3, remote: nil)).hasSuffix("Mac inconnu)"))
        // Le statut présenté d'un slot VPS parle du VPS, pas du Mac.
        let status = IOSConnectionStatus.resolve(.macAbsent(endpoint: endpoint), attemptFollowsFailure: false, machine: .vps)
        #expect(status == .disconnected(.onVps(.unreachable)))
        #expect(IOSConnectionStateText.cause(.onVps(.unreachable)).hasPrefix("Le VPS ne répond pas"))
        #expect(IOSConnectionStateText.title(for: .onVps(.unreachable)) == "Pas de connexion au VPS")
        #expect(IOSConnectionStateText.title(for: .unreachable) == "Pas de connexion au Mac")
        #expect(!status.gesturesEnabled)
    }

    @Test("la section Dépôts est la première de « Plus » sur iPhone, dans la barre latérale de l'iPad, avec son contenu vide")
    func reposSectionPlacement() {
        #expect(IOSTabs.plusSections.first == .repos)
        #expect(IOSTabs.isHidden(.section(.repos), compact: true))
        #expect(!IOSTabs.isHidden(.section(.repos), compact: false))
        #expect(IOSSection.sections(of: .pilotage).contains(.repos))
        #expect(IOSTabs.route(from: IOSTabRoute(tab: .section(.home), plusPath: []), to: .repos, compact: true)
            == IOSTabRoute(tab: .plus, plusPath: [.repos]))
        #expect(ConsoleSection.repos.title == "Dépôts")
        #expect(IOSSectionContent.of(.repos, state: .ready)?.message == ReposText.empty)
        #expect(IOSMachinePicker.isSingleMachine(.memory) && !IOSMachinePicker.isSingleMachine(.kanban))
    }

    @Test("le statut de l'Accueil et de Pipelines : connecté dès qu'une machine l'est, rendu du Mac seul sans VPS")
    func unifiedConnectionStatus() async {
        let (clients, _, _) = await TwoMachines.macAbsentAndVps()
        #expect(IOSConnectionStatus.of(clients.mac) == .disconnected(.unreachable))
        #expect(IOSConnectionStatus.of(clients) == .connected, "le VPS répond : l'ardoise a de quoi s'afficher")

        let macOnly = MachineClients(
            mac: TwoMachines.client(slot: .mac, transport: MachineRecordingTransport(kind: nil), address: TwoMachines.macAddress, token: "t"),
            vps: ConsoleClientModel(
                transport: MachineRecordingTransport(kind: nil),
                discovery: SilentDiscovery(),
                preferences: InMemoryClientPreferences(),
                tokens: CountingTokenStore(),
                pacer: ImmediatePacer(),
                pathSource: SilentPathSource(),
                searchPacer: ImmediatePacer(),
                slot: .vps
            ),
            preferences: InMemoryClientPreferences()
        )
        #expect(!macOnly.vpsConfigured)
        #expect(IOSConnectionStatus.of(macOnly) == IOSConnectionStatus.of(macOnly.mac), "sans VPS : le statut du Mac, tel quel")
        #expect(IOSReposContent.boardBanners(macOnly).isEmpty, "sans VPS : aucun bandeau")
    }

    @Test("le retour haptique suit la machine dont l'issue vient de changer, une seule valeur observée pour les deux")
    func feedbackFollowsTheMachineWhoseOutcomeChanged() {
        let none = IOSCommandOutcomes(mac: nil, vps: nil)
        let macOk = IOSCommandOutcomes(mac: ClientCommandOutcome(sequence: 1, succeeded: true), vps: nil)
        let vpsFailed = IOSCommandOutcomes(mac: macOk.mac, vps: ClientCommandOutcome(sequence: 1, succeeded: false))
        #expect(IOSCommandFeedback.feedback(from: none, to: macOk) == .success)
        #expect(IOSCommandFeedback.feedback(from: macOk, to: vpsFailed) == .error)
        #expect(IOSCommandFeedback.feedback(from: none, to: none) == nil)
    }
}
