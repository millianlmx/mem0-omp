// La sonde oMLX (BR-2, S-6) : elle nomme l'état d'un prérequis SYSTÈME que l'app
// ne configure pas. Un 200 suffit — même un corps non JSON —, un 401 signifie
// « jeton refusé », une connexion impossible est un ÉTAT `unreachable`, jamais une
// exception.
//
// Les requêtes passent par `StubURLProtocol` (MemoryFixtures.swift) : URL, en-tête
// d'autorisation et statut sont ceux que la sonde émet réellement, sans socket.

import Foundation
import Testing

@testable import OMPConsole

private func isUnreachable(_ status: OMLXStatus) -> Bool {
    if case .unreachable = status { return true }
    return false
}

@Test("all-in-one-app/AC-6 : un 200 rend `.reachable`, même si le corps n'est pas du JSON attendu")
func okStatusIsReachable() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/models", .init(status: 200, body: Data("pas du json".utf8)))
    let status = await OMLXProbe.status(
        config: StackConfig(omlxBaseURL: "http://localhost:1234/v1"),
        session: StubURLProtocol.session()
    )
    #expect(status == .reachable)
}

@Test("all-in-one-app/AC-6 : un 401 rend `.unauthorized`")
func unauthorizedStatusIsNamed() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/models", .init(status: 401, body: Data()))
    let status = await OMLXProbe.status(
        config: StackConfig(omlxBaseURL: "http://localhost:1234/v1", omlxApiToken: "jeton"),
        session: StubURLProtocol.session()
    )
    #expect(status == .unauthorized)
}

@Test("all-in-one-app/AC-6 : une connexion refusée rend `.unreachable`, sans exception")
func refusedConnectionIsAnUnreachableState() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/models", .init(error: URLError(.cannotConnectToHost)))
    let status = await OMLXProbe.status(
        config: StackConfig(omlxBaseURL: "http://localhost:1234/v1"),
        session: StubURLProtocol.session()
    )
    #expect(isUnreachable(status))
}

@Test("all-in-one-app/AC-6 : le jeton n'est envoyé que s'il est non vide")
func tokenIsSentOnlyWhenPresent() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/models", .init(status: 200, body: Data("{}".utf8)))
    _ = await OMLXProbe.status(
        config: StackConfig(omlxBaseURL: "http://localhost:1234/v1", omlxApiToken: "secret"),
        session: StubURLProtocol.session()
    )
    #expect(StubURLProtocol.requests.last?.value(forHTTPHeaderField: "Authorization") == "Bearer secret")

    StubURLProtocol.reset()
    StubURLProtocol.reply("/models", .init(status: 200, body: Data("{}".utf8)))
    _ = await OMLXProbe.status(
        config: StackConfig(omlxBaseURL: "http://localhost:1234/v1", omlxApiToken: ""),
        session: StubURLProtocol.session()
    )
    #expect(StubURLProtocol.requests.last?.value(forHTTPHeaderField: "Authorization") == nil)
}

@Test("all-in-one-app/AC-6 : l'URL sondée est `http://127.0.0.1:<port>/models`")
func probeURLIsAlwaysLocalModels() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/models", .init(status: 200, body: Data("{}".utf8)))
    _ = await OMLXProbe.status(
        config: StackConfig(omlxBaseURL: "http://host.containers.internal:9000/v1"),
        session: StubURLProtocol.session()
    )
    #expect(StubURLProtocol.requests.last?.url == URL(string: "http://127.0.0.1:9000/models")!)
}
