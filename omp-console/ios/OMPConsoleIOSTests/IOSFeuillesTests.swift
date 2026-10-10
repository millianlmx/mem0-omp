import Foundation
import Testing

@testable import ConsoleClient
@testable import ConsoleCore
@testable import OMPConsoleIOS

/// Une lecture de la Mémoire qui compte ses appels : la recette ne doit RIEN lire.
@MainActor
private final class CountingMemoryReader: IOSMemoryReading {
    var state: ClientState = .unpaired
    private(set) var reads = 0

    func memoryPage(scope: String?, offset: Int, limit: Int?) async throws -> RemoteMemoryPagePayload {
        reads += 1
        return RemoteMemoryPagePayload(scope: "projet", total: 0, offset: offset, rows: [], nextOffset: nil)
    }

    func memorySearch(query: String, scope: String?, limit: Int?) async throws -> RemoteMemorySearchPayload {
        reads += 1
        return RemoteMemorySearchPayload(rows: [], candidates: 0, scored: 0)
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        reads += 1
        return IOSMemoryGraphRecipe.graphe.payload
    }
}

/// Une source de fil qui publie un dossier personnel de Mac : le modèle doit le
/// passer au builder de sa lecture.
@MainActor
private final class HomeSessionSource: IOSSessionSource {
    let payload: RemoteSessionPayload
    let macHomeDirectory: String?

    init(payload: RemoteSessionPayload, macHomeDirectory: String?) {
        self.payload = payload
        self.macHomeDirectory = macHomeDirectory
    }

    func read(file: String) async throws -> RemoteSessionPayload { payload }

    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> {
        AsyncStream { $0.finish() }
    }

    func run(forFile file: String) -> RunChoice? { nil }
}

/// Les preuves Swift de la feature feuilles-ios-presentation-et-depots. Les crochets de
/// recette ouvrent les feuilles que `scripts/ios-feuilles-recette.sh` capture avant et
/// après (AC-11) : un crochet qui ne se résout pas, ou une fixture qui ne se décode
/// pas, n'ouvre AUCUNE feuille, et le relevé perd sa capture sans autre signal.
@Suite("feuilles-ios-presentation-et-depots — crochets de recette des feuilles")
struct IOSFeuillesTests {
    @Test("feuilles-ios-presentation-et-depots/AC-11 : -projet.recipe et -sessionomp.recipe — la dernière paire reconnue gagne")
    func launchRecipesResolve() {
        let project = IOSLaunchRecipeText.projectFlag
        let session = IOSLaunchRecipeText.sessionOmpFlag
        #expect(IOSProjectRecipe.resolve([project, "lancement"]) == .lancement)
        #expect(IOSProjectRecipe.resolve([project, "lancement", project, "dialogue"]) == .dialogue)
        #expect(IOSProjectRecipe.resolve([project, "dialogue", project, "inconnue"]) == .dialogue)
        #expect(IOSProjectRecipe.resolve([project]) == nil)
        #expect(IOSProjectRecipe.resolve([session, "lancement"]) == nil)
        #expect(IOSSessionOmpRecipe.resolve([session, "lancement"]) == .lancement)
        #expect(IOSSessionOmpRecipe.resolve([session, "dialogue"]) == nil)
        #expect(IOSSessionOmpRecipe.resolve([project, "lancement"]) == nil)
        #expect(IOSSessionOmpRecipe.resolve([]) == nil)
    }

    @Test("feuilles-ios-presentation-et-depots/AC-11 : la fixture de dialogue se décode, celle des dépôts présélectionne un homonyme")
    func launchFixturesAreUsable() throws {
        let dialog = try #require(IOSLaunchRecipe.dialog)
        #expect(dialog.method == .select)
        #expect(dialog.title == "Quelle base pour la feature ?")
        #expect(dialog.options == ["main", "feat/memoire-ios"])

        let fixture = IOSLaunchRecipe.fixture
        #expect(fixture.repos.map(\.repoRoot) == PipelinesText.recipeRepos)
        #expect(fixture.repos.map(\.name) == ["mem0-omp", "mem0-omp", "site-vitrine"])
        #expect(fixture.repos.contains { $0.repoKey == fixture.selectedKey })
        #expect(
            KanbanLaunchRepos.choices(fixture.repos.map(\.repoRoot)).map(\.label)
                == ["mem0-omp (Archives)", "mem0-omp (Projets)", "site-vitrine"])
    }

    @Test("feuilles-ios-presentation-et-depots/AC-11 : -memoire.recipe liste garde la liste et sélectionne le souvenir de la fixture")
    @MainActor
    func memoryListRecipeSelectsFromTheList() async throws {
        #expect(IOSMemoryGraphRecipe.resolve([IOSMemoryText.graphRecipeFlag, "liste"]) == .liste)
        let reader = CountingMemoryReader()
        let graph = IOSMemoryGraphModel(client: reader)
        await IOSMemoryGraphRecipe.liste.activate(graph)
        #expect(graph.shown == false)
        let selection = try #require(IOSMemoryGraphRecipe.liste.listSelection(graph))
        #expect(selection.row.id == IOSMemoryText.graphRecipeMemory)
        #expect(selection.row.text == "titre un")
        #expect(IOSMemoryGraphRecipe.fiche.listSelection(graph) == nil)
        #expect(reader.reads == 0)
    }

    /// Un appel `read` d'un fichier du Mac HORS de la racine du projet de la session.
    private static let macHomePayloadJSON = #"""
    {"header":{"id":"s1","cwd":"/tmp/autre"},"kind":"topLevel","entries":[{"index":0,"offset":0,"kind":"assistant","text":"Je lis.","toolCalls":[{"id":"c1","name":"read","arguments":{"path":"/Users/recette/Projets/x/a.swift"}}]}],"skipped":[],"truncated":false}
    """#

    private static func toolTargets(_ rows: [SessionRow]) -> [String] {
        rows.compactMap { row in
            if case .toolCall(let call) = row.kind { return call.target }
            return nil
        }
    }

    @Test("feuilles-ios-presentation-et-depots/AC-7 : un chemin du Mac hors du projet s'affiche « ~/… » dans le fil, absolu si le Mac ne publie pas son dossier")
    @MainActor
    func threadRowsAbbreviateMacHome() async throws {
        let payload = try JSONDecoder().decode(RemoteSessionPayload.self, from: Data(Self.macHomePayloadJSON.utf8))
        #expect(Self.toolTargets(IOSSessionThreadFacts.rows(of: payload, home: "/Users/recette")) == ["~/Projets/x/a.swift"])
        #expect(Self.toolTargets(IOSSessionThreadFacts.rows(of: payload, home: nil)) == ["/Users/recette/Projets/x/a.swift"])

        // Le modèle du fil prend le dossier publié par sa source (la feuille de session
        // comme l'écran Session OMP), jamais le bac à sable de l'app.
        for (home, expected) in [("/Users/recette", "~/Projets/x/a.swift"), (nil, "/Users/recette/Projets/x/a.swift")] as [(String?, String)] {
            let source = HomeSessionSource(payload: payload, macHomeDirectory: home)
            let model = IOSSessionThreadModel(source: source, file: "s.jsonl", title: "t", subtitle: nil, tracksRun: false)
            await model.read()
            #expect(Self.toolTargets(model.rows) == [expected])
        }
    }

    @Test("feuilles-ios-presentation-et-depots/AC-5 : une rangée de dépôt dit le nom seul, « nom (parent) » pour les homonymes, jamais un chemin")
    func repoRowLabels() {
        let roots = ["/Users/demo/Archives/mem0-omp", "/Users/demo/Projets/mem0-omp", "/Users/demo/Projets/site-vitrine"]
        // La clé n'est pas la racine : le libellé suit la racine, il est rangé par clé.
        let repos = roots.enumerated().map { RemoteRepoRow(repoKey: "k\($0.offset)", repoRoot: $0.element, name: "x") }
        let labels = IOSRepoRows.labels(repos)
        #expect(labels == ["k0": "mem0-omp (Archives)", "k1": "mem0-omp (Projets)", "k2": "site-vitrine"])
        #expect(labels.values.allSatisfy { !$0.contains("/") })

        // Deux clés sur la même racine reçoivent le même libellé ; une racine terminée
        // par « / » est nommée sans la barre.
        let twins = [
            RemoteRepoRow(repoKey: "a", repoRoot: "/Users/demo/Projets/site-vitrine/", name: "x"),
            RemoteRepoRow(repoKey: "b", repoRoot: "/Users/demo/Projets/site-vitrine/", name: "x"),
        ]
        #expect(IOSRepoRows.labels(twins) == ["a": "site-vitrine", "b": "site-vitrine"])
    }

    @Test("feuilles-ios-presentation-et-depots/AC-2 : la feuille ajustée prend la hauteur mesurée, jamais une hauteur nulle avant la mesure")
    func fittedSheetIdealHeight() {
        // Avant la première mesure (0) ou sur une mesure absurde, aucune hauteur
        // idéale : la feuille n'est pas écrasée, elle garde sa taille système.
        #expect(IOSSheetSizing.idealHeight(measured: 0) == nil)
        #expect(IOSSheetSizing.idealHeight(measured: -1) == nil)
        #expect(IOSSheetSizing.idealHeight(measured: 312.5) == 312.5)
    }
}
