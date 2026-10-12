// Le nettoyage confirmé de l'ancien moteur (omp-console-sans-podman, S-6 ;
// AC-10). Aucun podman réel : la doublure `CleanupDouble` route par binaire
// ABSOLU, journalise chaque appel (binaire, argv, environnement) et refuse tout
// autre programme — `launchctl` compris. La racine jetable est celle de la
// migration (`LegacySandbox`), complétée de tout ce que le nettoyage doit
// épargner.

import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

// MARK: - La doublure

/// Un podman scripté. `@unchecked Sendable` : tous les accès viennent du
/// MainActor (les tests y vivent).
private final class CleanupDouble: @unchecked Sendable {
    struct Call {
        var binary: String
        var arguments: [String]
        var environment: [String: String]
        /// `components/podman` existait-il au moment de l'appel ?
        var podmanPresent: Bool
    }

    let podman: String
    let podmanRoot: URL
    private(set) var calls: [Call] = []
    /// La réponse de `machine rm -f omp-console`.
    var remove = ProcessRun(code: 0, stdout: "", stderr: "", timedOut: false)

    @MainActor
    init(sandbox: LegacySandbox) {
        podman = sandbox.legacy.podmanBinary.path
        podmanRoot = sandbox.paths.componentsRoot.appendingPathComponent("podman", isDirectory: true)
    }

    var runner: CommandRunner {
        CommandRunner { [self] binary, arguments, environment, _ in
            calls.append(Call(
                binary: binary.path,
                arguments: arguments,
                environment: environment,
                podmanPresent: FileManager.default.fileExists(atPath: podmanRoot.path)
            ))
            guard binary.path == podman else {
                Issue.record("binaire inattendu : \(binary.path) \(arguments)")
                return ProcessRun(code: 127, stdout: "", stderr: "", timedOut: false)
            }
            return remove
        }
    }
}

/// La racine d'une bascule faite : `bascule.json`, l'ancien moteur
/// (`components/podman`, `config`, `data`, `tmp`) et tout ce qui doit survivre.
@MainActor
private struct CleanupSandbox {
    let base: LegacySandbox
    let double: CleanupDouble
    let model: PodmanCleanupModel

    var paths: AppPaths { base.paths }
    var podmanRoot: URL { paths.componentsRoot.appendingPathComponent("podman", isDirectory: true) }

    /// Ce que le nettoyage ne touche JAMAIS (S-6, point 3).
    var survivors: [URL] {
        [
            paths.qdrantStorage,
            paths.stackEnv,
            paths.installationToken,
            paths.switchState,
            paths.podmanImportReport,
            paths.mem0Database,
            paths.remoteDir.appendingPathComponent("devices.json"),
            paths.ompDir("1.0.0").appendingPathComponent("omp"),
        ]
    }

    /// Les dossiers que le nettoyage supprime, dans l'ordre de S-6.
    var leftovers: [URL] { [podmanRoot, paths.configDir, paths.dataDir, paths.tmpDir] }

    init(switched: Bool = true, leftovers kept: Set<String> = ["podman", "config", "data", "tmp"]) throws {
        base = try LegacySandbox()
        let fileManager = FileManager.default
        let paths = base.paths
        func write(_ text: String, to url: URL) throws {
            try fileManager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(text.utf8).write(to: url)
        }
        // `LegacySandbox` a déjà posé le podman exécutable : on l'enlève si le cas
        // ne le garde pas.
        if !kept.contains("podman") {
            try fileManager.removeItem(at: paths.componentsRoot.appendingPathComponent("podman", isDirectory: true))
        }
        if kept.contains("config") {
            try write("[engine]\n", to: paths.configDir.appendingPathComponent("containers/containers.conf"))
        }
        if kept.contains("data") {
            try write("disque", to: paths.dataDir.appendingPathComponent("containers/podman/machine/applehv/omp-console.raw"))
        }
        if kept.contains("tmp") {
            try write("4242", to: paths.tmpDir.appendingPathComponent("gvproxy.pid"))
        }
        if switched {
            try write(#"{"forced":false,"rejected":0,"source":"podman","switchedAt":"2026-10-12T10:00:00Z","version":1}"#, to: paths.switchState)
            try write("{}", to: paths.podmanImportReport)
        }
        try write("jeton", to: paths.installationToken)
        try write("base", to: paths.mem0Database)
        try write("[]", to: paths.remoteDir.appendingPathComponent("devices.json"))
        try write("#!/bin/sh\n", to: paths.ompDir("1.0.0").appendingPathComponent("omp"))
        double = CleanupDouble(sandbox: base)
        model = PodmanCleanupModel(
            paths: paths,
            environment: ["HOME": "/Users/recette", "PATH": "/usr/bin:/bin"],
            run: double.runner
        )
    }

    func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    func remove() { base.remove() }
}

// MARK: - AC-10

@MainActor
@Test("omp-console-sans-podman/AC-10 : sans confirmation rien n'est supprimé (refresh, requestRemoval puis cancel)")
func ac10NothingIsRemovedWithoutConfirmation() async throws {
    let sandbox = try CleanupSandbox()
    defer { sandbox.remove() }
    let model = sandbox.model
    let qdrantBefore = try sandbox.base.qdrantTree()

    model.refresh()
    #expect(model.state == .offered)
    // « Supprimer » hors confirmation n'a aucun effet.
    #expect(model.confirm() == nil)
    #expect(model.state == .offered)

    model.requestRemoval()
    #expect(model.state == .confirming)
    model.cancel()
    #expect(model.state == .offered)
    // Un rafraîchissement ne vaut pas confirmation non plus.
    model.refresh()
    #expect(model.state == .offered)

    #expect(sandbox.double.calls.isEmpty)
    for url in sandbox.leftovers + sandbox.survivors {
        #expect(sandbox.exists(url), "\(url.path)")
    }
    #expect(try sandbox.base.qdrantTree() == qdrantBefore)
}

@MainActor
@Test("omp-console-sans-podman/AC-10 : confirmer supprime la machine puis components/podman, config, data, tmp, garde stack/qdrant_storage intact et n'appelle jamais launchctl")
func ac10ConfirmRemovesMachineThenLeftovers() async throws {
    let sandbox = try CleanupSandbox()
    defer { sandbox.remove() }
    let model = sandbox.model
    let qdrantBefore = try sandbox.base.qdrantTree()

    model.refresh()
    model.requestRemoval()
    let task = try #require(model.confirm())
    // `.removing` est posé avant toute attente, et un rafraîchissement ne
    // l'interrompt pas.
    #expect(model.state == .removing)
    model.refresh()
    #expect(model.state == .removing)
    await task.value

    // UN seul appel : la machine de l'app, par le podman de l'app, dans
    // l'environnement isolé — AVANT toute suppression.
    let calls = sandbox.double.calls
    #expect(calls.map(\.binary) == [sandbox.base.legacy.podmanBinary.path])
    #expect(calls.map(\.arguments) == [["machine", "rm", "-f", "omp-console"]])
    #expect(calls.first?.podmanPresent == true)
    #expect(calls.first?.environment["XDG_CONFIG_HOME"] == sandbox.paths.configDir.path)
    #expect(calls.first?.environment["XDG_DATA_HOME"] == sandbox.paths.dataDir.path)
    #expect(!calls.contains { $0.binary.hasSuffix("launchctl") })

    for url in sandbox.leftovers {
        #expect(!sandbox.exists(url), "\(url.path)")
    }
    for url in sandbox.survivors {
        #expect(sandbox.exists(url), "\(url.path)")
    }
    #expect(try sandbox.base.qdrantTree() == qdrantBefore)
    // Succès : le bandeau disparaît, sans autre message.
    #expect(model.state == .hidden)
}

@MainActor
@Test("omp-console-sans-podman/AC-10 : machine rm en échec ⇒ rien supprimé, bandeau en échec lisible avec Réessayer et diagnostic")
func ac10MachineRemoveFailureDeletesNothing() async throws {
    let sandbox = try CleanupSandbox()
    defer { sandbox.remove() }
    let model = sandbox.model
    sandbox.double.remove = ProcessRun(code: 125, stdout: "", stderr: "Error: machine verrouillée\n", timedOut: false)

    model.refresh()
    model.requestRemoval()
    await model.confirm()?.value

    #expect(model.state == .failed(diagnostic: "podman machine rm -f omp-console a échoué\u{00A0}: Error: machine verrouillée"))
    for url in sandbox.leftovers + sandbox.survivors {
        #expect(sandbox.exists(url), "\(url.path)")
    }
    // Lisible : la conséquence et le geste, sans jargon ; le brut est dans le
    // diagnostic copiable.
    #expect(
        MemoryText.podmanCleanupFailed
            == "La suppression de l’ancien moteur a échoué\u{00A0}: il occupe toujours de la place. Réessayez\u{00A0}; si l’échec revient, copiez le diagnostic pour le signaler."
    )
    for text in [
        MemoryText.podmanCleanupMessage,
        MemoryText.podmanCleanupRemove,
        MemoryText.podmanCleanupConfirmTitle,
        MemoryText.podmanCleanupConfirmMessage,
        MemoryText.podmanCleanupProgress,
        MemoryText.podmanCleanupFailed,
    ] {
        #expect(forbiddenTokens(in: text).isEmpty, "« \(text) »")
    }

    // « Réessayer » rouvre la confirmation ; la machine cède, tout part.
    model.requestRemoval()
    #expect(model.state == .confirming)
    sandbox.double.remove = ProcessRun(code: 0, stdout: "", stderr: "", timedOut: false)
    await model.confirm()?.value
    #expect(model.state == .hidden)
    for url in sandbox.leftovers {
        #expect(!sandbox.exists(url), "\(url.path)")
    }
}

@MainActor
@Test("omp-console-sans-podman/AC-10 : une machine déjà absente n'empêche pas le nettoyage")
func ac10MissingMachineIsASuccess() async throws {
    let sandbox = try CleanupSandbox()
    defer { sandbox.remove() }
    let model = sandbox.model
    sandbox.double.remove = ProcessRun(code: 125, stdout: "", stderr: "Error: omp-console: VM Does Not Exist\n", timedOut: false)

    model.refresh()
    model.requestRemoval()
    await model.confirm()?.value

    #expect(model.state == .hidden)
    for url in sandbox.leftovers {
        #expect(!sandbox.exists(url), "\(url.path)")
    }
}

@MainActor
@Test("omp-console-sans-podman/AC-10 : un dossier qui résiste ⇒ échec nommant son chemin, ce qui précède reste supprimé, et Réessayer reprend sans redemander la machine")
func ac10DeleteFailureKeepsProgressAndResumes() async throws {
    let sandbox = try CleanupSandbox()
    defer { sandbox.remove() }
    let model = sandbox.model
    // Un sous-dossier en lecture seule rend `data` impossible à supprimer.
    let locked = sandbox.paths.dataDir.appendingPathComponent("containers/podman/machine/applehv", isDirectory: true)
    try FileManager.default.setAttributes([.posixPermissions: 0o500], ofItemAtPath: locked.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path) }

    model.refresh()
    model.requestRemoval()
    await model.confirm()?.value

    guard case let .failed(diagnostic) = model.state else {
        Issue.record("état attendu : échec, obtenu \(model.state)")
        return
    }
    #expect(diagnostic.hasPrefix("Suppression impossible de \(sandbox.paths.dataDir.path)\u{00A0}: "))
    #expect(!sandbox.exists(sandbox.podmanRoot))
    #expect(!sandbox.exists(sandbox.paths.configDir))
    #expect(sandbox.exists(sandbox.paths.dataDir))
    #expect(sandbox.exists(sandbox.paths.tmpDir))
    #expect(sandbox.double.calls.count == 1)

    // La cause levée, « Réessayer » reprend : le podman parti, la machine n'est
    // plus demandée.
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: locked.path)
    model.requestRemoval()
    await model.confirm()?.value
    #expect(model.state == .hidden)
    #expect(sandbox.double.calls.count == 1)
    for url in sandbox.leftovers {
        #expect(!sandbox.exists(url), "\(url.path)")
    }
    for url in sandbox.survivors {
        #expect(sandbox.exists(url), "\(url.path)")
    }
}

@MainActor
@Test("omp-console-sans-podman/AC-10 : le bandeau n'est offert qu'après bascule.json et tant qu'il reste un élément podman")
func ac10BannerOnlyAfterSwitchWhileLeftoversRemain() throws {
    // Pas encore basculé : l'ancien moteur sert peut-être encore.
    let pending = try CleanupSandbox(switched: false)
    defer { pending.remove() }
    pending.model.refresh()
    #expect(pending.model.state == .hidden)
    pending.model.requestRemoval()
    #expect(pending.model.state == .hidden)

    // Basculé, et chacun des trois éléments suffit à lui seul.
    for kept in ["podman", "config", "data"] {
        let sandbox = try CleanupSandbox(leftovers: [kept])
        defer { sandbox.remove() }
        sandbox.model.refresh()
        #expect(sandbox.model.state == .offered, "\(kept)")
    }

    // Basculé, plus rien (ou seulement `tmp`) : rien à proposer.
    for kept: Set<String> in [[], ["tmp"]] {
        let sandbox = try CleanupSandbox(leftovers: kept)
        defer { sandbox.remove() }
        sandbox.model.refresh()
        #expect(sandbox.model.state == .hidden, "\(kept)")
    }
}
