// Les FILS de l'OS agentique (OSThreads, OSDecisions, OSPulse) : le titre nettoyé, le
// regroupement des features en fils, l'ordre et la phase d'un fil, les sections de la
// liste, une session omp locale devenue fil, l'espace d'un fil et d'une décision, les lots
// de décisions de même sorte et l'activité d'une session locale dans le pouls. Pur, sauf le pouls (flux
// scripté sur la doublure de transport).

@testable import ConsoleClient
import Foundation
import Testing

private func run(
    _ id: String, _ title: String, _ state: HarnessRunState = .merged, repo: String = "demo", step: String? = nil, at: Double,
    updated: Double? = nil, after: String? = nil, project: String? = nil, by: String? = nil
) -> HarnessRun {
    HarnessRun(
        id: id, repo: repo, slug: id, title: title, request: title, state: state.rawValue, step: step, createdBy: by,
        projectId: project, createdAt: at, updatedAt: updated ?? at, afterRun: after
    )
}

private func request(_ id: String, _ instruction: String, _ state: String, at: Double) throws -> WorkstationRequest {
    try JSONDecoder().decode(
        WorkstationRequest.self,
        from: JSONSerialization.data(withJSONObject: ["id": id, "instruction": instruction, "state": state, "createdAt": at, "updatedAt": at, "by": "mac"])
    )
}

private func intake(_ id: String, title: String, created: [String: String]) throws -> HarnessIntake {
    try JSONDecoder().decode(HarnessIntake.self, from: JSONSerialization.data(withJSONObject: [
        "id": id, "text": "t", "source": "console", "state": "confirmed", "exchanges": [] as [Any], "statement": "t", "by": "millian",
        "plan": ["kind": "feature", "repo": "demo", "title": title, "statement": "t"], "created": created, "createdAt": 1, "updatedAt": 2,
    ] as [String: Any]))
}

private func session(
    _ id: String, _ title: String = "Export CSV", state: HarnessLocalSessionState = .working, repo: String? = "demo", runId: String? = nil,
    at: Double = 100, cost: Double? = nil
) -> HarnessLocalSession {
    HarnessLocalSession(
        id: id, client: "mac", host: "macbook", cwd: "/Users/moi/demo", repo: repo, branch: "feat/x", title: title, state: state.rawValue,
        cost: cost, runId: runId, startedAt: at, updatedAt: at + 5
    )
}

private func thread(_ id: String, _ phase: OSPhase, updated: Double, repo: String? = "demo") -> OSThread {
    OSThread(
        id: id, title: id, repo: repo, origin: .person(nil), runs: [], requests: [], audit: nil, intake: nil, phase: phase,
        pending: 0, autonomous: 0, cost: 0, createdAt: updated, updatedAt: updated
    )
}

private func threadOf(_ runId: String, in threads: [OSThread]) -> OSThread? {
    threads.first { thread in thread.runs.contains { $0.id == runId } }
}

@Suite("Fils, décisions et pouls")
@MainActor
struct OSThreadsTests {
    // MARK: Titres

    @Test("un titre perd ses enveloppes « Suite de « … » » et « Découpage de « … » », même imbriquées ; sans guillemet fermant, il est dit tronqué")
    func cleanWrappers() {
        #expect(OSThreads.clean("Suite de « Export CSV »").title == "Export CSV")
        let nested = OSThreads.clean("Suite de « Découpage de « Suite de « Export CSV » » »")
        #expect(nested.title == "Export CSV" && !nested.truncated && nested.issue == nil)
        let cut = OSThreads.clean("Suite de « Suite de « Export des comman")
        #expect(cut.title == "Export des comman" && cut.truncated)
        #expect(OSThreads.clean("  Export CSV \n").title == "Export CSV")
        #expect(!OSThreads.clean("Export CSV").truncated)
    }

    @Test("un titre perd son préfixe d'issue (gardé à part), son préfixe de commit conventionnel, son compteur ×N et l'identifiant du runner, et prend une majuscule")
    func cleanPrefixes() {
        let issue = OSThreads.clean("Issue #42 : le panier se vide")
        #expect(issue.title == "Le panier se vide" && issue.issue == 42)
        #expect(OSThreads.clean("fix(api): corrige le cache").title == "Corrige le cache")
        #expect(OSThreads.clean("feat!: nouveau thème").title == "Nouveau thème")
        #expect(OSThreads.clean("chore: Mise à jour").title == "Mise à jour")
        #expect(OSThreads.clean("Export CSV ×3").title == "Export CSV")
        #expect(OSThreads.clean("Export CSV — omp-runner-7f3a9c").title == "Export CSV")
        let all = OSThreads.clean("Suite de « Issue #7 : fix: répare l'export ×2 — omp-runner-x1 »")
        #expect(all.title == "Répare l'export" && all.issue == 7 && !all.truncated)
        // Deux-points sans préfixe de commit : le titre reste entier.
        #expect(OSThreads.clean("Panier : total faux").title == "Panier : total faux")
        #expect(OSThreads.clean("").title == "")
    }

    // MARK: Regroupement

    @Test("les features d'une même suite (afterRun), d'un même projet, ou de même titre nettoyé dans un dépôt forment un fil ; un autre dépôt, un autre fil")
    func grouping() {
        let runs = [
            run("a1", "Export CSV", at: 10),
            run("a2", "Corriger l'encodage", .running, at: 20, after: "a1"),
            run("p1", "Page d'accueil", at: 30, project: "p"),
            run("p2", "Page de contact", .queued, at: 40, project: "p"),
            run("t1", "Refonte du panier", .failed, at: 50),
            run("t2", "fix: refonte du panier ×2", at: 60),
            run("t3", "Refonte du panier", repo: "docs", at: 70),
            run("u1", "Migration de la base de données", at: 80),
            run("u2", "Suite de « Migration de la base", .running, at: 90),
            run("o1", "Suite orpheline", at: 95, after: "inconnue"),
        ]
        let threads = OSThreads.build(runs: runs, inbox: nil, projects: [HarnessProject(id: "p", repo: "demo", title: "feat: site vitrine")])
        #expect(threads.count == 6)
        #expect(threadOf("a1", in: threads)?.runs.map(\.id) == ["a1", "a2"], "une suite rejoint le fil de son parent, la plus ancienne d'abord")
        #expect(threadOf("a1", in: threads)?.title == "Export CSV")
        #expect(threadOf("a1", in: threads)?.id == "r:a1")
        #expect(threadOf("p1", in: threads)?.runs.map(\.id) == ["p1", "p2"])
        #expect(threadOf("p1", in: threads)?.title == "Site vitrine", "le fil d'un projet porte son titre nettoyé")
        #expect(threadOf("t1", in: threads)?.runs.map(\.id) == ["t1", "t2"])
        #expect(threadOf("t3", in: threads)?.runs.map(\.id) == ["t3"], "même titre, autre dépôt : un autre fil")
        #expect(threadOf("t3", in: threads)?.repo == "docs")
        #expect(threadOf("u1", in: threads)?.runs.map(\.id) == ["u1", "u2"], "un titre de suite tronqué rejoint le fil qu'il prolonge")
        #expect(threadOf("o1", in: threads)?.runs.map(\.id) == ["o1"], "un parent inconnu ne lie rien")
    }

    @Test("la boîte prime sur l'historique : une feature vivante y est plus fraîche, et ce qu'elle attend met le fil « à vous »")
    func inboxWins() {
        let stale = run("r1", "Export CSV", .running, at: 10)
        let fresh = run("r1", "Export CSV", .awaitingHuman, step: "specs", at: 10, updated: 50)
        let question = HarnessEscalation(id: 7, runId: "r2", category: "schema", question: "Où ?", options: ["a", "b"])
        let escalated = run("r2", "Panier", .escalated, at: 20)
        let inbox = HarnessInbox(
            batches: [HarnessEscalationBatch(run: escalated, items: [question, question])], awaiting: [fresh],
            decisions: [HarnessDecision(id: 1, runId: "r1", seq: 1, question: "?", options: ["x"], chosen: "x", rationale: "r")],
            runs: [], costs: ["r1": 1.5, "r2": 0.5]
        )
        let threads = OSThreads.build(runs: [stale], inbox: inbox)
        let specs = threadOf("r1", in: threads)
        #expect(specs?.runs.first?.state == "awaiting_human")
        #expect(specs?.phase == .yours && specs?.pending == 1 && specs?.autonomous == 1 && specs?.cost == 1.5)
        let asked = threadOf("r2", in: threads)
        #expect(asked?.phase == .yours && asked?.pending == 2 && asked?.cost == 0.5, "un fil de la boîte seule existe, avec ses deux questions")
    }

    @Test("la phase d'un fil mixte : le plus pressant de ce qui vit ; sinon livré s'il y a eu une livraison ; sinon l'état de la dernière feature")
    func mixedPhase() {
        let threads = OSThreads.build(
            runs: [
                run("w1", "Vivant", at: 10), run("w2", "Vivant", .failed, at: 11), run("w3", "Vivant", .queued, at: 12), run("w4", "Vivant", .running, at: 13),
                run("d1", "Livré", at: 20), run("d2", "Livré", .cancelled, at: 21),
                run("f1", "Échec", .cancelled, at: 30), run("f2", "Échec", .failed, at: 31),
                run("s1", "Arrêté", .failed, at: 40), run("s2", "Arrêté", .cancelled, at: 41),
                run("n1", "État futur", at: 50),
            ].map { run in
                var run = run
                if run.id == "n1" { run.state = "etat_futur" }
                return run
            },
            inbox: nil
        )
        #expect(threadOf("w1", in: threads)?.phase == .working, "au travail l'emporte sur en file")
        #expect(threadOf("w1", in: threads)?.focusRun?.id == "w4")
        #expect(threadOf("w1", in: threads)?.liveRuns.map(\.id) == ["w3", "w4"])
        #expect(threadOf("d1", in: threads)?.phase == .done)
        #expect(threadOf("d1", in: threads)?.focusRun?.id == "d1", "rien ne vit : la dernière livrée")
        #expect(threadOf("f1", in: threads)?.phase == .failed)
        #expect(threadOf("s1", in: threads)?.phase == .stopped)
        #expect(threadOf("n1", in: threads)?.phase == .working, "un état inconnu de cette version se lit comme au travail")
    }

    @Test("les demandes au poste de même consigne (à la casse et aux blancs près) sont les tentatives d'un seul fil")
    func workstationAttempts() throws {
        let requests = [
            try request("q1", "Relance le client Durand", "failed", at: 10),
            try request("q2", "  relance le client DURAND \n", "done", at: 20),
            try request("q3", "Prépare la réunion\navec les notes", "running", at: 30),
        ]
        let asked = try intake("i1", title: "Relancer Durand", created: ["kind": "workstation_request", "id": "q2"])
        let threads = OSThreads.build(runs: [], inbox: nil, intakes: [asked], requests: requests)
        #expect(threads.count == 2)
        let retried = try #require(threads.first { $0.id == "w:q1" })
        #expect(retried.requests.map(\.id) == ["q1", "q2"])
        #expect(retried.phase == .done, "une tentative a abouti")
        #expect(retried.title == "Relancer Durand", "le titre du plan de la Demande, s'il y en a une")
        #expect(retried.repo == nil && retried.origin == .person("mac") && retried.request?.id == "q2")
        #expect(retried.createdAt == 10 && retried.updatedAt == 20)
        let live = try #require(threads.first { $0.id == "w:q3" })
        #expect(live.phase == .working && live.title == "Prépare la réunion")
        #expect(threads.first?.id == "w:q3", "ce qui vit passe devant")
    }

    @Test("un audit ouvert sans projet est son propre fil : au travail tant qu'il analyse, livré une fois ses propositions rendues (elles ne sont pas une décision) ; lancé en projet, il devient l'origine du fil du projet")
    func audits() throws {
        let audits = [
            HarnessAudit(id: "a1", repo: "demo", focus: "## Sécurité\ndes formulaires", state: "proposed", createdAt: 10),
            HarnessAudit(id: "a2", repo: "docs", state: "analysing", createdAt: 20),
            HarnessAudit(id: "a3", repo: "demo", focus: "perf", state: "launched", projectId: "p", createdAt: 30),
            HarnessAudit(id: "a4", repo: "demo", state: "cancelled", createdAt: 40),
        ]
        let threads = OSThreads.build(runs: [run("p1", "Cache HTTP", at: 50, project: "p")], inbox: nil, audits: audits)
        #expect(Set(threads.map(\.id)) == ["a:a1", "a:a2", "r:p1"])
        let proposed = try #require(threads.first { $0.id == "a:a1" })
        #expect(proposed.phase == .done && proposed.pending == 0, "des propositions d'audit ne mettent pas le fil « à vous » : elles vivent dans Propositions")
        #expect(proposed.title == "Sécurité" && proposed.origin == .audit("## Sécurité\ndes formulaires") && proposed.audit?.isProposed == true)
        #expect(!threads.contains { $0.phase == .yours })
        let analysing = try #require(threads.first { $0.id == "a:a2" })
        #expect(analysing.phase == .working && analysing.pending == 0 && analysing.title == "docs", "sans périmètre : le dépôt")
        #expect(threadOf("p1", in: threads)?.origin == .audit("perf"))
        #expect(threadOf("p1", in: threads)?.audit?.id == "a3")
    }

    @Test("l'origine d'un fil : la vigie, une issue, le pilote de l'usine, la personne de la Demande, sinon le client qui l'a lancé")
    func origins() throws {
        let asked = try intake("i1", title: "Exporter les commandes", created: ["kind": "run", "id": "h1"])
        let threads = OSThreads.build(
            runs: [
                run("v1", "Issue #9 : corrige la fuite", at: 10),
                run("i1", "Issue #12 : le panier se vide", at: 20),
                run("f1", "Nettoyage", at: 30, by: "pilote-usine"),
                run("h1", "feat: export", at: 40, by: "app-mac"),
                run("c1", "Divers", at: 50, by: "ci"),
            ],
            inbox: nil, intakes: [asked], incidents: [VigieIncident(fingerprint: "x", issueNumber: 9, fixRunId: "v1")]
        )
        #expect(threadOf("v1", in: threads)?.origin == .vigie(9), "la vigie prime sur l'issue qu'elle a publiée")
        #expect(threadOf("i1", in: threads)?.origin == .issue(12))
        #expect(threadOf("f1", in: threads)?.origin == .factory)
        #expect(threadOf("h1", in: threads)?.origin == .person("millian"))
        #expect(threadOf("h1", in: threads)?.title == "Exporter les commandes")
        #expect(threadOf("h1", in: threads)?.intake?.id == "i1")
        #expect(threadOf("c1", in: threads)?.origin == .person("ci"))
    }

    @Test("l'ordre des fils : à vous, au travail, en file, puis ce qui est fini — toujours du plus récent au plus ancien")
    func order() {
        let inbox = HarnessInbox(awaiting: [run("y1", "À valider", .awaitingHuman, at: 1, updated: 5)])
        let threads = OSThreads.build(
            runs: [
                run("d-old", "Vieux livré", at: 10, updated: 100),
                run("q1", "En file", .queued, at: 11, updated: 20),
                run("x1", "Annulé récent", .cancelled, at: 12, updated: 900),
                run("w-old", "Travail ancien", .running, at: 13, updated: 30),
                run("f1", "Échec", .failed, at: 14, updated: 500),
                run("w-new", "Travail récent", .running, at: 15, updated: 40),
                run("d-new", "Livré récent", at: 16, updated: 700),
            ],
            inbox: inbox
        )
        #expect(threads.map { $0.runs[0].id } == ["y1", "w-new", "w-old", "q1", "x1", "d-new", "f1", "d-old"])
    }

    // MARK: Sections

    @Test("les sections : les fils vivants par phase, les finis par ancienneté (aujourd'hui, hier, cette semaine, plus tôt), les arrêtés à part ; aucune section vide")
    func sections() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(identifier: "UTC"))
        let now = try #require(calendar.date(from: DateComponents(year: 2026, month: 11, day: 9, hour: 12)))
        let today = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
        let hour = 3_600_000.0
        let day = 24 * hour
        let threads = [
            thread("yours", .yours, updated: today - 30 * day),
            thread("working", .working, updated: today),
            thread("queued", .queued, updated: today),
            thread("today", .done, updated: today + hour),
            thread("today-failed", .failed, updated: today),
            thread("yesterday", .done, updated: today - hour),
            thread("yesterday-edge", .failed, updated: today - day),
            thread("week", .done, updated: today - day - hour),
            thread("week-edge", .done, updated: today - 7 * day),
            thread("earlier", .failed, updated: today - 7 * day - hour),
            thread("stopped-now", .stopped, updated: today + hour),
            thread("stopped-old", .stopped, updated: today - 40 * day),
        ]
        let sections = OSThreads.sections(threads, now: now, calendar: calendar)
        #expect(sections.map(\.0) == [.yours, .working, .queued, .today, .yesterday, .week, .earlier, .stopped])
        let ids = Dictionary(uniqueKeysWithValues: sections.map { ($0.0, $0.1.map(\.id)) })
        #expect(ids[.yours] == ["yours"], "un fil vivant reste dans sa phase, quelle que soit sa date")
        #expect(ids[.today] == ["today", "today-failed"])
        #expect(ids[.yesterday] == ["yesterday", "yesterday-edge"])
        #expect(ids[.week] == ["week", "week-edge"])
        #expect(ids[.earlier] == ["earlier"])
        #expect(ids[.stopped] == ["stopped-now", "stopped-old"], "un fil arrêté va à part, même d'aujourd'hui")

        let few = OSThreads.sections([thread("seul", .done, updated: today - 2 * day)], now: now, calendar: calendar)
        #expect(few.map(\.0) == [.week])
        #expect(OSThreads.sections([], now: now, calendar: calendar).isEmpty)
    }

    @Test("la position d'une feature sur le chemin Besoins → Specs → Implémentation → Revue → Fusion, et les lignes utiles d'un texte")
    func stepsAndLines() {
        #expect(OSThreads.stepIndex(of: run("r", "T", .running, step: "req", at: 1)) == 0)
        #expect(OSThreads.stepIndex(of: run("r", "T", .awaitingHuman, step: "specs", at: 1)) == 1)
        #expect(OSThreads.stepIndex(of: run("r", "T", .running, step: "impl", at: 1)) == 2)
        #expect(OSThreads.stepIndex(of: run("r", "T", .running, step: "fix", at: 1)) == 3)
        #expect(OSThreads.stepIndex(of: run("r", "T", .merging, step: "review", at: 1)) == 4)
        #expect(OSThreads.stepIndex(of: run("r", "T", .merged, at: 1)) == 4)
        #expect(OSThreads.stepIndex(of: run("r", "T", .queued, at: 1)) == 0)
        #expect(OSThreads.firstLine("\n  ## **Titre** du plan\nsuite") == "Titre du plan")
        #expect(OSThreads.gist("# Titre\n\nLa première phrase.\nLa seconde.") == "La première phrase.")
        #expect(OSThreads.preview("# Titre\nun\n\ndeux\ntrois", lines: 2) == "un\ndeux")
    }

    // MARK: Sessions locales

    @Test("une session omp locale est un fil : son hôte pour origine, sa phase selon son état, son titre nettoyé, son coût")
    func localSessionThread() throws {
        let threads = OSThreads.build(
            runs: [run("r1", "Autre chose", at: 10, updated: 10)], inbox: nil,
            localSessions: [
                session("s1", "fix: export csv", state: .working, at: 100, cost: 0.8),
                session("s2", "Brouillon", state: .idle, repo: nil, at: 200),
                session("s3", "Terminé", state: .ended, at: 300),
            ]
        )
        #expect(threads.map(\.id) == ["l:s1", "l:s2", "l:s3", "r:r1"], "au travail, en attente, puis les finis du plus récent au plus ancien")
        let working = try #require(threads.first { $0.id == "l:s1" })
        #expect(working.origin == .local("macbook"))
        #expect(working.localSession?.id == "s1" && working.runs.isEmpty && working.requests.isEmpty)
        #expect(working.title == "Export csv" && working.repo == "demo" && working.phase == .working && working.cost == 0.8)
        #expect(working.createdAt == 100 && working.updatedAt == 105 && working.pending == 0)
        #expect(threads.first { $0.id == "l:s2" }?.phase == .queued, "l'agent a rendu la main : en attente")
        #expect(threads.first { $0.id == "l:s2" }?.repo == nil)
        #expect(threads.first { $0.id == "l:s3" }?.phase == .done)
        #expect(threads.first { $0.id == "r:r1" }?.localSession == nil)

        var future = session("s4")
        future.state = "etat_futur"
        #expect(OSThreads.phase(of: future) == .working)
        var untitled = session("s5", "")
        untitled.cwd = "/Users/moi/boutique"
        #expect(OSThreads.build(runs: [], inbox: nil, localSessions: [untitled]).first?.title == "boutique", "sans titre : le dossier de travail")
    }

    @Test("une session locale reprise par l'usine rejoint le fil de sa feature au lieu d'en ouvrir un second : le fil garde l'hôte pour origine")
    func handedOffSession() throws {
        let threads = OSThreads.build(
            runs: [run("r1", "Export CSV", .running, at: 200, by: "app-mac"), run("r2", "Suite", .queued, at: 210, after: "r1")],
            inbox: HarnessInbox(costs: ["r1": 2]),
            localSessions: [session("s1", "Export CSV", state: .idle, runId: "r2", at: 100, cost: 0.5), session("s2", "Seule", runId: "disparue", at: 150)]
        )
        #expect(threads.count == 2)
        let joined = try #require(threadOf("r1", in: threads))
        #expect(joined.id == "r:r1" && joined.localSession?.id == "s1" && joined.origin == .local("macbook"))
        #expect(joined.runs.map(\.id) == ["r1", "r2"] && joined.phase == .working)
        #expect(joined.createdAt == 100, "le fil commence avec la session")
        #expect(joined.cost == 2.5)
        #expect(threads.contains { $0.id == "l:s2" }, "une feature inconnue ne rattache rien : la session garde son fil")
    }

    // MARK: Espaces

    @Test("l'espace d'un fil se déduit de son dépôt ; une demande au poste va à l'espace qui porte le poste ; hors de tout espace : aucun")
    func spaces() throws {
        let spaces = [
            HarnessSpace(id: "s1", name: "Acme", repos: ["boutique", "api"]),
            HarnessSpace(id: "s2", name: "Perso", repos: ["demo"], poste: true),
        ]
        #expect(OSThreads.space(of: thread("a", .working, updated: 1, repo: "api"), spaces: spaces)?.id == "s1")
        #expect(OSThreads.space(of: thread("b", .working, updated: 1, repo: "demo"), spaces: spaces)?.id == "s2")
        #expect(OSThreads.space(of: thread("c", .working, updated: 1, repo: "ailleurs"), spaces: spaces) == nil)
        #expect(OSThreads.space(of: thread("d", .working, updated: 1, repo: nil), spaces: spaces) == nil, "sans dépôt ni demande au poste : aucun espace")

        let desk = try #require(OSThreads.build(runs: [], inbox: nil, requests: [try request("q1", "Relance Durand", "running", at: 1)]).first)
        #expect(OSThreads.space(of: desk, spaces: spaces)?.id == "s2")
        #expect(OSThreads.space(of: desk, spaces: [spaces[0]]) == nil, "aucun espace ne porte le poste")

        let local = try #require(OSThreads.build(runs: [], inbox: nil, localSessions: [session("s1", repo: "boutique")]).first)
        #expect(OSThreads.space(of: local, spaces: spaces)?.id == "s1", "une session locale suit le dépôt où elle travaille")
        #expect(OSThreads.space(ofRepo: nil, spaces: spaces) == nil && OSThreads.space(ofRepo: "api", spaces: []) == nil)
    }

    // MARK: Décisions

    @Test("les décisions de même sorte forment un lot, dans l'ordre de lecture ; un lot de plusieurs se tranche d'un geste ; aucune sorte vide ; un audit proposé n'est pas une décision")
    func decisionLots() throws {
        let question = HarnessEscalation(id: 7, runId: "r1", category: "schema", question: "Où ?", options: ["a", "b"])
        let inbox = HarnessInbox(
            batches: [
                HarnessEscalationBatch(run: run("r1", "A", .escalated, at: 1), items: [question]),
                HarnessEscalationBatch(run: run("r9", "Fini", .merged, at: 1), items: [question]),
                HarnessEscalationBatch(run: run("r8", "Vide", .escalated, at: 1), items: []),
            ],
            awaiting: [
                run("r2", "B", .awaitingHuman, repo: "docs", step: "specs", at: 2),
                run("r3", "C", .awaitingHuman, at: 3),
                run("r4", "D", .awaitingHuman, step: "specs", at: 4),
            ],
            audits: [HarnessAudit(id: "a1", repo: "demo", state: "proposed"), HarnessAudit(id: "a2", repo: "demo", state: "analysing")]
        )
        let approvals = [
            WorkstationAction(seq: 9, kind: "type", rationale: "r", state: "awaiting_approval"),
            WorkstationAction(seq: 10, kind: "type", rationale: "r", state: "awaiting_approval"),
        ]
        let planned = try JSONDecoder().decode(HarnessIntake.self, from: JSONSerialization.data(withJSONObject: [
            "id": "i1", "text": "t", "source": "console", "repo": "demo", "state": "planned", "exchanges": [] as [Any], "statement": "t",
            "plan": ["kind": "bug", "repo": "demo", "title": "T", "statement": "t"], "createdAt": 1, "updatedAt": 2,
        ] as [String: Any]))
        var classifying = planned
        classifying.id = "i2"
        classifying.state = "classifying"
        let write = try JSONDecoder().decode(AtlassianWrite.self, from: Data(#"{"id":"w1","issueKey":"ACME-1","body":"Fait."}"#.utf8))

        let all = OSDecisions.all(inbox: inbox, approvals: approvals, intakes: [planned, classifying], writes: [write])
        #expect(all.map(\.id) == ["q:r1", "s:r2", "v:r3", "s:r4", "w:9", "w:10", "i:i1", "j:w1"], "l'audit proposé de la boîte n'y est pas")
        #expect(all.map(\.repo) == ["demo", "docs", "demo", "demo", nil, nil, "demo", nil])
        #expect(OSDecisionKind.allCases == [.questions, .specs, .verdict, .approval, .intake, .jira])

        let lots = OSDecisions.lots(all)
        #expect(lots.map(\.kind) == [.questions, .specs, .verdict, .approval, .intake, .jira])
        #expect(lots.map(\.items.count) == [1, 2, 1, 2, 1, 1])
        let specs = try #require(lots.first { $0.kind == .specs })
        #expect(specs.isBatch && specs.id == "specs" && specs.runIds == ["r2", "r4"], "deux specs : un seul geste peut les valider")
        #expect(specs.items.map(\.id) == ["s:r2", "s:r4"])
        #expect(lots.first { $0.kind == .verdict }?.isBatch == false)
        #expect(lots.first { $0.kind == .approval }?.runIds.isEmpty == true)

        #expect(OSDecisions.of(runId: "r2", inbox: inbox).map(\.id) == ["s:r2"])
        #expect(OSDecisions.of(runId: "r9", inbox: inbox).isEmpty, "les questions d'une feature terminée n'attendent plus personne")
        #expect(OSDecisions.lots([]).isEmpty && OSDecisions.all(inbox: nil).isEmpty)
    }

    @Test("chaque décision a son espace : celui de son dépôt, l'espace du poste pour un envoi ou une Demande au poste, l'espace du projet Jira pour un commentaire ; l'espace retenu ne garde que les siennes, et le rangement par espace met le hors-espace en dernier")
    func decisionSpaces() throws {
        let spaces = [
            HarnessSpace(id: "s1", name: "Acme", repos: ["boutique"], jiraProjects: ["acme"]),
            HarnessSpace(id: "s2", name: "Perso", repos: ["demo"], poste: true),
        ]
        let review = OSDecision.verdict(run("r1", "A", .awaitingHuman, repo: "boutique", at: 1))
        let specs = OSDecision.specs(run("r2", "B", .awaitingHuman, repo: "demo", step: "specs", at: 2))
        let orphan = OSDecision.verdict(run("r3", "C", .awaitingHuman, repo: "ailleurs", at: 3))
        let send = OSDecision.approval(WorkstationAction(seq: 9, kind: "type", rationale: "r", state: "awaiting_approval"))
        let comment = OSDecision.jira(try JSONDecoder().decode(AtlassianWrite.self, from: Data(#"{"id":"w1","issueKey":"ACME-12","body":"Fait."}"#.utf8)))
        let stray = OSDecision.jira(try JSONDecoder().decode(AtlassianWrite.self, from: Data(#"{"id":"w2","issueKey":"AUTRE-1","body":"Fait."}"#.utf8)))
        let desk = OSDecision.intake(try JSONDecoder().decode(HarnessIntake.self, from: JSONSerialization.data(withJSONObject: [
            "id": "i1", "text": "t", "source": "console", "state": "planned", "exchanges": [] as [Any], "statement": "t",
            "plan": ["kind": "workstation_request", "title": "T", "statement": "t"], "createdAt": 1, "updatedAt": 2,
        ] as [String: Any])))
        let all = [review, specs, orphan, send, comment, stray, desk]

        #expect(all.map { OSDecisions.space(of: $0, spaces: spaces)?.id } == ["s1", "s2", nil, "s2", "s1", nil, "s2"])
        #expect(OSDecisions.space(of: send, spaces: [spaces[0]]) == nil, "aucun espace ne porte le poste")
        #expect(desk.repo == nil && review.repo == "boutique")

        #expect(OSDecisions.scoped(all, spaceId: "s1", spaces: spaces).map(\.id) == ["v:r1", "j:w1"])
        #expect(OSDecisions.scoped(all, spaceId: "s2", spaces: spaces).map(\.id) == ["s:r2", "w:9", "i:i1"])
        #expect(OSDecisions.scoped(all, spaceId: nil, spaces: spaces) == all && OSDecisions.scoped(all, spaceId: "inconnu", spaces: spaces) == all)

        let groups = OSDecisions.bySpace(all, spaces: spaces)
        #expect(groups.map { $0.space?.id } == ["s1", "s2", nil])
        #expect(groups.map { $0.items.map(\.id) } == [["v:r1", "j:w1"], ["s:r2", "w:9", "i:i1"], ["v:r3", "j:w2"]])
        #expect(OSDecisions.bySpace([specs], spaces: spaces).map(\.id) == ["s2"], "aucun groupe vide")
        #expect(OSDecisions.bySpace(all, spaces: []).map(\.items.count) == [7], "sans espace sur le serveur : un seul groupe")
        #expect(OSDecisionLot(kind: .verdict, items: [review], spaceId: "s1").id == "s1/verdict" && OSDecisionLot(kind: .verdict, items: [review]).id == "verdict")
    }

    @Test("les décisions du serveur relié réunissent la boîte et les Demandes ouvertes")
    func decisionsOfServer() async throws {
        let inbox = #"{"cursor":1,"batches":[],"decisions":[],"runs":[],"awaiting":["# + osRunJSON("r2", state: "awaiting_human", step: "specs") + "]}"
        let model = await osConnected(osTransport(inbox: inbox, routes: [:]))
        #expect(OSDecisions.all(server: model).map(\.id) == ["s:r2"])
    }

    // MARK: Pouls

    @Test("le pouls garde la dernière activité d'une session locale (`payload.localSession`), outil nommé ou non, à côté de celle des features")
    func localSessionPulse() async throws {
        let transport = osTransport(routes: [:])
        let model = await osConnected(transport)
        transport.stream([
            Data(#"id: 1\#nevent: activity\#ndata: {"at":1700000000000,"runId":null,"payload":{"tool":"edit","intent":"Corrige l'export\nen CSV","localSession":"s1"}}\#n\#n"#.utf8),
            Data(#"id: 2\#nevent: activity\#ndata: {"at":1700000001000,"runId":null,"payload":{"intent":"Relit les specs","localSession":"s2"}}\#n\#n"#.utf8),
            Data(#"id: 3\#nevent: activity\#ndata: {"at":1700000002000,"runId":"r1","payload":{"tool":"bash","intent":""}}\#n\#n"#.utf8),
            Data(#"id: 4\#nevent: activity\#ndata: {"at":1700000003000,"runId":null,"payload":{"intent":"Sans outil ni session"}}\#n\#n"#.utf8),
            Data(#"id: 5\#nevent: activity\#ndata: {"at":1700000004000,"runId":null,"payload":{"localSession":"s3"}}\#n\#n"#.utf8),
        ])
        let pulse = OSPulse(harness: model)
        pulse.start()
        #expect(await eventually { pulse.activity[.run("r1")] != nil })
        pulse.stop()

        #expect(transport.calls.contains { $0.path == "/v1/events?live=1&after=42" })
        let first = try #require(pulse.activity[.localSession("s1")])
        #expect(first.tool == "edit" && first.line == "Corrige l'export" && first.at == Date(timeIntervalSince1970: 1_700_000_000))
        #expect(pulse.activity[.localSession("s2")] == OSActivity(tool: nil, line: "Relit les specs", at: Date(timeIntervalSince1970: 1_700_000_001)))
        #expect(pulse.activity[.run("r1")]?.line == "bash", "sans intention : l'outil")
        #expect(pulse.activity[.system] == nil, "hors session locale, une activité sans outil ne dit rien")
        #expect(pulse.activity[.localSession("s3")] == nil, "ni intention ni outil : rien à montrer")
        let now = Date(timeIntervalSince1970: 1_700_000_030)
        #expect(pulse.current(.localSession("s1"), now: now) == first)
        #expect(pulse.current(.localSession("s1"), now: now.addingTimeInterval(120)) == nil, "une activité de plus de 90 s n'est plus montrée")
    }
}
