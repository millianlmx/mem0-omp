// Les preuves Swift de l'Accueil iOS (BR-4, BR-5) : la machine à états, la parité
// des faits depuis la fixture PARTAGÉE `HomeParity`, le badge, la bienvenue, le
// contenu des feuilles et le contrôle négatif des notifications.
//
// Chaque test nomme l'id d'acceptation qu'il prouve. La structure est le seul
// endroit qui nomme `HomeParity.snapshot` côté iOS : c'est la garde de parité des
// faits, le pendant de la suite macOS.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

@Suite("ios-accueil — l'Accueil et ses feuilles")
struct IOSHomeTests {
    // MARK: - Fixture

    /// L'ardoise dérivée de la fixture partagée, horloge fixe.
    private static let board: KanbanBoardState = KanbanBoardState.derive(
        snapshot: HomeParity.snapshot,
        nowMs: 1_700_000_000_000,
        stateDir: "",
        isAlive: .transported(HomeParity.snapshot),
        prFacts: [:]
    )

    private static var dashboard: HomeDashboard {
        guard case .board(let board) = Self.board else {
            Issue.record("la fixture HomeParity ne produit pas d'ardoise")
            return HomeDashboard(attention: [], running: [], paused: [], notStarted: [], delivered: [])
        }
        return HomePresentation.dashboard(board)
    }

    private static let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)
    private static let ompAvailable = OmpStatus.available(URL(fileURLWithPath: "/usr/local/bin/omp"))

    /// Les huit états de `ClientState` (S-10).
    private static let clientStates: [ClientState] = [
        .unpaired,
        .searching,
        .connecting(endpoint: endpoint),
        .connected(endpoint: endpoint),
        .noNetwork,
        .macAbsent(endpoint: endpoint),
        .revoked,
        .incompatibleProtocol(local: 1, remote: 2),
    ]

    private static let boards: [KanbanBoardState] = [
        .loading,
        .storeEmpty(dir: "/tmp/store"),
        board,
    ]

    private static let omps: [OmpStatus] = [.missing, ompAvailable]

    // MARK: - AC-9 : priorité de la machine à états

    @Test("ios-accueil/AC-9 : hors .connected, l'Accueil est dégradé quelle que soit l'ardoise")
    func resolvePriority() {
        var reached: Set<String> = []
        for state in Self.clientStates {
            for board in Self.boards {
                for omp in Self.omps {
                    let resolved = IOSHomeState.resolve(state: state, board: board, omp: omp)
                    if case .connected = state {
                        // EXACTEMENT HomePresentation.state(omp:board:), mappé.
                        switch HomePresentation.state(omp: omp, board: board) {
                        case .ompMissing: #expect(resolved == .macMissingOMP)
                        case .loading: #expect(resolved == .loading)
                        case .firstRun: #expect(resolved == .firstRun)
                        case .dashboard(let dashboard): #expect(resolved == .dashboard(dashboard))
                        }
                        reached.insert(String(describing: resolved))
                    } else {
                        #expect(resolved == .disconnected(state), "\(state) / \(board)")
                        #expect(resolved != .dashboard(Self.dashboard), "aucun tableau de bord hors connexion")
                    }
                }
            }
        }
        // Les cinq états de S-10 sont atteints par la table.
        #expect(reached.count == 4, "OMP absent, chargement, premiers pas, tableau de bord")
    }

    // MARK: - AC-1 : parité des faits

    @Test("ios-accueil/AC-1 : la fixture partagée produit les mêmes faits que macOS")
    func parityFacts() {
        let dashboard = Self.dashboard
        #expect(dashboard.attention.count == 5)
        #expect(dashboard.attention.map(\.nature).contains(.question))
        #expect(dashboard.attention.map(\.nature).contains(.milestoneSpecs))
        #expect(dashboard.attention.map(\.nature).contains(.milestoneReview))
        #expect(dashboard.running.count == 2)
        #expect(dashboard.paused.count == 1)
        #expect(dashboard.notStarted.count == 1)
        #expect(dashboard.delivered.count == 2)
        #expect(HomePresentation.showsRepo(dashboard))
        #expect(HomePresentation.attentionCount(omp: Self.ompAvailable, board: Self.board) == 5)

        let question = dashboard.attention.first { $0.nature == .question }
        #expect(question?.prompt == "On livre avec le drapeau activé ?")
    }

    // MARK: - accueil-en-cours-melange-pause-et-compte

    /// Le tableau de bord que l'Accueil iOS rend, client connecté, sur la fixture.
    private static var connectedDashboard: HomeDashboard? {
        let resolved = IOSHomeState.resolve(state: .connected(endpoint: endpoint), board: board, omp: ompAvailable)
        guard case .dashboard(let dashboard) = resolved else { return nil }
        return dashboard
    }

    @Test("accueil-en-cours-melange-pause-et-compte/AC-2 : sur iOS, les cinq sections et leur contenu sont ceux du Mac")
    func sectionsMatchTheMac() throws {
        let ios = try #require(Self.connectedDashboard)
        // Le Mac dérive l'ardoise de recette `HomeParity.board` (même fixture,
        // même horloge) ; l'iPhone celle qu'il dérive de l'instantané transporté.
        guard case .board(let macBoard) = HomeParity.board else {
            Issue.record("HomeParity.board doit être une ardoise")
            return
        }
        let mac = HomePresentation.dashboard(macBoard)
        #expect(ios.attention.map(\.id) == mac.attention.map(\.id))
        #expect(ios.running.map(\.id) == mac.running.map(\.id))
        #expect(ios.paused.map(\.id) == mac.paused.map(\.id))
        #expect(ios.notStarted.map(\.id) == mac.notStarted.map(\.id))
        #expect(ios.delivered.map(\.id) == mac.delivered.map(\.id))
        let counts: [Int] = [ios.attention.count, ios.running.count, ios.paused.count, ios.notStarted.count, ios.delivered.count]
        #expect(counts == [5, 2, 1, 1, 2])

        // Le contenu de chaque section : les runs vivants « En cours », la pause
        // « À reprendre », la feature jamais lancée « Pas commencées ».
        #expect(ios.running.map(\.id) == ["run:aaaaaaaaaaaaaaa2", "run:aaaaaaaaaaaaaaa3"])
        #expect(ios.paused.map { $0.action?.slug } == ["reprise"])
        #expect(ios.paused.map { ConsoleStatus.of(card: $0).text } == ["En pause"])
        #expect(ios.notStarted.map { $0.action?.slug } == ["theme-sombre"])
        #expect(!ios.running.contains { KanbanActionPresentation.resumable($0) || $0.column == .enAttente })

        // Les identifiants AX iOS sont ceux du Mac (`home.<section>.<id>`),
        // préfixés `ios.` : la recette lit les mêmes rangées sur les deux coques.
        for card in ios.running { #expect(IOSHomeAccessibility.running(card.id) == "ios.home.running.\(card.id)") }
        for card in ios.paused {
            #expect(IOSHomeAccessibility.paused(card.id) == "ios.home.paused.\(card.id)")
            #expect(IOSHomeAccessibility.resume(card.id) == "ios.home.resume.\(card.id)")
        }
        for card in ios.notStarted { #expect(IOSHomeAccessibility.notStarted(card.id) == "ios.home.notStarted.\(card.id)") }

        // Aucune carte dans deux sections.
        let all = (ios.attention.map(\.card) + IOSHomeContent.rows(ios)).map(\.id)
        #expect(Set(all).count == all.count)
    }

    @Test("accueil-en-cours-melange-pause-et-compte/AC-3 : l'échec et le blocage sont dans « À vous » seulement, avec un libellé lisible et « Reprendre »")
    func failedAndBlockedAreAttentionOnly() throws {
        let ios = try #require(Self.connectedDashboard)
        let failed = try #require(ios.attention.first { $0.card.action?.slug == "cache-sessions" })
        let blocked = try #require(ios.attention.first { $0.card.action?.slug == "export-csv" })

        #expect(failed.nature == .failed)
        #expect(HomeText.natureText(failed.nature) == "En échec")
        #expect(failed.prompt == "L'étape « Implémentation » s'est arrêtée en échec.")
        #expect(IOSHomeText.natureSymbol(failed.nature) == "xmark.octagon.fill")

        #expect(blocked.nature == .blocked)
        #expect(HomeText.natureText(blocked.nature) == "Bloquée")
        #expect(blocked.prompt == "La pipeline est bloquée à l'étape « Spécification ».")
        #expect(IOSHomeText.natureSymbol(blocked.nature) == "exclamationmark.triangle.fill")

        for attention in [failed, blocked] {
            // Le geste de la carte : « Reprendre », par la clé de reprise de la carte.
            #expect(IOSHomeContent.attentionButton(attention) == .relaunch)
            #expect(IOSHomeContent.attentionGestureKey(attention) == IOSHomeGestureKey(cardId: attention.card.id, gesture: .resume))
            // Aucun pid, chemin ni JSON dans le libellé ni l'invite.
            for text in [HomeText.natureText(attention.nature), attention.prompt] {
                #expect(!text.contains("/") && !text.contains("{") && !text.contains { $0.isNumber }, "\(text)")
            }
            // Dans aucune autre section.
            #expect(!IOSHomeContent.rows(ios).contains { $0.id == attention.card.id })
        }
    }

    // MARK: - AC-10 : le badge

    @Test("ios-accueil/AC-10 : le badge vaut 0 hors tableau de bord et 5 sur l'Accueil")
    func badgeCounts() {
        #expect(IOSHomeContent.badge(omp: Self.ompAvailable, board: .loading) == 0)
        #expect(IOSHomeContent.badge(omp: Self.ompAvailable, board: .storeEmpty(dir: "/tmp")) == 0)
        #expect(IOSHomeContent.badge(omp: .missing, board: Self.board) == 0)
        #expect(IOSHomeContent.badge(omp: Self.ompAvailable, board: Self.board) == 5)
    }

    // MARK: - AC-18 : la bienvenue

    @Test("ios-accueil/AC-18 : la bienvenue n'est due qu'à la première ouverture de l'Accueil")
    func welcomeDue() {
        #expect(IOSHomeContent.welcomeDue(welcomeSeen: false, section: .home))
        #expect(!IOSHomeContent.welcomeDue(welcomeSeen: true, section: .home))
        #expect(!IOSHomeContent.welcomeDue(welcomeSeen: false, section: .kanban))
    }

    // MARK: - AC-3 : les deux zones de la feuille Répondre

    @Test("ios-accueil/AC-3 : la feuille Répondre aiguille question en vol et question en texte")
    func answerZones() {
        let question = Self.dashboard.attention.first { $0.nature == .question }
        if case .pendingQuestion(_, let text, let options) = question.flatMap({ IOSHomeContent.answerZone($0.card) }) {
            #expect(text == "On livre avec le drapeau activé ?")
            #expect(options.count == 2)
            #expect(options.first?.label == "Avec le drapeau")
        } else {
            Issue.record("la carte question n'offre pas de zone pendingQuestion")
        }

        let milestone = Self.dashboard.attention.first { $0.nature == .milestoneSpecs }
        #expect(milestone.flatMap { IOSHomeContent.answerZone($0.card) } == nil)

        let textCard = KanbanCard(
            id: "feature:repo:slug",
            column: .questionEnVol,
            repo: "repo",
            title: "Une question en texte",
            state: "waiting",
            phase: .req,
            models: nil,
            prUrl: nil,
            startMs: 0,
            endMs: nil,
            marks: [],
            sources: [],
            action: KanbanCardAction(
                repoRoot: "/tmp/repo",
                slug: "slug",
                waitKind: .answer,
                featureState: .waiting,
                run: nil,
                waitPrompt: "Votre réponse"
            )
        )
        if case .textQuestion(let slug, let prompt) = IOSHomeContent.answerZone(textCard) {
            #expect(slug == "slug")
            #expect(prompt == "Votre réponse")
        } else {
            Issue.record("la carte sans ask n'offre pas de zone textQuestion")
        }
    }

    // MARK: - AC-8 : le contenu de la feuille Contrat

    @Test("ios-accueil/AC-8 : le découpage du contrat rend les mêmes sections que macOS")
    func contractOutputs() throws {
        // La fixture porte une carte à moment : le bouton « Lire le contrat » est
        // donc exerçable (S-11).
        let specs = Self.dashboard.attention.first { $0.nature == .milestoneSpecs }
        #expect(specs.flatMap { ContractDocument.moment(for: $0.card) } == .specs)

        // Par le PUR : `IOSHomeContent.contract` sur le markdown de la fixture.
        let text = try Self.payload(state: IOSHomeText.documentText, content: HomeParity.contractMarkdown)
        guard case .sections(let specs) = IOSHomeContent.contract(with: text, moment: .specs) else {
            Issue.record("le contrat texte ne rend pas de sections")
            return
        }
        #expect(specs.map(\.title) == ["Spécifications", "Lots"])
        #expect(specs.allSatisfy { $0.text != nil })
        #expect(ContractDocument.titles(for: .besoins) == ["Besoins", "Critères d'acceptation"])

        // Une section absente d'un fichier présent.
        let partial = try Self.payload(state: IOSHomeText.documentText, content: "## Besoins\n\n- Un besoin.\n")
        if case .sections(let sections) = IOSHomeContent.contract(with: partial, moment: .besoins) {
            #expect(sections.count == 2)
            #expect(sections[0].text != nil)
            #expect(sections[1].text == nil, "la section absente rend un texte nul")
        } else {
            Issue.record("le contrat partiel ne rend pas de sections")
        }

        // Fichier absent.
        let missing = try Self.payload(state: IOSHomeText.documentMissing, content: nil)
        #expect(IOSHomeContent.contract(with: missing, moment: .specs) == .missing)

        // Fichier non textuel : la raison du Mac est conservée (jamais un décompte).
        let binary = try Self.payload(state: "binary", content: nil, reason: "contenu non textuel")
        #expect(IOSHomeContent.contract(with: binary, moment: .specs) == .unreadable("contenu non textuel"))
    }

    // MARK: - AC-11 : les livraisons récentes

    @Test("ios-accueil/AC-11 : seule une livraison à PR exploitable offre un lien")
    func deliveredLinks() {
        let delivered = Self.dashboard.delivered
        #expect(delivered.contains { IOSHomeContent.deliveredLink($0) != nil })
        let withoutPR = KanbanCard(
            id: "history:1",
            column: .prOuverte,
            repo: "repo",
            title: "Sans PR",
            state: "done",
            phase: .release,
            models: nil,
            prUrl: nil,
            startMs: 0,
            endMs: 1,
            marks: [],
            sources: []
        )
        #expect(IOSHomeContent.deliveredLink(withoutPR) == nil)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : « Livrées récemment » porte l'état réel de la PR, la même dérivation que macOS")
    func deliveredReadsThePullRequestState() {
        let nowMs: Double = 1_700_000_000_000
        let dayMs: Double = 86_400_000
        func delivered(_ facts: [PullRequestFact]) -> [KanbanCard] {
            let state = KanbanBoardState.derive(
                snapshot: HomeParity.snapshot,
                nowMs: nowMs,
                stateDir: "",
                isAlive: .transported(HomeParity.snapshot),
                prFacts: PullRequestFacts.index(facts)
            )
            return state.kanbanBoard.map { HomePresentation.dashboard($0).delivered } ?? []
        }
        let urls = PullRequestFacts.urls(in: HomeParity.snapshot)
        #expect(urls.count == 2)
        // AC-4 : aucun fait reçu ⇒ « PR créée », jamais « PR ouverte ».
        #expect(delivered([]).map { ConsoleStatus.of(card: $0).text } == ["PR créée", "PR créée"])
        // AC-1 / AC-3 : fusionnée hier et ouverte.
        let merged = PullRequestFact(url: urls[0], state: .merged, closedAtMs: nowMs - dayMs)
        let open = PullRequestFact(url: urls[1], state: .open, closedAtMs: nil)
        let fresh = delivered([merged, open])
        #expect(Set(fresh.map { ConsoleStatus.of(card: $0).text }) == ["PR fusionnée", "PR ouverte"])
        // AC-8 : fusionnée il y a 8 jours ⇒ hors de « Livrées récemment ».
        let old = PullRequestFact(url: urls[0], state: .merged, closedAtMs: nowMs - 8 * dayMs)
        #expect(delivered([old, open]).map(\.prUrl) == [urls[1]])
    }

    // MARK: - AC-14 : le lien « Tout afficher »

    @Test("ios-accueil/AC-14 : le lien Tout afficher sélectionne la section Pipelines")
    func allPipelinesSection() {
        #expect(IOSHomeContent.allPipelinesSection == .kanban)
    }

    // MARK: - AC-12 : le bandeau de préparation

    @Test("ios-accueil/AC-12 : le bandeau de préparation vient du Mac, jamais inventé")
    func setupBanner() {
        #expect(IOSHomeContent.setupBanner(components: nil) == nil)
        let components = RemoteComponentsPayload(ompInstalled: true, ompPath: nil, setupBanner: "Préparation en cours…")
        #expect(IOSHomeContent.setupBanner(components: components) == "Préparation en cours…")
    }

    // MARK: - AC-16 : OMP absent sur le Mac

    @Test("ios-accueil/AC-16 : OMP absent n'est conclu que sur réponse du Mac")
    func macMissingRequiresComponents() {
        #expect(
            IOSHomeState.resolve(state: .connected(endpoint: Self.endpoint), board: Self.board, omp: .missing)
                == .macMissingOMP
        )
        // La priorité de `.ompMissing` sur `.loading` (parité HomePresentation).
        #expect(
            IOSHomeState.resolve(state: .connected(endpoint: Self.endpoint), board: .loading, omp: .missing)
                == .macMissingOMP
        )
        // OMP disponible + magasin vide ⇒ premiers pas, jamais « OMP absent ».
        #expect(
            IOSHomeState.resolve(state: .connected(endpoint: Self.endpoint), board: .storeEmpty(dir: "/tmp"), omp: Self.ompAvailable)
                == .firstRun
        )
    }

    // MARK: - AC-17 : le chargement

    @Test("ios-accueil/AC-17 : avant le premier instantané, l'Accueil est en chargement")
    func loadingBeforeFirstSnapshot() {
        #expect(
            IOSHomeState.resolve(state: .connected(endpoint: Self.endpoint), board: .loading, omp: Self.ompAvailable)
                == .loading
        )
        // Le crochet de recette force un état depuis la fixture partagée.
        if case .dashboard(let dashboard) = IOSHomeRecipe.dashboard.homeState {
            #expect(dashboard.attention.count == 5)
        } else {
            Issue.record("la recette .dashboard ne rend pas de tableau de bord")
        }
        #expect(IOSHomeRecipe.loading.homeState == .loading)
        #expect(IOSHomeRecipe.firstRun.homeState == .firstRun)
        #expect(IOSHomeRecipe.ompMissing.homeState == .macMissingOMP)
        #expect(IOSHomeRecipe.resolve(["-home.recipe", "degraded"]) == .degraded)
        #expect(IOSHomeRecipe.resolve(["-section", "home"]) == nil)
    }

    // MARK: - AC-2 : le suivi du direct

    @Test("ios-accueil/AC-2 : l'état suit l'ardoise publiée sans geste de l'utilisateur")
    func liveUpdates() {
        let connected = ClientState.connected(endpoint: Self.endpoint)
        #expect(IOSHomeState.resolve(state: connected, board: .loading, omp: Self.ompAvailable) == .loading)
        let arrived = IOSHomeState.resolve(state: connected, board: Self.board, omp: Self.ompAvailable)
        #expect(arrived != .loading)
        if case .dashboard(let dashboard) = arrived {
            #expect(dashboard.attention.count == 5)
        } else {
            Issue.record("l'arrivée de l'instantané ne produit pas de tableau de bord")
        }
    }

    // MARK: - AC-15 : aucun bandeau de notifications

    @Test("ios-accueil/AC-15 : aucune source de l'app ne nomme le bandeau de notifications")
    func noNotificationsBanner() throws {
        let base = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("OMPConsoleIOS")
        let names = [
            "RootView.swift",
            "HomeView.swift",
            "IOSHomeState.swift",
            "IOSHomeContent.swift",
            "IOSHomeText.swift",
            "IOSHomeRecipe.swift",
            "HomeAnswerSheet.swift",
            "HomeContractSheet.swift",
            "HomeWelcomeSheet.swift",
            "IOSSection.swift",
            "IOSSectionContent.swift",
            "IOSSectionView.swift",
            "IOSScreenState.swift",
            "IOSText.swift",
            "ConnectionSheet.swift",
            "ConnectionText.swift",
            "OMPConsoleIOSApp.swift",
        ]
        let forbidden = [
            "notificationsBanner",
            "notificationsDenied",
            "HomeText.openSettings",
            "HomeText.ignore",
            "UNUserNotificationCenter",
            "requestAuthorization",
        ]
        var read = 0
        for name in names {
            let file = base.appendingPathComponent(name)
            guard let text = try? String(contentsOf: file, encoding: .utf8) else { continue }
            read += 1
            for token in forbidden {
                #expect(!text.contains(token), "\(name) nomme \(token)")
            }
        }
        #expect(read == names.count, "toutes les sources de l'app ont été relues")
    }

    // MARK: - Outils

    /// Un `RemoteContractPayload` décodé d'un JSON construit (le type n'a pas
    /// d'`init` public).
    private static func payload(state: String, content: String?, reason: String? = nil) throws -> RemoteContractPayload {
        var document: [String: Any] = ["name": "contract.md", "state": state]
        if let content { document["content"] = content }
        if let reason { document["reason"] = reason }
        let data = try JSONSerialization.data(withJSONObject: ["document": document])
        return try JSONDecoder().decode(RemoteContractPayload.self, from: data)
    }
}
