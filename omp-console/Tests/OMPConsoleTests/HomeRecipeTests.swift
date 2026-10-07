// La recette mécanique de l'Accueil (S-9, BR-6 étape 3) : un client iOS
// CONSOMMATEUR réel (URLSession) contre une pile RÉELLE (`RemoteStack` : vrai
// serveur HTTP, vrai routeur, vrai registre, vrai flux SSE), hors suite, hors CI.
//
// Le paquet ne vend aucun produit exécutable, donc le véhicule de la recette est
// ce test, DÉSACTIVÉ par défaut : aucune étape de `.github/workflows/check.yml`
// ni `scripts/swift-app.sh` ne pose `MEM0_HOME_RECIPE`, la CI le rapporte
// « skipped » et ne l'exécute jamais.
//
// SCÉNARIO, pas à pas (S-9) :
//   1. la pile macOS est montée sur un magasin d'état — celui de l'opérateur quand
//      `MEM0_HOME_RECIPE_DIR` le désigne (run RÉEL), sinon une fixture jetable
//      portant une feature au jalon specs et son contrat ;
//   2. l'app s'appaire (le code affiché par le Mac), puis OUVRE L'ACCUEIL : elle
//      lit `components()` et `journal()` (200 attendus) et reçoit l'instantané ;
//   3. elle lit le CONTRAT d'une carte à moment (`contract(cardId:)`) et le
//      refuse proprement sur une carte inconnue (404 documenté) ;
//   4. sur un run réel (magasin seedé), elle RÉPOND à une question `ask` — par une
//      option, puis par un TEXTE libre —, VALIDE un jalon, et REPREND un lot.
// Chaque étape IMPRIME son observation (jamais un ✓ muet).
//
// La recette est la preuve pas à pas de S-9 (AC-3 à AC-6 : répondre par une option,
// répondre par un texte, valider un jalon, reprendre un lot) et, par sa lecture du
// contrat d'une carte à moment, de S-6 (AC-8).

import ConsoleClient
import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

/// Les doublures minimales du harnais ConsoleClientTests (non visibles ici).
@MainActor
private final class HomeRecipeDiscovery: DiscoverySource {
    var onChange: (([DiscoveredMac]) -> Void)?
    var onProtocolVersion: ((Int) -> Void)?
    var onDenied: ((Bool) -> Void)?
    func start(serviceType: String) {}
    func stop() {}
}

@MainActor
private final class HomeRecipePath: ClientPathSource {
    var onChange: ((Bool) -> Void)?
    func start() {}
    func stop() {}
}

/// Le contrat du magasin jetable : les deux sections du moment `.specs`.
private let recipeContract = """
# Contrat de recette (Accueil)

## Spécifications

- La recette exerce les gestes de l'Accueil par l'API.

## Lots

- BR-6 : preuves de la feature ios-accueil.
"""

@MainActor
@Test(
    "ios-accueil/AC-3, AC-4, AC-5, AC-6 : recette — répondre à un ask par une option puis un texte, valider un jalon, reprendre un lot",
    .enabled(if: ProcessInfo.processInfo.environment["MEM0_HOME_RECIPE"] != nil)
)
/// Le nom de la FONCTION porte « recette » : `swift test --filter AccueilRecipe`
/// filtre sur l'identifiant du test, pas sur son titre affiché.
func accueilRecipe() async throws {
    let environment = ProcessInfo.processInfo.environment
    let seededDir = environment["MEM0_HOME_RECIPE_DIR"]

    // 1. Le magasin. Sans magasin seedé, une fixture jetable porte une feature au
    //    jalon specs, dont le worktree contient un contrat réel sur disque : la
    //    lecture du contrat n'est alors pas une devinette.
    let fixture = seededDir == nil ? StoreFixture() : nil
    var contractCardId: String?
    if let fixture {
        let repoRoot = makeDirectory(fixture, "depot")
        let worktree = makeDirectory(fixture, "depot/specs-a-valider")
        let contractPath = joinPath(worktree, ".omp/pipeline/contract.md")
        try FileManager.default.createDirectory(
            atPath: (contractPath as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true
        )
        fixture.publish(path: contractPath, contents: recipeContract)
        fixture.publish(.lots, "\(fixtureId(0xB2)).json", object: lotObject(
            repoRoot: repoRoot,
            features: [lotFeatureObject(
                slug: "specs-a-valider",
                state: "waiting",
                phase: "specs",
                worktree: worktree,
                waitKind: "specs"
            )]
        ))
        contractCardId = "feature:\(KanbanRepoKey.key(forRoot: repoRoot)):specs-a-valider"
    }

    let stateDir = seededDir ?? fixture!.root
    let stack = try await RemoteStack.make(stateDir: stateDir)
    defer { stack.stop() }
    stack.kanban.start()
    _ = await awaitMainTrue { stack.kanban.state.kanbanBoard != nil }
    print("recette Accueil : pile montée sur \(stateDir) — magasin seedé = \(seededDir != nil)")

    // 2. L'appairage, puis l'ouverture de l'Accueil.
    let code = try stack.registry.generateCode()
    let client = ConsoleClientModel(
        transport: URLSessionTransport(),
        discovery: HomeRecipeDiscovery(),
        preferences: InMemoryClientPreferences(),
        tokens: InMemoryTokenStore(),
        pathSource: HomeRecipePath()
    )
    defer { client.stop() }
    client.start()
    _ = client.setManualAddress("127.0.0.1:\(stack.port)")
    try await client.pair(code: code.value, deviceName: "Recette Accueil")
    #expect(client.pairingFailure == nil, "l'appairage doit aboutir")
    _ = await awaitMainTrue(timeout: 5) { if case .connected = client.state { return true } else { return false } }
    print("recette Accueil : appairé — état = \(client.state), omp = \(client.omp)")

    // 3. Les deux lectures neuves de l'Accueil : 200 attendus (aucune levée).
    let components = try await client.components()
    let journal = try await client.journal()
    print(
        "recette Accueil : components ompInstalled=\(components.ompInstalled) "
            + "setupBanner=\(components.setupBanner ?? "nil"), journal \(journal.entries.count) entrée(s)"
    )

    // L'instantané est lu : c'est lui qui pose l'ardoise de l'Accueil.
    _ = try await client.store()
    let dashboard: HomeDashboard? = {
        if case .dashboard(let dashboard) = HomePresentation.state(omp: client.omp, board: client.board) {
            return dashboard
        }
        return nil
    }()
    if let dashboard {
        print(
            "recette Accueil : \(dashboard.attention.count) fait(s) d'attention, "
                + "\(dashboard.running.count) en cours, \(dashboard.delivered.count) livrée(s)"
        )
    } else {
        print("recette Accueil : ardoise = \(client.board)")
    }

    // 4. Le contrat d'une carte à moment.
    if contractCardId == nil, let dashboard {
        contractCardId = dashboard.attention.first { ContractDocument.moment(for: $0.card) != nil }?.card.id
    }
    if let contractCardId {
        let payload = try await client.contract(cardId: contractCardId)
        print(
            "recette Accueil : contrat de \(contractCardId) — state=\(payload.document.state), "
                + "\(payload.document.content?.count ?? 0) octet(s)"
        )
        #expect(payload.document.state == "text", "le contrat du worktree doit se lire")
        #expect(payload.document.content?.contains("## Spécifications") == true)
    } else {
        print("recette Accueil : aucune carte à moment dans le magasin — « contract » NON joué")
    }
    // Le refus documenté (404 `not_found`) sur une carte inconnue.
    do {
        _ = try await client.contract(cardId: "feature:0000000000000000:inconnue")
        Issue.record("une carte inconnue doit être refusée")
    } catch let error as ClientError {
        print("recette Accueil : contrat d'une carte inconnue — \(error)")
        if case .api(.notFound(let message)) = error {
            #expect(message == "carte inconnue")
        }
    }

    // 5. Les gestes, sur un run RÉEL seulement (magasin seedé par l'opérateur).
    guard seededDir != nil else {
        print("recette Accueil : aucun magasin seedé (MEM0_HOME_RECIPE_DIR absent) — gestes NON joués")
        print("recette Accueil : terminée")
        return
    }
    guard let dashboard else {
        print("recette Accueil : l'Accueil n'est pas au tableau de bord — gestes NON joués")
        print("recette Accueil : terminée")
        return
    }

    // Répondre à une question `ask` : d'abord une option, puis un texte libre.
    if let attention = dashboard.attention.first(where: { $0.nature == .question }),
       let pending = attention.card.action?.run?.pendingAsk {
        let label = pending.options.first?.label ?? pending.question
        do {
            let accepted = try await client.answer(cardId: attention.card.id, kind: "selected", label: label, text: nil)
            print("recette Accueil : réponse « \(label) » à \(attention.card.id) — accepted=\(accepted.accepted)")
        } catch {
            print("recette Accueil : réponse par option refusée — \(error)")
        }
        do {
            let accepted = try await client.answer(
                cardId: attention.card.id,
                kind: "custom",
                label: nil,
                text: "Recette : je réponds depuis l'Accueil."
            )
            print("recette Accueil : texte libre à \(attention.card.id) — accepted=\(accepted.accepted)")
        } catch {
            print("recette Accueil : réponse par texte refusée — \(error)")
        }
    } else {
        print("recette Accueil : aucun ask en vol — « answer » NON joué")
    }

    // Valider un jalon (specs puis revue, s'ils sont présents).
    for nature in [HomeAttentionNature.milestoneSpecs, .milestoneReview] {
        guard let attention = dashboard.attention.first(where: { $0.nature == nature }) else {
            print("recette Accueil : aucun jalon \(HomeText.natureText(nature)) — « verdict » NON joué")
            continue
        }
        let verdict = nature == .milestoneSpecs ? "specs" : "review"
        do {
            let accepted = try await client.verdict(cardId: attention.card.id, verdict: verdict)
            print("recette Accueil : jalon \(verdict) de \(attention.card.id) — accepted=\(accepted.accepted)")
        } catch {
            print("recette Accueil : jalon \(verdict) refusé — \(error)")
        }
    }

    // Reprendre un lot au pilote mort.
    if let resumable = dashboard.running.first(where: { KanbanActionPresentation.resumable($0) }) {
        do {
            let accepted = try await client.resume(cardId: resumable.id)
            print("recette Accueil : reprise de \(resumable.id) — accepted=\(accepted.accepted)")
        } catch {
            print("recette Accueil : reprise refusée — \(error)")
        }
    } else {
        print("recette Accueil : aucun lot resumable — « resume » NON joué")
    }

    print("recette Accueil : terminée")
}
