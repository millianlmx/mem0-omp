// La lecture de l'état GitHub d'une PR (S-1 de pipelines-livrees-statut-pr-faux-et-doub),
// prouvée contre le `gh` DOUBLURE de `ProjectFixtures.swift` : un script `sh` qui
// rend la sortie de `pr view --json state,mergedAt,closedAt` et journalise son argv.
//
// Les sorties reprennent les formes MESURÉES sur gh 2.98.0 (Doc-1 du contrat).

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

private let prURL = "https://github.com/proprietaire/depot/pull/72"

/// Lit `prURL` contre un `gh` doublure qui rend `stdout` avec le code `code`.
private func read(_ stdout: String, code: Int32 = 0) async throws -> (Result<PullRequestFact, GhError>, GhStub) {
    let stub = try GhStub(viewJSON: nil, checksJSON: nil, stateJSON: stdout, stateCode: code)
    let reader = GhPullRequestStateReader(cli: GhCLI(binary: stub.script, timeout: 20))
    do {
        return (.success(try await reader.state(prUrl: prURL)), stub)
    } catch let error as GhError {
        return (.failure(error), stub)
    }
}

/// 2026-10-07T07:56:23Z en ms epoch.
private let mergedAtMs = 1_791_359_783_000.0

@Suite("Lecture de l'état d'une PR")
struct PRStateReaderTests {
    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : une PR fusionnée donne un fait MERGED daté de sa fusion, par l'argv exact")
    func mergedFact() async throws {
        let (result, stub) = try await read(#"{"closedAt":"2026-10-07T07:56:23Z","mergedAt":"2026-10-07T07:56:23Z","state":"MERGED"}"#)
        #expect(try result.get() == PullRequestFact(url: prURL, state: .merged, closedAtMs: mergedAtMs))
        #expect(stub.logged() == ["pr", "view", "--json", "state,mergedAt,closedAt", "--", prURL])
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : une PR fusionnée sans `mergedAt` est datée par `closedAt`, et une date illisible ne l'invalide pas")
    func mergedFactDateFallbacks() async throws {
        let (fallback, _) = try await read(#"{"closedAt":"2026-10-07T07:56:23.000Z","mergedAt":null,"state":"MERGED"}"#)
        #expect(try fallback.get() == PullRequestFact(url: prURL, state: .merged, closedAtMs: mergedAtMs))
        let (undated, _) = try await read(#"{"closedAt":"hier","state":"MERGED"}"#)
        #expect(try undated.get() == PullRequestFact(url: prURL, state: .merged, closedAtMs: nil))
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-2 : une PR fermée sans fusion donne un fait CLOSED daté de sa fermeture")
    func closedFact() async throws {
        let (result, _) = try await read(#"{"closedAt":"2026-10-07T07:56:23Z","mergedAt":null,"state":"CLOSED"}"#)
        #expect(try result.get() == PullRequestFact(url: prURL, state: .closed, closedAtMs: mergedAtMs))
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-3 : une PR ouverte donne un fait OPEN sans date")
    func openFact() async throws {
        let (result, _) = try await read(#"{"closedAt":null,"mergedAt":null,"state":"OPEN"}"#)
        #expect(try result.get() == PullRequestFact(url: prURL, state: .open, closedAtMs: nil))
    }

    @Test(
        "pipelines-livrees-statut-pr-faux-et-doub/AC-4 : un échec de lecture ne rend AUCUN fait",
        arguments: [
            (#"GraphQL: Could not resolve to a PullRequest"#, Int32(1)),
            ("not json", Int32(0)),
            (#"{"state":"DRAFT"}"#, Int32(0)),
            (#"{"mergedAt":null}"#, Int32(0)),
            ("[]", Int32(0)),
        ]
    )
    func failuresGiveNoFact(stdout: String, code: Int32) async throws {
        let (result, _) = try await read(stdout, code: code)
        guard case let .failure(error) = result else {
            Issue.record("aucun fait ne doit être inventé : \(result)")
            return
        }
        if code != 0 {
            #expect(error == .commandFailed(command: "pr view", code: code, detail: ""))
        } else {
            guard case .unreadableOutput(command: "pr view", detail: _) = error else {
                Issue.record("sortie illisible attendue : \(error)")
                return
            }
        }
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : une adresse refusée ne lance aucun gh et ne rend aucun fait")
    func refusedURLNeverRunsGH() async throws {
        let stub = try GhStub(viewJSON: nil, checksJSON: nil, stateJSON: #"{"state":"OPEN"}"#)
        let reader = GhPullRequestStateReader(cli: GhCLI(binary: stub.script, timeout: 20))
        await #expect(throws: GhError.invalidPRURL(url: "https://example.com/x")) {
            try await reader.state(prUrl: "https://example.com/x")
        }
        #expect(stub.logged().isEmpty)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : gh introuvable ne rend aucun fait")
    func missingGhGivesNoFact() async throws {
        let reader = GhPullRequestStateReader(cli: GhCLI(binary: URL(fileURLWithPath: "/nonexistent/gh"), timeout: 20))
        await #expect(throws: GhError.self) {
            try await reader.state(prUrl: prURL)
        }
    }
}
