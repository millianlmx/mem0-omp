// Les preuves des trois lectures neuves de l'Accueil (S-4, S-5, S-6) : l'état des
// composants, le journal des gestes servi tel quel, et le contrat d'une carte.
//
// Tout passe par la pile RÉELLE du harnais (`RemoteStack`) : le routeur réel, la
// vraie garde, la vraie enveloppe d'erreur.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

@Suite("Remote composants, journal et contrat")
@MainActor
struct RemoteHomeRouteTests {

    // MARK: - AC-16 : les composants

    @Test("ios-accueil/AC-16 : la route des composants sert l'état RÉEL injecté par la coque")
    func componentsRouteServesInjectedState() async throws {
        let stack = try await RemoteStack.make(components: {
            RemoteComponentsPayload(
                ompInstalled: false,
                ompPath: nil,
                setupBanner: "Préparation en cours — Téléchargement d'OMP…"
            )
        })
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/components", token: token)
        #expect(reply.status == 200)
        #expect(reply.headers["x-console-protocol-version"] == "1")
        let payload = try reply.json(RemoteComponentsPayload.self)
        #expect(payload.ompInstalled == false)
        #expect(payload.ompPath == nil)
        #expect(payload.setupBanner == "Préparation en cours — Téléchargement d'OMP…")
    }

    @Test("ios-accueil/AC-16 : OMP présent ⇒ le chemin du binaire accompagne l'état")
    func componentsRouteCarriesBinaryPath() async throws {
        let stack = try await RemoteStack.make(components: {
            RemoteComponentsPayload(ompInstalled: true, ompPath: "/tmp/omp/bin/omp", setupBanner: nil)
        })
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/components", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteComponentsPayload.self)
        #expect(payload.ompInstalled)
        #expect(payload.ompPath == "/tmp/omp/bin/omp")
        #expect(payload.setupBanner == nil)
    }

    @Test("feuilles-ios-presentation-et-depots/AC-7 : la route des composants publie le dossier personnel du Mac")
    func componentsCarryHomeDirectory() async throws {
        // La charge est bâtie SANS nommer le dossier, comme le fournisseur de la coque :
        // le champ suit toute construction.
        let stack = try await RemoteStack.make(components: {
            RemoteComponentsPayload(ompInstalled: true, ompPath: "/tmp/omp/bin/omp", setupBanner: nil)
        })
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/components", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteComponentsPayload.self)
        #expect(payload.homeDirectory == NSHomeDirectory())
        #expect(reply.text.contains("\"homeDirectory\""))
    }

    @Test("la garde des trois lectures neuves est celle des 26 autres")
    func newReadsShareTheGuard() async throws {
        let stack = try await RemoteStack.make()
        defer { stack.stop() }
        let token = try await stack.pair()

        for path in ["/v1/components", "/v1/journal", "/v1/cards/inconnu/contract"] {
            let withoutProtocol = try await stack.call("GET", path, token: token, omitProtocolHeader: true)
            #expect(withoutProtocol.status == 400, "\(path) sans en-tête de version → 400")
            #expect(withoutProtocol.errorCode == "bad_request")

            let withoutToken = try await stack.call("GET", path)
            #expect(withoutToken.status == 401, "\(path) sans jeton → 401")
            #expect(withoutToken.errorCode == "unauthorized")
        }
    }

    // MARK: - AC-13 : le journal

    @Test("ios-accueil/AC-13 : le journal des gestes est servi tel quel, plus récent en tête")
    func journalRouteServesTheModelJournal() async throws {
        let store = StoreFixture()
        let actions = ActionsModel(writer: PipelineWriter(stateDir: store.root))
        let stack = try await RemoteStack.make(stateDir: store.root, actionsModel: actions)
        defer { stack.stop() }
        let token = try await stack.pair()

        // Un geste réel consigne une entrée dans le journal du modèle.
        actions.launch(title: "Titre", description: "Intention", repoRoot: store.root)
        try #require(actions.journal.count == 1)

        let reply = try await stack.call("GET", "/v1/journal", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteJournalPayload.self)
        #expect(payload.entries.count == actions.journal.count)
        #expect(payload.entries.first?.kindLabel == ActionsText.launchLabel)
        #expect(payload.entries.first?.id == actions.journal.first?.id)
    }

    @Test("le journal vide se sert `entries: []`, jamais une erreur")
    func emptyJournalIsServedEmpty() async throws {
        let store = StoreFixture()
        let stack = try await RemoteStack.make(stateDir: store.root)
        defer { stack.stop() }
        let token = try await stack.pair()

        let reply = try await stack.call("GET", "/v1/journal", token: token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteJournalPayload.self)
        #expect(payload.entries.isEmpty)
    }

    // MARK: - AC-8 : le contrat d'une carte

    @Test("ios-accueil/AC-8 : le contrat d'une carte à moment est servi depuis son worktree")
    func contractRouteServesTheFile() async throws {
        let fixture = try await makeContractFixture()
        defer { fixture.stack.stop() }

        let reply = try await fixture.stack.call("GET", "/v1/cards/\(fixture.cardId)/contract", token: fixture.token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteContractPayload.self)
        #expect(payload.document.name == "contract.md")
        #expect(payload.document.state == "text")
        #expect(payload.document.content?.contains("## Spécifications") == true)
        #expect(payload.document.content?.contains("## Lots") == true)
    }

    @Test("ios-accueil/AC-8 : un contrat absent est un 200 `missing`, pas une erreur")
    func missingContractFileIsReported() async throws {
        let fixture = try await makeContractFixture(writeContract: false)
        defer { fixture.stack.stop() }

        let reply = try await fixture.stack.call("GET", "/v1/cards/\(fixture.cardId)/contract", token: fixture.token)
        #expect(reply.status == 200)
        let payload = try reply.json(RemoteContractPayload.self)
        #expect(payload.document.state == "missing")
        #expect(payload.document.content == nil)
    }

    @Test("ios-accueil/AC-8 : une carte inconnue est un 404")
    func unknownCardIsNotFound() async throws {
        let fixture = try await makeContractFixture()
        defer { fixture.stack.stop() }

        let reply = try await fixture.stack.call(
            "GET", "/v1/cards/feature:0000000000000000:absente/contract", token: fixture.token
        )
        #expect(reply.status == 404)
        #expect(reply.errorCode == "not_found")
        #expect(reply.errorMessage == "carte inconnue")
    }

    @Test("ios-accueil/AC-8 : une carte sans moment ou sans worktree est un 409")
    func cardWithoutContractIsConflict() async throws {
        let fixture = try await makeContractFixture()
        defer { fixture.stack.stop() }

        let reply = try await fixture.stack.call("GET", "/v1/cards/\(fixture.idleCardId)/contract", token: fixture.token)
        #expect(reply.status == 409)
        #expect(reply.errorCode == "conflict")
        #expect(reply.errorMessage == "carte sans contrat")
    }
}

// MARK: - Fixture du contrat

@MainActor
private struct ContractFixture {
    let store: StoreFixture
    let stack: RemoteStack
    let token: String
    let repoKey: String

    var cardId: String { "feature:\(repoKey):alpha" }
    var idleCardId: String { "feature:\(repoKey):beta" }
}

/// Un lot à deux features : `alpha` en attente du jalon specs avec un worktree (un
/// moment de contrat), `beta` sans worktree (aucun moment).
@MainActor
private func makeContractFixture(writeContract: Bool = true) async throws -> ContractFixture {
    let store = StoreFixture()
    let repoRoot = store.root + "/depot"
    let worktree = repoRoot + "/alpha"
    try FileManager.default.createDirectory(atPath: repoRoot + "/.git", withIntermediateDirectories: true)
    try FileManager.default.createDirectory(
        atPath: worktree + "/.omp/pipeline",
        withIntermediateDirectories: true
    )
    if writeContract {
        let markdown = "# Contrat\n\n## Spécifications\n\nLa spec du lot.\n\n## Lots\n\n### BR-1\n"
        try Data(markdown.utf8).write(to: URL(fileURLWithPath: worktree + "/.omp/pipeline/contract.md"))
    }

    let repoKey = ProjectPaths.key(forRoot: repoRoot)
    store.publish(.lots, "\(fixtureId(0xC1)).json", object: lotObject(
        repoRoot: repoRoot,
        features: [
            lotFeatureObject(slug: "alpha", state: "waiting", worktree: worktree, waitKind: "specs"),
            lotFeatureObject(slug: "beta", state: "pending", worktree: ""),
        ]
    ))
    store.publish(.projects, "\(repoKey).json", object: projectObject(repoKey: repoKey, repoRoot: repoRoot))

    let stack = try await RemoteStack.make(stateDir: store.root)
    stack.kanban.start()
    let ready = await awaitMainTrue { stack.kanban.state.kanbanBoard?.cards.count ?? 0 >= 2 }
    try #require(ready, "le tableau doit publier les deux cartes du lot")
    return ContractFixture(
        store: store,
        stack: stack,
        token: try await stack.pair(),
        repoKey: repoKey
    )
}
