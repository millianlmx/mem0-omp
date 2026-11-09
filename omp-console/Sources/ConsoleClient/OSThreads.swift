// PROTOTYPE « OS agentique » (branche proto/os-fils) : les FILS. Un fil est une
// intention, de la demande au résultat : il réunit les features d'un même projet,
// d'une même chaîne de suites (`afterRun`, « Suite de « … » »), d'une même issue
// relancée, la demande au poste ou l'audit qui en est l'origine. Le regroupement se
// fait ici, côté client, à partir de ce que le serveur sert déjà ; le serveur pourra
// le servir lui-même (`GET /v1/threads`) une fois le paradigme validé.
//
// Pur : aucune vue, aucun réseau. Les écrans du prototype lisent `OSThreads.build`.

import Foundation

/// Où en est un fil, dans l'ordre de lecture : ce qui vous attend d'abord.
public enum OSPhase: Int, Comparable, Sendable {
    case yours, working, queued, done, failed, stopped

    public static func < (lhs: OSPhase, rhs: OSPhase) -> Bool { lhs.rawValue < rhs.rawValue }

    /// Le fil est encore vivant (rien de terminé).
    public var isLive: Bool { self == .yours || self == .working || self == .queued }
}

/// Qui a ouvert le fil.
public enum OSOrigin: Equatable, Sendable {
    /// Vous (ou un client nommé), éventuellement par une Demande.
    case person(String?)
    /// Une issue du dépôt, relevée par le serveur.
    case issue(Int)
    /// Un incident de la vigie, publié en issue ou non.
    case vigie(Int?)
    /// Un audit du dépôt.
    case audit(String)
    /// Le pilote de l'usine.
    case factory
}

/// Un fil : une intention et tout ce que l'OS a fait pour elle.
public struct OSThread: Identifiable, Equatable, Sendable {
    public var id: String
    public var title: String
    public var repo: String?
    public var origin: OSOrigin
    /// Les features du fil, de la plus ancienne à la plus récente.
    public var runs: [HarnessRun]
    /// Les demandes au poste qui forment le fil (les tentatives d'une même consigne), s'il en est.
    public var requests: [WorkstationRequest]
    /// L'audit du fil (origine d'un projet, ou audit encore ouvert).
    public var audit: HarnessAudit?
    /// La Demande qui a ouvert le fil, si le serveur l'a gardée.
    public var intake: HarnessIntake?
    public var phase: OSPhase
    /// Ce qui attend l'humain dans ce fil (questions, specs, verdicts, propositions).
    public var pending: Int
    /// Les décisions prises seules, à relire.
    public var autonomous: Int
    public var cost: Double
    public var createdAt: Double
    public var updatedAt: Double

    /// La feature qui travaille ou attend en ce moment, sinon la dernière livrée, sinon la dernière.
    public var focusRun: HarnessRun? {
        runs.last { OSThreads.phase(of: $0, inbox: nil).isLive } ?? runs.last { $0.phase == .merged } ?? runs.last
    }

    /// Les features vivantes du fil.
    public var liveRuns: [HarnessRun] { runs.filter { OSThreads.phase(of: $0, inbox: nil).isLive } }

    /// La dernière demande au poste du fil.
    public var request: WorkstationRequest? { requests.last }
}

/// Une section de la liste des fils ; les fils arrêtés vont à part, repliés.
public enum OSThreadSection: Int, CaseIterable, Identifiable, Sendable {
    case yours, working, queued, today, yesterday, week, earlier, stopped

    public var id: Int { rawValue }
}

public enum OSThreads {
    // MARK: Titres

    /// Un titre lisible : sans « Suite de « … » » ni « Découpage de « … » », sans préfixe
    /// d'issue ni de commit conventionnel, sans compteur `×N` ni identifiant de runner. Rend
    /// aussi le numéro d'issue retiré et si le titre d'origine était tronqué.
    public static func clean(_ raw: String) -> (title: String, issue: Int?, truncated: Bool) {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var truncated = false
        while let wrapper = ["Suite de « ", "Découpage de « "].first(where: { text.hasPrefix($0) }) {
            text = String(text.dropFirst(wrapper.count))
            if text.hasSuffix(" »") {
                text = String(text.dropLast(2))
            } else {
                truncated = true
            }
        }
        var issue: Int?
        if let match = text.firstMatch(of: #/^Issue #(\d+) : /#) {
            issue = Int(match.1)
            text = String(text[match.range.upperBound...])
        }
        text = text.replacing(#/ — omp-runner-\S+/#, with: "")
        text = text.replacing(#/ ×\d+/#, with: "")
        text = text.replacing(#/^[a-z]+(\([^)]*\))?!?: /#, with: "")
        text = text.trimmingCharacters(in: .whitespaces)
        if let first = text.first, first.isLowercase {
            text = first.uppercased() + text.dropFirst()
        }
        return (text.isEmpty ? raw : text, issue, truncated)
    }

    // MARK: Phases

    /// La phase d'une feature ; avec la boîte, une feature qui attend un geste est à vous.
    public static func phase(of run: HarnessRun, inbox: HarnessInbox?) -> OSPhase {
        if let inbox, pending(of: run.id, inbox: inbox) > 0 { return .yours }
        switch run.phase {
        case .queued: return .queued
        case .running, .merging: return .working
        case .escalated, .awaitingHuman: return .yours
        case .merged: return .done
        case .failed: return .failed
        case .cancelled: return .stopped
        case nil: return .working
        }
    }

    /// Ce que la boîte attend de l'humain pour une feature.
    public static func pending(of runId: String, inbox: HarnessInbox) -> Int {
        let questions = inbox.openBatches.filter { $0.id == runId }.reduce(0) { $0 + $1.items.count }
        let waiting = inbox.awaiting.contains { $0.id == runId } ? 1 : 0
        return questions + waiting
    }

    public static func phase(of request: WorkstationRequest) -> OSPhase {
        switch request.state {
        case .queued: .queued
        case .running: .working
        case .done: .done
        case .failed: .failed
        case .cancelled: .stopped
        }
    }

    // MARK: Regroupement

    /// Les fils, de ce qui vous attend à ce qui est fini, les plus récents d'abord.
    public static func build(
        runs: [HarnessRun],
        inbox: HarnessInbox?,
        projects: [HarnessProject] = [],
        audits: [HarnessAudit] = [],
        intakes: [HarnessIntake] = [],
        requests: [WorkstationRequest] = [],
        incidents: [VigieIncident] = []
    ) -> [OSThread] {
        // Les features vivantes de la boîte priment : elles sont plus fraîches que l'historique.
        var byId: [String: HarnessRun] = [:]
        for run in runs { byId[run.id] = run }
        for run in (inbox?.runs ?? []) + (inbox?.awaiting ?? []) + (inbox?.batches.compactMap(\.run) ?? []) {
            byId[run.id] = run
        }
        let all = byId.values.sorted { $0.createdAt < $1.createdAt }

        var groups = UnionFind(all.map(\.id))
        var cleaned: [String: (title: String, issue: Int?, truncated: Bool)] = [:]
        var firstByProject: [String: String] = [:]
        var firstByTitle: [String: String] = [:]
        for run in all {
            let clean = clean(run.title)
            cleaned[run.id] = clean
            if let parent = run.afterRun, byId[parent] != nil { groups.union(run.id, parent) }
            if let project = run.projectId {
                if let first = firstByProject[project] { groups.union(run.id, first) } else { firstByProject[project] = run.id }
            }
            let key = run.repo + "|" + clean.title.lowercased()
            if let first = firstByTitle[key] { groups.union(run.id, first) } else { firstByTitle[key] = run.id }
        }
        // Un titre de suite tronqué rejoint le fil dont le titre le prolonge.
        for run in all {
            guard let clean = cleaned[run.id], clean.truncated else { continue }
            let prefix = clean.title.lowercased()
            if let other = all.first(where: { $0.id != run.id && $0.repo == run.repo && cleaned[$0.id]?.title.lowercased().hasPrefix(prefix) == true }) {
                groups.union(run.id, other.id)
            }
        }

        var members: [String: [HarnessRun]] = [:]
        for run in all { members[groups.find(run.id), default: []].append(run) }

        let intakeByRun = Dictionary(
            intakes.compactMap { intake in intake.created.flatMap { $0.kind == "run" ? ($0.id, intake) : nil } },
            uniquingKeysWith: { first, _ in first }
        )
        let intakeByRequest = Dictionary(
            intakes.compactMap { intake in intake.created.flatMap { $0.kind == "workstation_request" ? ($0.id, intake) : nil } },
            uniquingKeysWith: { first, _ in first }
        )
        let vigieByRun = Dictionary(incidents.compactMap { incident in incident.fixRunId.map { ($0, incident) } }, uniquingKeysWith: { first, _ in first })
        let projectsById = Dictionary(projects.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let auditByProject = Dictionary(audits.compactMap { audit in audit.projectId.map { ($0, audit) } }, uniquingKeysWith: { first, _ in first })

        var threads: [OSThread] = members.map { root, runs in
            let first = runs[0]
            let project = runs.lazy.compactMap(\.projectId).first.flatMap { projectsById[$0] }
            let audit = runs.lazy.compactMap(\.projectId).first.flatMap { auditByProject[$0] }
            let intake = runs.lazy.compactMap { intakeByRun[$0.id] }.first
            let issue = runs.lazy.compactMap { cleaned[$0.id]?.issue }.first
            let incident = runs.lazy.compactMap { vigieByRun[$0.id] }.first
            let origin: OSOrigin
            if let incident { origin = .vigie(incident.issueNumber) }
            else if let issue { origin = .issue(issue) }
            else if let audit { origin = .audit(audit.focus) }
            else if first.createdBy?.hasPrefix("pilote") == true { origin = .factory }
            else { origin = .person(intake?.by ?? first.createdBy) }
            let title = intake?.plan?.title ?? project.map { clean($0.title).title } ?? cleaned[first.id]?.title ?? first.title
            let phases = runs.map { phase(of: $0, inbox: inbox) }
            let phase: OSPhase
            if let live = phases.filter(\.isLive).min() {
                phase = live
            } else if phases.contains(.done) {
                phase = .done
            } else {
                phase = phases.last ?? .stopped
            }
            let pending = inbox.map { inbox in runs.reduce(0) { $0 + Self.pending(of: $1.id, inbox: inbox) } } ?? 0
            let autonomous = inbox.map { inbox in inbox.decisions.filter { decision in runs.contains { $0.id == decision.runId } }.count } ?? 0
            let cost = runs.reduce(0) { $0 + (inbox?.costs[$1.id] ?? 0) }
            return OSThread(
                id: "r:" + root, title: title, repo: first.repo, origin: origin, runs: runs, requests: [], audit: audit,
                intake: intake, phase: phase, pending: pending, autonomous: autonomous, cost: cost,
                createdAt: first.createdAt, updatedAt: runs.map(\.updatedAt).max() ?? first.updatedAt
            )
        }

        // Les demandes au poste de même consigne sont les tentatives d'une même intention.
        var byInstruction: [String: [WorkstationRequest]] = [:]
        for request in requests.sorted(by: { $0.createdAt < $1.createdAt }) {
            byInstruction[request.instruction.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), default: []].append(request)
        }
        for attempts in byInstruction.values {
            guard let first = attempts.first, let last = attempts.last else { continue }
            let intake = attempts.lazy.compactMap { intakeByRequest[$0.id] }.first
            let phases = attempts.map(Self.phase(of:))
            threads.append(OSThread(
                id: "w:" + first.id, title: intake?.plan?.title ?? firstLine(first.instruction), repo: nil,
                origin: .person(first.by), runs: [], requests: attempts, audit: nil, intake: intake,
                phase: phases.filter(\.isLive).min() ?? (phases.contains(.done) ? .done : phases.last ?? .stopped),
                pending: 0, autonomous: 0, cost: 0,
                createdAt: first.createdAt, updatedAt: last.updatedAt
            ))
        }

        // Un audit ouvert sans projet encore : son propre fil.
        for audit in audits where audit.isOpen && audit.projectId == nil {
            threads.append(OSThread(
                id: "a:" + audit.id, title: audit.focus.isEmpty ? audit.repo : firstLine(audit.focus), repo: audit.repo,
                origin: .audit(audit.focus), runs: [], requests: [], audit: audit, intake: nil,
                phase: audit.isProposed ? .yours : .working, pending: audit.isProposed ? 1 : 0, autonomous: 0, cost: 0,
                createdAt: audit.createdAt, updatedAt: audit.createdAt
            ))
        }

        return threads.sorted { lhs, rhs in
            if lhs.phase.isLive != rhs.phase.isLive { return lhs.phase.isLive }
            if lhs.phase.isLive, lhs.phase != rhs.phase { return lhs.phase < rhs.phase }
            return lhs.updatedAt > rhs.updatedAt
        }
    }

    /// Les fils rangés en sections : vivants par phase, terminés par ancienneté.
    public static func sections(_ threads: [OSThread], now: Date = Date(), calendar: Calendar = .current) -> [(OSThreadSection, [OSThread])] {
        var buckets: [OSThreadSection: [OSThread]] = [:]
        let today = calendar.startOfDay(for: now).timeIntervalSince1970 * 1000
        let day = 86_400_000.0
        for thread in threads {
            let section: OSThreadSection
            switch thread.phase {
            case .yours: section = .yours
            case .working: section = .working
            case .queued: section = .queued
            case .stopped: section = .stopped
            case .done, .failed:
                let at = thread.updatedAt
                if at >= today {
                    section = .today
                } else if at >= today - day {
                    section = .yesterday
                } else if at >= today - 7 * day {
                    section = .week
                } else {
                    section = .earlier
                }
            }
            buckets[section, default: []].append(thread)
        }
        return OSThreadSection.allCases.compactMap { section in buckets[section].map { (section, $0) } }
    }

    /// La position d'une feature sur le chemin Besoins → Specs → Implémentation → Revue → Fusion (0…4).
    public static func stepIndex(of run: HarnessRun) -> Int {
        switch run.phase {
        case .merging, .merged: return 4
        default: break
        }
        switch run.step {
        case "req": return 0
        case "specs": return 1
        case "impl": return 2
        case "review", "fix": return 3
        default: return run.phase == .queued ? 0 : 2
        }
    }

    /// La première ligne non vide d'un texte, sans balisage Markdown de tête.
    public static func firstLine(_ text: String) -> String {
        let line = text.split(whereSeparator: \.isNewline).lazy.map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty } ?? ""
        return line.replacing(#/^[#>*\-\s]+/#, with: "").replacingOccurrences(of: "**", with: "")
    }

    /// La première phrase utile d'un document Markdown : la première ligne qui n'est pas un titre.
    public static func gist(_ text: String) -> String {
        let lines = text.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let body = lines.first { !$0.hasPrefix("#") } ?? lines.first ?? ""
        return firstLine(body)
    }

    /// Les `count` premières lignes utiles d'un texte, en un bloc : l'aperçu d'un compte rendu.
    public static func preview(_ text: String, lines count: Int) -> String {
        text.split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") }
            .prefix(count)
            .joined(separator: "\n")
    }
}

/// Union-find sur des identifiants : le représentant d'un groupe est le plus ancien membre lu.
private struct UnionFind {
    private var parent: [String: String] = [:]

    init(_ ids: [String]) {
        for id in ids { parent[id] = id }
    }

    mutating func find(_ id: String) -> String {
        var root = id
        while let next = parent[root], next != root { root = next }
        var node = id
        while let next = parent[node], next != root {
            parent[node] = root
            node = next
        }
        return root
    }

    mutating func union(_ a: String, _ b: String) {
        let rootA = find(a)
        let rootB = find(b)
        guard rootA != rootB else { return }
        parent[rootA] = rootB
    }
}
