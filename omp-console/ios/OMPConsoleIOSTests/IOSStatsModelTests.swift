// Les preuves Swift du modèle et du contenu de la section Statistiques (BR-4) : le
// contenu PUR (cartes, total, mention, état vide), la surface de chaque état, les
// quatre déclencheurs de relevé et l'avancement des durées.

@testable import OMPConsoleIOS
import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@MainActor
@Suite("ios-statistiques — le modèle de la section Statistiques")
struct IOSStatsModelTests {
    private let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)
    private let connected = ClientState.connected(endpoint: ClientEndpoint.manual(host: "127.0.0.1", port: 8787))

    private func feature(
        slug: String,
        input: Int = 0,
        output: Int = 0,
        cacheRead: Int? = nil,
        cacheWrite: Int? = nil,
        turns: Int = 0,
        durationMs: Double,
        liveRuns: Int = 0,
        model: String? = nil
    ) -> RemoteStatsFeature {
        RemoteStatsFeature(
            slug: slug,
            input: input,
            output: output,
            cacheRead: cacheRead,
            cacheWrite: cacheWrite,
            turns: turns,
            durationMs: durationMs,
            liveRuns: liveRuns,
            model: model
        )
    }

    private func payload(
        projectKey: String? = "k",
        features: [RemoteStatsFeature],
        projects: [RemoteStatsProject] = [RemoteStatsProject(key: "k", label: "depot")],
        hiddenPlanFeatures: Int = 0
    ) -> RemoteStatsPayload {
        RemoteStatsPayload(
            projectKey: projectKey,
            project: projectKey == nil ? "" : "depot",
            projects: projects,
            features: features,
            hiddenPlanFeatures: hiddenPlanFeatures
        )
    }

    private func makeModel(
        state: @escaping @MainActor () -> ClientState,
        load: @escaping IOSStatsModel.Load,
        nowMs: @escaping @Sendable () -> Double = { 0 }
    ) -> IOSStatsModel {
        IOSStatsModel(load: load, state: state, nowMs: nowMs)
    }

    private func eventually(_ condition: @MainActor () -> Bool) async -> Bool {
        for _ in 0..<400 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(5))
        }
        return condition()
    }

    // MARK: - Contenu pur

    @Test("ios-statistiques/AC-1 : une carte par feature porte modèle, durée, tours et tokens entrants/sortants")
    func statsCardsSumTheListedFeatures() {
        let f = feature(
            slug: "f1",
            input: 200,
            output: 40,
            turns: 2,
            durationMs: 1_500,
            liveRuns: 1,
            model: "opencode-go/deepseek-v4.1-flash"
        )
        let card = IOSStatsContent.featureCard(f, elapsedMs: 0)
        #expect(card.title == "f1")
        #expect(card.lines.map(\.label) == [
            StatsPresentation.columnModel,
            StatsPresentation.timeSpent,
            StatsPresentation.turns,
            StatsPresentation.sentTokens,
            StatsPresentation.receivedTokens,
        ])
        #expect(card.lines[0].value == "opencode-go/deepseek-v4.1-flash")
        #expect(card.lines[1].value == ConsoleFormat.duration(ms: 1_500))
        #expect(card.lines[2].value == "2")
        #expect(card.lines[3].value == ConsoleFormat.tokens(200))
        #expect(card.lines[4].value == ConsoleFormat.tokens(40))

        // Le modèle absent se dit d'un tiret, jamais d'une chaîne vide.
        #expect(IOSStatsContent.featureCard(feature(slug: "f2", durationMs: 0), elapsedMs: 0).lines[0].value == IOSStatsContent.noModel)

        // Une carte par feature, dans l'ordre servi, chacune identifiée par son slug.
        let order = IOSStatsContent.cards(
            payload(features: [feature(slug: "a", durationMs: 0), feature(slug: "b", durationMs: 0)]),
            elapsedMs: 0
        )
        #expect(order.map(\.title) == ["a", "b"])
        #expect(StatsAccessibility.feature("a") == "ios.stats.feature.a")
        #expect(StatsAccessibility.total == "ios.stats.total")
    }

    @Test("ios-stats-tokens-envoyes-incoherent/AC-1, AC-2, AC-3 : « Tokens envoyés » compte l'entrée, le cache lu et le cache écrit")
    func statsSentTokensCountTheCache() {
        let cached = feature(
            slug: "f", input: 76, output: 40_233, cacheRead: 33_206, cacheWrite: 15_936, durationMs: 0
        )
        let bare = feature(slug: "g", input: 5, durationMs: 0)

        // AC-1 : la carte vaut I + R + W, non I seul ; « Tokens reçus » reste la sortie.
        let card = IOSStatsContent.featureCard(cached, elapsedMs: 0)
        #expect(card.lines[3].label == StatsPresentation.sentTokens)
        #expect(card.lines[3].value == ConsoleFormat.tokens(49_218))
        #expect(card.lines[3].value != ConsoleFormat.tokens(76))
        #expect(card.lines[4].value == ConsoleFormat.tokens(40_233))

        // AC-2 : le total somme les valeurs entières des features listées.
        let total = IOSStatsContent.totalCard(payload(features: [cached, bare]), elapsedMs: 0)
        #expect(total.lines[2].label == StatsPresentation.sentTokens)
        #expect(total.lines[2].value == ConsoleFormat.tokens(49_223))

        // AC-3 : sans cache (Mac ancien), l'entrée seule, jamais une valeur vide.
        let plain = IOSStatsContent.featureCard(bare, elapsedMs: 0)
        #expect(plain.lines[3].value == ConsoleFormat.tokens(5))
        #expect(!plain.lines[3].value.isEmpty)
    }

    @Test("ios-statistiques/AC-3 : la ligne de total somme les features listées, rien d'autre")
    func statsTotalSumsOnlyListedFeatures() {
        let p = payload(
            features: [
                feature(slug: "a", input: 100, output: 20, turns: 2, durationMs: 1_000, liveRuns: 1),
                feature(slug: "b", input: 5, output: 1, turns: 1, durationMs: 500),
            ],
            hiddenPlanFeatures: 3
        )
        let total = IOSStatsContent.totalCard(p, elapsedMs: 0)
        #expect(total.title == IOSStatsText.total)
        #expect(total.lines.map(\.label) == [
            StatsPresentation.timeSpent,
            StatsPresentation.turns,
            StatsPresentation.sentTokens,
            StatsPresentation.receivedTokens,
        ])
        #expect(total.lines[0].value == ConsoleFormat.duration(ms: 1_500))
        #expect(total.lines[1].value == "3")
        #expect(total.lines[2].value == ConsoleFormat.tokens(105))
        #expect(total.lines[3].value == ConsoleFormat.tokens(21))

        // Le compte des features masquées n'entre dans AUCUN total, il porte la
        // mention mot pour mot celle de macOS.
        #expect(IOSStatsContent.hiddenMention(p) == StatsPresentation.hidden(3))
        #expect(IOSStatsContent.hiddenMention(payload(features: [feature(slug: "a", durationMs: 0)])) == nil)

        // L'état vide est le mot partagé, et la mention apparaît AUSSI à vide.
        let empty = payload(features: [], hiddenPlanFeatures: 2)
        #expect(IOSStatsContent.emptyMessage(empty) == StatsPresentation.empty)
        #expect(IOSStatsContent.emptyMessage(p) == nil)
        #expect(IOSStatsContent.hiddenMention(empty) == StatsPresentation.hidden(2))
    }

    @Test("ios-statistiques/AC-6 : la durée d'une feature avance à l'horloge de rendu, au rythme de ses runs vivants")
    func statsDurationsAdvanceWithLiveRuns() async {
        let live = feature(slug: "f", durationMs: 1_000, liveRuns: 2)
        let atReceipt = IOSStatsContent.featureCard(live, elapsedMs: 0)
        let later = IOSStatsContent.featureCard(live, elapsedMs: 5_000)
        #expect(atReceipt.lines[1].value == ConsoleFormat.duration(ms: 1_000))
        #expect(later.lines[1].value == ConsoleFormat.duration(ms: 1_000 + 2 * 5_000))
        // Les tokens et les tours ne bougent pas localement.
        #expect(later.lines[2].value == atReceipt.lines[2].value)
        #expect(later.lines[3].value == atReceipt.lines[3].value)

        // L'instant de référence est celui de la RÉCEPTION du relevé.
        let model = makeModel(state: { self.connected }, load: { _ in self.payload(features: [live]) }, nowMs: { 10_000 })
        model.reload(trigger: .appeared)
        #expect(await eventually { model.payload != nil })
        #expect(model.receivedAtMs == 10_000)
        #expect(model.elapsedMs(at: 10_000) == 0)
        #expect(model.elapsedMs(at: 15_000) == 5_000)
        // Un instant antérieur ne fait jamais reculer la durée.
        #expect(model.elapsedMs(at: 9_000) == 0)
    }

    // MARK: - Surface et déclencheurs

    @Test("ios-statistiques/AC-1 : chaque état de la section a sa surface, dans l'ordre de priorité")
    func statsSurfacesCoverEveryState() {
        let board = payload(features: [feature(slug: "a", durationMs: 0)])
        // Hors `.connected` : dégradé, portant le mot de ConnectionText.
        for state in [
            ClientState.unpaired,
            .searching,
            .connecting(endpoint: endpoint),
            .noNetwork,
            .macAbsent(endpoint: endpoint),
            .revoked,
            .incompatibleProtocol(local: 3, remote: 2),
        ] {
            #expect(IOSStatsModel.surface(state: state, payload: board, failure: nil) == .degraded(ConnectionText.state(state)))
        }
        // Connecté : chargement, erreur, aucun projet, vide, tableau.
        #expect(IOSStatsModel.surface(state: connected, payload: nil, failure: nil) == .loading)
        #expect(IOSStatsModel.surface(state: connected, payload: nil, failure: "relevé refusé") == .error("relevé refusé"))
        #expect(IOSStatsModel.surface(state: connected, payload: payload(projectKey: nil, features: [], projects: []), failure: nil) == .noProject)
        #expect(IOSStatsModel.surface(state: connected, payload: payload(features: []), failure: nil) == .empty)
        #expect(IOSStatsModel.surface(state: connected, payload: board, failure: nil) == .board)
    }

    @Test("ios-statistiques/AC-6 : les quatre déclencheurs relancent un relevé, jamais hors `.connected`")
    func statsReloadsOnlyWhenConnected() async {
        // Les quatre sources : apparition, changement de projet, nouvel état du
        // magasin, mise à jour de session.
        let on = makeModel(state: { self.connected }, load: { _ in self.payload(features: []) })
        for trigger in [StatsTrigger.appeared, .projectChanged, .boardChanged, .sessionsChanged] {
            on.reload(trigger: trigger)
        }
        #expect(on.loadCount == 4)

        // Hors `.connected` : aucune requête n'est émise.
        for state in [ClientState.unpaired, .macAbsent(endpoint: endpoint), .revoked] {
            let off = makeModel(state: { state }, load: { _ in self.payload(features: []) })
            for trigger in [StatsTrigger.appeared, .projectChanged, .boardChanged, .sessionsChanged] {
                off.reload(trigger: trigger)
            }
            #expect(off.loadCount == 0)
            #expect(!IOSStatsModel.reloads(.boardChanged, state: state))
        }

        // Le choix de l'utilisateur porte la clé CHOISIE au relevé suivant (S-3).
        var keys: [String?] = []
        let model = makeModel(state: { self.connected }, load: { key in
            keys.append(key)
            return self.payload(projectKey: "k2", features: [], projects: [RemoteStatsProject(key: "k2", label: "autre")])
        })
        model.select(project: "k2")
        #expect(await eventually { keys.count == 1 })
        #expect(keys == ["k2"])
        // Le relevé suivant part de la clé SERVIE (le Mac fait foi).
        #expect(await eventually { model.selectedKey == "k2" })
        model.reload(trigger: .appeared)
        #expect(await eventually { keys.count == 2 })
        #expect(keys == ["k2", "k2"])

        // Une erreur rend la main à l'état d'erreur, avec le message TRADUIT (S-5).
        let failing = makeModel(state: { self.connected }, load: { _ in throw ClientError.notConnected })
        failing.reload(trigger: .appeared)
        #expect(await eventually { failing.failure != nil })
        #expect(failing.surface == .error(IOSMacErrorText.message(for: .macUnreachable)))
    }

    // MARK: - Erreurs du Mac (ios-erreurs-serveur-lisibles)

    /// Le prédicat « lisible » : ni adresse, ni JSON, ni code HTTP à trois chiffres.
    private func isReadable(_ text: String) -> Bool {
        let forbidden = ["localhost", "://", "{", "\"detail\""]
        guard !forbidden.contains(where: text.contains) else { return false }
        return text.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
    }

    /// Le 503 que rend le Mac quand mem0-http répond 405 : l'adresse et le JSON amont sont
    /// dans le message. La réponse passe par la vraie traduction du client.
    private func relayed503() -> ClientError {
        let detail = MemoryText.unavailableDetail(
            address: "localhost:8321",
            error: "réponse 405 du service ({\"detail\":\"Method Not Allowed\"})"
        )
        let body = (try? JSONSerialization.data(
            withJSONObject: ["error": ["code": "unavailable", "message": detail]]
        )) ?? Data()
        return ClientErrorMapping.translate(status: 503, protocolVersion: 1, body: body)
    }

    @Test("ios-erreurs-serveur-lisibles/AC-8 : statsShowsTranslatedFailure — le 503 relayé s'affiche en « service indisponible », sans URL ni JSON")
    func statsShowsTranslatedFailure() async {
        let error = relayed503()
        let model = makeModel(state: { self.connected }, load: { _ in throw error })
        model.reload(trigger: .appeared)
        #expect(await eventually { model.failure != nil })
        let expected = IOSMacErrorText.message(for: .serviceUnavailable)
        #expect(model.surface == .error(expected))
        #expect(isReadable(expected))
        #expect(expected.contains("Service indisponible sur le Mac"))
    }

    @Test("ios-erreurs-serveur-lisibles/AC-7 : statsRetryShowsBoard — après un échec, le relevé relancé affiche le tableau")
    func statsRetryShowsBoard() async {
        let error = relayed503()
        var succeed = false
        let model = makeModel(state: { self.connected }, load: { _ in
            if !succeed { throw error }
            return self.payload(features: [self.feature(slug: "a", durationMs: 1)])
        })
        model.reload(trigger: .appeared)
        #expect(await eventually { model.failure != nil })
        #expect(model.surface == .error(IOSMacErrorText.message(for: .serviceUnavailable)))

        // Réessayer relance le même relevé (`reload(trigger: .appeared)`).
        succeed = true
        model.reload(trigger: .appeared)
        #expect(await eventually { model.payload != nil })
        #expect(model.failure == nil)
        #expect(model.surface == .board)
    }

    @Test("ios-erreurs-serveur-lisibles/AC-5 : statsUnauthorizedShowsNoError — un 401 ne pose aucun message ; la surface suit l'état du client")
    func statsUnauthorizedShowsNoError() async {
        var current = connected
        let model = makeModel(state: { current }, load: { _ in throw ClientError.api(.unauthorized) })
        model.reload(trigger: .appeared)
        // Le relevé a échoué, puis `reload` a laissé `failure` à nil.
        try? await Task.sleep(for: .milliseconds(50))
        #expect(model.failure == nil)
        #expect(model.surface == .loading)

        // Le client révoqué : la surface passe par l'état de connexion, jamais par `.error`.
        current = .revoked
        #expect(model.failure == nil)
        #expect(model.surface == .degraded(ConnectionText.state(.revoked)))
    }
}
