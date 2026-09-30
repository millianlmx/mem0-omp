// La composition du service `gh` (S-2, S-3, S-6), prouvée avec un `gh` DOUBLURE sur
// disque (défini dans `ProjectFixtures.swift`) : un script `sh` jetable qui rend le
// JSON attendu selon ses arguments, et dont le journal d'appels fige l'`argv`
// réellement exécuté.
//
// Les adresses employées sont CONFORMES (`https://github.com/<owner>/<repo>/pull/n`) :
// le service les refuse sinon, avant tout lancement (`validatedPRURL`, S-3).

import Foundation
import Testing

@testable import OMPConsole

private let prURL = "https://github.com/proprietaire/depot/pull/45"

@Test("suivi-pr-ci/AC-1 : une lecture réussie exécute `pr view` puis `pr checks` et rend les trois statuts requis")
func readComposesTwoInvocations() async throws {
    let stub = try GhStub(
        viewJSON: #"{"title": "Ma PR", "headRefOid": "abc123", "body": "Corps réel"}"#,
        checksJSON: """
        [
          {"name": "release-simulation", "bucket": "pass", "link": "https://exemple.test/job/3"},
          {"name": "check (ubuntu-latest)", "bucket": "pass", "link": "https://exemple.test/job/1"},
          {"name": "check (macos-latest)", "bucket": "fail", "link": "https://exemple.test/job/2"},
          {"name": "un-contexte-non-requis", "bucket": "pass", "link": "https://exemple.test/job/4"}
        ]
        """
    )
    let service = GhPRService(cli: GhCLI(binary: stub.script))
    let snapshot = try await service.read(prUrl: prURL, in: stub.directory.path)

    #expect(snapshot.title == "Ma PR")
    #expect(snapshot.headOid == "abc123")
    #expect(snapshot.body == "Corps réel")
    // Exactement les trois statuts REQUIS, dans l'ordre de S-1 ; le contexte non
    // requis est ignoré (périmètre borné de S-1).
    #expect(snapshot.checks.map(\.name) == [
        "check (ubuntu-latest)", "check (macos-latest)", "release-simulation",
    ])
    #expect(snapshot.checks.map(\.state) == [.green, .red, .green])

    // L'argv RÉELLEMENT exécuté : d'abord `pr view`, puis `pr checks`. Les littéraux
    // sont en dur — comparer à `GhCommand` seul ne prouverait pas AC-3.
    #expect(stub.logged() == [
        "pr", "view", "--json", "title,headRefOid,body", "--", prURL,
        "pr", "checks", "--json", "name,bucket,link", "--", prURL,
    ])
    #expect(stub.logged() == GhCommand.prView(url: prURL) + GhCommand.prChecks(url: prURL))
    // Chaque invocation place l'URL en positionnel DERRIÈRE `--` (S-2).
    let logged = stub.logged()
    #expect(logged[4] == "--" && logged[5] == prURL)
    #expect(logged[10] == "--" && logged[11] == prURL)
}

@Test("suivi-pr-ci/AC-6 : un code de sortie non nul devient un échec portant la dernière ligne de stderr")
func nonZeroExitIsCommandFailed() async throws {
    let stub = try GhStub(
        viewJSON: "{}",
        checksJSON: "[]",
        viewStderr: "première ligne\naucun statut rapporté sur la branche"
    )
    let service = GhPRService(cli: GhCLI(binary: stub.script))
    do {
        _ = try await service.read(prUrl: prURL, in: stub.directory.path)
        Issue.record("une sortie non nulle doit lever")
    } catch let error as GhError {
        #expect(error == .commandFailed(
            command: "pr view",
            code: 1,
            detail: "aucun statut rapporté sur la branche"
        ))
        #expect(error.userMessage.contains("aucun statut rapporté sur la branche"))
    }
}

@Test("suivi-pr-ci/AC-4 : la fusion exécute l'argv exact de S-6")
func mergeRunsExactArgv() async throws {
    let stub = try GhStub(viewJSON: "{}", checksJSON: "[]")
    let service = GhPRService(cli: GhCLI(binary: stub.script))
    try await service.merge(
        prUrl: prURL,
        title: "Mon titre",
        body: "Le corps de la PR",
        headOid: "abc123",
        in: stub.directory.path
    )
    #expect(stub.logged() == [
        "pr", "merge",
        "--squash", "--subject", "Mon titre", "--body", "Le corps de la PR", "--match-head-commit", "abc123",
        "--", prURL,
    ])
    #expect(
        stub.logged()
            == GhCommand.prMerge(
                url: prURL,
                title: "Mon titre",
                body: "Le corps de la PR",
                headOid: "abc123"
            )
    )
}

@Test("chemins-du-magasin-non-confines/AC-4 : une adresse refusée n'exécute JAMAIS gh, en lecture comme en fusion")
func refusedURLNeverRunsGH() async throws {
    let stub = try GhStub(viewJSON: "{}", checksJSON: "[]")
    let service = GhPRService(cli: GhCLI(binary: stub.script))
    let hostile = "https://gitlab.com/o/r/pull/1"

    var readError: GhError?
    do {
        _ = try await service.read(prUrl: hostile, in: stub.directory.path)
    } catch let error as GhError {
        readError = error
    }
    #expect(readError == .invalidPRURL(url: hostile))

    var mergeError: GhError?
    do {
        try await service.merge(
            prUrl: hostile,
            title: "t",
            body: "b",
            headOid: "abc",
            in: stub.directory.path
        )
    } catch let error as GhError {
        mergeError = error
    }
    #expect(mergeError == .invalidPRURL(url: hostile))
    #expect(stub.logged().isEmpty, "aucun `gh` n'est lancé, ni en lecture ni en fusion")
}

@Test("suivi-pr-ci/AC-6 : une sortie illisible est un échec `unreadableOutput`")
func unreadableOutputIsNamed() async throws {
    let stub = try GhStub(viewJSON: "pas du json", checksJSON: "[]")
    let service = GhPRService(cli: GhCLI(binary: stub.script))
    do {
        _ = try await service.read(prUrl: prURL, in: stub.directory.path)
        Issue.record("une sortie illisible doit lever")
    } catch let error as GhError {
        guard case .unreadableOutput = error else {
            Issue.record("attendu unreadableOutput, reçu \(error)")
            return
        }
    }
}
