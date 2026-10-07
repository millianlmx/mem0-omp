// La recette OUTILLÉE de la feature ios-projet (S-12, AC-12) : conduire un projet
// de bout en bout DEPUIS LE CLIENT iOS, contre une coque réelle (pile locale sur
// un port éphémère, vraies routes, vrai registre, vrai flux).
//
// Elle est GATED par `MEM0_REMOTE_RECIPE=1` (patron `clientDistantRecipe` de
// `ClientContractTests.swift`) : sans la variable, elle rend la main sans rien
// éprouver — c'est le rejeu MANUEL de la recette pas à pas qui reste la preuve
// d'écran, elle est documentée dans `omp-console/README.md` § Coque iOS et dans
// la section `## Revue` du contrat. Son nom de fonction est ce que
// `swift test --filter iosProjetRecipe` cible ; son titre porte l'id qualifié.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Découverte muette : le client se connecte par l'adresse manuelle, jamais par
/// Bonjour (ce que la recette n'éprouve pas).
@MainActor
private final class RecipeDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class RecipePath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

/// Attend une condition sans bloquer plus que nécessaire. 10 s (et non 5) : le
/// premier `.connected` dépend de la montée du flux SSE, la seule partie lente.
@MainActor
private func recipeEventually(timeout: Double = 10, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(nanoseconds: 20_000_000)
    }
    return condition()
}

@MainActor
@Suite("Recette ios-projet (coque réelle)")
struct ProjectIOSRecipeTests {
    @Test("ios-projet/AC-12 : recette réelle — dépôts, démarrage, escalade et arrêt depuis le client iOS")
    func iosProjetRecipe() async throws {
        guard ProcessInfo.processInfo.environment["MEM0_REMOTE_RECIPE"] == "1" else { return }

        // Une coque réelle : un dépôt git jamais cadré (rien qu'un lot), donc
        // exactement le cas de S-8 (« un dépôt jamais cadré »).
        let store = StoreFixture()
        let repoRoot = store.root + "/depot"
        try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
        store.publish(.lots, "\(fixtureId(0xF1)).json", object: lotObject(id: fixtureId(0xF1), repoRoot: repoRoot))

        let transport = ScriptedRpcTransport()
        transport.readyLine = projectReadyLine()
        wireProjectAutoResponses(transport)
        makeProjectTransportRenderOnClose(transport)
        let project = makeProjectModel(host: makeScriptedProjectHost(transport), stateDir: store.root)
        let stack = try await RemoteStack.make(stateDir: store.root, projectModel: project)
        defer { stack.stop() }

        // Le client iOS réel, branché sur l'adresse manuelle de la pile.
        let client = ConsoleClientModel(
            transport: URLSessionTransport(),
            discovery: RecipeDiscovery(),
            preferences: InMemoryClientPreferences(),
            tokens: InMemoryTokenStore(),
            pacer: LiveClientPacer(),
            pathSource: RecipePath()
        )
        defer { client.stop() }
        // `start()` d'abord : sans lui `running` reste faux et `beginConnection`
        // sort sur son garde — les appels HTTP passeraient (endpoint résolu) mais
        // le flux SSE ne s'ouvrirait jamais, donc `state` n'atteindrait pas
        // `.connected` et aucune trame `conduite` n'arriverait.
        client.start()
        _ = client.setManualAddress("127.0.0.1:\(stack.port)")
        let code = try stack.registry.generateCode()
        try await client.pair(code: code.value, deviceName: "Recette iPad")
        #expect(await recipeEventually { if case .connected = client.state { return true }; return false })

        // 1. GET /v1/repos — le dépôt jamais cadré est proposé AVEC sa clé.
        let repos = try await client.repos()
        let repoKey = KanbanRepoKey.key(forRoot: realpathOr(repoRoot))
        #expect(repos.rows.contains { $0.repoKey == repoKey })

        // 2. Démarrer la conduite sur ce dépôt : la coque arme le projet.
        _ = try await client.startConduite(repoKey: repoKey, name: "Recette")
        #expect(await recipeEventually { client.conduite?.repoKey == repoKey })
        let live = try await client.conduiteState()
        #expect(live.state == "live")
        #expect(live.repoKey == repoKey)
        #expect(live.status != nil)

        // 3. Une escalade arrive par le flux, on y répond depuis le client.
        transport.emit(projectDialogLine(
            id: "recette-1",
            method: "select",
            extra: ["title": "Revue du plan", "options": ["Valider le plan", "Corriger le plan"]]
        ))
        #expect(await recipeEventually { client.conduite?.dialogs.first?.id == "recette-1" })
        _ = try await client.answerProjectDialog(
            id: "recette-1",
            kind: "value",
            value: "Valider le plan",
            confirmed: nil
        )
        #expect(await recipeEventually { client.conduite?.dialogs.isEmpty == true })

        // 4. Arrêter la conduite : la coque ferme le projet.
        _ = try await client.closeConduite(repoKey: repoKey)
        #expect(await recipeEventually { client.conduite?.state == "closed" })
    }
}
