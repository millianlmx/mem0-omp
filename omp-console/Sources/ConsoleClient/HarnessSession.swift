// Le DIRECT de la session OMP d'une feature (ou de l'analyse d'un audit) : ce que
// l'agent du serveur écrit, son raisonnement et chaque outil qu'il lance, en temps
// réel. Le serveur écrit la session en base (`GET /v1/runs/{id}/session`, page par page
// avec `?before=`) et pousse chaque entrée nouvelle ou modifiée en événement éphémère
// `session` sur `GET /v1/events?run=…&live=1` (`audit=…` pour un audit) : une entrée de
// même `seq` REMPLACE la précédente (un paragraphe qui s'allonge, un outil qui se
// termine). Le même flux porte la sortie des tests en direct (`test_output`).
//
// Aucun texte ici : les écrans traduisent `kind`, `status` et les codes des signaux
// avec `PipelineServerText`.

import Foundation

/// Les sortes d'entrées du direct.
public enum HarnessSessionKind: String, Sendable {
    /// Un paragraphe de l'agent.
    case text
    /// Son raisonnement.
    case thinking
    /// Un outil, de son lancement à son résultat.
    case tool
    /// Un signal de la session (contexte compacté, réessai du fournisseur).
    case notice
}

/// Une entrée du direct : un paragraphe de l'agent, son raisonnement, un outil ou un signal.
public struct HarnessSessionEntry: Codable, Equatable, Sendable, Identifiable {
    public var seq: Int
    /// L'instant de sa naissance, en millisecondes depuis 1970.
    public var at: Double
    /// L'étape du run (`specs`, `impl`, `review`, `fix`…) quand l'entrée est née.
    public var step: String?
    /// `text`, `thinking`, `tool` ou `notice` ; une sorte inconnue s'affiche comme du texte.
    public var kind: String
    /// Le texte de l'agent ; pour un outil, son intention ou ses arguments ; pour un signal, son code.
    public var text: String
    public var tool: String?
    /// `running`, `ok` ou `error` pour un outil.
    public var status: String?
    /// La fin du résultat d'un outil terminé.
    public var detail: String?

    public init(seq: Int, at: Double = 0, step: String? = nil, kind: String, text: String, tool: String? = nil, status: String? = nil, detail: String? = nil) {
        self.seq = seq
        self.at = at
        self.step = step
        self.kind = kind
        self.text = text
        self.tool = tool
        self.status = status
        self.detail = detail
    }

    public var id: Int { seq }

    /// La sorte de l'entrée ; une sorte inconnue de cette version de l'app est du texte.
    public var sort: HarnessSessionKind { HarnessSessionKind(rawValue: kind) ?? .text }

    public var isTool: Bool { sort == .tool }
    public var isThinking: Bool { sort == .thinking }
    public var isNotice: Bool { sort == .notice }
    /// Un outil lancé, pas encore terminé.
    public var isRunning: Bool { isTool && status == "running" }
    public var isFailure: Bool { status == "error" }
}

/// Ce dont on suit le direct : une feature, ou l'analyse d'un audit.
public enum HarnessSessionTarget: Equatable, Hashable, Sendable {
    case run(String)
    case audit(String)

    public var id: String {
        switch self {
        case let .run(id), let .audit(id): id
        }
    }

    /// Le chemin du tampon (`?before=` y remonte page par page).
    func sessionPath(_ encoded: String) -> String {
        switch self {
        case .run: "/v1/runs/\(encoded)/session"
        case .audit: "/v1/audits/\(encoded)/session"
        }
    }

    /// Le filtre du flux d'événements.
    func streamQuery(_ encoded: String) -> String {
        switch self {
        case .run: "run=\(encoded)"
        case .audit: "audit=\(encoded)"
        }
    }
}

/// La réponse de `GET /v1/runs/{id}/session` (ou `/v1/audits/{id}/session`).
public struct HarnessSessionView: Codable, Equatable, Sendable {
    public var runId: String?
    public var auditId: String?
    /// Le run (ou l'audit) est conduit en ce moment par le serveur (un agent peut écrire).
    public var live: Bool
    /// Le curseur du journal au moment de la lecture.
    public var cursor: Int
    public var entries: [HarnessSessionEntry]
    /// Il reste des entrées plus anciennes (`?before=` la première seq) ; absent d'un serveur plus ancien.
    public var more: Bool?

    public init(runId: String? = nil, auditId: String? = nil, live: Bool, cursor: Int = 0, entries: [HarnessSessionEntry] = [], more: Bool? = nil) {
        self.runId = runId
        self.auditId = auditId
        self.live = live
        self.cursor = cursor
        self.entries = entries
        self.more = more
    }
}

/// Le direct suivi par l'app : une feature (ou un audit) à la fois.
public struct HarnessSessionFeed: Equatable, Sendable {
    /// Les entrées gardées par l'app, pages antérieures comprises : les plus anciennes partent au-delà.
    public static let keep = 2000

    public var target: HarnessSessionTarget
    /// Les entrées, dans l'ordre de leur `seq`.
    public private(set) var entries: [HarnessSessionEntry]
    /// Le run (ou l'audit) est conduit en ce moment par le serveur.
    public var isRunning: Bool
    /// Le tampon du serveur a été lu au moins une fois.
    public var isLoaded: Bool
    /// Le serveur garde des entrées plus anciennes que la première reçue (une session se rejoue).
    public var hasEarlier: Bool
    /// Les derniers jobs de tests de la feature et leur sortie, en direct.
    public var tests: [HarnessTestJob]

    public init(target: HarnessSessionTarget, entries: [HarnessSessionEntry] = [], isRunning: Bool = false, isLoaded: Bool = false, hasEarlier: Bool = false, tests: [HarnessTestJob] = []) {
        self.target = target
        self.entries = []
        self.isRunning = isRunning
        self.isLoaded = isLoaded
        self.hasEarlier = hasEarlier
        self.tests = tests
        for entry in entries { apply(entry) }
    }

    /// L'identifiant suivi (run ou audit).
    public var targetId: String { target.id }

    /// Le tampon du serveur, qui fait foi (à l'ouverture et après une coupure).
    public mutating func load(_ view: HarnessSessionView) {
        entries = []
        for entry in view.entries { apply(entry) }
        isRunning = view.live
        isLoaded = true
        hasEarlier = view.more ?? false
    }

    /// Le tampon relu en cours de route (changement d'état du run) : ses entrées
    /// rejoignent celles déjà reçues par le flux, sans en retirer.
    public mutating func merge(_ view: HarnessSessionView) {
        for entry in view.entries { apply(entry) }
        isRunning = view.live
        isLoaded = true
    }

    /// Une page plus ancienne (`?before=`) : ses entrées passent devant, sans en retirer.
    public mutating func prepend(_ view: HarnessSessionView) {
        let known = Set(entries.map(\.seq))
        entries = view.entries.filter { !known.contains($0.seq) } + entries
        entries.sort { $0.seq < $1.seq }
        hasEarlier = view.more ?? false
    }

    /// Une entrée reçue : elle remplace celle de même `seq`, sinon prend sa place dans l'ordre.
    public mutating func apply(_ entry: HarnessSessionEntry) {
        if let index = entries.lastIndex(where: { $0.seq == entry.seq }) {
            entries[index] = entry
            return
        }
        if let last = entries.last, last.seq > entry.seq {
            let index = entries.firstIndex { $0.seq > entry.seq } ?? entries.endIndex
            entries.insert(entry, at: index)
        } else {
            entries.append(entry)
        }
        if entries.count > Self.keep { entries.removeFirst(entries.count - Self.keep) }
    }

    /// L'outil en cours, s'il y en a un : ce que l'agent fait à l'instant.
    public var current: HarnessSessionEntry? { entries.last(where: \.isRunning) }

    /// Le job de tests en cours, s'il y en a un.
    public var runningTest: HarnessTestJob? { tests.last(where: \.isRunning) }
}

extension HarnessRun {
    /// La feature a un direct à suivre — ou à rejouer : le serveur garde sa session, même
    /// fusionnée ou arrêtée. Seule une feature encore en file n'a rien dit.
    public var canFollowSession: Bool {
        phase != .queued || step != "req" || fixes > 0
    }
}

extension HarnessAudit {
    /// L'analyse a un direct : en cours, ou à rejouer une fois rendue.
    public var canFollowSession: Bool { state != "queued" }
}

/// Un événement du flux SSE : son nom et ses données brutes (la ligne `data:`).
public struct HarnessStreamEvent: Equatable, Sendable {
    public var name: String
    public var data: Data

    public init(name: String, data: Data) {
        self.name = name
        self.data = data
    }

    /// L'entrée du direct que porte un événement `session` ; `nil` pour tout autre événement.
    public var sessionEntry: HarnessSessionEntry? {
        guard name == "session" else { return nil }
        return (try? JSONDecoder().decode(SessionEnvelope.self, from: data))?.payload.entry
    }

    /// Le run de l'événement, s'il en a un.
    public var runId: String? {
        (try? JSONDecoder().decode(RunEnvelope.self, from: data))?.runId
    }

    /// Le morceau de sortie de tests que porte un événement `test_output` ; `nil` pour tout autre événement.
    public var testOutput: HarnessTestOutput? {
        guard name == "test_output" else { return nil }
        return (try? JSONDecoder().decode(TestOutputEnvelope.self, from: data))?.payload
    }
}

private struct TestOutputEnvelope: Decodable {
    var payload: HarnessTestOutput
}

private struct SessionEnvelope: Decodable {
    struct Payload: Decodable {
        var entry: HarnessSessionEntry
    }

    var payload: Payload
}

private struct RunEnvelope: Decodable {
    var runId: String?
}
