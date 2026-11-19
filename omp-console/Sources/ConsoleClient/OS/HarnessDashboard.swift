// Le TABLEAU DE BORD de l'Accueil : ce qu'il faut voir d'un coup d'œil avant de lire
// la boîte, quand plusieurs projets tournent en même temps — les KPIs en tuiles, puis
// quatre blocs tracés : ce qui attend l'humain (par projet), le débit, le coût, la
// santé du serveur.
//
// Fonction PURE de la boîte (`GET /v1/inbox`) et des statistiques (`GET /v1/stats`) :
// les deux apps tracent les mêmes séries. Un serveur plus ancien, sans séries, donne
// des blocs vides plutôt qu'un échec.

import ConsoleCore
import Foundation

/// Une ancre de la boîte de l'humain : une tuile du tableau de bord y fait défiler.
public enum HarnessHomeAnchor: String, CaseIterable, Sendable {
    case toDecide = "home.inbox.toDecide"
    case specs = "home.inbox.specs"
    case verdicts = "home.inbox.verdicts"
    case decisions = "home.inbox.decisions"
    case active = "home.inbox.active"
}

public struct HarnessDashboard: Equatable, Sendable {
    /// Ce qui attend l'humain, par sorte : la série empilée du bloc « Ce qui vous attend ».
    public enum WaitKind: String, CaseIterable, Sendable {
        case questions, specs, verdicts, decisions
    }

    /// Ce qui attend l'humain dans un dépôt, pour une sorte.
    public struct Waiting: Equatable, Sendable, Identifiable {
        public var repo: String
        public var kind: WaitKind
        public var count: Int

        public var id: String { "\(repo)/\(kind.rawValue)" }
    }

    /// Un jour des séries : features lancées, fusionnées, échouées, et le coût des agents.
    public struct Day: Equatable, Sendable, Identifiable {
        /// Le jour UTC, `2026-10-24`.
        public var day: String
        /// Minuit UTC de ce jour : l'abscisse des graphiques.
        public var date: Date
        public var created: Int
        public var merged: Int
        public var failed: Int
        public var cost: Double

        public var id: String { day }
    }

    /// Une valeur nommée : features en cours d'une étape, coût d'un dépôt.
    public struct Share: Equatable, Sendable, Identifiable {
        public var label: String
        public var value: Double

        public var id: String { label }
    }

    /// Une étape : combien de passages, combien en échec.
    public struct StepHealth: Equatable, Sendable, Identifiable {
        public var step: String
        public var count: Int
        public var failed: Int

        public var id: String { step }
        /// La part des passages en échec, de 0 à 1.
        public var failureRate: Double { count == 0 ? 0 : Double(failed) / Double(count) }
    }

    // MARK: KPIs

    /// Ce qui BLOQUE une feature : questions ouvertes, specs et verdicts à valider.
    public var pending: Int
    /// Les décisions prises seules, à relire.
    public var toReview: Int
    /// Les features en file, en cours ou en fusion.
    public var active: Int
    /// Depuis combien de secondes attend la plus vieille feature bloquée ; `nil` si rien n'attend.
    public var oldestWaitSec: Double?
    /// Les alertes en cours de la veille du serveur.
    public var alerts: Int
    /// Les audits dont les propositions attendent un choix (section Audit).
    public var auditsToSort: Int
    /// Les statistiques sont lues (sinon, les KPIs qui en dépendent sont `nil`).
    public var hasStats: Bool
    public var mergedLast7Days: Int?
    public var mergeRate: Double?
    public var medianLeadSec: Double?
    public var fixesPerMerged: Double?
    public var costLast7Days: Double?

    // MARK: Séries

    /// Par dépôt et par sorte, les zéros omis ; dépôts dans l'ordre alphabétique.
    public var waiting: [Waiting]
    /// Les 14 derniers jours, chacun présent ; vide d'un serveur sans séries.
    public var days: [Day]
    /// Les features en cours, par étape, dans l'ordre du chemin nominal.
    public var activeBySteps: [Share]
    /// Le coût de chaque dépôt sur 7 jours, du plus cher au moins cher.
    public var costByRepo: [Share]
    /// Les étapes du chemin nominal qui ont tourné.
    public var stepHealth: [StepHealth]
    public var runners: HarnessStats.Slots?
    public var heavy: HarnessStats.Slots?
    /// Les commandes de tests instables ; `nil` d'un serveur plus ancien.
    public var flaky: Int?

    public init(inbox: HarnessInbox, stats: HarnessStats?, now: Date = Date()) {
        pending = inbox.pendingCount
        toReview = inbox.decisions.count
        active = inbox.active.count
        alerts = inbox.alerts.count
        auditsToSort = inbox.auditsProposed.count
        let blocked = inbox.batches.compactMap { $0.run ?? inbox.run($0.id) } + inbox.awaiting
        oldestWaitSec = blocked.map(\.updatedAt).min().map { max(0, now.timeIntervalSince1970 - $0 / 1000) }

        hasStats = stats != nil
        mergedLast7Days = stats?.runs.mergedLast7Days
        mergeRate = stats?.runs.mergeRate
        medianLeadSec = stats?.runs.medianLeadSec
        fixesPerMerged = stats?.runs.fixesPerMerged
        costLast7Days = stats?.usage?.last7Days.cost

        waiting = Self.waiting(inbox)
        days = Self.days(stats)
        activeBySteps = Self.activeBySteps(inbox.active)
        costByRepo = (stats?.usage?.byRepoLast7Days ?? [:])
            .map { Share(label: $0.key, value: $0.value.cost) }
            .filter { $0.value > 0 }
            .sorted { $0.value != $1.value ? $0.value > $1.value : $0.label < $1.label }
        stepHealth = HarnessRun.stepKinds.compactMap { kind in
            guard let step = stats?.steps[kind], step.count > 0 else { return nil }
            return StepHealth(step: HarnessRun.label(forStep: kind), count: step.count, failed: step.failed)
        }
        runners = stats?.scheduler.runner
        heavy = stats?.scheduler.heavy
        flaky = stats?.tests.flaky?.count
    }

    /// Le total de ce qui attend, toutes sortes confondues, par dépôt.
    public var waitingByRepo: [Share] {
        var totals: [String: Int] = [:]
        for item in waiting { totals[item.repo, default: 0] += item.count }
        return totals.map { Share(label: $0.key, value: Double($0.value)) }.sorted { $0.label < $1.label }
    }

    /// Des features ont fini (fusionnées ou échouées) sur la fenêtre des séries.
    public var hasThroughput: Bool { days.contains { $0.merged + $0.failed + $0.created > 0 } }

    /// Les agents ont coûté quelque chose sur la fenêtre des séries.
    public var hasCost: Bool { days.contains { $0.cost > 0 } }

    // MARK: - Construction

    private static func waiting(_ inbox: HarnessInbox) -> [Waiting] {
        var counts: [String: [WaitKind: Int]] = [:]
        func add(_ repo: String?, _ kind: WaitKind, _ count: Int = 1) {
            counts[repo ?? "?", default: [:]][kind, default: 0] += count
        }
        for batch in inbox.batches {
            add((batch.run ?? inbox.run(batch.id))?.repo, .questions, batch.items.count)
        }
        for run in inbox.specsAwaiting { add(run.repo, .specs) }
        for run in inbox.verdictsAwaiting { add(run.repo, .verdicts) }
        for decision in inbox.decisions { add(inbox.run(decision.runId)?.repo, .decisions) }
        return counts.keys.sorted().flatMap { repo in
            WaitKind.allCases.compactMap { kind in
                guard let count = counts[repo]?[kind], count > 0 else { return nil }
                return Waiting(repo: repo, kind: kind, count: count)
            }
        }
    }

    /// Les jours des runs (`runs.byDay`, déjà complets), avec le coût de `usage.byDay`
    /// (qui omet les jours sans dépense).
    private static func days(_ stats: HarnessStats?) -> [Day] {
        guard let runs = stats?.runs.byDay else { return [] }
        let costs = Dictionary((stats?.usage?.byDay ?? []).map { ($0.day, $0.cost) }, uniquingKeysWith: +)
        return runs.compactMap { day in
            guard let date = date(of: day.day) else { return nil }
            return Day(day: day.day, date: date, created: day.created, merged: day.merged, failed: day.failed, cost: costs[day.day] ?? 0)
        }
    }

    /// Minuit UTC d'un jour `2026-10-24` ; `nil` pour un texte d'une autre forme.
    static func date(of day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .gmt
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// En file d'abord, puis les étapes du chemin nominal, puis la fusion.
    private static func activeBySteps(_ runs: [HarnessRun]) -> [Share] {
        var counts: [String: Int] = [:]
        for run in runs {
            counts[key(of: run), default: 0] += 1
        }
        let order = ["queued"] + HarnessRun.stepKinds + ["merging"]
        let known = order.compactMap { kind in counts[kind].map { Share(label: label(of: kind), value: Double($0)) } }
        let others = counts.keys.filter { !order.contains($0) }.sorted().map { Share(label: label(of: $0), value: Double(counts[$0] ?? 0)) }
        return known + others
    }

    private static func key(of run: HarnessRun) -> String {
        switch run.phase {
        case .queued: "queued"
        case .merging: "merging"
        default: run.step ?? run.state
        }
    }

    private static func label(of key: String) -> String {
        switch key {
        case "queued", "merging": PipelineServerText.state(key)
        default: HarnessRun.label(forStep: key)
        }
    }
}
