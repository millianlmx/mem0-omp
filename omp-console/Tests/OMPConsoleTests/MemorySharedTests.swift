// La mémoire partagée avec le serveur de pipelines : `~/.omp/mem0.json` donne à
// l'app la même adresse qu'aux sessions (une app lancée par le Finder ne lit pas le
// profil du shell), et une adresse distante, choisie et authentifiée, est acceptée
// sans le jeton d'installation qui garde le port local.

import Foundation
import Testing
@testable import OMPConsole

/// Un HOME jetable, avec ou sans `.omp/mem0.json`.
private func home(settings: [String: Any]?) throws -> String {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("omp-console-home-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir.appendingPathComponent(".omp"), withIntermediateDirectories: true)
    if let settings {
        try JSONSerialization.data(withJSONObject: settings).write(to: dir.appendingPathComponent(".omp/mem0.json"))
    }
    return dir.path
}

@Test("memoire-partagee/AC-1 : sans MEM0_HTTP_URL, ~/.omp/mem0.json donne l'adresse et le jeton ; l'environnement l'emporte, sans jamais recevoir le jeton du fichier")
func sharedMemorySettingsFile() throws {
    let shared = try home(settings: ["url": "https://vps.tailnet.ts.net:8443", "token": "jeton-vps"])

    let fromFile = MemoryServiceConfig.fromEnvironment(["HOME": shared])
    #expect(fromFile.baseURL.absoluteString == "https://vps.tailnet.ts.net:8443")
    #expect(fromFile.token == "jeton-vps")
    #expect(fromFile.isRemote)
    #expect(fromFile.chosen && !fromFile.verifiesIdentity)

    // Une pile en conteneurs sur ce Mac, choisie dans le fichier : locale, mais choisie.
    let localStack = try home(settings: ["url": "http://127.0.0.1:8322", "token": "jeton-pile"])
    let stack = MemoryServiceConfig.fromEnvironment(["HOME": localStack])
    #expect(!stack.isRemote && stack.chosen && !stack.verifiesIdentity)

    let fromEnv = MemoryServiceConfig.fromEnvironment(["HOME": shared, "MEM0_HTTP_URL": "http://127.0.0.1:9000"])
    #expect(fromEnv.baseURL.absoluteString == "http://127.0.0.1:9000")
    #expect(fromEnv.token.isEmpty, "le jeton du serveur ne part pas vers une autre adresse")
    #expect(!fromEnv.isRemote)
    #expect(fromEnv.verifiesIdentity, "une adresse locale de l'environnement reste sondée")

    let tokenFromEnv = MemoryServiceConfig.fromEnvironment(["HOME": shared, "MEM0_HTTP_TOKEN": "autre"])
    #expect(tokenFromEnv.baseURL.absoluteString == "https://vps.tailnet.ts.net:8443")
    #expect(tokenFromEnv.token == "autre")

    // Pas de fichier, ou un fichier sans adresse : le service de l'app.
    for settings: [String: Any]? in [nil, ["token": "orphelin"]] {
        let bare = try home(settings: settings)
        let local = MemoryServiceConfig.fromEnvironment(["HOME": bare])
        #expect(local.baseURL.absoluteString == "http://localhost:8321")
        #expect(local.token.isEmpty)
    }
}

@Test("memoire-partagee/AC-2 : une mémoire distante ou choisie répond « disponible » sans jeton d'installation ; une adresse locale de l'environnement reste soumise à la sonde identitaire")
func remoteMemoryIsAcceptedWithoutInstallationToken() async {
    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(body: memoryJSON(["ok": true, "mem0": "mem0-rs 0.1.0"])))
    let remote = await stubbedHTTPMemoryService(token: "jeton-vps", baseURL: "https://vps.tailnet.ts.net:8443").health()
    #expect(remote.isAvailable)
    #expect(!remote.isForeign)
    #expect(StubURLProtocol.requests.first?.value(forHTTPHeaderField: "X-Mem0-Token") == "jeton-vps")

    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(body: memoryJSON(["ok": true, "mem0": "mem0-rs 0.1.0"])))
    let local = await stubbedHTTPMemoryService(installationToken: "jeton", baseURL: "http://127.0.0.1:8321").health()
    #expect(!local.isAvailable)
    #expect(local.isForeign, "un service local sans notre jeton reste étranger")

    // Une adresse locale choisie dans ~/.omp/mem0.json : acceptée sans le jeton d'installation.
    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(body: memoryJSON(["ok": true])))
    var chosen = MemoryServiceConfig(baseURL: URL(string: "http://127.0.0.1:8322")!, token: "t", installationToken: "jeton")
    chosen.chosen = true
    let stack = await HTTPMemoryService(config: chosen, session: StubURLProtocol.session()).health()
    #expect(stack.isAvailable)

    StubURLProtocol.reset()
    StubURLProtocol.reply("/health", .init(body: memoryJSON(["ok": false])))
    let down = await stubbedHTTPMemoryService(baseURL: "https://vps.tailnet.ts.net:8443").health()
    #expect(!down.isAvailable, "distante ou non, `ok` faux n'est jamais disponible")
}
