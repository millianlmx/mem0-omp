// Les preuves Swift des sessions iOS (BR-4, BR-6) : la moitié iOS de la parité
// (la charge utile figée de `SessionParity` → `IOSSessionThreadFacts.rows`), la
// liste et son filtre, les plis, les diffs, la question `ask`, le suivi direct,
// les états d'un fichier illisible ou tronqué, et la réutilisation du fil hors de
// la section Sessions.
//
// Chaque test PORTE l'id d'acceptation qu'il prouve. Les faits pinnés sont les
// MÊMES que ceux de `Tests/OMPConsoleTests/SessionParityTests.swift` côté macOS :
// c'est ce qui rend la parité vérifiable, et non lue.
//
// Le fichier ne nomme aucun type du magasin (jeton interdit des sources iOS) :
// il construit ses listes par `SessionList`/`RunChoice`, et lit la fixture par le
// miroir client.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

/// Une source de test : elle compte ses lectures et sert la charge utile donnée.
/// C'est ce qui permet de prouver « une lecture pour N ajouts » sans socket.
@MainActor
private final class SessionStubSource: IOSSessionSource {
    var payload: RemoteSessionPayload
    var run: RunChoice?
    var failure: Error?
    private(set) var readCount = 0
    private let stream: AsyncStream<RemoteSessionFeedItem>

    init(payload: RemoteSessionPayload, run: RunChoice? = nil) {
        self.payload = payload
        self.run = run
        self.failure = nil
        self.stream = AsyncStream { $0.finish() }
    }

    func read(file: String) async throws -> RemoteSessionPayload {
        readCount += 1
        if let failure { throw failure }
        return payload
    }

    func feed(forFile file: String) -> AsyncStream<RemoteSessionFeedItem> { stream }

    func run(forFile file: String) -> RunChoice? { run }
}

@MainActor
@Suite("ios-sessions — la liste, le fil et le suivi")
struct IOSSessionTests {
    // MARK: - Outillage

    private static let endpoint = ClientEndpoint.manual(host: "127.0.0.1", port: 8787)

    /// Une horloge FIXE : la parité et le groupement ne dépendent jamais de l'heure.
    private static let nowMs: Double = 1_700_000_000_000

    private static let dayMs: Double = 86_400_000

    private static var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar
    }

    /// La charge utile figée, décodée par le miroir client.
    private static func payload() throws -> RemoteSessionPayload {
        try JSONDecoder().decode(RemoteSessionPayload.self, from: Data(SessionParity.payloadJSON.utf8))
    }

    /// Une entrée de transport fabriquée pour un ajout du flux.
    private static func wireEntry(index: Int, offset: Int, kind: String, text: String) throws -> RemoteConversationEntry {
        let json = """
        {"index":\(index),"kind":"\(kind)","offset":\(offset),"text":"\(text)","timestampMs":1790762400000}
        """
        return try JSONDecoder().decode(RemoteConversationEntry.self, from: Data(json.utf8))
    }

    private static func choice(id: String, repo: String, startedAtMs: Double, state: RunChoiceState) -> RunChoice {
        let sessionFile = "/sessions/" + id + ".jsonl"
        return RunChoice(
            id: sessionFile,
            sessionFile: sessionFile,
            label: repo + "/" + id,
            repo: repo,
            featureTitle: id,
            startedAtMs: startedAtMs,
            phase: .impl,
            state: state,
            isStale: false,
            target: ViewerTarget(
                sessionFile: sessionFile,
                title: id,
                subtitle: RunChoice.subtitle(phase: .impl, repo: repo)
            )
        )
    }

    private static func toolCall(_ rows: [SessionRow], _ callId: String) -> ToolCallRow? {
        for row in rows {
            if case .toolCall(let call) = row.kind, call.callId == callId { return call }
        }
        return nil
    }

    private static func toolResults(_ rows: [SessionRow]) -> [ToolResultRow] {
        rows.compactMap {
            if case .toolResult(let result) = $0.kind { return result } else { return nil }
        }
    }

    /// Les lignes PINNÉES de la session de référence — exactement celles que
    /// `SessionParityTests` épingle côté macOS (dix lignes : le doublon du texte
    /// de l'agent n'en produit aucune).
    private static var pinnedRows: [SessionRow] {
        [
            SessionRow(id: "r120", kind: .user(UserRow(text: "Bonjour, corrige le fichier src/app.swift"))),
            SessionRow(
                id: "r310",
                kind: .assistant(
                    AssistantRow(
                        text: "je lis le fichier puis je propose un plan",
                        thinking: "je réfléchis à la correction à appliquer"
                    )
                )
            ),
            SessionRow(
                id: "r310.c0",
                kind: .toolCall(
                    ToolCallRow(
                        callId: "call-read",
                        name: "read",
                        target: "src/app.swift",
                        argumentsJSON: #"{"i":"lire le fichier","offset":2,"path":"/tmp/omp-parity/src/app.swift"}"#,
                        result: ToolResultRow(
                            callId: "call-read",
                            name: "read",
                            text: "deux lignes lues",
                            diff: nil,
                            isError: false
                        ),
                        ask: nil
                    )
                )
            ),
            SessionRow(
                id: "r310.c1",
                kind: .toolCall(
                    ToolCallRow(
                        callId: "call-edit",
                        name: "edit",
                        target: "src/app.swift",
                        argumentsJSON: #"{"newString":"let ajoute = 3","oldString":"let retire = 2","path":"/tmp/omp-parity/src/app.swift"}"#,
                        result: ToolResultRow(
                            callId: "call-edit",
                            name: "edit",
                            text: "édition appliquée",
                            diff: SessionParity.editDiff,
                            isError: false
                        ),
                        ask: nil
                    )
                )
            ),
            SessionRow(
                id: "r310.c2",
                kind: .toolCall(
                    ToolCallRow(
                        callId: "call-ask",
                        name: "ask",
                        target: "Quel plan préfères-tu ?",
                        argumentsJSON: #"{"questions":[{"header":"Plan","id":"q1","options":[{"description":"aucune modification","label":"Garder le fichier"},{"label":"Renommer le module"}],"question":"Quel plan préfères-tu ?"}]}"#,
                        result: nil,
                        ask: AskSpan(
                            questions: [
                                AskSpan.Question(
                                    id: "q1",
                                    question: "Quel plan préfères-tu ?",
                                    header: "Plan",
                                    options: [
                                        AskSpan.Option(label: "Garder le fichier", description: "aucune modification"),
                                        AskSpan.Option(label: "Renommer le module", description: nil),
                                    ]
                                )
                            ]
                        )
                    )
                )
            ),
            SessionRow(
                id: "r1802",
                kind: .toolResult(
                    ToolResultRow(
                        callId: "call-absent",
                        name: "bash",
                        text: SessionParity.patchText,
                        diff: nil,
                        isError: false
                    )
                )
            ),
            SessionRow(
                id: "r2189",
                kind: .marker(.compaction(summary: "contexte compacté à 4 200 jetons", tokensBefore: 4200))
            ),
            SessionRow(
                id: "r2327",
                kind: .marker(.branchSummary(summary: "résumé de branche : reprise après compaction", fromId: "root"))
            ),
            SessionRow(id: "r2478", kind: .assistant(AssistantRow(text: "La correction est appliquée.", thinking: nil))),
            SessionRow(
                id: "r2478.c0",
                kind: .toolCall(
                    ToolCallRow(
                        callId: "call-memory",
                        name: "mem0_add",
                        target: "la correction est appliquée",
                        argumentsJSON: #"{"scope":"project","text":"la correction est appliquée"}"#,
                        result: nil,
                        ask: nil
                    )
                )
            ),
        ]
    }

    private static func loadedModel(_ payload: RemoteSessionPayload) async -> IOSSessionThreadModel {
        let model = IOSSessionThreadModel(
            source: SessionStubSource(payload: payload),
            file: "parity-session-1.jsonl",
            title: "parity-session-1",
            subtitle: nil
        )
        await model.read()
        return model
    }

    // MARK: - AC-1 : la liste groupée par jour

    @Test("ios-sessions/AC-1 : la liste groupe par jour et couvre ses cinq états")
    func listGroupsByDay() {
        let choices = [
            Self.choice(id: "alpha-recent", repo: "alpha", startedAtMs: Self.nowMs - 1_000, state: .live(.running)),
            Self.choice(id: "beta-recent", repo: "beta", startedAtMs: Self.nowMs - 2_000, state: .live(.waiting)),
            Self.choice(id: "beta-ancien", repo: "beta", startedAtMs: Self.nowMs - Self.dayMs, state: .ended(.done)),
        ]
        let list = SessionList(choices: choices, storeAbsent: false, discarded: 0)
        let connected = ClientState.connected(endpoint: Self.endpoint)

        guard case .list(let days) = IOSSessionsModel.screen(
            connection: connected, list: list, project: nil, nowMs: Self.nowMs, calendar: Self.calendar
        ) else {
            Issue.record("une liste peuplée doit rendre des jours")
            return
        }
        #expect(days.count == 2)
        #expect(days.first?.title == SessionDays.todayTitle)
        #expect(days.last?.title == SessionDays.yesterdayTitle)
        #expect(days.first?.choices.map(\.featureTitle) == ["alpha-recent", "beta-recent"])
        #expect(days.last?.choices.map(\.featureTitle) == ["beta-ancien"])
        #expect(days.allSatisfy { !$0.choices.isEmpty })

        // Les états d'écran, dans l'ordre de priorité de S-1.
        #expect(
            IOSSessionsModel.screen(connection: .unpaired, list: nil, project: nil, nowMs: Self.nowMs, calendar: Self.calendar)
                == .noConnection
        )
        #expect(
            IOSSessionsModel.screen(connection: connected, list: nil, project: nil, nowMs: Self.nowMs, calendar: Self.calendar)
                == .loading
        )
        #expect(
            IOSSessionsModel.screen(
                connection: connected,
                list: SessionList(choices: [], storeAbsent: true, discarded: 0),
                project: nil,
                nowMs: Self.nowMs,
                calendar: Self.calendar
            ) == .storeAbsent
        )
        #expect(
            IOSSessionsModel.screen(
                connection: connected,
                list: SessionList(choices: [], storeAbsent: false, discarded: 0),
                project: nil,
                nowMs: Self.nowMs,
                calendar: Self.calendar
            ) == .empty
        )
        // Un instantané arrivé APRÈS un état déconnecté passe à la liste sans geste.
        #expect(
            IOSSessionsModel.screen(connection: .unpaired, list: list, project: nil, nowMs: Self.nowMs, calendar: Self.calendar)
                != .noConnection
        )

        // La recette force les mêmes états, depuis la fixture partagée.
        #expect(IOSSessionsRecipe.resolve(["-sessions.recipe", IOSSessionText.recipeListe]) == .liste)
        #expect(IOSSessionsRecipe.resolve(["-sessions.recipe", IOSSessionText.recipeVide]) == .vide)
        #expect(IOSSessionsRecipe.resolve(["-sessions.recipe", "inconnue"]) == nil)
        #expect(IOSSessionsRecipe.resolve([]) == nil)
        #expect(IOSSessionsRecipe.liste.list.choices.count == 1)
        #expect(IOSSessionsRecipe.liste.list.choices.first?.sessionFile.contains("parity-session-1") == true)
        #expect(IOSSessionsRecipe.vide.list.choices.isEmpty)
        #expect(
            IOSSessionsModel.screen(
                connection: .unpaired,
                list: IOSSessionsRecipe.vide.list,
                project: nil,
                nowMs: Self.nowMs,
                calendar: Self.calendar
            ) == .empty
        )
    }

    // MARK: - AC-2 : le filtre par projet

    @Test("ios-sessions/AC-2 : le filtre par projet réduit la liste et recalcule ses en-têtes")
    func projectFilter() {
        let choices = [
            Self.choice(id: "alpha-recent", repo: "alpha", startedAtMs: Self.nowMs - 1_000, state: .live(.running)),
            Self.choice(id: "beta-recent", repo: "beta", startedAtMs: Self.nowMs - 2_000, state: .ended(.done)),
            Self.choice(id: "beta-ancien", repo: "beta", startedAtMs: Self.nowMs - Self.dayMs, state: .ended(.failed)),
        ]
        let list = SessionList(choices: choices, storeAbsent: false, discarded: 0)

        // Les options : projets distincts, dans l'ordre de PREMIÈRE apparition.
        #expect(SessionFilter.projects(of: choices) == ["alpha", "beta"])
        // Le filtre s'applique AVANT le groupement : un jour sans run disparaît.
        #expect(SessionFilter.apply("alpha", to: choices).map(\.featureTitle) == ["alpha-recent"])
        #expect(SessionFilter.apply(nil, to: choices).count == 3)
        #expect(IOSSessionsModel.days(of: list, project: nil, nowMs: Self.nowMs, calendar: Self.calendar).count == 2)
        #expect(IOSSessionsModel.days(of: list, project: "alpha", nowMs: Self.nowMs, calendar: Self.calendar).count == 1)
        #expect(IOSSessionsModel.days(of: list, project: "beta", nowMs: Self.nowMs, calendar: Self.calendar).count == 2)

        // Un projet DISPARU retombe sur « tous » — jamais une liste vide muette.
        #expect(IOSSessionsModel.resolvedProject("disparu", projects: ["alpha", "beta"]) == nil)
        #expect(IOSSessionsModel.resolvedProject("beta", projects: ["alpha", "beta"]) == "beta")
        #expect(IOSSessionsModel.resolvedProject(nil, projects: ["alpha"]) == nil)
        let fallback = IOSSessionsModel.resolvedProject(
            "disparu",
            projects: SessionFilter.projects(of: choices)
        )
        guard case .list(let days) = IOSSessionsModel.screen(
            connection: .connected(endpoint: Self.endpoint),
            list: list,
            project: fallback,
            nowMs: Self.nowMs,
            calendar: Self.calendar
        ) else {
            Issue.record("le repli du filtre doit rendre la liste complète")
            return
        }
        #expect(days.count == 2)

        // Un dépôt vide n'est pas une option.
        #expect(
            SessionFilter.projects(of: [Self.choice(id: "sans-repo", repo: "", startedAtMs: Self.nowMs, state: .ended(.done))])
                .isEmpty
        )
    }

    // MARK: - AC-3 : la parité des faits

    @Test("ios-sessions/AC-3 : la charge utile de la fixture rend les mêmes lignes que macOS")
    func parityRows() throws {
        let payload = try Self.payload()
        let rows = IOSSessionThreadFacts.rows(of: payload)

        // Les mêmes lignes, une par une — les faits pinnés du contrat.
        #expect(rows == Self.pinnedRows)
        #expect(rows.count == 10)

        // Et les faits qui DOIVENT être retrouvables, pinnés séparément.
        let read = try #require(Self.toolCall(rows, "call-read"))
        #expect(read.target == "src/app.swift")
        #expect(read.argumentsJSON == #"{"i":"lire le fichier","offset":2,"path":"/tmp/omp-parity/src/app.swift"}"#)
        #expect(read.result?.text == "deux lignes lues")
        #expect(try #require(Self.toolCall(rows, "call-memory")).name == "mem0_add")

        let markers = rows.compactMap { row -> MarkerRow? in
            if case .marker(let marker) = row.kind { return marker } else { return nil }
        }
        #expect(markers.count == 2)
        #expect(markers.first == MarkerRow.compaction(summary: "contexte compacté à 4 200 jetons", tokensBefore: 4200))
        #expect(markers.last == MarkerRow.branchSummary(summary: "résumé de branche : reprise après compaction", fromId: "root"))

        // L'état de la charge utile, et le compte des entrées ignorées.
        #expect(IOSSessionThreadFacts.state(of: payload) == .ready)
        #expect(payload.skipped.count == 2)
        #expect(payload.truncated == false)
        #expect(payload.unreadableReason == nil)
    }

    // MARK: - AC-4 : illisible, tronqué, absent

    @Test("ios-sessions/AC-4 : illisible, tronqué et fichier absent ne laissent jamais un écran muet")
    func unreadableAndTruncated() async throws {
        // Fichier illisible : le motif OS, les lignes déjà lues restent.
        var broken = try Self.payload()
        broken.unreadableReason = IOSSessionText.unreadableReason
        #expect(IOSSessionThreadFacts.state(of: broken) == .unreadable(IOSSessionText.unreadableReason))
        let unreadableModel = await Self.loadedModel(broken)
        #expect(unreadableModel.state == .unreadable(IOSSessionText.unreadableReason))
        #expect(unreadableModel.rows.isEmpty)
        #expect(unreadableModel.notes.isEmpty)
        #expect(unreadableModel.threadStatus == ConsoleStatus(text: ConversationText.readError, tone: .danger))
        #expect(unreadableModel.isLoading == false)

        // Troncature : les lignes restent, la note le dit (S-4).
        var truncated = try Self.payload()
        truncated.truncated = true
        let truncatedModel = await Self.loadedModel(truncated)
        #expect(truncatedModel.rows.count == Self.pinnedRows.count)
        #expect(truncatedModel.ignoredCount == 2)
        #expect(truncatedModel.notes == [ConversationText.ignored(2), ConversationText.rewritten])
        #expect(IOSSessionThreadFacts.notes(ignored: 0, rewritten: 0).isEmpty)

        // Fichier ABSENT (404) : l'attente, sans bandeau — exactement macOS.
        let missingSource = SessionStubSource(payload: truncated)
        missingSource.failure = ClientError.api(.notFound("session introuvable"))
        let missing = IOSSessionThreadModel(source: missingSource, file: "absent.jsonl", title: "t", subtitle: nil)
        await missing.read()
        #expect(missing.state == .waiting)
        #expect(missing.errorBanner == nil)
        #expect(missing.threadStatus == ConsoleStatus(text: ConversationText.starting, tone: .info))

        // Échec de LECTURE (transport) : un bandeau, jamais un écran muet.
        let brokenSource = SessionStubSource(payload: truncated)
        brokenSource.failure = ClientError.transport(.unreachable("hôte muet"))
        let failing = IOSSessionThreadModel(source: brokenSource, file: "s.jsonl", title: "t", subtitle: nil)
        await failing.read()
        #expect(failing.errorBanner == ConversationText.readError)
        #expect(failing.isLoading == false)

        // La recette `.illisible` porte le même motif, et rien n'est fabriqué.
        let recipeThread = try #require(IOSSessionsRecipe.illisible.thread)
        #expect(recipeThread.payload.unreadableReason == IOSSessionText.unreadableReason)
        let recipeModel = IOSSessionThreadModel(
            source: IOSSessionsRecipeSource(thread: recipeThread),
            file: recipeThread.file,
            title: recipeThread.title,
            subtitle: recipeThread.subtitle
        )
        await recipeModel.read()
        #expect(recipeModel.state == .unreadable(IOSSessionText.unreadableReason))
    }

    // MARK: - AC-6 : plis indépendants et diffs colorés

    @Test("ios-sessions/AC-6 : les plis sont indépendants et les diffs portent leurs tons")
    func foldsAndDiffs() async throws {
        let model = await Self.loadedModel(try Self.payload())

        // Deux clés distinctes par ligne d'agent.
        let thinkingKey = IOSSessionRowView.thinkingKey(of: "r310")
        #expect(thinkingKey != "r310")
        #expect(!model.isExpanded("r310.c1"))
        #expect(!model.isExpanded(thinkingKey))

        model.toggleFold("r310.c1")
        #expect(model.isExpanded("r310.c1"))
        #expect(!model.isExpanded(thinkingKey), "plier l'appel ne déplie pas la réflexion")
        model.toggleFold(thinkingKey)
        #expect(model.isExpanded(thinkingKey))
        #expect(model.isExpanded("r310.c1"), "plier la réflexion ne replie pas l'appel")
        model.toggleFold("r310.c1")
        #expect(!model.isExpanded("r310.c1"))
        #expect(model.isExpanded(thinkingKey))

        // L'amorçage : seules les lignes CRÉÉES reçoivent un pli, seul un `ask` est déplié.
        #expect(IOSSessionThreadFacts.expanded(after: model.rows, startingAt: 0, in: []) == ["r310.c2"])
        #expect(
            IOSSessionThreadFacts.expanded(after: model.rows, startingAt: model.rows.count, in: ["r310.c1"])
                == ["r310.c1"]
        )

        // Le diff d'édition : trois tons, sans en-tête de section.
        let edit = try #require(Self.toolCall(model.rows, "call-edit"))
        let editDiff = try #require(edit.result?.diff)
        #expect(diffLines(in: editDiff).map(\.tone) == [.context, .removed, .added])
        #expect(
            diffLines(in: editDiff).map { SessionDiffText.toneLabel($0.tone) }
                == ["contexte", "ligne supprimée", "ligne ajoutée"]
        )

        // Le diff unifié DANS le texte d'un résultat autonome : les quatre tons.
        let orphan = try #require(Self.toolResults(model.rows).first { $0.callId == "call-absent" })
        let segment = try #require(
            bodySegments(in: orphan.text).compactMap { segment -> [DiffLine]? in
                if case .diff(let lines) = segment { return lines } else { return nil }
            }.first
        )
        #expect(segment.map(\.tone) == [.section, .section, .section, .section, .section, .removed, .added])
        #expect(SessionDiffText.toneLabel(.added) == "ligne ajoutée")
        #expect(SessionDiffText.toneLabel(.removed) == "ligne supprimée")
        #expect(SessionDiffText.toneLabel(.section) == "en-tête de diff")
        #expect(SessionDiffText.toneLabel(.context) == "contexte")
    }

    // MARK: - AC-7 : la question ask

    @Test("ios-sessions/AC-7 : la question ask est dépliée d'emblée, et sans aucun geste de réponse")
    func askHighlighted() async throws {
        let model = await Self.loadedModel(try Self.payload())

        let askRow = try #require(
            model.rows.first { row in
                if case .toolCall(let call) = row.kind { return call.ask != nil } else { return false }
            }
        )
        #expect(askRow.id == "r310.c2")
        #expect(model.isExpanded(askRow.id), "une question entre DÉPLIÉE")
        #expect(model.expanded == [askRow.id], "rien d'autre n'est déplié d'emblée")

        guard case .toolCall(let call) = askRow.kind else {
            Issue.record("la ligne du ask n'est pas un appel d'outil")
            return
        }
        #expect(call.name == "ask")
        #expect(call.target == "Quel plan préfères-tu ?")
        let span = try #require(call.ask)
        #expect(span.questions.count == 1)
        let question = try #require(span.questions.first)
        #expect(question.id == "q1")
        #expect(question.header == "Plan")
        #expect(question.question == "Quel plan préfères-tu ?")
        #expect(question.options.map(\.label) == ["Garder le fichier", "Renommer le module"])
        #expect(question.options.map(\.description) == ["aucune modification", nil])

        // Les identifiants du bloc sont ceux que S-7 nomme.
        #expect(IOSSessionsAccessibility.ask("r310.c2") == "ios.session.ask.r310.c2")
        #expect(IOSSessionsAccessibility.askQuestion("r310.c2", 0) == "ios.session.ask.r310.c2.question.0")
        #expect(IOSSessionsAccessibility.askOption("r310.c2", 0, 1) == "ios.session.ask.r310.c2.option.0.1")

        // La réflexion, elle, reste repliée sous sa propre clé.
        #expect(!model.isExpanded(IOSSessionRowView.thinkingKey(of: askRow.id)))
    }

    // MARK: - AC-8 : le suivi direct

    @Test("ios-sessions/AC-8 : un ajout s'ajoute — une seule lecture, plis et position préservés")
    func additionsDoNotReload() async throws {
        let source = SessionStubSource(payload: try Self.payload())
        let model = IOSSessionThreadModel(source: source, file: "s.jsonl", title: "t", subtitle: nil)
        await model.read()
        #expect(source.readCount == 1)

        let before = model.rows
        model.toggleFold("r310.c1")
        let request = model.scrollRequest

        model.apply(.added([try Self.wireEntry(index: 20, offset: 9_000, kind: "user", text: "encore un tour")]))
        model.apply(.added([]))
        #expect(source.readCount == 1, "un ajout ne relit JAMAIS la session")
        #expect(model.rows.count == before.count + 1)
        #expect(model.rows.first?.id == before.first?.id, "les identités publiées ne bougent pas")
        #expect(Array(model.rows.map(\.id).prefix(before.count)) == before.map(\.id))
        #expect(model.isExpanded("r310.c1"), "un ajout ne réinitialise pas les plis")
        #expect(model.scrollRequest > request, "collé au bas, l'ajout demande un défilement")

        // Un évènement d'un autre fichier n'est jamais délivré : c'est le contrat du
        // flux (`sessionFeed(forFile:)`), vérifié côté client ; ici, une réécriture
        // repart d'une lecture neuve.
        model.apply(.rewrote)
        #expect(model.reconstructions == 1)
        #expect(model.rows.isEmpty)
        #expect(model.expanded.isEmpty)
        var spins = 0
        while source.readCount < 2, spins < 100 {
            await Task.yield()
            spins += 1
        }
        #expect(source.readCount == 2)
        #expect(model.rows == Self.pinnedRows)
    }

    @Test("ios-sessions/AC-8 : le fil ne colle au bas que tant que l'utilisateur n'a pas remonté")
    func followPolicy() async throws {
        let source = SessionStubSource(payload: try Self.payload())
        let model = IOSSessionThreadModel(source: source, file: "s.jsonl", title: "t", subtitle: nil)
        await model.read()

        // Une lecture qui ajoute des lignes demande un défilement, et le fil suit.
        #expect(model.following)
        #expect(model.scrollRequest > 0)
        #expect(model.threadStatus == ConsoleStatus(text: ConversationText.live, tone: .success))

        // Le défilement demandé arrive au bas : le suivi reste armé.
        model.reportBottomGap(ViewerScrollGeometry(gap: 0, origin: 0))
        #expect(model.following)

        // Un geste alors que le fil n'est pas au bas suspend le suivi…
        model.reportBottomGap(ViewerScrollGeometry(gap: 400, origin: 120))
        model.reportUserScroll(deltaY: 1)
        #expect(!model.following)
        #expect(model.threadStatus == nil, "hors du direct, seul le bouton dit l'état")
        let request = model.scrollRequest
        model.apply(.added([try Self.wireEntry(index: 20, offset: 9_000, kind: "user", text: "pendant la lecture")]))
        #expect(model.scrollRequest == request, "remonté, le fil n'est plus forcé")

        // Revenir en bas recolle sans geste.
        model.reportBottomGap(ViewerScrollGeometry(gap: 0, origin: 0))
        #expect(model.following)
        #expect(model.threadStatus == ConsoleStatus(text: ConversationText.live, tone: .success))

        // « Revenir au direct » reprend le suivi et redemande un défilement.
        model.reportBottomGap(ViewerScrollGeometry(gap: 400, origin: 120))
        model.reportUserScroll(deltaY: 1)
        #expect(!model.following)
        let suspended = model.scrollRequest
        model.returnToLive()
        #expect(model.following)
        #expect(model.scrollRequest > suspended)
    }

    // MARK: - AC-9 : vivant → terminé

    @Test("ios-sessions/AC-9 : l'état du run passe de vivant à terminé sans rouvrir la session")
    func runStatusTransition() async throws {
        let live = Self.choice(id: "s-live", repo: "alpha", startedAtMs: Self.nowMs, state: .live(.running))
        let ended = Self.choice(id: "s-live", repo: "alpha", startedAtMs: Self.nowMs, state: .ended(.done))
        let source = SessionStubSource(payload: try Self.payload(), run: live)
        let model = IOSSessionThreadModel(
            source: source,
            file: live.sessionFile,
            title: live.featureTitle,
            subtitle: live.target.subtitle
        )
        #expect(model.runStatus == ConsoleStatus.of(run: live))
        #expect(model.runStatus?.tone == .info)

        // La trame `store` met l'instantané à jour : la source voit le run terminé.
        source.run = ended
        model.refreshRunStatus()
        #expect(model.runStatus == ConsoleStatus.of(run: ended))
        #expect(model.runStatus?.tone == .success)
        #expect(model.runStatus != ConsoleStatus.of(run: live))

        // Un run INTROUVABLE est traité comme un run terminé.
        source.run = nil
        model.refreshRunStatus()
        #expect(model.runStatus == ConsoleStatus.finishedRun)
        #expect(IOSSessionThreadFacts.status(run: nil) == ConsoleStatus.of(run: ended))

        // Et les deux autres tons du contrat.
        let waiting = Self.choice(id: "w", repo: "a", startedAtMs: 0, state: .live(.waiting))
        #expect(IOSSessionThreadFacts.status(run: waiting).tone == .attention)
        let failed = Self.choice(id: "f", repo: "a", startedAtMs: 0, state: .ended(.failed))
        #expect(IOSSessionThreadFacts.status(run: failed).tone == .danger)

        // La recette `.enDirect` monte un run vivant, depuis la fixture partagée.
        let thread = try #require(IOSSessionsRecipe.enDirect.thread)
        let run = try #require(thread.run)
        #expect(run.state == .live(.running))
        let recipeModel = IOSSessionThreadModel(
            source: IOSSessionsRecipeSource(thread: thread),
            file: thread.file,
            title: thread.title,
            subtitle: thread.subtitle
        )
        #expect(recipeModel.runStatus == ConsoleStatus.of(run: run))
        await recipeModel.read()
        #expect(recipeModel.rows == Self.pinnedRows)
    }

    // MARK: - AC-10 : le fil réutilisable

    @Test("ios-sessions/AC-10 : le fil se monte depuis une source seule, hors de la section Sessions")
    func componentIsReusable() async throws {
        let payload = try Self.payload()
        let source = SessionStubSource(payload: payload)
        let model = IOSSessionThreadModel(
            source: source,
            file: "une-session-quelconque.jsonl",
            title: "une feature",
            subtitle: nil
        )
        await model.read()
        #expect(source.readCount == 1)
        #expect(model.rows == IOSSessionThreadFacts.rows(of: payload))
        #expect(model.notes == [ConversationText.ignored(2)])

        // Le rendu se monte sur le modèle SEUL : aucune référence de client, aucune
        // référence de section (`test/ios-sessions.test.ts` interdit leurs noms dans
        // ces fichiers).
        _ = IOSSessionThreadView(model: model)
        _ = IOSSessionRowView(row: model.rows[0], isOpen: false, isThinkingOpen: false, onToggle: { _ in })
    }
}
