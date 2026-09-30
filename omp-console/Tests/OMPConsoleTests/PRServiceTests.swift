// La composition du service `gh` (S-2, S-6), prouvée avec un `gh` DOUBLURE sur
// disque : un script `sh` jetable qui rend le JSON attendu selon ses arguments, et
// dont le journal d'appels fige l'`argv` réellement exécuté.

import Foundation
import Testing

@testable import OMPConsole

private struct GhStub {
    let directory: URL
    let script: URL
    let log: URL

    init(viewJSON: String?, checksJSON: String?, viewStderr: String? = nil, mergeSucceeds: Bool = true) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("gh-stub-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        script = directory.appendingPathComponent("gh")
        log = directory.appendingPathComponent("args.log")

        let view = directory.appendingPathComponent("view.json")
        let checks = directory.appendingPathComponent("checks.json")
        try Data((viewJSON ?? "{}").utf8).write(to: view)
        try Data((checksJSON ?? "[]").utf8).write(to: checks)

        var lines = [
            "#!/bin/sh",
            "printf '%s\\n' \"$@\" >> '#LOG#'",
        ]
        if let viewStderr {
            let line = "if [ \"$1 $2\" = \"pr view\" ]; then printf '%s\\n' '#VIEWERR#' >&2; exit 1; fi"
            lines.append(line.replacingOccurrences(of: "#VIEWERR#", with: viewStderr))
        }
        lines.append("case \"$1 $2\" in")
        lines.append("  \"pr view\") cat '#VIEW#' ;;")
        lines.append("  \"pr checks\") cat '#CHECKS#' ;;")
        lines.append("  \"pr merge\") exit #MERGECODE# ;;")
        lines.append("esac")
        lines.append("exit 0")

        var body = lines.joined(separator: "\n")
        body = body
            .replacingOccurrences(of: "#LOG#", with: log.path)
            .replacingOccurrences(of: "#VIEW#", with: view.path)
            .replacingOccurrences(of: "#CHECKS#", with: checks.path)
            .replacingOccurrences(of: "#MERGECODE#", with: mergeSucceeds ? "0" : "1")
        try Data(body.utf8).write(to: script)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: script.path)
    }

    /// Les lignes du journal : une par argument, dans l'ordre des invocations.
    func logged() -> [String] {
        (try? String(contentsOf: log, encoding: .utf8))?
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
            .filter { !$0.isEmpty } ?? []
    }
}

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
    let snapshot = try await service.read(prUrl: "https://exemple.test/pull/45", in: stub.directory.path)

    #expect(snapshot.title == "Ma PR")
    #expect(snapshot.headOid == "abc123")
    #expect(snapshot.body == "Corps réel")
    // Exactement les trois statuts REQUIS, dans l'ordre de S-1 ; le contexte non
    // requis est ignoré (périmètre borné de S-1).
    #expect(snapshot.checks.map(\.name) == [
        "check (ubuntu-latest)", "check (macos-latest)", "release-simulation",
    ])
    #expect(snapshot.checks.map(\.state) == [.green, .red, .green])

    // L'argv réellement exécuté : d'abord `pr view`, puis `pr checks`.
    let expected = GhCommand.prView(url: "https://exemple.test/pull/45")
        + GhCommand.prChecks(url: "https://exemple.test/pull/45")
    #expect(stub.logged() == expected)
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
        _ = try await service.read(prUrl: "https://exemple.test/pull/45", in: stub.directory.path)
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
        prUrl: "https://exemple.test/pull/45",
        title: "Mon titre",
        body: "Le corps de la PR",
        headOid: "abc123",
        in: stub.directory.path
    )
    #expect(
        stub.logged()
            == GhCommand.prMerge(
                url: "https://exemple.test/pull/45",
                title: "Mon titre",
                body: "Le corps de la PR",
                headOid: "abc123"
            )
    )
}

@Test("suivi-pr-ci/AC-6 : une sortie illisible est un échec `unreadableOutput`")
func unreadableOutputIsNamed() async throws {
    let stub = try GhStub(viewJSON: "pas du json", checksJSON: "[]")
    let service = GhPRService(cli: GhCLI(binary: stub.script))
    do {
        _ = try await service.read(prUrl: "https://exemple.test/pull/45", in: stub.directory.path)
        Issue.record("une sortie illisible doit lever")
    } catch let error as GhError {
        guard case .unreadableOutput = error else {
            Issue.record("attendu unreadableOutput, reçu \(error)")
            return
        }
    }
}
