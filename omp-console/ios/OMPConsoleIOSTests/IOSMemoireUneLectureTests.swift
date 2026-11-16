// Les preuves Swift de « une seule lecture de portée par actualisation »
// (memoire-ios-une-seule-lecture-de-portee) : la liste, ses pages suivantes, le graphe et la
// recherche se partagent UNE lecture de la mémoire du serveur par actualisation, et la liste ne
// mélange jamais deux lectures.
//
// Aucune socket : les écrans (`IOSMemoryModel`, `IOSMemoryGraphModel`) sont branchés sur le MÊME
// `MemoryAccess`, relié à la doublure `CountingMemoryTransport`. Elle compte les requêtes par
// adresse et par chemin, peut retenir une réponse jusqu'à ce que le test la libère, et voit
// l'annulation d'une réponse retenue. Ce fichier est le seul de la cible qui nomme la signature
// `MemoryTransport.send(_ request: URLRequest)`, qu'une doublure de transport doit écrire (la garde
// `coque-ios` l'exempte nommément de ce seul jeton). Les adresses se posent sans schéma :
// `MemoryAccess` le complète.

import Combine
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

// MARK: - La doublure de transport

/// Un échange retenu : la porte que `release` ouvre, et la règle d'annulation de ce `hold`.
private final class UneLectureGate: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var outcome: Result<Void, Error>?

    /// Attend la fin de la porte : une réponse déjà décidée rend la main aussitôt.
    func wait() async throws {
        try await withCheckedThrowingContinuation { (waiting: CheckedContinuation<Void, Error>) in
            lock.lock()
            if let decided = outcome {
                lock.unlock()
                waiting.resume(with: decided)
            } else {
                continuation = waiting
                lock.unlock()
            }
        }
    }

    /// Décide la porte, une seule fois ; faux si elle l'était déjà.
    @discardableResult
    func finish(_ result: Result<Void, Error>) -> Bool {
        lock.lock()
        guard outcome == nil else {
            lock.unlock()
            return false
        }
        outcome = result
        let waiting = continuation
        continuation = nil
        lock.unlock()
        waiting?.resume(with: result)
        return true
    }
}

/// Un `MemoryTransport` de test : réponses servies par adresse et chemin (requête comprise),
/// requêtes comptées, réponses retenues, annulations vues. Le verrou rend ses états sûrs entre
/// la tâche des tests et les tâches de lecture.
final class CountingMemoryTransport: MemoryTransport, @unchecked Sendable {
    private struct Key: Hashable {
        let host: String
        let path: String
    }

    private struct Entry {
        let key: Key
        let method: String
        let body: Data?
    }

    private enum Reply {
        case status(Int, Data)
        case failure(any Error)
    }

    private struct Held {
        let gate: UneLectureGate
        let ignoringCancellation: Bool
    }

    static let defaultHost = "m1.test"

    private let lock = NSLock()
    private var replies: [Key: Reply] = [:]
    private var holds: [Key: Bool] = [:]
    private var waiting: [Key: Held] = [:]
    private var log: [Entry] = []
    private var cancellations: [Key: Int] = [:]
    private var markedAt = 0

    private func locked<Value>(_ body: () -> Value) -> Value {
        lock.lock()
        defer { lock.unlock() }
        return body()
    }

    // MARK: Ce que la doublure sert

    /// Sert `json` (statut 200 sauf mention) à la prochaine requête sur ce chemin et aux suivantes.
    func serve(host: String = CountingMemoryTransport.defaultHost, path: String, json: String, status: Int = 200) {
        locked { replies[Key(host: host, path: path)] = .status(status, Data(json.utf8)) }
    }

    /// Répond par un statut d'échec, sans corps utile.
    func fail(host: String = CountingMemoryTransport.defaultHost, path: String, status: Int) {
        serve(host: host, path: path, json: "{}", status: status)
    }

    /// Lève `error` à la place d'une réponse (délai dépassé, annulation du transport…).
    func fail(host: String = CountingMemoryTransport.defaultHost, path: String, _ error: any Error) {
        locked { replies[Key(host: host, path: path)] = .failure(error) }
    }

    /// La PROCHAINE requête sur ce chemin attend `release`. Elle reçoit alors la réponse servie à
    /// ce moment. Sans `ignoringCancellation`, l'annulation de la tâche appelante la termine
    /// aussitôt en `CancellationError` et compte une annulation.
    func hold(host: String = CountingMemoryTransport.defaultHost, path: String, ignoringCancellation: Bool = false) {
        locked { holds[Key(host: host, path: path)] = ignoringCancellation }
    }

    func isHeld(host: String = CountingMemoryTransport.defaultHost, path: String) -> Bool {
        locked { waiting[Key(host: host, path: path)] != nil }
    }

    func release(host: String = CountingMemoryTransport.defaultHost, path: String) {
        let key = Key(host: host, path: path)
        let held = locked { waiting.removeValue(forKey: key) }
        held?.gate.finish(.success(()))
    }

    // MARK: Ce que la doublure a vu

    /// Les requêtes parties vers ce chemin exact (requête comprise), sur une adresse ou sur toutes.
    func count(host: String? = nil, path: String) -> Int {
        tally(from: 0, host: host) { $0 == path }
    }

    /// Les requêtes dont le chemin commence par `prefix` (`/memory/all?agent_id=`).
    func count(host: String? = nil, prefix: String) -> Int {
        tally(from: 0, host: host) { $0.hasPrefix(prefix) }
    }

    /// Les réponses retenues puis annulées sur ce chemin.
    func cancelled(host: String = CountingMemoryTransport.defaultHost, path: String) -> Int {
        locked { cancellations[Key(host: host, path: path)] ?? 0 }
    }

    /// Pose la marque : les comptes « depuis la marque » repartent de là.
    @discardableResult
    func mark() -> Int {
        locked {
            markedAt = log.count
            return markedAt
        }
    }

    func countSinceMark(host: String? = nil, path: String) -> Int {
        let start = locked { markedAt }
        return tally(from: start, host: host) { $0 == path }
    }

    func countSinceMark(host: String? = nil, prefix: String) -> Int {
        let start = locked { markedAt }
        return tally(from: start, host: host) { $0.hasPrefix(prefix) }
    }

    /// Toutes les requêtes parties depuis la marque.
    func requestsSinceMark() -> Int {
        locked { log.count - markedAt }
    }

    /// Les corps JSON décodés des requêtes parties vers ce chemin (la recherche).
    func bodies(path: String) -> [[String: Any]] {
        let found = locked { log.filter { $0.key.path == path }.compactMap(\.body) }
        return found.compactMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
    }

    private func tally(from start: Int, host: String?, where matches: (String) -> Bool) -> Int {
        locked {
            log[start...].filter { entry in
                (host == nil || entry.key.host == host) && matches(entry.key.path)
            }.count
        }
    }

    // MARK: MemoryTransport

    func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        let arrival = arrive(request)
        if let held = arrival.held {
            try await wait(on: held, key: arrival.key)
        }
        return try reply(for: arrival.key)
    }

    /// L'arrivée d'une requête, en un seul tour de verrou : elle est comptée ET, si un `hold` l'attend,
    /// retenue, sans qu'un test voie l'une sans l'autre.
    private func arrive(_ request: URLRequest) -> (key: Key, held: Held?) {
        let host = request.url?.host ?? ""
        var path = request.url?.path ?? ""
        if let query = request.url?.query { path += "?" + query }
        let key = Key(host: host, path: path)
        return locked { () -> (key: Key, held: Held?) in
            log.append(Entry(key: key, method: request.httpMethod ?? "GET", body: request.httpBody))
            guard let ignoring = holds.removeValue(forKey: key) else { return (key, nil) }
            let held = Held(gate: UneLectureGate(), ignoringCancellation: ignoring)
            waiting[key] = held
            return (key, held)
        }
    }

    private func wait(on held: Held, key: Key) async throws {
        try await withTaskCancellationHandler {
            try await held.gate.wait()
        } onCancel: {
            guard !held.ignoringCancellation else { return }
            if held.gate.finish(.failure(CancellationError())) {
                self.noteCancelled(held.gate, key: key)
            }
        }
    }

    private func noteCancelled(_ gate: UneLectureGate, key: Key) {
        locked {
            if waiting[key]?.gate === gate { waiting[key] = nil }
            cancellations[key, default: 0] += 1
        }
    }

    private func reply(for key: Key) throws -> (status: Int, body: Data) {
        let reply = locked { replies[key] }
        switch reply {
        case .status(let status, let body)?:
            return (status, body)
        case .failure(let error)?:
            throw error
        case nil:
            return (404, Data("{}".utf8))
        }
    }
}

// MARK: - Les lignes servies

private let m1Host = "m1.test"
private let m2Host = "m2.test"

private enum Route {
    static let all = "/memory/all"
    static let graph = "/memory/graph"
    static let search = "/memory/search"
    static let scopePrefix = "/memory/all?agent_id="

    static func scope(_ name: String) -> String { scopePrefix + name }
}

/// Les arêtes que sert `/memory/graph` : aucune, les nœuds viennent des lignes lues.
private let noEdges = #"{"total":0,"edges":[]}"#

/// `count` ids distincts `prefix0`, `prefix1`…
private func names(_ prefix: String, _ count: Int) -> [String] {
    (0 ..< count).map { prefix + String($0) }
}

/// Plusieurs portées à la suite, la plus récente en tête, comme `GET /memory/all` les sert ; une
/// portée `nil` donne des lignes sans `agent_id`.
private func concat(_ parts: (String?, [String])...) -> String {
    let items = parts.flatMap { part in
        part.1.map { id -> String in
            let agent = part.0.map { #","agent_id":"\#($0)""# } ?? ""
            return #"{"id":"\#(id)","memory":"souvenir \#(id)"\#(agent)}"#
        }
    }
    return #"{"total":\#(items.count),"results":[\#(items.joined(separator: ","))]}"#
}

/// Les lignes d'une seule portée (`GET /memory/all?agent_id=…`), ou sans portée.
private func rows(_ scope: String?, _ ids: [String]) -> String {
    concat((scope, ids))
}

private func isPrefix(_ ids: [String], of full: [String]) -> Bool {
    ids.count <= full.count && Array(full.prefix(ids.count)) == ids
}

private func loadFailed(_ load: IOSMemoryLoad) -> Bool {
    if case .failed = load { return true }
    return false
}

private func loadIsPage(_ load: IOSMemoryLoad) -> Bool {
    if case .page = load { return true }
    return false
}

private func graphFailed(_ state: IOSMemoryGraphModel.State) -> Bool {
    if case .failed = state { return true }
    return false
}

/// Les valeurs qu'un `@Published` a prises, dans l'ordre.
final class UneLectureJournal<Value>: @unchecked Sendable {
    var values: [Value] = []
}

// MARK: - Les paramètres

/// Les deux mémoires sans aucune portée de AC-4.
enum UneLectureMemoireSansProjet: String, CaseIterable, Sendable {
    case empty = "vide"
    case withoutAgent = "lignes sans agent_id"

    var json: String {
        switch self {
        case .empty: rows(nil, [])
        case .withoutAgent: rows(nil, names("x", 4))
        }
    }
}

/// Les deux échecs d'actualisation de AC-10.
enum UneLectureEchec: String, CaseIterable, Sendable {
    case unavailable = "503"
    case timedOut = "délai dépassé"

    var expected: IOSMemoryFailure {
        switch self {
        case .unavailable: .serviceUnavailable
        case .timedOut: .timedOut
        }
    }

    func apply(on transport: CountingMemoryTransport, path: String) {
        switch self {
        case .unavailable: transport.fail(path: path, status: 503)
        case .timedOut: transport.fail(path: path, URLError(.timedOut))
        }
    }
}

/// Les trois gestes d'actualisation de la liste de AC-7 : tirer, « Réessayer » et ⌘R sur la liste
/// appellent tous `model.refresh()` (`IOSMemoryScreen.swift`, `.refreshable`, « Réessayer », ⌘R).
enum UneLectureGeste: String, CaseIterable, Sendable {
    case pull = "tirer"
    case retry = "Réessayer"
    case commandR = "⌘R sur la liste"

    @MainActor
    func perform(on bench: UneLectureBench) async {
        await bench.model.refresh()
    }
}

// MARK: - L'écran rejoué

/// L'accès, la liste et le graphe branchés ensemble sur la doublure, et les gestes de
/// `IOSMemoryScreen` rejoués comme l'écran les enchaîne.
@MainActor
final class UneLectureBench {
    let transport: CountingMemoryTransport
    let preferences: InMemoryClientPreferences
    let tokens: InMemoryTokenStore
    private(set) var access: MemoryAccess
    private(set) var model: IOSMemoryModel
    private(set) var graph: IOSMemoryGraphModel

    private init(transport: CountingMemoryTransport, preferences: InMemoryClientPreferences, tokens: InMemoryTokenStore) {
        self.transport = transport
        self.preferences = preferences
        self.tokens = tokens
        let access = MemoryAccess(preferences: preferences, tokens: tokens, transport: transport)
        self.access = access
        model = IOSMemoryModel(client: access)
        graph = IOSMemoryGraphModel(client: access)
    }

    /// Une mémoire reliée à `m1.test` (adresse sans schéma : `MemoryAccess` y ajoute le sien).
    static func make(_ transport: CountingMemoryTransport) async -> UneLectureBench {
        let bench = UneLectureBench(transport: transport, preferences: InMemoryClientPreferences(), tokens: InMemoryTokenStore())
        await bench.access.configure(address: m1Host, token: "t")
        return bench
    }

    /// Le relancement : un accès NEUF sur les MÊMES préférences et le même jeton, puis `load()`.
    func relaunch() async {
        let access = MemoryAccess(preferences: preferences, tokens: tokens, transport: transport)
        self.access = access
        model = IOSMemoryModel(client: access)
        graph = IOSMemoryGraphModel(client: access)
        await access.load()
    }

    /// `reload()` de l'écran : la liste, puis le graphe s'il est affiché.
    func reload() async {
        await model.refresh()
        if graph.shown { await graph.refresh() }
    }

    /// Le choix d'un projet dans le menu : `choose(scope:)` puis `reload()`.
    func choose(_ scope: String) async {
        access.choose(scope: scope)
        await reload()
    }

    /// Un code d'appairage collé : `configure`, puis `reload` si et seulement si `pairings` a changé,
    /// comme `onMemoryConfigured`. Rend vrai quand l'écran a relu.
    @discardableResult
    func pair(address: String, token: String) async -> Bool {
        let before = access.pairings
        await access.configure(address: address, token: token)
        guard access.pairings != before else { return false }
        await reload()
        return true
    }

    /// Le défilement jusqu'au pied : `loadMore()` tant qu'une page suivante est offerte.
    func scrollToEnd() async {
        var turns = 0
        while model.summary?.more == .available, turns < 20 {
            turns += 1
            await model.loadMore()
        }
    }

    var summaryIds: [String] { model.summary?.rows.map(\.id) ?? [] }

    /// Les nœuds de souvenir du graphe (hors nœuds-étiquettes).
    var memoryNodes: [MemoryGraphNode] { graph.visible.nodes.filter { $0.id.memoryId != nil } }
    var memoryNodeIds: [String] { memoryNodes.compactMap { $0.id.memoryId } }

    /// L'attente d'une réponse retenue, sans dormir : on cède la main jusqu'à ce qu'elle le soit.
    func waitHeld(_ path: String, host: String = CountingMemoryTransport.defaultHost) async {
        while !transport.isHeld(host: host, path: path) { await Task.yield() }
    }

    /// L'attente du chargement du graphe : le modèle est alors dans la lecture partagée.
    func waitGraphLoading() async {
        while graph.state != .loading { await Task.yield() }
    }
}

// MARK: - Les preuves

@MainActor
@Suite("memoire-ios-une-seule-lecture-de-portee — une lecture de portée par actualisation", .serialized)
struct IOSMemoireUneLectureTests {
    /// AC-2 : une mémoire où « recent » (250, écrite en dernier) précède « ancien », ouverte jusqu'au
    /// graphe. Rend l'écran, la doublure et les ids de « recent ».
    private func openRecent() async -> (bench: UneLectureBench, transport: CountingMemoryTransport, recent: [String]) {
        let transport = CountingMemoryTransport()
        let recent = names("r", 250)
        transport.serve(path: Route.all, json: concat(("recent", recent), ("ancien", names("o", 40))))
        transport.serve(path: Route.scope("recent"), json: rows("recent", recent))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        await bench.scrollToEnd()
        await bench.graph.activate()
        return (bench, transport, recent)
    }

    /// AC-4 : le départ commun, la liste puis le graphe sur une mémoire sans portée.
    private func openUnscoped(_ memory: UneLectureMemoireSansProjet) async -> (bench: UneLectureBench, transport: CountingMemoryTransport) {
        let transport = CountingMemoryTransport()
        transport.serve(path: Route.all, json: memory.json)
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        await bench.graph.activate()
        return (bench, transport)
    }

    // MARK: - AC-1

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-1 : choisir un projet, défiler jusqu'au bout puis ouvrir le graphe lit le projet une fois et le graphe une fois")
    func ac1ChooseScrollThenGraph() async {
        let transport = CountingMemoryTransport()
        let autre = names("a", 3)
        let produit = names("p", 250)
        transport.serve(path: Route.all, json: concat(("autre", autre), ("produit", produit)))
        transport.serve(path: Route.scope("produit"), json: rows("produit", produit))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)

        // Le lancement : la lecture sans portée donne les portées.
        await bench.model.refresh()
        #expect(bench.access.scopes == ["autre", "produit"])
        transport.mark()

        await bench.choose("produit")
        await bench.scrollToEnd()
        await bench.graph.activate()

        #expect(transport.countSinceMark(path: Route.scope("produit")) == 1)
        #expect(transport.countSinceMark(path: Route.graph) == 1)
        #expect(transport.countSinceMark(path: Route.all) == 0)
        #expect(bench.summaryIds == produit)
        #expect(Set(bench.summaryIds).count == 250)
        #expect(bench.memoryNodeIds.count == 250)
        #expect(Set(bench.memoryNodeIds) == Set(produit))
    }

    // MARK: - AC-2

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-2 : sans projet choisi, une lecture de toute la mémoire sert le projet le plus récent, ses pages et son graphe")
    func ac2EverythingServesTheMostRecent() async {
        let (bench, transport, recent) = await openRecent()

        #expect(transport.count(path: Route.all) == 1)
        #expect(transport.count(prefix: Route.scopePrefix) == 0)
        #expect(transport.count(path: Route.graph) == 1)
        #expect(bench.summaryIds == recent)
        #expect(Set(bench.summaryIds).count == 250)
        #expect(bench.model.summary?.scope == "recent")
        #expect(bench.memoryNodeIds.count == 250)
        #expect(Set(bench.memoryNodeIds) == Set(recent))
        #expect(bench.memoryNodes.allSatisfy { $0.scope == "recent" })
    }

    // MARK: - AC-3

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-3 : deux actualisations relisent le projet deux fois, jamais toute la mémoire")
    func ac3TwoRefreshesReadTheScopeTwice() async {
        let (bench, transport, _) = await openRecent()

        bench.graph.hide()
        transport.mark()
        await bench.model.refresh()
        await bench.model.refresh()
        await bench.graph.activate()

        #expect(transport.countSinceMark(path: Route.all) == 0)
        #expect(transport.countSinceMark(path: Route.scope("recent")) == 2)
        #expect(transport.countSinceMark(path: Route.graph) == 1)
    }

    // MARK: - AC-4

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-4 : une mémoire sans projet est lue une fois par actualisation, jamais à chaque écran", arguments: UneLectureMemoireSansProjet.allCases)
    func ac4UnscopedMemoryIsReadOncePerRefresh(_ memory: UneLectureMemoireSansProjet) async {
        let (bench, transport) = await openUnscoped(memory)

        #expect(bench.model.state(connection: .connected) == .noProject)
        #expect(bench.graph.state == .noProject)
        #expect(transport.count(path: Route.all) == 1)
        #expect(transport.count(prefix: Route.scopePrefix) == 0)
        #expect(transport.count(path: Route.graph) == 0)

        // Retour à la liste, tirage : la doublure sert désormais une portée « neuve ».
        bench.graph.hide()
        let neuve = names("n", 3)
        transport.serve(path: Route.all, json: rows("neuve", neuve))
        transport.mark()
        await bench.model.refresh()

        #expect(transport.countSinceMark(path: Route.all) == 1)
        #expect(transport.countSinceMark(prefix: Route.scopePrefix) == 0)
        guard case let .summary(scope, _, shown, _) = bench.model.state(connection: .connected) else {
            Issue.record("le sommaire de « neuve » devait s'afficher après le tirage")
            return
        }
        #expect(scope == "neuve")
        #expect(shown.map(\.id) == neuve)
        #expect(bench.access.scopes == ["neuve"])
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-4 : ⌘R du graphe sur une mémoire où une portée apparaît la sert au graphe et recale la liste sans lecture", arguments: UneLectureMemoireSansProjet.allCases)
    func ac4GraphRefreshFindsANewScope(_ memory: UneLectureMemoireSansProjet) async {
        let (bench, transport) = await openUnscoped(memory)
        #expect(transport.count(path: Route.all) == 1)
        #expect(transport.count(path: Route.graph) == 0)

        let neuve = names("n", 3)
        transport.serve(path: Route.all, json: rows("neuve", neuve))
        transport.mark()
        await bench.graph.refresh()

        #expect(transport.countSinceMark(path: Route.all) == 1)
        #expect(transport.countSinceMark(prefix: Route.scopePrefix) == 0)
        #expect(transport.countSinceMark(path: Route.graph) == 1)
        #expect(bench.memoryNodeIds.count == 3)
        #expect(Set(bench.memoryNodeIds) == Set(neuve))
        #expect(bench.access.scopes == ["neuve"])
        // La liste se recale sur la lecture gardée (`keptReads`), sans aucune lecture de plus.
        guard case let .summary(scope, _, shown, _) = bench.model.state(connection: .connected) else {
            Issue.record("la liste devait se recaler sur la lecture de « neuve »")
            return
        }
        #expect(scope == "neuve")
        #expect(shown.map(\.id) == neuve)
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-4 : ⌘R du graphe sur une mémoire restée sans portée relit toute la mémoire et reste sur « aucun projet »", arguments: UneLectureMemoireSansProjet.allCases)
    func ac4GraphRefreshOnAMemoryStillWithoutScope(_ memory: UneLectureMemoireSansProjet) async {
        let (bench, transport) = await openUnscoped(memory)

        transport.mark()
        await bench.graph.refresh()

        #expect(transport.countSinceMark(path: Route.all) == 1)
        #expect(transport.countSinceMark(prefix: Route.scopePrefix) == 0)
        #expect(transport.countSinceMark(path: Route.graph) == 0)
        #expect(bench.graph.state == .noProject)
        #expect(bench.model.state(connection: .connected) == .noProject)
    }

    // MARK: - AC-5

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-5 : au relancement avec un projet gardé, une seule lecture de toute la mémoire remplit le menu et la liste")
    func ac5RelaunchWithAKeptScopeReadsEverythingOnce() async {
        let transport = CountingMemoryTransport()
        let autre = names("a", 40)
        let produit = names("p", 250)
        transport.serve(path: Route.all, json: concat(("autre", autre), ("produit", produit)))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        // Un lancement précédent a choisi « produit » : la préférence est gardée.
        bench.access.choose(scope: "produit")

        await bench.relaunch()
        #expect(bench.access.chosenScope == "produit")
        await bench.model.refresh()
        await bench.scrollToEnd()
        await bench.graph.activate()

        #expect(bench.summaryIds == produit)
        #expect(Set(bench.summaryIds).count == 250)
        #expect(bench.model.summary?.scope == "produit")
        #expect(Set(bench.memoryNodeIds) == Set(produit))
        #expect(bench.memoryNodeIds.count == 250)
        #expect(bench.access.scopes == ["autre", "produit"])
        // Le menu « Projet » est actif : mémoire reliée et portées connues.
        #expect(IOSMemoryModel.gesturesEnabled(bench.access.isConfigured))
        #expect(!bench.access.scopes.isEmpty)
        #expect(transport.count(path: Route.all) == 1)
        #expect(transport.count(prefix: Route.scopePrefix) == 0)
        #expect(transport.count(path: Route.graph) == 1)
    }

    // MARK: - AC-6

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-6 : choisir un autre projet le lit une fois, graphe affiché ou non, et le choix est gardé", arguments: [true, false])
    func ac6ChoosingAnotherScopeReadsItOnce(graphShown: Bool) async {
        let transport = CountingMemoryTransport()
        let autre = names("a", 250)
        let produit = names("p", 250)
        transport.serve(path: Route.all, json: concat(("autre", autre), ("produit", produit)))
        transport.serve(path: Route.scope("autre"), json: rows("autre", autre))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        bench.access.choose(scope: "produit")

        await bench.model.refresh()
        #expect(bench.model.summary?.scope == "produit")
        if graphShown { await bench.graph.activate() }
        transport.mark()

        await bench.choose("autre")
        await bench.scrollToEnd()
        if !graphShown { await bench.graph.activate() }

        #expect(transport.countSinceMark(path: Route.scope("autre")) == 1)
        #expect(transport.countSinceMark(path: Route.all) == 0)
        #expect(transport.countSinceMark(path: Route.graph) == 1)
        #expect(bench.model.summary?.scope == "autre")
        #expect(bench.summaryIds == autre)
        #expect(Set(bench.summaryIds).count == 250)
        #expect(bench.memoryNodeIds.count == 250)
        #expect(Set(bench.memoryNodeIds) == Set(autre))

        // Le choix est gardé au lancement suivant.
        await bench.relaunch()
        #expect(bench.access.chosenScope == "autre")
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-6 : variante concurrente — la lecture de l'ancien projet, finie après le choix, ne se garde pas")
    func ac6ALateReadOfThePreviousScopeIsNotKept() async throws {
        let transport = CountingMemoryTransport()
        let autre = names("a", 150)
        let produit = names("p", 250)
        transport.serve(path: Route.all, json: concat(("autre", autre), ("produit", produit)))
        transport.serve(path: Route.scope("produit"), json: rows("produit", produit))
        transport.serve(path: Route.scope("autre"), json: rows("autre", autre))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        bench.access.choose(scope: "produit")
        await bench.model.refresh()
        await bench.graph.activate()

        // ⌘R du graphe sur « produit » : sa lecture est retenue, puis le graphe est caché.
        transport.hold(path: Route.scope("produit"))
        let pending = Task { await bench.graph.refresh() }
        await bench.waitHeld(Route.scope("produit"))
        bench.graph.hide()

        // Le choix d'« autre » ne relit que la liste, le graphe étant caché.
        await bench.choose("autre")
        transport.release(path: Route.scope("produit"))
        await pending.value

        #expect(bench.model.summary?.scope == "autre")
        #expect(isPrefix(bench.summaryIds, of: autre))
        let page = try await bench.access.memoryPage(scope: "autre", offset: 100, limit: nil)
        #expect(page.rows.map(\.id) == Array(autre[100 ..< 150]))
        await bench.scrollToEnd()
        #expect(bench.model.summary?.scope == "autre")
        #expect(bench.summaryIds == autre)
        #expect(transport.count(path: Route.scope("autre")) == 1)
    }

    // MARK: - AC-7

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-7 : actualiser relit le projet une fois et la liste égale la nouvelle lecture", arguments: UneLectureGeste.allCases)
    func ac7RefreshReadsTheScopeOnceAndTheListEqualsIt(_ geste: UneLectureGeste) async {
        let transport = CountingMemoryTransport()
        let a = names("p", 250)
        // B : un souvenir neuf en tête, « p7 » retiré.
        let b = ["pNeuf"] + a.filter { $0 != "p7" }
        transport.serve(path: Route.all, json: rows("produit", a))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        await bench.scrollToEnd()
        #expect(bench.summaryIds == a)

        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        transport.mark()
        await geste.perform(on: bench)
        await bench.scrollToEnd()

        #expect(transport.countSinceMark(path: Route.scope("produit")) == 1)
        #expect(transport.countSinceMark(path: Route.all) == 0)
        // Les pages suivantes tranchent la lecture B : aucune lecture de plus.
        #expect(transport.requestsSinceMark() == 1)
        #expect(bench.summaryIds == b)
        #expect(bench.summaryIds.contains("pNeuf"))
        #expect(!bench.summaryIds.contains("p7"))
        #expect(Set(bench.summaryIds).count == bench.summaryIds.count)
    }

    // MARK: - AC-8

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-8 : une page demandée pendant la relecture du graphe ne mélange jamais deux lectures")
    func ac8APageRequestedDuringTheGraphRereadNeverMixesTwoReads() async {
        let transport = CountingMemoryTransport()
        let a = names("p", 250)
        // B : A décalée de 50.
        let b = Array(a[50...]) + Array(a[..<50])
        transport.serve(path: Route.all, json: concat(("autre", names("o", 3)), ("produit", a)))
        transport.serve(path: Route.scope("produit"), json: rows("produit", a))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)

        // La lecture A du projet : le lancement, puis le choix de « produit ».
        await bench.model.refresh()
        await bench.choose("produit")
        #expect(transport.count(path: Route.scope("produit")) == 1)
        #expect(bench.summaryIds == Array(a[0 ..< 100]))
        await bench.graph.activate()

        // ⌘R du graphe : la doublure retient la lecture B.
        transport.hold(path: Route.scope("produit"))
        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        let pending = Task { await bench.graph.refresh() }
        await bench.waitHeld(Route.scope("produit"))

        // Retour à la liste, pied atteint avant la réponse : la page 2 vient de A, jamais de B.
        bench.graph.hide()
        await bench.model.loadMore()
        #expect(isPrefix(bench.summaryIds, of: a) || isPrefix(bench.summaryIds, of: b))
        #expect(bench.summaryIds == Array(a[0 ..< 200]))

        // La doublure livre B.
        transport.release(path: Route.scope("produit"))
        await pending.value
        #expect(isPrefix(bench.summaryIds, of: a) || isPrefix(bench.summaryIds, of: b))
        #expect(bench.summaryIds == Array(b[0 ..< 100]))
        #expect(bench.model.summary?.more == .available)
        #expect(bench.model.summary?.nextOffset == 100)

        transport.mark()
        await bench.scrollToEnd()
        #expect(transport.requestsSinceMark() == 0)
        #expect(bench.summaryIds == b)
        #expect(transport.count(path: Route.scope("produit")) == 2)
    }

    // MARK: - AC-9

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-9 : après un ⌘R du graphe, la liste repart de la nouvelle lecture sans la relire")
    func ac9AfterAGraphRefreshTheListRestartsFromTheNewRead() async {
        let transport = CountingMemoryTransport()
        let a = names("p", 250)
        // B : A décalée de 50, « p10 » retiré.
        let b = (Array(a[50...]) + Array(a[..<50])).filter { $0 != "p10" }
        transport.serve(path: Route.all, json: concat(("autre", names("o", 3)), ("produit", a)))
        transport.serve(path: Route.scope("produit"), json: rows("produit", a))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        await bench.choose("produit")
        await bench.graph.activate()
        #expect(bench.summaryIds == Array(a[0 ..< 100]))

        // ⌘R sur le graphe seul : la doublure sert B.
        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        await bench.graph.refresh()
        transport.mark()
        bench.graph.hide()

        // Au retour à la liste : la première page de B, sans lecture.
        #expect(bench.summaryIds == Array(b[0 ..< 100]))
        await bench.scrollToEnd()

        #expect(transport.count(path: Route.scope("produit")) == 2)
        #expect(transport.requestsSinceMark() == 0)
        #expect(bench.summaryIds == b)
        #expect(Set(bench.summaryIds).count == b.count)
        #expect(!bench.summaryIds.contains("p10"))
        #expect(Set(bench.memoryNodeIds) == Set(b))
    }

    // MARK: - AC-10

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : une actualisation en échec garde la lecture précédente, une annulation n'est jamais annoncée", arguments: UneLectureEchec.allCases)
    func ac10AFailedRefreshKeepsThePreviousRead(_ failure: UneLectureEchec) async throws {
        let transport = CountingMemoryTransport()
        let a = names("p", 250)
        let b = names("q", 250)
        transport.serve(path: Route.all, json: rows("produit", a))
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        let before = try #require(bench.model.summary)
        #expect(before.rows.map(\.id) == Array(a[0 ..< 100]))

        failure.apply(on: transport, path: Route.scope("produit"))
        await bench.model.refresh()

        // Connecté : l'échec, sans les anciennes lignes.
        #expect(bench.model.state(connection: .connected) == .failed(failure.expected))
        // Hors connexion : le sommaire de A.
        #expect(bench.model.state(connection: .connecting) == .summary(scope: "produit", total: 250, rows: before.rows, more: before.more))
        #expect(bench.model.summary == before)

        // La lecture A reste servie à ce qui ne relit pas le serveur.
        transport.mark()
        let page = try await bench.access.memoryPage(scope: "produit", offset: 100, limit: nil)
        #expect(page.rows.map(\.id) == Array(a[100 ..< 200]))
        #expect(transport.requestsSinceMark() == 0)

        // « Réessayer » réussit : la nouvelle lecture, exactement une lecture de plus.
        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        transport.mark()
        await bench.model.refresh()
        #expect(transport.countSinceMark(path: Route.scope("produit")) == 1)
        #expect(bench.summaryIds == Array(b[0 ..< 100]))
        guard case let .summary(scope, _, _, _) = bench.model.state(connection: .connected) else {
            Issue.record("le sommaire de B devait s'afficher après « Réessayer »")
            return
        }
        #expect(scope == "produit")
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : une annulation du transport laisse l'état d'avant, jamais en échec")
    func ac10ATransportCancellationLeavesThePreviousState() async throws {
        let transport = CountingMemoryTransport()
        transport.serve(path: Route.all, json: rows("produit", names("p", 250)))
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        let before = try #require(bench.model.summary)

        transport.fail(path: Route.scope("produit"), URLError(.cancelled))
        await bench.model.refresh()

        #expect(bench.model.load == .page(before))
        #expect(!loadFailed(bench.model.load))
        #expect(bench.model.canRefresh)
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : une lecture retenue, puis un second refresh, ne produit jamais d'échec")
    func ac10AHeldReadThenASecondRefreshNeverFails() async {
        let transport = CountingMemoryTransport()
        let a = names("p", 250)
        let b = names("q", 250)
        transport.serve(path: Route.all, json: rows("produit", a))
        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()

        let journal = UneLectureJournal<IOSMemoryLoad>()
        let watch = bench.model.$load.sink { journal.values.append($0) }
        defer { watch.cancel() }

        transport.hold(path: Route.scope("produit"))
        let first = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.scope("produit"))
        await bench.model.refresh()
        await first.value

        #expect(!journal.values.contains(where: loadFailed))
        #expect(loadIsPage(bench.model.load))
        #expect(bench.summaryIds == Array(b[0 ..< 100]))
        #expect(bench.model.canRefresh)
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : le graphe quitté pendant sa lecture n'annonce jamais d'échec")
    func ac10SuspendingTheGraphDuringItsReadNeverFails() async {
        let transport = CountingMemoryTransport()
        transport.serve(path: Route.all, json: rows("produit", names("p", 250)))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()

        let journal = UneLectureJournal<IOSMemoryGraphModel.State>()
        let watch = bench.graph.$state.sink { journal.values.append($0) }
        defer { watch.cancel() }

        transport.hold(path: Route.graph)
        let opening = Task { await bench.graph.activate() }
        await bench.waitHeld(Route.graph)
        bench.graph.suspend()
        await opening.value

        #expect(!journal.values.contains(where: graphFailed))
        #expect(bench.graph.state == .idle)
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : (i) deux refresh() dont le premier est retenu, avec un sommaire — l'écran revient au sommaire de A")
    func ac10CaseOneNeverStuckLoadingWithASummary() async throws {
        let transport = CountingMemoryTransport()
        transport.serve(path: Route.all, json: rows("produit", names("p", 250)))
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        let before = try #require(bench.model.summary)

        transport.hold(path: Route.scope("produit"))
        let first = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.scope("produit"))
        transport.fail(path: Route.scope("produit"), URLError(.cancelled))
        let second = Task { await bench.model.refresh() }
        await first.value
        await second.value

        #expect(bench.model.load == .page(before))
        #expect(bench.model.canRefresh)
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : (ii) la même suite au premier chargement, sans sommaire — l'écran revient à l'état d'avant toute lecture")
    func ac10CaseTwoNeverStuckLoadingWithoutASummary() async {
        let transport = CountingMemoryTransport()
        transport.serve(path: Route.all, json: rows("produit", names("p", 250)))
        let bench = await UneLectureBench.make(transport)

        transport.hold(path: Route.all)
        let first = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.all)
        transport.fail(path: Route.all, URLError(.cancelled))
        let second = Task { await bench.model.refresh() }
        await first.value
        await second.value

        #expect(bench.model.load == .idle)
        #expect(bench.model.canRefresh)
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : (iii) la même suite sur le graphe — jamais bloqué en chargement")
    func ac10CaseThreeNeverStuckLoadingOnTheGraph() async {
        let transport = CountingMemoryTransport()
        transport.serve(path: Route.all, json: rows("produit", names("p", 250)))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()

        transport.hold(path: Route.graph)
        let first = Task { await bench.graph.refresh() }
        await bench.waitHeld(Route.graph)
        transport.fail(path: Route.graph, URLError(.cancelled))
        await bench.graph.refresh()
        await first.value

        #expect(bench.graph.state != .loading)
        #expect(!graphFailed(bench.graph.state))
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-10 : (iv) deux refresh() retenus puis un appairage vers la même adresse — le sommaire de la nouvelle lecture, sans échec")
    func ac10CaseFourPairingDuringHeldReads() async {
        let transport = CountingMemoryTransport()
        let a = names("p", 250)
        let b = names("q", 250)
        transport.serve(path: Route.all, json: rows("produit", a))
        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()

        let journal = UneLectureJournal<IOSMemoryLoad>()
        let watch = bench.model.$load.sink { journal.values.append($0) }
        defer { watch.cancel() }

        // Deux refresh() retenus à la suite : le second remplace la lecture du premier.
        transport.hold(path: Route.scope("produit"))
        let first = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.scope("produit"))
        transport.hold(path: Route.scope("produit"))
        let second = Task { await bench.model.refresh() }
        while transport.count(path: Route.scope("produit")) < 2 { await Task.yield() }
        await bench.waitHeld(Route.scope("produit"))

        // Le code d'appairage vers la même adresse annule la lecture retenue, puis l'écran relit.
        let reloaded = await bench.pair(address: m1Host, token: "t")
        await first.value
        await second.value

        #expect(reloaded)
        #expect(!journal.values.contains(where: loadFailed))
        #expect(loadIsPage(bench.model.load))
        #expect(bench.summaryIds == Array(b[0 ..< 100]))
        #expect(!bench.model.isLoading)
        #expect(bench.model.canRefresh)
    }

    // MARK: - AC-11

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-11 : le graphe ouvert pendant la première lecture la partage")
    func ac11TheGraphOpenedDuringTheFirstReadSharesIt() async {
        let transport = CountingMemoryTransport()
        let recent = names("r", 120)
        transport.serve(path: Route.all, json: concat(("recent", recent), ("ancien", names("o", 30))))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)

        // La première page attend la lecture sans portée.
        transport.hold(path: Route.all)
        let listing = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.all)
        let opening = Task { await bench.graph.activate() }
        await bench.waitGraphLoading()
        transport.release(path: Route.all)
        await listing.value
        await opening.value

        #expect(transport.count(path: Route.all) == 1)
        #expect(transport.count(prefix: Route.scopePrefix) == 0)
        #expect(transport.count(path: Route.graph) == 1)
        #expect(bench.model.summary?.scope == "recent")
        #expect(isPrefix(bench.summaryIds, of: recent))
        #expect(bench.memoryNodeIds.count == 120)
        #expect(Set(bench.memoryNodeIds) == Set(recent))
        #expect(bench.memoryNodes.allSatisfy { $0.scope == "recent" })
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-11 : une recherche partie pendant la première lecture la partage")
    func ac11ASearchStartedDuringTheFirstReadSharesIt() async throws {
        let transport = CountingMemoryTransport()
        let recent = names("r", 120)
        transport.serve(path: Route.all, json: concat(("recent", recent), ("ancien", names("o", 30))))
        transport.serve(path: Route.search, json: #"{"results":[]}"#)
        let bench = await UneLectureBench.make(transport)
        let access = bench.access

        transport.hold(path: Route.all)
        let page = Task { try await access.memoryPage(scope: nil, offset: 0, limit: nil) }
        await bench.waitHeld(Route.all)
        let search = Task { try await access.memorySearch(query: "souvenir", scope: nil, limit: nil) }
        // La recherche rejoint la lecture en vol dès son premier tour : quelques tours lui suffisent.
        for _ in 0 ..< 20 { await Task.yield() }
        transport.release(path: Route.all)

        let shown = try await page.value
        _ = try await search.value

        #expect(transport.count(path: Route.all) == 1)
        #expect(transport.count(prefix: Route.scopePrefix) == 0)
        #expect(transport.count(path: Route.search) == 1)
        let bodies = transport.bodies(path: Route.search)
        #expect(bodies.count == 1)
        #expect(bodies.first?["agent_id"] as? String == "recent")
        #expect(shown.scope == "recent")
        #expect(shown.rows.map(\.id) == recent.prefix(MemoryReader.pageSize).map { $0 })
    }

    // MARK: - AC-12

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-12 : le graphe ouvert pendant la lecture du projet choisi la partage")
    func ac12TheGraphOpenedDuringTheChosenScopeReadSharesIt() async {
        let transport = CountingMemoryTransport()
        let produit = names("p", 250)
        transport.serve(path: Route.all, json: concat(("autre", names("a", 3)), ("produit", produit)))
        transport.serve(path: Route.scope("produit"), json: rows("produit", produit))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        // La liste des portées est connue (lancement), puis « produit » est choisi.
        await bench.model.refresh()
        bench.access.choose(scope: "produit")

        transport.hold(path: Route.scope("produit"))
        let listing = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.scope("produit"))
        let opening = Task { await bench.graph.activate() }
        await bench.waitGraphLoading()
        transport.release(path: Route.scope("produit"))
        await listing.value
        await opening.value
        await bench.scrollToEnd()

        #expect(transport.count(path: Route.scope("produit")) == 1)
        #expect(transport.count(path: Route.graph) == 1)
        #expect(bench.summaryIds == produit)
        #expect(bench.memoryNodeIds.count == 250)
        #expect(Set(bench.memoryNodeIds) == Set(produit))
    }

    // MARK: - AC-13

    /// Le départ d'AC-13 : la liste des portées connue, « produit » choisie, les lignes de A servies.
    private func openChosen() async -> (bench: UneLectureBench, transport: CountingMemoryTransport, a: [String], b: [String]) {
        let transport = CountingMemoryTransport()
        let a = names("a", 250)
        let b = names("b", 250)
        transport.serve(path: Route.all, json: concat(("autre", names("o", 3)), ("produit", a)))
        transport.serve(path: Route.scope("produit"), json: rows("produit", a))
        transport.serve(path: Route.graph, json: noEdges)
        let bench = await UneLectureBench.make(transport)
        await bench.model.refresh()
        bench.access.choose(scope: "produit")
        return (bench, transport, a, b)
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-13 : tirer pendant la première lecture la remplace, l'ancienne est annulée et jamais montrée")
    func ac13PullingDuringTheFirstReadReplacesIt() async {
        let (bench, transport, _, b) = await openChosen()

        transport.hold(path: Route.scope("produit"))
        let first = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.scope("produit"))
        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        await bench.model.refresh()
        await first.value

        #expect(transport.count(path: Route.scope("produit")) == 2)
        #expect(transport.cancelled(path: Route.scope("produit")) == 1)
        #expect(bench.summaryIds == Array(b[0 ..< 100]))

        // Le graphe prend la lecture B sans relire le projet.
        transport.mark()
        await bench.graph.activate()
        #expect(transport.countSinceMark(path: Route.scope("produit")) == 0)
        #expect(transport.countSinceMark(path: Route.all) == 0)
        #expect(bench.memoryNodeIds.count == 250)
        #expect(Set(bench.memoryNodeIds) == Set(b))
    }

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-13 : tirer pendant la première lecture la remplace, la réponse ancienne livrée malgré l'annulation n'est ni gardée ni montrée")
    func ac13ALateAnswerOfTheReplacedReadIsNeitherKeptNorShown() async throws {
        let (bench, transport, a, b) = await openChosen()

        transport.hold(path: Route.scope("produit"), ignoringCancellation: true)
        let first = Task { await bench.model.refresh() }
        await bench.waitHeld(Route.scope("produit"))
        transport.serve(path: Route.scope("produit"), json: rows("produit", b))
        await bench.model.refresh()
        #expect(bench.summaryIds == Array(b[0 ..< 100]))

        // La doublure livre A après B : la réponse tardive est celle de A.
        transport.serve(path: Route.scope("produit"), json: rows("produit", a))
        transport.release(path: Route.scope("produit"))
        await first.value

        #expect(transport.count(path: Route.scope("produit")) == 2)
        #expect(bench.summaryIds == Array(b[0 ..< 100]))
        let page = try await bench.access.memoryPage(scope: "produit", offset: 100, limit: nil)
        #expect(page.rows.map(\.id) == Array(b[100 ..< 200]))
    }

    // MARK: - AC-14

    @Test("memoire-ios-une-seule-lecture-de-portee/AC-14 : un appairage vers une autre mémoire relit ses projets une fois, vers la même relit le projet une fois")
    func ac14PairingToAnotherMemoryThenToTheSameOne() async {
        let transport = CountingMemoryTransport()
        let recent = names("r", 120)
        transport.serve(host: m1Host, path: Route.all, json: concat(("recent", recent), ("ancien", names("o", 10))))
        let m2Recent = names("x", 120)
        transport.serve(host: m2Host, path: Route.all, json: concat(("m2-recent", m2Recent), ("m2-ancien", names("z", 10))))
        let bench = await UneLectureBench.make(transport)
        let original = bench.access

        // Le sommaire de « recent », les portées lues à M1.
        await bench.model.refresh()
        #expect(bench.model.summary?.scope == "recent")
        #expect(bench.access.scopes == ["recent", "ancien"])
        let paired = bench.access.pairings
        #expect(paired == 1)

        // Un code vers une autre adresse : la lecture sans portée de M2, une fois.
        transport.mark()
        let reloadedOnM2 = await bench.pair(address: m2Host, token: "t2")
        #expect(reloadedOnM2)
        #expect(bench.access.pairings == paired + 1)
        #expect(transport.countSinceMark(host: m2Host, path: Route.all) == 1)
        #expect(transport.requestsSinceMark() == 1)
        #expect(transport.countSinceMark(prefix: Route.scopePrefix) == 0)
        #expect(bench.access.scopes == ["m2-recent", "m2-ancien"])
        #expect(bench.model.summary?.scope == "m2-recent")
        #expect(bench.summaryIds == Array(m2Recent[0 ..< 100]))

        // Un code vers la même adresse : aucune lecture sans portée, le projet relu une fois.
        let relue = names("y", 120)
        transport.serve(host: m2Host, path: Route.scope("m2-recent"), json: rows("m2-recent", relue))
        transport.mark()
        let reloadedOnTheSame = await bench.pair(address: m2Host, token: "t2")
        #expect(reloadedOnTheSame)
        #expect(bench.access.pairings == paired + 2)
        #expect(transport.countSinceMark(path: Route.all) == 0)
        #expect(transport.countSinceMark(host: m2Host, path: Route.scope("m2-recent")) == 1)
        #expect(bench.access.scopes == ["m2-recent", "m2-ancien"])
        #expect(bench.summaryIds == Array(relue[0 ..< 100]))

        // Le pied tranche cette lecture, sans appel.
        await bench.scrollToEnd()
        #expect(bench.summaryIds == relue)
        #expect(transport.requestsSinceMark() == 1)

        // Ni `load()` ni un accès relancé ne comptent un appairage ; `forget()` non plus.
        let counted = original.pairings
        await original.load()
        #expect(original.pairings == counted)
        await bench.relaunch()
        #expect(bench.access.pairings == 0)
        #expect(bench.access.isConfigured)
        await original.forget()
        #expect(original.pairings == counted)
    }
}
