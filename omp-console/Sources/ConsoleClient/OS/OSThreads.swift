// « OS agentique » : les FILS. Un fil est une intention, de la demande au résultat : il
// réunit les features d'un même projet, d'une même chaîne de suites (`afterRun`,
// « Suite de « … » »), d'une même issue relancée, la demande au poste ou l'audit qui en
// est l'origine, et la session omp locale qui y travaille sur une machine de l'humain.
// Le regroupement se fait ici, côté client, à partir de ce que le serveur sert déjà ; le
// serveur pourra le servir lui-même (`GET /v1/threads`) une fois le paradigme validé.
//
// Pur : aucune vue, aucun réseau. Les écrans lisent `OSThreads.build`.

import Foundation
import Synchronization

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
    /// Une session omp locale, sur cette machine de l'humain.
    case local(String)
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
    /// La session omp locale du fil : seule, ou reprise par une feature (passage de relais).
    public var localSession: HarnessLocalSession? = nil
    public var phase: OSPhase
    /// Ce qui attend l'humain dans ce fil (questions, specs, revues).
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
    /// aussi le numéro d'issue retiré et si le titre d'origine était tronqué. Mémorisé par
    /// titre : un titre ne change pas, et chaque construction des fils les relit tous.
    public static func clean(_ raw: String) -> (title: String, issue: Int?, truncated: Bool) {
        if let known = cleanedTitles.withLock({ $0[raw] }) { return known }
        let cleaned = cleaning(raw)
        cleanedTitles.withLock { cache in
            if cache.count >= cleanedTitlesLimit { cache.removeAll(keepingCapacity: true) }
            cache[raw] = cleaned
        }
        return cleaned
    }

    /// Assez pour tout un historique : au-delà, la mémoire se vide et chaque titre se renettoie.
    private static let cleanedTitlesLimit = 32_768
    private static let cleanedTitles = Mutex<[String: (title: String, issue: Int?, truncated: Bool)]>([:])

    private static func cleaning(_ raw: String) -> (title: String, issue: Int?, truncated: Bool) {
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
        if text.hasPrefix("Issue #") {
            let digits = text.dropFirst("Issue #".count).prefix { $0.isASCII && $0.isNumber }
            let rest = text.dropFirst("Issue #".count + digits.count)
            if !digits.isEmpty, rest.hasPrefix(" : ") {
                issue = Int(digits)
                text = String(rest.dropFirst(3))
            }
        }
        text = removingRunnerSuffix(text)
        text = removingCounters(text)
        text = removingCommitPrefix(text)
        text = text.trimmingCharacters(in: .whitespaces)
        if let first = text.first, first.isLowercase {
            text = first.uppercased() + text.dropFirst()
        }
        return (text.isEmpty ? raw : text, issue, truncated)
    }

    // Les nettoyages d'un titre, à la main : une `Regex` par titre et par construction coûtait
    // l'essentiel du calcul des fils sur un long historique.

    /// Sans « — omp-runner-<id> » (jusqu'à l'espace suivante).
    private static func removingRunnerSuffix(_ text: String) -> String {
        var text = text
        while let marker = text.range(of: " — omp-runner-") {
            let end = text[marker.upperBound...].firstIndex(where: \.isWhitespace) ?? text.endIndex
            guard text[marker.upperBound..<end].isEmpty == false else { break }
            text.removeSubrange(marker.lowerBound..<end)
        }
        return text
    }

    /// Sans compteur « ×N ».
    private static func removingCounters(_ text: String) -> String {
        guard text.contains(" ×") else { return text }
        var result = ""
        var index = text.startIndex
        while index < text.endIndex {
            if text[index...].hasPrefix(" ×") {
                let digitsStart = text.index(index, offsetBy: 2)
                let digitsEnd = text[digitsStart...].firstIndex { !($0.isASCII && $0.isNumber) } ?? text.endIndex
                if digitsEnd > digitsStart {
                    index = digitsEnd
                    continue
                }
            }
            result.append(text[index])
            index = text.index(after: index)
        }
        return result
    }

    /// Sans préfixe de commit conventionnel (`feat: `, `fix(api)!: `…).
    private static func removingCommitPrefix(_ text: String) -> String {
        let kind = text.prefix { $0.isASCII && $0.isLowercase }
        guard !kind.isEmpty else { return text }
        var rest = text.dropFirst(kind.count)
        if rest.first == "(" {
            guard let close = rest.firstIndex(of: ")") else { return text }
            rest = rest[rest.index(after: close)...]
        }
        if rest.first == "!" { rest = rest.dropFirst() }
        guard rest.hasPrefix(": ") else { return text }
        return String(rest.dropFirst(2))
    }

    // MARK: Phases

    /// La phase d'une feature ; avec la boîte, une feature qui attend un geste est à vous.
    public static func phase(of run: HarnessRun, inbox: HarnessInbox?) -> OSPhase {
        phase(of: run, pending: inbox.map { pending(of: run.id, inbox: $0) } ?? 0)
    }

    /// La phase d'une feature dont on sait ce qu'elle attend de l'humain.
    public static func phase(of run: HarnessRun, pending: Int) -> OSPhase {
        if pending > 0 { return .yours }
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

    /// `pending(of:inbox:)` pour toutes les features d'un coup : une passe sur la boîte.
    public static func pendingByRun(_ inbox: HarnessInbox?) -> [String: Int] {
        guard let inbox else { return [:] }
        var counts: [String: Int] = [:]
        for batch in inbox.openBatches { counts[batch.id, default: 0] += batch.items.count }
        var waiting = Set<String>()
        for run in inbox.awaiting where waiting.insert(run.id).inserted { counts[run.id, default: 0] += 1 }
        return counts
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

    /// La phase d'une session locale : au travail tant que l'agent agit, en attente (grise)
    /// quand il a rendu la main, finie une fois la session fermée.
    public static func phase(of session: HarnessLocalSession) -> OSPhase {
        switch session.phase {
        case .working, nil: .working
        case .idle: .queued
        case .ended: .done
        }
    }

    // MARK: Espaces

    /// L'espace d'un dépôt : celui qui le compte parmi les siens (un dépôt n'en a qu'un).
    public static func space(ofRepo repo: String?, spaces: [HarnessSpace]) -> HarnessSpace? {
        guard let repo else { return nil }
        return spaces.first { $0.repos.contains(repo) }
    }

    /// L'espace d'un fil, déduit de son dépôt ; une demande au poste (sans dépôt) va à
    /// l'espace qui porte le poste. `nil` : hors de tout espace.
    public static func space(of thread: OSThread, spaces: [HarnessSpace]) -> HarnessSpace? {
        if let space = space(ofRepo: thread.repo, spaces: spaces) { return space }
        return thread.repo == nil && !thread.requests.isEmpty ? spaces.first(where: \.poste) : nil
    }

    // MARK: Regroupement

    /// Les fils, de ce qui vous attend à ce qui est fini, les plus récents d'abord (à égalité,
    /// par identifiant : l'ordre ne bouge pas d'une construction à l'autre). Presque linéaire :
    /// la boîte est indexée une fois (attentes et décisions par feature), les titres nettoyés
    /// sont mémorisés, et chaque feature retrouve son fil par un index.
    public static func build(
        runs: [HarnessRun],
        inbox: HarnessInbox?,
        projects: [HarnessProject] = [],
        audits: [HarnessAudit] = [],
        intakes: [HarnessIntake] = [],
        requests: [WorkstationRequest] = [],
        incidents: [VigieIncident] = [],
        localSessions: [HarnessLocalSession] = []
    ) -> [OSThread] {
        // Les features vivantes de la boîte priment : elles sont plus fraîches que l'historique.
        var byId: [String: HarnessRun] = [:]
        for run in runs { byId[run.id] = run }
        for run in (inbox?.runs ?? []) + (inbox?.awaiting ?? []) + (inbox?.batches.compactMap(\.run) ?? []) {
            byId[run.id] = run
        }
        let all = byId.values.sorted { $0.createdAt != $1.createdAt ? $0.createdAt < $1.createdAt : $0.id < $1.id }

        var groups = UnionFind(all.map(\.id))
        var cleaned: [String: (title: String, issue: Int?, truncated: Bool)] = [:]
        var lowered: [String: String] = [:]
        var firstByProject: [String: String] = [:]
        var firstByTitle: [String: String] = [:]
        for run in all {
            let cleanTitle = clean(run.title)
            let lower = cleanTitle.title.lowercased()
            cleaned[run.id] = cleanTitle
            lowered[run.id] = lower
            if let parent = run.afterRun, byId[parent] != nil { groups.union(run.id, parent) }
            if let project = run.projectId {
                if let first = firstByProject[project] { groups.union(run.id, first) } else { firstByProject[project] = run.id }
            }
            let key = run.repo + "|" + lower
            if let first = firstByTitle[key] { groups.union(run.id, first) } else { firstByTitle[key] = run.id }
        }
        // Un titre de suite tronqué rejoint le fil dont le titre le prolonge.
        for run in all {
            guard cleaned[run.id]?.truncated == true, let prefix = lowered[run.id] else { continue }
            if let other = all.first(where: { $0.id != run.id && $0.repo == run.repo && lowered[$0.id]?.hasPrefix(prefix) == true }) {
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
        let waitingByRun = Self.pendingByRun(inbox)
        var autonomousByRun: [String: Int] = [:]
        for decision in inbox?.decisions ?? [] { autonomousByRun[decision.runId, default: 0] += 1 }

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
            // `Self.` : la constante `phase` déclarée juste après masque la fonction pour un compilateur plus ancien.
            let phases = runs.map { Self.phase(of: $0, pending: waitingByRun[$0.id] ?? 0) }
            let phase: OSPhase
            if let live = phases.filter(\.isLive).min() {
                phase = live
            } else if phases.contains(.done) {
                phase = .done
            } else {
                phase = phases.last ?? .stopped
            }
            let waiting = runs.reduce(0) { $0 + (waitingByRun[$1.id] ?? 0) }
            let autonomous = runs.reduce(0) { $0 + (autonomousByRun[$1.id] ?? 0) }
            let cost = runs.reduce(0) { $0 + (inbox?.costs[$1.id] ?? 0) }
            return OSThread(
                id: "r:" + root, title: title, repo: first.repo, origin: origin, runs: runs, requests: [], audit: audit,
                intake: intake, phase: phase, pending: waiting, autonomous: autonomous, cost: cost,
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

        // Un audit ouvert sans projet encore : son propre fil. Une fois ses propositions
        // rendues, il a livré : elles ne sont pas une décision, elles vivent dans Propositions.
        for audit in audits where audit.isOpen && audit.projectId == nil {
            threads.append(OSThread(
                id: "a:" + audit.id, title: audit.focus.isEmpty ? audit.repo : firstLine(audit.focus), repo: audit.repo,
                origin: .audit(audit.focus), runs: [], requests: [], audit: audit, intake: nil,
                phase: audit.isProposed ? .done : .working, pending: 0, autonomous: 0, cost: 0,
                createdAt: audit.createdAt, updatedAt: audit.createdAt
            ))
        }

        // Une session omp locale est un fil : celui de la feature qui a repris son travail
        // (passage de relais), sinon le sien.
        var threadOfRun: [String: Int] = [:]
        for (index, thread) in threads.enumerated() {
            for run in thread.runs { threadOfRun[run.id] = index }
        }
        for session in localSessions.sorted(by: { $0.startedAt < $1.startedAt }) {
            if let runId = session.runId, let index = threadOfRun[runId] {
                threads[index].localSession = session
                threads[index].origin = .local(session.host)
                threads[index].createdAt = min(threads[index].createdAt, session.startedAt)
                threads[index].cost += session.cost ?? 0
                continue
            }
            let title = clean(session.title).title
            threads.append(OSThread(
                id: "l:" + session.id, title: title.isEmpty ? (session.cwd as NSString).lastPathComponent : title, repo: session.repo,
                origin: .local(session.host), runs: [], requests: [], audit: nil, intake: nil, localSession: session,
                phase: phase(of: session), pending: 0, autonomous: 0, cost: session.cost ?? 0,
                createdAt: session.startedAt, updatedAt: session.updatedAt
            ))
        }

        return threads.sorted { lhs, rhs in
            if lhs.phase.isLive != rhs.phase.isLive { return lhs.phase.isLive }
            if lhs.phase.isLive, lhs.phase != rhs.phase { return lhs.phase < rhs.phase }
            if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
            return lhs.id < rhs.id
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
    /// Mémorisée par texte (bornée) : les rangées la relisent à chaque rendu.
    public static func firstLine(_ text: String) -> String {
        if let known = firstLines.withLock({ $0[text] }) { return known }
        let cleaned = firstLineUncached(text)
        firstLines.withLock { cache in
            if cache.count >= cleanedTitlesLimit { cache.removeAll(keepingCapacity: true) }
            cache[text] = cleaned
        }
        return cleaned
    }

    private static let firstLines = Mutex<[String: String]>([:])

    /// `firstLine` sans mémoire : pour un texte vu une seule fois (le pouls, qui ne doit pas
    /// remplir la mémoire des rangées de paragraphes qui grandissent).
    static func firstLineUncached(_ text: String) -> String {
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
