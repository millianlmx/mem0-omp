// La vue UNIFIÉE des dépôts des deux machines (S-6 de orchestrator-living-in-a-vps) :
// une fonction PURE qui fusionne ce que le Mac et le VPS déclarent. Aucune E/S,
// aucun `repoKey` calculé ici : les clés viennent des machines.
//
// Règles : regroupement par identité GitHub (sans identité, une ligne par
// machine) ; la machine CONDUCTRICE est celle dont la ligne n'a pas de bascule
// `done` ; une bascule `frozen` est « en cours » ; deux machines sans bascule
// pour la même identité sont en conflit ; une machine injoignable parle par son
// dernier relevé mémorisé et ses lignes sont marquées injoignables.

import Foundation

/// Ce que l'on sait d'UNE machine.
public enum MachineRepos: Equatable, Sendable {
    /// Elle répond : ses dépôts, à l'instant.
    case reachable([RepoRow])
    /// Elle ne répond pas : son DERNIER relevé connu (vide s'il n'y en a pas).
    case unreachable(lastKnown: [RepoRow])
    /// Aucune adresse ni appairage : la machine n'existe pas pour l'app.
    case notConfigured

    public var rows: [RepoRow] {
        switch self {
        case .reachable(let rows), .unreachable(let rows): rows
        case .notConfigured: []
        }
    }

    public var isReachable: Bool {
        if case .reachable = self { return true }
        return false
    }

    public var isConfigured: Bool {
        if case .notConfigured = self { return false }
        return true
    }
}

/// L'état d'une ligne de la vue unifiée.
public enum UnifiedRepoStatus: Equatable, Sendable {
    /// Rien à dire : le dépôt est pilotable.
    case drivable
    /// La machine conductrice ne répond pas.
    case unreachable(RepoMachine)
    /// La bascule vers `to` est gelée sur la source : la source ne démarre plus rien.
    case handoverInProgress(to: RepoMachine)
    /// La cible a démarré les features mais leur retrait de la source a échoué.
    case handoverToFinish(to: RepoMachine)
    /// Connu des deux machines sans bascule.
    case conflict
}

/// Un geste « Confier à … » d'une ligne : actif, ou désactivé avec son motif.
public struct HandoverOffer: Equatable, Sendable {
    public var from: RepoMachine
    public var to: RepoMachine
    /// Le motif affiché quand le geste est désactivé ; `nil` : le geste est offert.
    public var disabledReason: String?

    public init(from: RepoMachine, to: RepoMachine, disabledReason: String?) {
        self.from = from
        self.to = to
        self.disabledReason = disabledReason
    }

    public var isEnabled: Bool { disabledReason == nil }
}

/// Une ligne de la vue unifiée : un dépôt, vu des deux machines.
public struct UnifiedRepo: Equatable, Identifiable, Sendable {
    /// L'identité GitHub, sinon `<machine>:<repoKey>`.
    public var id: String
    /// Le dernier segment de l'identité, sinon le nom de la ligne de la machine.
    public var name: String
    public var identity: String?
    public var mac: RepoRow?
    public var vps: RepoRow?
    /// La machine qui conduit le dépôt ; `nil` en conflit.
    public var conductor: RepoMachine?
    public var status: UnifiedRepoStatus
    /// Les machines dont la ligne vient d'un relevé mémorisé (injoignables).
    public var staleMachines: Set<RepoMachine>
    /// Les gestes « Confier à … » : un seul, deux en conflit, aucun en cours de bascule.
    public var offers: [HandoverOffer]
    /// Les features démarrées non terminées de la machine NON conductrice
    /// (elles finissent là-bas) ; `nil` quand il n'y en a pas.
    public var finishing: (machine: RepoMachine, count: Int)?

    public func row(on machine: RepoMachine) -> RepoRow? {
        machine == .mac ? mac : vps
    }

    /// Où démarrer une feature : la machine conductrice et SA ligne, quand le
    /// dépôt est pilotable (pas de bascule en cours, conductrice joignable).
    public var launchTarget: (machine: RepoMachine, row: RepoRow)? {
        guard status == .drivable, let conductor, let row = row(on: conductor) else { return nil }
        return (conductor, row)
    }

    /// La bascule gelée de cette ligne : la machine source, l'identifiant et la cible.
    public var frozenHandover: (source: RepoMachine, handover: RepoHandover)? {
        for machine in RepoMachine.allCases {
            if let handover = row(on: machine)?.handover, handover.state == .frozen { return (machine, handover) }
        }
        return nil
    }

    public static func == (lhs: UnifiedRepo, rhs: UnifiedRepo) -> Bool {
        lhs.id == rhs.id && lhs.name == rhs.name && lhs.identity == rhs.identity && lhs.mac == rhs.mac
            && lhs.vps == rhs.vps && lhs.conductor == rhs.conductor && lhs.status == rhs.status
            && lhs.staleMachines == rhs.staleMachines && lhs.offers == rhs.offers
            && lhs.finishing?.machine == rhs.finishing?.machine && lhs.finishing?.count == rhs.finishing?.count
    }
}

public enum UnifiedRepos {
    /// Fusionne les deux machines.
    ///
    /// - Parameters:
    ///   - finishing: pour chaque machine, le nombre de features démarrées non
    ///     terminées par `repoKey` de cette machine (`startedUnfinished`).
    ///   - toFinish: les identités (ou ids de ligne) dont une bascule attend son
    ///     dernier retrait : leur état « en cours » devient « à terminer ».
    public static func merge(
        mac: MachineRepos,
        vps: MachineRepos,
        finishing: [RepoMachine: [String: Int]] = [:],
        toFinish: Set<String> = []
    ) -> [UnifiedRepo] {
        let entries: [RepoMachine: MachineRepos] = [.mac: mac, .vps: vps]
        var order: [String] = []
        var groups: [String: [RepoMachine: RepoRow]] = [:]
        for machine in RepoMachine.allCases {
            for row in entries[machine]?.rows ?? [] {
                let key = row.identity ?? "\(machine.rawValue):\(row.repoKey)"
                if groups[key] == nil { order.append(key) }
                // Deux lignes d'une même machine sous une même identité : la première gagne.
                if groups[key]?[machine] == nil { groups[key, default: [:]][machine] = row }
            }
        }
        let lines = order.compactMap { key -> UnifiedRepo? in
            guard let rows = groups[key] else { return nil }
            return line(id: key, rows: rows, entries: entries, finishing: finishing, toFinish: toFinish)
        }
        return lines.sorted { left, right in
            let l = left.name.lowercased(), r = right.name.lowercased()
            return l == r ? left.id < right.id : l < r
        }
    }

    private static func line(
        id: String,
        rows: [RepoMachine: RepoRow],
        entries: [RepoMachine: MachineRepos],
        finishing: [RepoMachine: [String: Int]],
        toFinish: Set<String>
    ) -> UnifiedRepo {
        let mac = rows[.mac], vps = rows[.vps]
        let identity = (mac ?? vps)?.identity
        let name = identity.map(RepoIdentity.shortName) ?? (mac ?? vps)?.name ?? id
        let stale = Set(RepoMachine.allCases.filter { rows[$0] != nil && entries[$0]?.isReachable == false })

        func done(_ machine: RepoMachine) -> Bool { rows[machine]?.handover?.state == .done }
        func frozen(_ machine: RepoMachine) -> RepoHandover? {
            rows[machine]?.handover?.state == .frozen ? rows[machine]?.handover : nil
        }

        var conductor: RepoMachine?
        var status: UnifiedRepoStatus
        if rows.count == 1, let only = rows.keys.first {
            // Une seule machine connaît le dépôt : elle le conduit, sauf si elle l'a confié.
            if let handover = rows[only]?.handover, handover.state == .done {
                conductor = handover.to
            } else {
                conductor = only
            }
            status = .drivable
        } else {
            let candidates = RepoMachine.allCases.filter { !done($0) }
            if candidates.count == 1 {
                conductor = candidates[0]
                status = .drivable
            } else if candidates.count == 2, let frozenSource = RepoMachine.allCases.first(where: { frozen($0) != nil }) {
                // Deux candidates dont l'une est gelée : la source gelée conduit encore.
                conductor = frozenSource
                status = .drivable
            } else {
                conductor = nil
                status = .conflict
            }
        }
        if let source = RepoMachine.allCases.first(where: { frozen($0) != nil }), status != .conflict, let handover = frozen(source) {
            status = toFinish.contains(id) ? .handoverToFinish(to: handover.to) : .handoverInProgress(to: handover.to)
        }
        if status != .conflict, let conductor, entries[conductor]?.isReachable == false {
            status = .unreachable(conductor)
        }

        let counts = RepoMachine.allCases.compactMap { machine -> (RepoMachine, Int)? in
            guard machine != conductor, let row = rows[machine], let n = finishing[machine]?[row.repoKey], n > 0 else { return nil }
            return (machine, n)
        }
        var offers: [HandoverOffer] = []
        switch status {
        case .handoverInProgress, .handoverToFinish:
            break
        case .conflict:
            for target in RepoMachine.allCases {
                offers.append(offer(from: target.other, to: target, identity: identity, entries: entries))
            }
        case .drivable, .unreachable:
            if let conductor {
                offers.append(offer(from: conductor, to: conductor.other, identity: identity, entries: entries))
            }
        }
        return UnifiedRepo(
            id: id,
            name: name,
            identity: identity,
            mac: mac,
            vps: vps,
            conductor: conductor,
            status: status,
            staleMachines: stale,
            offers: offers,
            finishing: counts.first.map { (machine: $0.0, count: $0.1) }
        )
    }

    /// Le geste « Confier à `to` » et son éventuel motif de désactivation, dans
    /// l'ordre : cible non appairée, source injoignable, cible injoignable,
    /// dépôt sans dépôt distant GitHub.
    private static func offer(
        from: RepoMachine,
        to: RepoMachine,
        identity: String?,
        entries: [RepoMachine: MachineRepos]
    ) -> HandoverOffer {
        var reason: String?
        if entries[to]?.isConfigured != true {
            reason = ReposText.notPaired(to)
        } else if entries[from]?.isReachable != true {
            reason = ReposText.unreachable(from)
        } else if entries[to]?.isReachable != true {
            reason = ReposText.unreachable(to)
        } else if identity == nil {
            reason = ReposText.noRemote
        }
        return HandoverOffer(from: from, to: to, disabledReason: reason)
    }

    // MARK: - Faits lus dans un instantané

    /// Le nombre de features DÉMARRÉES et non terminées d'un dépôt, lu dans
    /// l'instantané de la machine : un dossier de feature existe (`worktree`
    /// non vide) et la feature n'est ni terminée, ni annulée, ni échouée.
    public static func startedUnfinished(in snapshot: StoreSnapshot?, repoRoot: String) -> Int {
        guard let snapshot else { return 0 }
        return snapshot.lots.lots
            .filter { $0.repoRoot == repoRoot }
            .flatMap(\.features)
            .filter { feature in
                guard !feature.worktree.isEmpty else { return false }
                switch feature.state {
                case .done, .cancelled, .failed: return false
                case .pending, .running, .waiting, .blocked: return true
                }
            }
            .count
    }

    /// Le nombre de features PAS ENCORE démarrées d'un dépôt (`pending` sans
    /// dossier de feature) : celles qui partent sur l'autre machine.
    public static func notStarted(in snapshot: StoreSnapshot?, repoRoot: String) -> Int {
        guard let snapshot else { return 0 }
        return snapshot.lots.lots
            .filter { $0.repoRoot == repoRoot }
            .flatMap(\.features)
            .filter { $0.state == .pending && $0.worktree.isEmpty }
            .count
    }

    /// Les décomptes par `repoKey` d'une machine, pour `merge(finishing:)`.
    public static func finishingCounts(rows: [RepoRow], snapshot: StoreSnapshot?) -> [String: Int] {
        var counts: [String: Int] = [:]
        for row in rows {
            let n = startedUnfinished(in: snapshot, repoRoot: row.repoRoot)
            if n > 0 { counts[row.repoKey] = n }
        }
        return counts
    }

    // MARK: - Dernier relevé mémorisé

    /// Le dernier relevé d'une machine, sérialisé pour la préférence
    /// `machines.<kind>.lastRepos` (JSON, clés triées).
    public static func encodeLastKnown(_ rows: [RepoRow]) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(rows) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Relit le dernier relevé ; une valeur absente ou illisible donne `[]`.
    public static func decodeLastKnown(_ text: String?) -> [RepoRow] {
        guard let text, let data = text.data(using: .utf8),
              let rows = try? JSONDecoder().decode([RepoRow].self, from: data) else { return [] }
        return rows
    }

    /// La clé de la préférence du dernier relevé d'une machine.
    public static func lastReposKey(_ machine: RepoMachine) -> String {
        "machines.\(machine.rawValue).lastRepos"
    }
}
