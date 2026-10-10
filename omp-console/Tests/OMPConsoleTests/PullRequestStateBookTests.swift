// Le registre des faits de PR du Mac et sa publication à l'ardoise (S-5 de
// pipelines-livrees-statut-pr-faux-et-doub, lot BR-2).
//
// Le registre est exercé avec un lecteur SCRIPTÉ (`ScriptedPullRequestStateReader`,
// ProjectFixtures.swift) ; le modèle de l'ardoise, sur un magasin de fixtures
// réel, avec ce même lecteur ou avec le `gh` doublure sur disque (`GhStub`)
// résolu par `OMP_CONSOLE_GH_BINARY`. Aucun test ne lance le `gh` du poste.

import ConsoleCore
import Foundation
import Testing
@testable import OMPConsole

private let urlA = "https://github.com/proprietaire/depot/pull/1"
private let urlB = "https://github.com/proprietaire/depot/pull/2"
private let urlC = "https://github.com/proprietaire/depot/pull/3"

/// L'instant FIXE du magasin.
private let bookNow: Double = 1_800_000_000_000
private let dayMs: Double = 86_400_000
private let bookRepo = "/tmp/pr-states/mem0-omp"

private func fact(_ url: String, _ state: PullRequestState, _ closedAtMs: Double? = nil) -> PullRequestFact {
    PullRequestFact(url: url, state: state, closedAtMs: closedAtMs)
}

/// Attend la fin de la relecture en cours.
@MainActor
private func settled(_ book: PullRequestStateBook) async -> Bool {
    await awaitMainTrue(timeout: 5) { !book.refreshing }
}

// MARK: - Registre

@MainActor
@Suite("Registre des faits de PR")
struct PullRequestStateBookTests {
    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : au lancement, chaque URL observée est lue une fois et son fait publié")
    func launchReadsEveryURL() async {
        let reader = ScriptedPullRequestStateReader()
        reader.script(urlA, .merged, closedAtMs: 10)
        reader.script(urlB, .closed, closedAtMs: 20)
        reader.script(urlC, .open)
        let book = PullRequestStateBook(reader: reader)

        book.observe(urls: [urlA, urlB, urlC])
        #expect(book.refreshing, "la relecture est en cours dès l'observation")
        #expect(await settled(book))

        #expect(book.facts == [
            urlA: fact(urlA, .merged, 10),
            urlB: fact(urlB, .closed, 20),
            urlC: fact(urlC, .open),
        ])
        #expect([urlA, urlB, urlC].map(reader.readCount) == [1, 1, 1])
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : une URL nouvelle est lue une seule fois, les URLs déjà tentées ne sont pas relues")
    func newURLIsReadOnce() async {
        let reader = ScriptedPullRequestStateReader()
        reader.script(urlA, .open)
        reader.script(urlB, .merged, closedAtMs: 5)
        let book = PullRequestStateBook(reader: reader)

        book.observe(urls: [urlA])
        #expect(await settled(book))
        book.observe(urls: [urlA, urlB])
        #expect(await settled(book))
        book.observe(urls: [urlA, urlB])
        #expect(!book.refreshing, "aucune URL nouvelle : aucune relecture")

        #expect(reader.readCount(urlA) == 1)
        #expect(reader.readCount(urlB) == 1)
        #expect(book.facts[urlB] == fact(urlB, .merged, 5))
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : une URL vue PENDANT une relecture est lue à sa fin, sous la même bascule de relecture")
    func newURLDuringReadIsChained() async {
        let reader = ScriptedPullRequestStateReader(delay: .milliseconds(150))
        reader.script(urlA, .open)
        reader.script(urlB, .open)
        let book = PullRequestStateBook(reader: reader)

        book.observe(urls: [urlA])
        book.observe(urls: [urlA, urlB])
        #expect(book.refreshing)
        #expect(await awaitMainTrue(timeout: 5) { book.facts[urlA] != nil })
        #expect(book.refreshing, "B reste à lire : la relecture continue")
        #expect(await settled(book))

        #expect(book.facts.keys.sorted() == [urlA, urlB])
        #expect(reader.readCount(urlA) == 1)
        #expect(reader.readCount(urlB) == 1)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-5 : le rafraîchissement relit tout sauf les PR fusionnées, et un échec retire le fait")
    func refreshSkipsMergedAndDropsFailures() async {
        let reader = ScriptedPullRequestStateReader()
        reader.script(urlA, [
            .success(fact(urlA, .open)),
            .success(fact(urlA, .merged, 42)),
        ])
        reader.script(urlB, .merged, closedAtMs: 7)
        reader.script(urlC, [
            .success(fact(urlC, .open)),
            .failure(.commandFailed(command: "pr view", code: 1, detail: "hors ligne")),
        ])
        let book = PullRequestStateBook(reader: reader)
        book.observe(urls: [urlA, urlB, urlC])
        #expect(await settled(book))
        #expect(book.facts[urlA]?.state == .open)

        book.refresh()
        #expect(book.refreshing)
        #expect(await settled(book))

        #expect(book.facts[urlA] == fact(urlA, .merged, 42), "la PR fusionnée depuis est relue")
        #expect(reader.readCount(urlB) == 1, "une PR MERGED n'est jamais relue (état terminal)")
        #expect(book.facts[urlB] == fact(urlB, .merged, 7))
        #expect(book.facts[urlC] == nil, "un échec ramène l'état inconnu, jamais l'ancien fait")
        #expect(reader.readCount(urlC) == 2)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-5 : une demande pendant une relecture n'en lance pas une seconde, et les faits sont publiés en une fois")
    func noDoubleRefreshAndSinglePublication() async {
        let reader = ScriptedPullRequestStateReader()
        reader.script(urlA, .open)
        reader.script(urlB, .open)
        let book = PullRequestStateBook(reader: reader)
        book.observe(urls: [urlA, urlB])
        #expect(await settled(book))

        reader.script(urlA, .merged, closedAtMs: 1)
        reader.script(urlB, .closed, closedAtMs: 2)
        reader.delay = .milliseconds(200)
        var publications = 0
        let watch = book.$facts.dropFirst().sink { _ in publications += 1 }
        defer { watch.cancel() }

        book.refresh()
        book.refresh()
        book.refresh()
        #expect(await awaitMainTrue(timeout: 5) { reader.completed == 4 })
        #expect(await settled(book))

        #expect(reader.readCount(urlA) == 2)
        #expect(reader.readCount(urlB) == 2)
        #expect(publications == 1, "une relecture publie ses faits en UNE affectation")
        #expect(book.facts[urlA]?.state == .merged)
        #expect(book.facts[urlB]?.state == .closed)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-1 : au plus quatre lectures gh simultanées")
    func readsAreBoundedToFour() async {
        let reader = ScriptedPullRequestStateReader(delay: .milliseconds(100))
        let urls = (1...10).map { "https://github.com/proprietaire/depot/pull/\($0)" }
        for url in urls { reader.script(url, .open) }
        let book = PullRequestStateBook(reader: reader)

        book.observe(urls: urls)
        #expect(await settled(book))

        #expect(reader.maxInFlight == 4)
        #expect(book.facts.count == 10)
        #expect(reader.totalReads == 10)
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : sans gh, aucune lecture, aucun fait, aucune relecture affichée")
    func missingReaderReadsNothing() {
        let book = PullRequestStateBook(reader: nil)
        book.observe(urls: [urlA, urlB])
        book.refresh()
        #expect(!book.refreshing)
        #expect(book.facts.isEmpty)
    }
}

// MARK: - Ardoise du Mac

/// Un magasin portant UNE feature de lot terminée à `endedAt`, livrée par `url`.
private func deliveredStore(url: String, endedAt: Double) -> StoreFixture {
    let fixture = StoreFixture()
    let repoKey = KanbanRepoKey.key(forRoot: bookRepo)
    fixture.publish(.lots, "\(repoKey).json", object: lotObject(id: repoKey, repoRoot: bookRepo, features: [
        lotFeatureObject(slug: "livree", state: "done", phase: "release", prUrl: url, endedAt: endedAt),
    ]))
    return fixture
}

private let deliveredID = "feature:\(KanbanRepoKey.key(forRoot: bookRepo)):livree"

@MainActor
private func deliveredModel(_ fixture: StoreFixture, book: PullRequestStateBook) -> KanbanModel {
    KanbanModel(hub: StoreHub(stateDir: fixture.root, nowMs: { bookNow }), prStates: book)
}

@MainActor
@Suite("Faits de PR sur l'ardoise du Mac")
struct KanbanPullRequestFactsTests {
    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-5 : Mac — une carte « PR ouverte » passe à « PR fusionnée » au rafraîchissement manuel")
    func refreshTurnsOpenIntoMerged() async {
        let fixture = deliveredStore(url: urlA, endedAt: bookNow - 21 * dayMs)
        let reader = ScriptedPullRequestStateReader()
        reader.script(urlA, .open)
        let model = deliveredModel(fixture, book: PullRequestStateBook(reader: reader))
        defer { model.stop() }
        model.start()

        #expect(await awaitMainTrue(timeout: 5) { model.state.card(deliveredID)?.column == .prOuverte })
        #expect(model.state.card(deliveredID).map { ConsoleStatus.of(card: $0).text } == "PR ouverte")

        // La PR est fusionnée sur GitHub (hier) ; l'utilisateur rafraîchit.
        reader.script(urlA, .merged, closedAtMs: bookNow - dayMs)
        reader.delay = .milliseconds(100)
        model.refreshPullRequestStates()
        #expect(model.prRefreshing, "la relecture est visible le temps qu'elle dure")
        #expect(await awaitMainTrue(timeout: 5) { model.state.card(deliveredID)?.column == .fusionne })
        #expect(model.state.card(deliveredID).map { ConsoleStatus.of(card: $0).text } == "PR fusionnée")
        #expect(await awaitMainTrue(timeout: 5) { !model.prRefreshing })
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-12 : Mac — une carte « PR créée » de plus de 7 jours disparaît quand le rafraîchissement révèle une fusion vieille de 10 jours")
    func refreshRemovesOldMergedCard() async {
        let fixture = deliveredStore(url: urlA, endedAt: bookNow - 30 * dayMs)
        let reader = ScriptedPullRequestStateReader()
        reader.fail(urlA)
        let model = deliveredModel(fixture, book: PullRequestStateBook(reader: reader))
        defer { model.stop() }
        model.start()

        #expect(await awaitMainTrue(timeout: 5) { reader.completed == 1 && !model.prRefreshing })
        #expect(model.state.card(deliveredID)?.column == .prCreee, "état illisible : « PR créée », gardée malgré l'âge")

        reader.script(urlA, .merged, closedAtMs: bookNow - 10 * dayMs)
        model.refreshPullRequestStates()
        #expect(await awaitMainTrue(timeout: 5) { model.state.card(deliveredID) == nil })
    }

    @Test(
        "pipelines-livrees-statut-pr-faux-et-doub/AC-1 : Mac — au lancement, le gh résolu lit l'état réel et la carte porte son libellé",
        arguments: [
            (#"{"closedAt":"2027-01-14T08:00:00Z","mergedAt":"2027-01-14T08:00:00Z","state":"MERGED"}"#, "PR fusionnée"),
            (#"{"closedAt":"2027-01-14T08:00:00Z","mergedAt":null,"state":"CLOSED"}"#, "PR fermée"),
            (#"{"closedAt":null,"mergedAt":null,"state":"OPEN"}"#, "PR ouverte"),
        ]
    )
    func launchReadsThroughResolvedGh(stdout: String, label: String) async throws {
        // 2027-01-14T08:00:00Z est la veille de `bookNow` (2027-01-15T08:00:00Z).
        let stub = try GhStub(viewJSON: nil, checksJSON: nil, stateJSON: stdout)
        let fixture = deliveredStore(url: urlA, endedAt: bookNow - 21 * dayMs)
        let model = KanbanModel(
            hub: StoreHub(stateDir: fixture.root, nowMs: { bookNow }),
            environment: [GhBinary.overrideKey: stub.script.path]
        )
        defer { model.stop() }
        model.start()

        #expect(await awaitMainTrue(timeout: 10) {
            model.state.card(deliveredID).map { ConsoleStatus.of(card: $0).text } == label
        })
        #expect(stub.logged() == ["pr", "view", "--json", "state,mergedAt,closedAt", "--", urlA])
    }

    @Test("pipelines-livrees-statut-pr-faux-et-doub/AC-4 : Mac — gh introuvable, la carte porte « PR créée » et aucune relecture ne s'affiche")
    func missingGhKeepsCreated() async {
        let fixture = deliveredStore(url: urlA, endedAt: bookNow - 2 * dayMs)
        let model = KanbanModel(
            hub: StoreHub(stateDir: fixture.root, nowMs: { bookNow }),
            environment: [GhBinary.overrideKey: "/nonexistent/gh"]
        )
        defer { model.stop() }
        model.start()

        #expect(await awaitMainTrue(timeout: 5) { model.state.card(deliveredID) != nil })
        #expect(model.state.card(deliveredID).map { ConsoleStatus.of(card: $0).text } == "PR créée")
        model.refreshPullRequestStates()
        #expect(!model.prRefreshing)
        #expect(model.pullRequestStatesPayload() == RemotePullRequestStatesPayload(facts: [], refreshing: false))
    }
}
