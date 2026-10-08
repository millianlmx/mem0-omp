// Le contrat du client contre la VRAIE pile : la confrontation des catalogues
// (AC-13), la découverte Bonjour réelle (AC-1) et la recette gated (AC-20).
//
// Ce fichier vit dans OMPConsoleTests parce qu'il a besoin de `RemoteStack` et de
// la table de routes de la coque ; les `Remote…` de ConsoleClient y sont donc
// qualifiés quand un homonyme interne existe.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

// MARK: - Doublures minimales (le harnais ConsoleClientTests n'est pas visible ici)

@MainActor
private final class ContractDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class ContractPath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

@MainActor
private func makeModel(discovery: any DiscoverySource, tokens: InMemoryTokenStore = InMemoryTokenStore()) -> ConsoleClientModel {
    ConsoleClientModel(
        transport: URLSessionTransport(),
        discovery: discovery,
        preferences: InMemoryClientPreferences(),
        tokens: tokens,
        pacer: LiveClientPacer(),
        pathSource: ContractPath()
    )
}

/// L'endpoint d'une pile réelle.
private func endpoint(of stack: RemoteStack) -> ClientEndpoint {
    .manual(host: "127.0.0.1", port: Int(stack.port))
}

/// Le message d'erreur d'un corps, quand il y en a un.
private func errorMessage(_ body: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
          let error = object["error"] as? [String: Any] else { return nil }
    return error["message"] as? String
}

private func errorCode(_ body: Data) -> String? {
    guard let object = try? JSONSerialization.jsonObject(with: body) as? [String: Any],
          let error = object["error"] as? [String: Any] else { return nil }
    return error["code"] as? String
}

@MainActor
@Suite("Contrat client (pile réelle)")
struct ClientContractTests {
    @Test("client-distant-ios/AC-13 : le catalogue du client est l'image exacte des routes servies, et chacune existe")
    func catalogIsImageOfRouter() async throws {
        // 1. Confrontation des catalogues : méthode et chemin mis à part, l'image exacte.
        let served = RemoteRouter.routes.map { "\($0.method) \($0.path)" }
        #expect(served.count == 33)
        #expect(ClientRoute.all.count == 33)
        #expect(Set(served) == Set(ClientRoute.all.map { "\($0.method) \($0.path)" }))

        // 2. Chaque route est RÉSOLUE par le routeur réel : une route absente du
        //    routeur rendrait « route inconnue ».
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let transport = URLSessionTransport()
        let target = endpoint(of: stack)
        for route in ClientRoute.all {
            let path = route.path
                .replacingOccurrences(of: "{id}", with: "inconnu")
                .replacingOccurrences(of: "{repoKey}", with: "inconnu")
                .replacingOccurrences(of: "{slug}", with: "inconnu")
            let response = try await transport.send(
                ClientHTTPRequest(method: route.method, path: path, isStream: false),
                to: target,
                token: nil
            )
            #expect(
                !(response.status == 404 && errorMessage(response.body) == "route inconnue"),
                "\(route.method) \(route.path) n'est pas résolue par le routeur"
            )
        }

        // 3. Les routes servies sur une pile neuve se décodent TYPÉES.
        stack.stats.start()
        let code = try stack.registry.generateCode()
        let model = makeModel(discovery: ContractDiscovery())
        _ = model.setManualAddress("127.0.0.1:\(stack.port)")
        try await model.pair(code: code.value, deviceName: "Tests")

        #expect(try await model.version() == ConsoleAPI.protocolVersion)
        _ = try await model.store()
        _ = try await model.sessions()
        _ = try await model.projects()
        _ = try await model.statistics()
        _ = try await model.devices()
        _ = try await model.memory(scope: "inconnu", limit: nil)
        _ = try await model.memorySearch(query: "memoire", scope: "inconnu", limit: nil)
        _ = try await model.memoryGraph(scope: nil)
        _ = try await model.hostedSession()
        _ = try await model.repos()
        _ = try await model.conduiteState()

        // Le flux temps réel est ouvert par sa méthode typée.
        let events = try await model.openStream()
        var sawHello = false
        for try await event in events {
            if case .hello = event { sawHello = true; break }
        }
        #expect(sawHello)
        model.stop()
    }

    @Test("BR-3 : les charges utiles miroir conduite/dépôts sont l'image exacte de celles de la coque")
    func mirrorPayloadShapes() throws {
        #expect(try contractSameShape(
            #"{"repoKey":"k","repoRoot":"/tmp/r","name":"r"}"#,
            client: ConsoleClient.RemoteRepoRow.self,
            host: OMPConsole.RemoteRepoRow.self
        ))
        #expect(try contractSameShape(
            #"{"rows":[{"repoKey":"k","repoRoot":"/tmp/r","name":"r"}]}"#,
            client: ConsoleClient.RemoteReposPayload.self,
            host: OMPConsole.RemoteReposPayload.self
        ))
        #expect(try contractSameShape(
            #"{"state":"live","repoKey":"k","name":"P","repoRoot":"/tmp/r","status":{"text":"Active","tone":"success"},"dialogs":[]}"#,
            client: ConsoleClient.RemoteConduiteStatePayload.self,
            host: OMPConsole.RemoteConduiteStatePayload.self
        ))
        #expect(try contractSameShape(
            #"{"kind":"value","value":"x"}"#,
            client: ConsoleClient.RemoteDialogAnswerRequest.self,
            host: OMPConsole.RemoteDialogAnswerRequest.self
        ))
        #expect(try contractSameShape(
            #"{"id":"memory:m1","label":"titre","scope":"p","text":"texte","tags":["a"]}"#,
            client: ConsoleClient.RemoteMemoryGraphNode.self,
            host: OMPConsole.RemoteMemoryGraphNode.self
        ))
        #expect(try contractSameShape(
            ##"{"id":"tag:a","label":"#a","scope":""}"##,
            client: ConsoleClient.RemoteMemoryGraphNode.self,
            host: OMPConsole.RemoteMemoryGraphNode.self
        ))
        #expect(try contractSameShape(
            #"{"a":"memory:m1","b":"memory:m2","kind":"semantic","score":0.81}"#,
            client: ConsoleClient.RemoteMemoryGraphLink.self,
            host: OMPConsole.RemoteMemoryGraphLink.self
        ))
        #expect(try contractSameShape(
            #"{"a":"memory:m1","b":"tag:a","kind":"manual"}"#,
            client: ConsoleClient.RemoteMemoryGraphLink.self,
            host: OMPConsole.RemoteMemoryGraphLink.self
        ))
        #expect(try contractSameShape(
            #"{"nodes":[{"id":"memory:m1","label":"titre","scope":"p","text":"texte","tags":["a"]}],"links":[{"a":"memory:m1","b":"tag:a","kind":"tag"}],"total":1,"truncated":true}"#,
            client: ConsoleClient.RemoteMemoryGraphPayload.self,
            host: OMPConsole.RemoteMemoryGraphPayload.self
        ))
    }

    @Test("S-1 (AC-1) : une charge d'un Mac d'avant la feature (sans text, tags, truncated) reste lisible des deux côtés")
    func olderMacGraphPayloadStaysReadable() throws {
        let json = ##"{"nodes":[{"id":"memory:m1","label":"titre","scope":"p"},{"id":"tag:a","label":"#a","scope":""}],"links":[{"a":"memory:m1","b":"tag:a","kind":"tag"}],"total":2}"##
        let data = Data(json.utf8)

        let client = try JSONDecoder().decode(ConsoleClient.RemoteMemoryGraphPayload.self, from: data)
        #expect(client.total == 2)
        #expect(client.truncated == false)
        #expect(client.nodes.allSatisfy { $0.text == nil && $0.tags == nil })

        let host = try JSONDecoder().decode(OMPConsole.RemoteMemoryGraphPayload.self, from: data)
        #expect(host.total == 2)
        #expect(host.truncated == false)
        #expect(host.nodes.allSatisfy { $0.text == nil && $0.tags == nil })

        #expect(try contractSameShape(
            json,
            client: ConsoleClient.RemoteMemoryGraphPayload.self,
            host: OMPConsole.RemoteMemoryGraphPayload.self
        ))
    }

    @Test("les charges utiles miroir de session portent les mêmes champs des deux côtés (BR-2)")
    func sessionPayloadShapes() throws {
        let entry = #"{"index":2,"offset":120,"timestampMs":1.5,"kind":"assistant","text":"x","thinking":"réflexion","model":"m","usage":{"input":1,"output":2,"cacheRead":3,"cacheWrite":4,"totalTokens":10,"cost":0.25},"toolCalls":[{"id":"c1","name":"read","arguments":{"path":"/a.txt","i":"lire"}}],"callId":"c1","name":"read","diff":"-a","isError":false,"tokensBefore":7,"fromId":"root"}"#
        #expect(try contractSameShape(
            entry,
            client: ConsoleClient.RemoteConversationEntry.self,
            host: OMPConsole.RemoteConversationEntry.self
        ))
        #expect(try contractSameShape(
            #"{"id":"c1","name":"read","arguments":{"path":"/a.txt"}}"#,
            client: ConsoleClient.RemoteToolCall.self,
            host: OMPConsole.RemoteToolCall.self
        ))
        #expect(try contractSameShape(
            #"{"header":{"id":"s1","cwd":"/tmp/p","version":1,"timestamp":"2026-01-01T00:00:00.000Z","parentSession":"s0"},"kind":"topLevel","entries":[\#(entry)],"skipped":[{"offset":5,"reason":"invalidJSON"}],"truncated":false,"unreadableReason":"ouverture en lecture refusée"}"#,
            client: ConsoleClient.RemoteSessionPayload.self,
            host: OMPConsole.RemoteSessionPayload.self
        ))
    }

    @Test("client-distant-ios/AC-1 : la coque est découverte par Bonjour et présentée sans saisie d'adresse")
    func discoversMacOverBonjour() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let model = makeModel(discovery: BonjourDiscoverySource())
        model.start()
        // Aucune adresse n'a été saisie : la coque doit apparaître seule.
        let found = await contractEventually(timeout: 10) {
            model.discovered != nil && model.manualAddress == nil
        }
        #expect(found, "aucun Mac découvert par Bonjour — l'annonce de la pile est-elle active ?")
        #expect(model.discovered?.name == ConsoleAPI.Service.bonjourName)
        #expect(model.discovered?.endpoint.host.isEmpty == false)
        #expect(model.discovered?.endpoint.port != 0)
        model.stop()
    }

    /// La recette RÉELLE (AC-20) est gated : elle exige une coque vivante pilotée à
    /// la main derrière `MEM0_REMOTE_RECIPE=1`, et son nom de fonction est ce que
    /// `swift test --filter clientDistantRecipe` cible.
    @Test("client-distant-ios/AC-20 : recette réelle — appairage, lectures, flux contre la vraie coque")
    func clientDistantRecipe() async throws {
        guard ProcessInfo.processInfo.environment["MEM0_REMOTE_RECIPE"] == "1" else { return }
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let code = try stack.registry.generateCode()
        let model = makeModel(discovery: ContractDiscovery())
        _ = model.setManualAddress("127.0.0.1:\(stack.port)")
        try await model.pair(code: code.value, deviceName: "Recette")
        #expect(model.pairingFailure == nil)
        #expect(try await model.version() == ConsoleAPI.protocolVersion)
        let store = try await model.store()
        #expect(store.snapshot.root == .present || store.snapshot.root == .absent)
        let devices = try await model.devices()
        #expect(devices.devices.contains { $0.name == "Recette" })
        model.stop()
    }
}

/// Les noms des propriétés STOCKÉES d'une valeur, par réflexion : c'est ce que la
/// confrontation des miroirs compare.
private func contractFieldNames(_ value: Any) -> Set<String> {
    Set(Mirror(reflecting: value).children.compactMap(\.label))
}

/// Décodage du MÊME JSON par les deux types (client et coque) : les noms de champs
/// doivent coïncider — c'est l'invariant du miroir.
private func contractSameShape<Client: Decodable, Host: Decodable>(
    _ json: String,
    client: Client.Type,
    host: Host.Type
) throws -> Bool {
    let data = Data(json.utf8)
    let decodedClient = try JSONDecoder().decode(client, from: data)
    let decodedHost = try JSONDecoder().decode(host, from: data)
    return contractFieldNames(decodedClient) == contractFieldNames(decodedHost)
}

/// Attend une condition sans bloquer plus que nécessaire.
@MainActor
private func contractEventually(timeout: Double, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}
