// Le DIRECT de la session OMP d'une feature : ce que l'agent du serveur écrit, son
// raisonnement et chaque outil qu'il lance, en temps réel. Le serveur garde les
// dernières entrées de chaque run (`GET /v1/runs/{id}/session`) et pousse chaque
// entrée nouvelle ou modifiée en événement éphémère `session` sur
// `GET /v1/events?run=…&live=1` : une entrée de même `seq` REMPLACE la précédente (un
// paragraphe qui s'allonge, un outil qui se termine).
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

/// La réponse de `GET /v1/runs/{id}/session`.
public struct HarnessSessionView: Codable, Equatable, Sendable {
    public var runId: String
    /// Le run est conduit en ce moment par le serveur (un agent peut écrire).
    public var live: Bool
    /// Le curseur du journal au moment de la lecture.
    public var cursor: Int
    public var entries: [HarnessSessionEntry]

    public init(runId: String, live: Bool, cursor: Int = 0, entries: [HarnessSessionEntry] = []) {
        self.runId = runId
        self.live = live
        self.cursor = cursor
        self.entries = entries
    }
}

/// Le direct suivi par l'app : une feature à la fois.
public struct HarnessSessionFeed: Equatable, Sendable {
    /// Les entrées gardées par l'app (comme le serveur) : les plus anciennes partent.
    public static let keep = 200

    public var runId: String
    /// Les entrées, dans l'ordre de leur `seq`.
    public private(set) var entries: [HarnessSessionEntry]
    /// Le run est conduit en ce moment par le serveur.
    public var isRunning: Bool
    /// Le tampon du serveur a été lu au moins une fois.
    public var isLoaded: Bool

    public init(runId: String, entries: [HarnessSessionEntry] = [], isRunning: Bool = false, isLoaded: Bool = false) {
        self.runId = runId
        self.entries = []
        self.isRunning = isRunning
        self.isLoaded = isLoaded
        for entry in entries { apply(entry) }
    }

    /// Le tampon du serveur, qui fait foi (à l'ouverture et après une coupure).
    public mutating func load(_ view: HarnessSessionView) {
        entries = []
        for entry in view.entries { apply(entry) }
        isRunning = view.live
        isLoaded = true
    }

    /// Le tampon relu en cours de route (changement d'état du run) : ses entrées
    /// rejoignent celles déjà reçues par le flux, sans en retirer.
    public mutating func merge(_ view: HarnessSessionView) {
        for entry in view.entries { apply(entry) }
        isRunning = view.live
        isLoaded = true
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
}

extension HarnessRun {
    /// La feature a un direct à suivre : un agent y travaille, va y travailler, attend
    /// l'humain, ou vient d'échouer (son tampon dit pourquoi). Fusionnée ou arrêtée,
    /// elle n'en a plus.
    public var canFollowSession: Bool {
        guard let phase else { return false }
        return phase != .merged && phase != .cancelled
    }
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
