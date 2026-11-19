// Le renommage côté app Mac (renommage-memoire, S-6 à S-9, S-11, S-33 ;
// AC-303, AC-305, AC-310) : les anciens noms restent LUS pendant la version de
// transition, jamais écrits. Aucun launchctl, lsof ni ps réel : la doublure
// `AgentDouble` de MemoryAgentTests joue launchd (elle route par label : l'ancien agent
// a son propre état), la racine et le HOME sont jetables.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsole

// MARK: - Outils

private var fileManager: FileManager { .default }

/// Un HOME jetable, avec ou sans `.omp/memory.json` et `.omp/mem0.json` : un `String` est
/// écrit tel quel, un dictionnaire en JSON.
private func renamedHome(memory: Any? = nil, legacy: Any? = nil) throws -> URL {
    let home = fileManager.temporaryDirectory.appendingPathComponent("omp-renommage-home-\(UUID().uuidString)")
    let directory = home.appendingPathComponent(".omp")
    try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    for (name, content) in [("memory.json", memory), ("mem0.json", legacy)] {
        guard let content else { continue }
        let data: Data
        if let text = content as? String {
            data = Data(text.utf8)
        } else {
            data = try JSONSerialization.data(withJSONObject: content)
        }
        try data.write(to: directory.appendingPathComponent(name))
    }
    return home
}

private func homeEnvironment(_ home: URL) -> [String: String] {
    ["HOME": home.path]
}

/// Un code d'appairage décodé : l'adresse du serveur, son jeton, puis la mémoire partagée
/// (adresse vide ⇒ pas de mémoire) et son jeton.
private func pairing(memoryAddress: String = "https://vps.tailnet.ts.net:8443") throws -> HarnessPairing {
    let lines = ["https://vps.tailnet.ts.net", "jeton", memoryAddress, memoryAddress.isEmpty ? "" : "memoire"]
    let payload = Data(lines.joined(separator: "\n").utf8).base64EncodedString()
        .replacingOccurrences(of: "+", with: "-")
        .replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
    return try #require(HarnessPairing.decode("omp1:" + payload))
}

private func jsonObject(at url: URL) throws -> [String: Any] {
    try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
}

@MainActor
private func renamedAgent(
    _ sandbox: AgentSandbox,
    _ double: AgentDouble,
    environment: [String: String] = [:]
) -> MemoryAgent {
    let agent = MemoryAgent(
        paths: sandbox.paths,
        executable: sandbox.executable,
        port: 8321,
        environment: environment,
        run: double.runner,
        uid: 501,
        healthProbe: double.healthProbe
    )
    agent.healthBudget = 0.2
    agent.portFreeBudget = 0.05
    agent.unloadBudget = 0.5
    agent.pollInterval = 0.01
    return agent
}

/// Le `/health` de NOTRE service : il rend le jeton d'installation du disque.
private func installedHealth(_ paths: AppPaths) -> () -> Data? {
    {
        guard let token = InstallationTokenStore.load(at: paths.installationToken) else { return nil }
        return memoryJSON(["ok": true, "memory": "memory-rs 0.1.0", "user": "moi", "installation": token])
    }
}

private func plistDictionary(at url: URL) throws -> [String: Any] {
    let data = try Data(contentsOf: url)
    return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
}

/// Le dossier de données d'avant le renommage : `<racine>/mem0-rs/mem0-rs.db`.
private func makeLegacyDataFolder(_ sandbox: AgentSandbox, content: String = "souvenirs d'avant") throws -> (folder: URL, content: Data) {
    let folder = sandbox.paths.supportRoot.appendingPathComponent("mem0-rs", isDirectory: true)
    try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)
    let data = Data(content.utf8)
    try data.write(to: folder.appendingPathComponent("mem0-rs.db"))
    return (folder, data)
}

/// Le plist de l'ancien agent, posé sur le disque.
@MainActor
private func writeLegacyPlist(of agent: MemoryAgent) throws {
    try fileManager.createDirectory(at: agent.legacyPlistURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("<plist version=\"1.0\"><dict/></plist>".utf8).write(to: agent.legacyPlistURL)
}

private let legacyBinaryLine = "/Applications/OMP Console.app/Contents/Resources/mem0-rs --host 127.0.0.1 --port 8321"

// MARK: - S-6 : la fonction d'aide

@Test("renommage-memoire/AC-303 : RenamedEnvironment.value — ancien seul → ancien ; nouveau seul → nouveau ; les deux → nouveau ; nouveau vide + ancien → ancien ; vides ou absents → nil")
func renamedEnvironmentValue() {
    let read = { (environment: [String: String]) in
        RenamedEnvironment.value(environment, "MEMORY_RRF_K", legacy: "MEM0_RRF_K")
    }
    #expect(read(["MEM0_RRF_K": "ancien"]) == "ancien")
    #expect(read(["MEMORY_RRF_K": "nouveau"]) == "nouveau")
    #expect(read(["MEMORY_RRF_K": "nouveau", "MEM0_RRF_K": "ancien"]) == "nouveau")
    #expect(read(["MEMORY_RRF_K": "", "MEM0_RRF_K": "ancien"]) == "ancien")
    #expect(read(["MEMORY_RRF_K": "", "MEM0_RRF_K": ""]) == nil)
    #expect(read(["MEM0_RRF_K": ""]) == nil)
    #expect(read([:]) == nil)
}

@Test("renommage-memoire/AC-303 : MemoryServiceConfig lit MEMORY_HTTP_URL et MEMORY_HTTP_TOKEN, sinon MEM0_HTTP_URL et MEM0_HTTP_TOKEN ; le nouveau l'emporte")
func serviceConfigReadsLegacyVariables() {
    let legacy = MemoryServiceConfig.fromEnvironment([
        "MEM0_HTTP_URL": "http://127.0.0.1:9000",
        "MEM0_HTTP_TOKEN": "ancien",
    ])
    #expect(legacy.baseURL.absoluteString == "http://127.0.0.1:9000")
    #expect(legacy.token == "ancien")

    let both = MemoryServiceConfig.fromEnvironment([
        "MEMORY_HTTP_URL": "http://127.0.0.1:9001",
        "MEM0_HTTP_URL": "http://127.0.0.1:9000",
        "MEMORY_HTTP_TOKEN": "nouveau",
        "MEM0_HTTP_TOKEN": "ancien",
    ])
    #expect(both.baseURL.absoluteString == "http://127.0.0.1:9001")
    #expect(both.token == "nouveau")

    let emptyNew = MemoryServiceConfig.fromEnvironment([
        "MEMORY_HTTP_URL": "",
        "MEM0_HTTP_URL": "http://127.0.0.1:9000",
        "MEMORY_HTTP_TOKEN": "",
        "MEM0_HTTP_TOKEN": "ancien",
    ])
    #expect(emptyNew.baseURL.absoluteString == "http://127.0.0.1:9000")
    #expect(emptyNew.token == "ancien")
}

@Test("renommage-memoire/AC-303 : OMP_CONSOLE_MEMORY_PORT, sinon OMP_CONSOLE_MEM0_PORT ; le nouveau, posé et non vide, l'emporte même invalide")
func portReadsLegacyVariable() {
    #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEM0_PORT": "18321"]) == 18321)
    #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEMORY_PORT": "18322"]) == 18322)
    #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEMORY_PORT": "18322", "OMP_CONSOLE_MEM0_PORT": "18321"]) == 18322)
    #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEMORY_PORT": "", "OMP_CONSOLE_MEM0_PORT": "18321"]) == 18321)
    #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEMORY_PORT": "0", "OMP_CONSOLE_MEM0_PORT": "18321"]) == 8321)
    #expect(MemoryAgent.port(environment: ["OMP_CONSOLE_MEM0_PORT": "8321x"]) == 8321)
    // Le port de l'ancien nom guide aussi le client sans adresse.
    #expect(MemoryServiceConfig.fromEnvironment(["OMP_CONSOLE_MEM0_PORT": "18321"]).baseURL.absoluteString == "http://localhost:18321")
}

@Test("renommage-memoire/AC-303 : la portée suit MEMORY_PROJECT_ID, sinon MEM0_PROJECT_ID ; le nouveau l'emporte, vide il est ignoré")
func scopeReadsLegacyProjectId() async {
    func scope(_ environment: [String: String]) async -> String? {
        await MemoryScope.scope(projectRoot: "/tmp/omp-renommage-sans-projet", environment: environment, git: fixtureGit())
    }
    #expect(await scope(["MEM0_PROJECT_ID": "ancien"]) == "ancien")
    #expect(await scope(["MEMORY_PROJECT_ID": "nouveau"]) == "nouveau")
    #expect(await scope(["MEMORY_PROJECT_ID": "nouveau", "MEM0_PROJECT_ID": "ancien"]) == "nouveau")
    #expect(await scope(["MEMORY_PROJECT_ID": "", "MEM0_PROJECT_ID": "ancien"]) == "ancien")
}

// MARK: - S-8, S-9 : le fichier de réglages partagé

@Test("renommage-memoire/AC-305 : MemorySettingsFile lit ~/.omp/mem0.json quand memory.json n'existe pas ; memory.json l'emporte quand les deux existent ; illisible, il n'a pas de repli")
func settingsFileFollowsTheRenaming() throws {
    let legacyOnly = try renamedHome(legacy: ["url": "https://ancien.example:8443", "token": "jeton-ancien"])
    defer { try? fileManager.removeItem(at: legacyOnly) }
    let fromLegacy = try #require(MemorySettingsFile.load(environment: homeEnvironment(legacyOnly)))
    #expect(fromLegacy.url == "https://ancien.example:8443" && fromLegacy.token == "jeton-ancien")
    let config = MemoryServiceConfig.fromEnvironment(homeEnvironment(legacyOnly))
    #expect(config.baseURL.absoluteString == "https://ancien.example:8443" && config.token == "jeton-ancien")

    let both = try renamedHome(
        memory: ["url": "https://nouveau.example:8443", "token": "jeton-nouveau"],
        legacy: ["url": "https://ancien.example:8443", "token": "jeton-ancien"]
    )
    defer { try? fileManager.removeItem(at: both) }
    let fromBoth = try #require(MemorySettingsFile.load(environment: homeEnvironment(both)))
    #expect(fromBoth.url == "https://nouveau.example:8443" && fromBoth.token == "jeton-nouveau")

    // Un memory.json illisible n'est jamais remplacé par mem0.json : service local.
    let unreadable = try renamedHome(memory: "{ pas du json", legacy: ["url": "https://ancien.example:8443", "token": "jeton-ancien"])
    defer { try? fileManager.removeItem(at: unreadable) }
    #expect(MemorySettingsFile.load(environment: homeEnvironment(unreadable)) == nil)
    #expect(MemoryServiceConfig.fromEnvironment(homeEnvironment(unreadable)).baseURL.absoluteString == "http://localhost:8321")

    let none = try renamedHome()
    defer { try? fileManager.removeItem(at: none) }
    #expect(MemorySettingsFile.load(environment: homeEnvironment(none)) == nil)
}

@Test("renommage-memoire/AC-305 : writeShared écrit memory.json s'il existe, sinon mem0.json, et ne crée jamais memory.json")
func writeSharedNeverCreatesTheNewFile() throws {
    let code = try pairing()

    // Une installation d'avant : seul mem0.json existe → il est réécrit, memory.json reste absent.
    let legacyOnly = try renamedHome(legacy: ["url": "http://ancien", "token": "ancien"])
    defer { try? fileManager.removeItem(at: legacyOnly) }
    try code.writeShared(home: legacyOnly)
    let legacyFile = legacyOnly.appendingPathComponent(".omp/mem0.json")
    #expect(try jsonObject(at: legacyFile)["url"] as? String == "https://vps.tailnet.ts.net:8443")
    #expect(try jsonObject(at: legacyFile)["token"] as? String == "memoire")
    #expect(!fileManager.fileExists(atPath: legacyOnly.appendingPathComponent(".omp/memory.json").path))
    #expect(try fileManager.attributesOfItem(atPath: legacyFile.path)[.posixPermissions] as? Int == 0o600)
    #expect(try jsonObject(at: legacyOnly.appendingPathComponent(".omp/harness.json"))["url"] as? String == "https://vps.tailnet.ts.net")
    #expect(MemorySettingsFile.load(environment: homeEnvironment(legacyOnly))?.url == "https://vps.tailnet.ts.net:8443")

    // memory.json existe → il est écrit, mem0.json n'est pas touché.
    let oldContent = #"{"token":"ancien","url":"http://ancien"}"#
    let current = try renamedHome(memory: ["url": "http://avant", "token": "avant"], legacy: oldContent)
    defer { try? fileManager.removeItem(at: current) }
    try code.writeShared(home: current)
    let memoryFile = current.appendingPathComponent(".omp/memory.json")
    #expect(try jsonObject(at: memoryFile)["url"] as? String == "https://vps.tailnet.ts.net:8443")
    #expect(try String(contentsOf: current.appendingPathComponent(".omp/mem0.json"), encoding: .utf8) == oldContent)
    #expect(MemorySettingsFile.load(environment: homeEnvironment(current))?.token == "memoire")

    // Ni l'un ni l'autre : mem0.json est écrit, memory.json n'est jamais créé.
    let neither = try renamedHome()
    defer { try? fileManager.removeItem(at: neither) }
    try code.writeShared(home: neither)
    #expect(fileManager.fileExists(atPath: neither.appendingPathComponent(".omp/mem0.json").path))
    #expect(!fileManager.fileExists(atPath: neither.appendingPathComponent(".omp/memory.json").path))
    #expect(MemorySettingsFile.load(environment: homeEnvironment(neither))?.url == "https://vps.tailnet.ts.net:8443")

    // Un code sans mémoire n'écrit aucun fichier de réglages de la mémoire.
    let bare = try renamedHome()
    defer { try? fileManager.removeItem(at: bare) }
    try pairing(memoryAddress: "").writeShared(home: bare)
    #expect(!fileManager.fileExists(atPath: bare.appendingPathComponent(".omp/memory.json").path))
    #expect(!fileManager.fileExists(atPath: bare.appendingPathComponent(".omp/mem0.json").path))
}

// MARK: - S-12 : la santé ne lit que `ok` et `installation`

@Test("renommage-memoire/AC-309 : isOurMemory et isMemoryHealthy ne lisent que `ok` et `installation`, quelles que soient les clés de nom du corps")
func healthPredicatesIgnoreTheNameKeys() {
    let bodies: [[String: Any]] = [
        ["ok": true, "installation": "T"],
        ["ok": true, "installation": "T", "memory": "memory-rs 0.1.0"],
        ["ok": true, "installation": "T", "mem0": "memory-rs 0.1.0"],
        ["ok": true, "installation": "T", "memory": "memory-rs 0.1.0", "mem0": "memory-rs 0.1.0"],
    ]
    for body in bodies {
        let result = (status: 200, body: memoryJSON(body))
        #expect(MemoryAgent.isMemoryHealthy(result))
        #expect(MemoryAgent.isOurMemory(result, token: "T"))
        #expect(!MemoryAgent.isOurMemory(result, token: "autre"))
    }
    #expect(!MemoryAgent.isMemoryHealthy((status: 200, body: memoryJSON(["memory": "memory-rs 0.1.0"]))))
}

// MARK: - S-33 : le dossier de données

@MainActor
@Test("renommage-memoire/AC-310 : une racine qui n'a que mem0-rs/mem0-rs.db garde son dossier — memoryRoot est mem0-rs/, aucun memory-rs/ après ensureRunning, le plist pose MEMORY_DB_PATH sous mem0-rs/")
func legacyDataFolderIsKept() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let (folder, content) = try makeLegacyDataFolder(sandbox)
    let paths = sandbox.paths
    #expect(paths.memoryRoot.path == folder.path)
    #expect(paths.memoryDatabase.path == folder.appendingPathComponent("memory-rs.db").path)
    #expect(paths.memoryLog.path == folder.appendingPathComponent("memory-rs.log").path)

    let double = AgentDouble()
    double.healthBody = installedHealth(paths)
    let agent = renamedAgent(sandbox, double)
    try await agent.ensureRunning { _ in }

    #expect(!fileManager.fileExists(atPath: paths.supportRoot.appendingPathComponent("memory-rs").path))
    #expect(paths.memoryRoot.path == folder.path)
    let written = try plistDictionary(at: agent.plistURL)
    let environment = try #require(written["EnvironmentVariables"] as? [String: String])
    #expect(environment["MEMORY_DB_PATH"] == folder.appendingPathComponent("memory-rs.db").path)
    #expect(written["WorkingDirectory"] as? String == folder.path)
    #expect(written["StandardOutPath"] as? String == folder.appendingPathComponent("memory-rs.log").path)
    #expect(written["StandardErrorPath"] as? String == folder.appendingPathComponent("memory-rs.log").path)
    #expect(try Data(contentsOf: folder.appendingPathComponent("mem0-rs.db")) == content)
    #expect(try fileManager.contentsOfDirectory(atPath: folder.path) == ["mem0-rs.db"])
}

@MainActor
@Test("renommage-memoire/AC-310 : quand mem0-rs/ et memory-rs/ existent, memory-rs/ l'emporte ; quand aucun n'existe, memory-rs/ est créé en 0700 et mem0-rs/ ne l'est jamais")
func newDataFolderWinsOrIsCreated() async throws {
    // Les deux dossiers.
    let both = try AgentSandbox()
    defer { both.remove() }
    let (legacyFolder, content) = try makeLegacyDataFolder(both)
    let newFolder = both.paths.supportRoot.appendingPathComponent("memory-rs", isDirectory: true)
    try fileManager.createDirectory(at: newFolder, withIntermediateDirectories: true)
    #expect(both.paths.memoryRoot.path == newFolder.path)
    let bothDouble = AgentDouble()
    bothDouble.healthBody = installedHealth(both.paths)
    let bothAgent = renamedAgent(both, bothDouble)
    try await bothAgent.ensureRunning { _ in }
    let bothEnvironment = try #require(try plistDictionary(at: bothAgent.plistURL)["EnvironmentVariables"] as? [String: String])
    #expect(bothEnvironment["MEMORY_DB_PATH"] == newFolder.appendingPathComponent("memory-rs.db").path)
    #expect(try Data(contentsOf: legacyFolder.appendingPathComponent("mem0-rs.db")) == content)

    // Aucun dossier.
    let none = try AgentSandbox()
    defer { none.remove() }
    let created = none.paths.supportRoot.appendingPathComponent("memory-rs", isDirectory: true)
    #expect(none.paths.memoryRoot.path == created.path)
    #expect(!fileManager.fileExists(atPath: created.path), "lire memoryRoot ne crée rien")
    let noneDouble = AgentDouble()
    noneDouble.healthBody = installedHealth(none.paths)
    try await renamedAgent(none, noneDouble).ensureRunning { _ in }
    #expect(try fileManager.attributesOfItem(atPath: created.path)[.posixPermissions] as? Int == 0o700)
    #expect(!fileManager.fileExists(atPath: none.paths.supportRoot.appendingPathComponent("mem0-rs").path))
}

// MARK: - S-33 : l'ancien agent launchd

@Test("renommage-memoire/AC-310 : le label de l'agent est memory-rs, l'ancien label a la même variante hexadécimale pour une racine déplacée")
func legacyLabelFollowsTheSameVariant() {
    let real = AppPaths.standard(home: "/Users/x", environment: [:])
    #expect(MemoryAgent.label(paths: real) == "com.omp.console.memory-rs")
    #expect(MemoryAgent.legacyLabel(paths: real) == "com.omp.console.mem0-rs")

    let moved = AppPaths.standard(environment: ["OMP_CONSOLE_SUPPORT_ROOT": "/tmp/recette"])
    let suffix = String(MemoryAgent.label(paths: moved).dropFirst("com.omp.console.memory-rs.".count))
    #expect(suffix.count == 12)
    #expect(MemoryAgent.legacyLabel(paths: moved) == "com.omp.console.mem0-rs." + suffix)
}

@MainActor
@Test("renommage-memoire/AC-310 : ancien label chargé — bootout AVANT la première sonde lsof et avant le print du nouveau label, plist retiré, dossier intact, aucune portConflict")
func legacyAgentIsUnloadedBeforeTheFirstPortProbe() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let (folder, content) = try makeLegacyDataFolder(sandbox)
    let double = AgentDouble()
    double.healthBody = installedHealth(sandbox.paths)
    // L'ancien job (`KeepAlive`) tient le port avec l'ancien binaire : « étranger » pour la garde de port.
    double.legacyLoaded = true
    double.legacyHolder = (800, "ancien-agent", legacyBinaryLine)
    let agent = renamedAgent(sandbox, double)
    try writeLegacyPlist(of: agent)
    let legacyTarget = "gui/501/\(agent.legacyLabel)"

    try await agent.ensureRunning { _ in }

    let bootout = try #require(double.calls.firstIndex { $0.arguments == ["bootout", legacyTarget] })
    let firstProbe = try #require(double.calls.firstIndex { $0.binary == "/usr/sbin/lsof" })
    let firstNewPrint = try #require(double.calls.firstIndex { $0.arguments == ["print", "gui/501/\(agent.label)"] })
    #expect(bootout < firstProbe)
    #expect(bootout < firstNewPrint)
    #expect(double.legacyCalls.compactMap(\.arguments.first) == ["print", "bootout", "print"])
    #expect(!double.legacyLoaded)
    #expect(!fileManager.fileExists(atPath: agent.legacyPlistURL.path))
    #expect(double.loaded && fileManager.fileExists(atPath: agent.plistURL.path))
    // Les données d'avant ne sont jamais touchées : même dossier, même base, aucun memory-rs/.
    #expect(try Data(contentsOf: folder.appendingPathComponent("mem0-rs.db")) == content)
    #expect(try fileManager.contentsOfDirectory(atPath: folder.path) == ["mem0-rs.db"])
    #expect(!fileManager.fileExists(atPath: sandbox.paths.supportRoot.appendingPathComponent("memory-rs").path))
}

@MainActor
@Test("renommage-memoire/AC-310 : un second ensureRunning ne décharge plus l'ancien label et ne crée aucun dossier")
func secondRunLeavesNothingToRetire() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    _ = try makeLegacyDataFolder(sandbox)
    let double = AgentDouble()
    double.healthBody = installedHealth(sandbox.paths)
    double.legacyLoaded = true
    double.legacyHolder = (800, "ancien-agent", legacyBinaryLine)
    let agent = renamedAgent(sandbox, double)
    try writeLegacyPlist(of: agent)
    try await agent.ensureRunning { _ in }

    let before = double.calls.count
    let entries = try fileManager.contentsOfDirectory(atPath: sandbox.paths.supportRoot.path).sorted()
    try await renamedAgent(sandbox, double).ensureRunning { _ in }

    let second = Array(double.calls.dropFirst(before))
    #expect(!second.contains { $0.arguments.first == "bootout" }, "aucun bootout, de l'ancien label ni du nouveau")
    #expect(second.filter { $0.arguments == ["print", "gui/501/\(agent.legacyLabel)"] }.count == 1)
    #expect(try fileManager.contentsOfDirectory(atPath: sandbox.paths.supportRoot.path).sorted() == entries)
    #expect(!fileManager.fileExists(atPath: sandbox.paths.supportRoot.appendingPathComponent("memory-rs").path))
}

@MainActor
@Test("renommage-memoire/AC-310 : un plist de l'ancien agent resté sur le disque sans job chargé est retiré, sans bootout")
func orphanLegacyPlistIsRemoved() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = installedHealth(sandbox.paths)
    let agent = renamedAgent(sandbox, double)
    try writeLegacyPlist(of: agent)

    try await agent.ensureRunning { _ in }

    #expect(!fileManager.fileExists(atPath: agent.legacyPlistURL.path))
    #expect(double.legacyCalls.compactMap(\.arguments.first) == ["print"])
}

@MainActor
@Test("renommage-memoire/AC-310 : ensureStopped avec l'ancien label chargé le décharge et retire son plist, avant de regarder le nouveau label")
func ensureStoppedRetiresTheLegacyAgent() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let (folder, content) = try makeLegacyDataFolder(sandbox)
    let double = AgentDouble()
    double.legacyLoaded = true
    double.legacyHolder = (800, "ancien-agent", legacyBinaryLine)
    let agent = renamedAgent(sandbox, double)
    try writeLegacyPlist(of: agent)

    let wasLoaded = try await agent.ensureStopped()

    #expect(wasLoaded)
    #expect(double.calls.first?.arguments == ["print", "gui/501/\(agent.legacyLabel)"])
    #expect(double.legacyCalls.compactMap(\.arguments.first) == ["print", "bootout", "print"])
    #expect(double.launchctlVerbs == ["print"])
    #expect(!double.legacyLoaded)
    #expect(!fileManager.fileExists(atPath: agent.legacyPlistURL.path))
    #expect(try Data(contentsOf: folder.appendingPathComponent("mem0-rs.db")) == content)

    // Rien de chargé ni sur le disque : faux, et un seul print par label.
    let idle = AgentDouble()
    let stopped = renamedAgent(sandbox, idle)
    #expect(try await stopped.ensureStopped() == false)
    #expect(idle.legacyCalls.compactMap(\.arguments.first) == ["print"])
    #expect(idle.launchctlVerbs == ["print"])
}

// MARK: - S-33 : stack/env

@Test("renommage-memoire/AC-310 : StackConfig(values:) lit MEMORY_HTTP_TOKEN, sinon MEM0_HTTP_TOKEN ; les deux → le nouveau ; une clé présente et vide reste une valeur")
func stackConfigReadsTheLegacyTokenKey() {
    #expect(StackConfig(values: ["MEM0_HTTP_TOKEN": "T"]).memoryHttpToken == "T")
    #expect(StackConfig(values: ["MEMORY_HTTP_TOKEN": "N"]).memoryHttpToken == "N")
    #expect(StackConfig(values: ["MEM0_HTTP_TOKEN": "ancien", "MEMORY_HTTP_TOKEN": "nouveau"]).memoryHttpToken == "nouveau")
    #expect(StackConfig(values: ["MEMORY_HTTP_TOKEN": "", "MEM0_HTTP_TOKEN": "ancien"]).memoryHttpToken == "")
    #expect(StackConfig(values: [:]).memoryHttpToken == StackConfig.defaults.memoryHttpToken)
}

@Test("renommage-memoire/AC-310 : serialized écrit MEMORY_HTTP_TOKEN=T et aucune ligne MEM0_ ; `keys` et `values` ne portent que le nouveau nom")
func stackConfigWritesOnlyTheNewKey() {
    let config = StackConfig(values: StackEnvStore.parse("MEM0_HTTP_TOKEN=T\nOMLX_EMBED_MODEL=bge-m3\n"))
    #expect(config.memoryHttpToken == "T")
    let lines = config.serialized.split(separator: "\n").map(String.init)
    #expect(lines.contains("MEMORY_HTTP_TOKEN=T"))
    #expect(!lines.contains { $0.contains("MEM0_") })
    #expect(StackConfig.keys.contains("MEMORY_HTTP_TOKEN"))
    #expect(!StackConfig.keys.contains { $0.contains("MEM0_") })
    #expect(config.values["MEMORY_HTTP_TOKEN"] == "T")
    #expect(!config.values.keys.contains { $0.contains("MEM0_") })
}

@MainActor
@Test("renommage-memoire/AC-310 : un stack/env d'avant (MEM0_HTTP_TOKEN=T) donne un plist qui porte MEMORY_HTTP_TOKEN=T, sans ancienne clé, et le fichier n'est pas réécrit")
func plistCarriesTheTokenOfAnOldStackEnv() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    try fileManager.createDirectory(at: sandbox.paths.stackRoot, withIntermediateDirectories: true)
    let oldEnv = "MEM0_HTTP_TOKEN=T\n"
    try Data(oldEnv.utf8).write(to: sandbox.paths.stackEnv)
    let double = AgentDouble()
    double.healthBody = installedHealth(sandbox.paths)
    let agent = renamedAgent(sandbox, double)

    let expected = try agent.expectedPlist(installationToken: "installation")
    let expectedEnvironment = try #require(expected["EnvironmentVariables"] as? [String: String])
    #expect(expectedEnvironment["MEMORY_HTTP_TOKEN"] == "T")
    #expect(!expectedEnvironment.keys.contains { $0.contains("MEM0_") })

    try await agent.ensureRunning { _ in }
    let written = try #require(try plistDictionary(at: agent.plistURL)["EnvironmentVariables"] as? [String: String])
    #expect(written["MEMORY_HTTP_TOKEN"] == "T")
    #expect(!written.keys.contains { $0.contains("MEM0_") })
    #expect(try String(contentsOf: sandbox.paths.stackEnv, encoding: .utf8) == oldEnv)
}
