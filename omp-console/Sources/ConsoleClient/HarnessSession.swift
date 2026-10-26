// Le DIRECT de la session OMP d'une feature (ou de l'analyse d'un audit) : ce que
// l'agent du serveur écrit, son raisonnement et chaque outil qu'il lance, en temps
// réel. Le serveur écrit la session en base (`GET /v1/runs/{id}/session`, page par page
// avec `?before=`) et pousse chaque entrée nouvelle ou modifiée en événement éphémère
// `session` sur `GET /v1/events?run=…&live=1` (`audit=…` pour un audit) : une entrée de
// même `seq` REMPLACE la précédente (un paragraphe qui s'allonge, un outil qui se
// termine). Le même flux porte la sortie des tests en direct (`test_output`).
//
// Le DÉTAIL d'une entrée se lit à part, quand on l'ouvre (`GET /v1/runs/{id}/session/{seq}`) :
// le RENDU lisible d'un outil (`view` : des blocs de texte, de champs, de listes et de
// fiches de sous-agents, comme OMP l'affiche), sa sortie entière et son JSON brut —
// ceux qui s'écrivent pour un outil en cours —, ou le texte entier d'un paragraphe
// trop long pour son entrée. Un appel `task` porte aussi ses sous-agents en une ligne
// dans l'entrée (`agents`), mis à jour en direct.
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
    /// La fin du résultat d'un outil terminé (ou de sa sortie en cours d'écriture).
    public var detail: String?
    /// L'appel d'un outil en une ligne (sa commande, son chemin…), même quand `text` porte son intention ;
    /// absent d'un serveur plus ancien.
    public var call: String?
    /// L'instant où l'outil s'est terminé, en millisecondes depuis 1970.
    public var endedAt: Double?
    /// Le détail de l'entrée se lit à part (`HarnessModel.sessionDetail`) ; absent d'un serveur plus ancien.
    public var hasDetails: Bool?
    /// Les sous-agents d'un appel `task`, en une ligne chacun ; absent pour tout autre outil.
    public var agents: [HarnessAgentLine]?

    public init(seq: Int, at: Double = 0, step: String? = nil, kind: String, text: String, tool: String? = nil, status: String? = nil, detail: String? = nil, call: String? = nil, endedAt: Double? = nil, hasDetails: Bool? = nil, agents: [HarnessAgentLine]? = nil) {
        self.seq = seq
        self.at = at
        self.step = step
        self.kind = kind
        self.text = text
        self.tool = tool
        self.status = status
        self.detail = detail
        self.call = call
        self.endedAt = endedAt
        self.hasDetails = hasDetails
        self.agents = agents
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
    /// Le détail de l'entrée peut s'ouvrir.
    public var canOpenDetails: Bool { hasDetails == true }

    /// L'appel de l'outil quand il dit autre chose que le texte de l'entrée (son intention) ; `nil` sinon.
    public var distinctCall: String? {
        guard let call, !call.isEmpty, call != text else { return nil }
        return call
    }

    /// La durée d'un outil terminé, en millisecondes.
    public var durationMs: Double? {
        guard let endedAt, at > 0, endedAt >= at else { return nil }
        return endedAt - at
    }
}

/// La réponse de `GET /v1/runs/{id}/session/{seq}` (ou `/v1/audits/{id}/session/{seq}`) :
/// une entrée et son détail.
public struct HarnessSessionDetail: Codable, Equatable, Sendable {
    public var runId: String?
    public var auditId: String?
    public var entry: HarnessSessionEntry
    /// Les arguments d'un outil en JSON brut (un serveur 1.10 : une ligne `clé: valeur` par argument).
    public var args: String?
    /// La sortie entière d'un outil (celle qui s'écrit s'il tourne encore), ou le texte entier d'un paragraphe.
    public var output: String?
    /// Le résultat d'un outil en JSON brut ; absent d'un serveur plus ancien.
    public var result: String?
    /// Le rendu lisible de l'outil ; absent d'un serveur plus ancien (l'app montre alors `args` et `output`).
    public var view: HarnessToolView?

    public init(runId: String? = nil, auditId: String? = nil, entry: HarnessSessionEntry, args: String? = nil, output: String? = nil, result: String? = nil, view: HarnessToolView? = nil) {
        self.runId = runId
        self.auditId = auditId
        self.entry = entry
        self.args = args
        self.output = output
        self.result = result
        self.view = view
    }

    /// Le serveur a rendu l'outil : le JSON brut se replie sous son rendu.
    public var hasRendering: Bool { !(view?.blocks.isEmpty ?? true) }
}

/// Le rendu d'un appel d'outil : son appel en une ligne et ses blocs, dans l'ordre.
public struct HarnessToolView: Codable, Equatable, Sendable {
    /// L'appel en une ligne : la commande, le chemin, le motif, les sous-agents…
    public var headline: String
    public var blocks: [HarnessToolBlock]
    /// Les sous-agents d'un appel `task`, en une ligne chacun.
    public var agents: [HarnessAgentLine]?

    public init(headline: String, blocks: [HarnessToolBlock], agents: [HarnessAgentLine]? = nil) {
        self.headline = headline
        self.blocks = blocks
        self.agents = agents
    }

    /// L'appel s'affiche en tête du rendu, sauf quand son premier bloc le montre déjà (une commande).
    public var showsHeadline: Bool { !headline.isEmpty && blocks.first?.role != "command" }
}

/// Les sortes de blocs d'un rendu.
public enum HarnessToolBlockKind: String, Sendable {
    /// Un texte, sous une forme (`format`).
    case text
    /// Des paires clé-valeur courtes.
    case fields
    /// Une liste.
    case list
    /// Les fiches des sous-agents.
    case agents
}

/// Les formes d'un bloc de texte.
public enum HarnessToolTextFormat: String, Sendable {
    /// De la prose de l'agent, en Markdown.
    case markdown
    /// Une sortie, un fichier : en chasse fixe, tel quel.
    case code
    /// Des différences : lignes `+` en vert, `-` en rouge.
    case diff
    /// Une commande shell.
    case command
    /// Du texte simple.
    case plain
}

/// Un bloc du rendu : un texte, des champs, une liste ou des fiches de sous-agents.
/// Son `role` est un code que l'app traduit (`command`, `content`, `changes`…) ; à défaut,
/// son `title` vient des données (une clé JSON) et s'affiche tel quel.
public struct HarnessToolBlock: Codable, Equatable, Sendable {
    public var kind: String
    public var role: String?
    public var title: String?
    public var format: String?
    public var text: String?
    public var fields: [HarnessToolField]?
    public var items: [String]?
    public var agents: [HarnessAgentView]?

    public init(kind: String, role: String? = nil, title: String? = nil, format: String? = nil, text: String? = nil, fields: [HarnessToolField]? = nil, items: [String]? = nil, agents: [HarnessAgentView]? = nil) {
        self.kind = kind
        self.role = role
        self.title = title
        self.format = format
        self.text = text
        self.fields = fields
        self.items = items
        self.agents = agents
    }

    /// La sorte du bloc ; une sorte inconnue de cette version de l'app est du texte.
    public var sort: HarnessToolBlockKind { HarnessToolBlockKind(rawValue: kind) ?? .text }

    /// La forme d'un texte ; une forme inconnue est du texte simple.
    public var textFormat: HarnessToolTextFormat { format.flatMap(HarnessToolTextFormat.init(rawValue:)) ?? .plain }

    /// Le bloc rend une erreur de l'outil.
    public var isError: Bool { role == "error" }

    /// Le texte tel qu'il s'affiche : une commande précédée de l'invite du shell.
    public var displayText: String {
        let text = text ?? ""
        return textFormat == .command ? "$ \(text)" : text
    }

    /// Les lignes de différences d'un bloc `diff` : ajouts, retraits, en-têtes de bloc, contexte.
    public var diffLines: [HarnessDiffLine] {
        (text ?? "").split(separator: "\n", omittingEmptySubsequences: false).enumerated().map { index, raw in
            let line = String(raw)
            return HarnessDiffLine(id: index, kind: Self.diffKind(line), text: line.isEmpty ? " " : line)
        }
    }

    static func diffKind(_ line: String) -> HarnessDiffLine.Kind {
        if line.hasPrefix("@@") || line.hasPrefix("+++") || line.hasPrefix("---") { return .hunk }
        if line.hasPrefix("+") { return .added }
        if line.hasPrefix("-") { return .removed }
        return .context
    }
}

/// Une paire clé-valeur d'un bloc de champs.
public struct HarnessToolField: Codable, Equatable, Sendable {
    public var key: String
    public var value: String

    public init(key: String, value: String) {
        self.key = key
        self.value = value
    }
}

/// L'état d'un sous-agent.
public enum HarnessAgentStatus: String, Sendable {
    case pending, running, completed, failed, aborted
    /// Un état inconnu de cette version de l'app.
    case unknown
}

/// Un sous-agent en une ligne : qui il est, où il en est, ce qu'il fait à l'instant.
public struct HarnessAgentLine: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    /// Son type (`task`, `scout`, `reviewer`…).
    public var agent: String
    /// `pending`, `running`, `completed`, `failed` ou `aborted`.
    public var status: String
    public var task: String
    /// Son outil du moment et son intention, ou sa dernière intention.
    public var activity: String?

    public init(id: String, name: String, agent: String, status: String, task: String, activity: String? = nil) {
        self.id = id
        self.name = name
        self.agent = agent
        self.status = status
        self.task = task
        self.activity = activity
    }

    /// Son nom, ou son type s'il n'en a pas.
    public var label: String { name.isEmpty ? agent : name }

    public var state: HarnessAgentStatus { HarnessAgentStatus(rawValue: status) ?? .unknown }

    /// Ce que dit sa ligne sous son nom : ce qu'il fait à l'instant, sinon sa mission.
    public var summary: String { activity ?? task }
}

/// Un appel d'outil d'un sous-agent, en une ligne.
public struct HarnessAgentCall: Codable, Equatable, Sendable {
    public var tool: String
    public var text: String
    public var error: Bool

    public init(tool: String, text: String, error: Bool = false) {
        self.tool = tool
        self.text = text
        self.error = error
    }
}

/// La fiche d'un sous-agent : sa mission, ce qu'il fait, ses derniers outils, ce qu'il a rendu.
public struct HarnessAgentView: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var name: String
    public var agent: String
    public var status: String
    /// Sa mission, entière (Markdown).
    public var task: String
    public var activity: String?
    /// Ses derniers appels d'outils, du plus ancien au plus récent.
    public var recent: [HarnessAgentCall]
    /// Ce qu'il a rendu (Markdown), ou la fin de sa sortie en cours.
    public var output: String?
    public var error: String?
    public var durationMs: Double?
    public var tokens: Double?
    public var cost: Double?
    public var model: String?

    public init(id: String, name: String, agent: String, status: String, task: String, activity: String? = nil, recent: [HarnessAgentCall] = [], output: String? = nil, error: String? = nil, durationMs: Double? = nil, tokens: Double? = nil, cost: Double? = nil, model: String? = nil) {
        self.id = id
        self.name = name
        self.agent = agent
        self.status = status
        self.task = task
        self.activity = activity
        self.recent = recent
        self.output = output
        self.error = error
        self.durationMs = durationMs
        self.tokens = tokens
        self.cost = cost
        self.model = model
    }

    /// Son nom, ou son type s'il n'en a pas.
    public var label: String { name.isEmpty ? agent : name }

    public var state: HarnessAgentStatus { HarnessAgentStatus(rawValue: status) ?? .unknown }

    /// Ce qu'il fait à l'instant, tant qu'il travaille.
    public var currentActivity: String? { state == .running ? activity : nil }
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

    /// Le chemin du détail d'une entrée.
    func entryPath(_ encoded: String, seq: Int) -> String {
        "\(sessionPath(encoded))/\(seq)"
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
