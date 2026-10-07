// Les routes de LECTURE (S-7, S-8, S-9, S-6) : le magasin, les sessions, les
// documents, les statistiques, la mémoire et la liste des appareils.
//
// Aucune lecture disque propre à l'API : tout vient des couches existantes —
// `StoreHub.current()`, `storeRuns(of:)`, `SessionReader`, `StatsModel.state`,
// `MemoryServing`, `DeviceRegistry`. C'est ce qui garantit que l'API dit l'état
// RÉEL de la coque à l'instant de la requête (AC-6).

import ConsoleCore
import Foundation

@MainActor
final class RemoteReads {
    let hub: StoreHub
    let registry: DeviceRegistry
    let stats: StatsModel
    let service: any MemoryServing
    let memoryConfig: MemoryServiceConfig
    let memoryLinks: URL
    let environment: [String: String]
    let clock: RemoteClock

    init(
        hub: StoreHub,
        registry: DeviceRegistry,
        stats: StatsModel,
        service: any MemoryServing,
        memoryConfig: MemoryServiceConfig,
        memoryLinks: URL,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        clock: RemoteClock = .live
    ) {
        self.hub = hub
        self.registry = registry
        self.stats = stats
        self.service = service
        self.memoryConfig = memoryConfig
        self.memoryLinks = memoryLinks
        self.environment = environment
        self.clock = clock
    }

    // MARK: - Socle

    func version() -> RemoteVersionPayload {
        RemoteVersionPayload(protocolVersion: ConsoleAPI.protocolVersion)
    }

    func store() -> RemoteStorePayload {
        RemoteStorePayload(snapshot: hub.current())
    }

    func sessions() -> RemoteSessionsPayload {
        RemoteSessionsPayload(runs: storeRuns(of: hub.current()))
    }

    func projects() -> RemoteProjectsPayload {
        RemoteProjectsPayload(projects: hub.current().projects.projects)
    }

    /// Une session : lue depuis le DÉBUT du fichier, bornée aux dernières entrées.
    /// Fichier absent → 404 ; fichier illisible → 200 avec `skipped` qui le dit.
    func session(_ file: String) throws -> RemoteSessionPayload {
        guard FileManager.default.fileExists(atPath: file) else {
            throw ConsoleAPIError.notFound("session introuvable")
        }
        let reader = SessionReader(path: file)
        let read = reader.read()
        let conversation = reader.conversation
        var skipped = conversation.skipped.map {
            RemoteSkippedEntry(offset: $0.offset, reason: Self.reason($0.reason))
        }
        if case .unreadable(let reason) = (read.issue ?? nil) {
            skipped.append(RemoteSkippedEntry(offset: 0, reason: "unreadable (\(reason))"))
        }
        let header = conversation.header.map {
            RemoteSessionHeader(
                id: $0.id,
                cwd: $0.cwd,
                version: $0.version,
                timestamp: $0.timestamp,
                parentSession: $0.parentSession
            )
        }
        let kind = conversation.kind.map(Self.kind) ?? (conversation.header == nil ? nil : "topLevel")
        var kept = Array(conversation.entries.suffix(RemoteLimits.sessionEntries).map(RemoteConversationEntry.init))
        var truncated = conversation.entries.count > kept.count
        var payload = RemoteSessionPayload(
            header: header,
            kind: kind,
            entries: kept,
            skipped: skipped,
            truncated: truncated
        )
        // Borne d'OCTETS (S-7) : 2000 entrées volumineuses peuvent dépasser 2 Mio même
        // bornées en nombre ; on retire par moitié jusqu'à tenir, en le disant.
        while (try? HTTPJSON.encode(payload))?.count ?? 0 > RemoteLimits.responseBody, kept.count > 0 {
            kept = Array(kept.dropFirst(max(1, kept.count / 2)))
            truncated = true
            payload = RemoteSessionPayload(
                header: header,
                kind: kind,
                entries: kept,
                skipped: skipped,
                truncated: truncated
            )
        }
        return payload
    }

    /// Les deux documents d'un projet : `PROJECT.md` du magasin, puis le contrat de
    /// la racine du projet. `repoKey` inconnu → 404.
    func documents(repoKey: String) throws -> RemoteDocumentsPayload {
        let snapshot = hub.current()
        guard let project = snapshot.projects.projects.first(where: { $0.repoKey == repoKey }) else {
            throw ConsoleAPIError.notFound("projet inconnu")
        }
        let projectDoc = ProjectPaths.docFile(stateDir: hub.stateDir, repoKey: repoKey)
        let contractDoc = (project.repoRoot as NSString)
            .appendingPathComponent(".omp/pipeline/\(ProjectViewText.contractFileName)")
        return RemoteDocumentsPayload(documents: [
            Self.document(name: ProjectViewText.docFileName, path: projectDoc),
            Self.document(name: ProjectViewText.contractFileName, path: contractDoc),
        ])
    }

    // MARK: - Statistiques

    func statistics() throws -> RemoteStatsPayload {
        switch stats.state {
        case .loading:
            throw ConsoleAPIError.unavailable("les statistiques ne sont pas encore prêtes")
        case .noProject:
            return RemoteStatsPayload(
                project: "",
                totals: RemoteStatsTotals(input: 0, output: 0, turns: 0, durationMs: 0),
                rows: [],
                truncated: false
            )
        case .storeAbsent, .empty:
            let label = stats.projects.first { $0.id == stats.selectedKey }?.label ?? ""
            return RemoteStatsPayload(
                project: label,
                totals: RemoteStatsTotals(input: 0, output: 0, turns: 0, durationMs: 0),
                rows: [],
                truncated: false
            )
        case .board(let board):
            let nowMs = clock.nowMs()
            let rows = StatsPresentation.rows(board.project, nowMs: nowMs)
            let totals = projectTotals(board.project, nowMs: nowMs)
            let statsTotals = RemoteStatsTotals(
                input: totals.input,
                output: totals.output,
                turns: totals.turns,
                durationMs: totals.durationMs
            )
            var kept = Array(rows.prefix(RemoteLimits.statsRows))
            var truncated = rows.count > kept.count
            var payload = RemoteStatsPayload(
                project: board.project.label,
                totals: statsTotals,
                rows: kept,
                truncated: truncated
            )
            // Borne d'OCTETS (S-7) : même règle que les entrées de session.
            while (try? HTTPJSON.encode(payload))?.count ?? 0 > RemoteLimits.responseBody, kept.count > 0 {
                kept = Array(kept.dropFirst(max(1, kept.count / 2)))
                truncated = true
                payload = RemoteStatsPayload(
                    project: board.project.label,
                    totals: statsTotals,
                    rows: kept,
                    truncated: truncated
                )
            }
            return payload
        }
    }

    // MARK: - Appareils

    func devices() -> RemoteDevicesPayload {
        RemoteDevicesPayload(devices: registry.devices.map { device in
            RemoteDeviceRow(
                id: device.id.uuidString.lowercased(),
                name: device.name,
                pairedAtMs: device.pairedAtMs,
                lastSeenAtMs: device.lastSeenAtMs,
                connected: registry.connected.contains(device.id)
            )
        })
    }

    // MARK: - Mémoire

    func memory(scope: String?, limit rawLimit: String?) async throws -> RemoteMemoryPagePayload {
        let limit = try Self.limit(rawLimit)
        let scope = await resolvedScope(scope)
        do {
            let page = try await service.all(scope: scope)
            return RemoteMemoryPagePayload(
                total: page.total,
                rows: page.rows.prefix(limit).map(RemoteMemoryRow.init)
            )
        } catch {
            throw Self.memoryError(error, config: memoryConfig)
        }
    }

    func memorySearch(query: String?, scope: String?, limit rawLimit: String?) async throws -> RemoteMemorySearchPayload {
        let limit = try Self.limit(rawLimit)
        guard let query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ConsoleAPIError.badRequest("requête vide")
        }
        let scope = await resolvedScope(scope)
        do {
            let rows = try await service.search(query: query, scope: scope, pool: MemorySearch.pool(requested: limit))
            let selected = MemorySearch.select(rows: rows, floor: MemorySearch.threshold, limit: limit)
            return RemoteMemorySearchPayload(
                rows: selected.kept.map(RemoteMemoryRow.init),
                candidates: selected.candidates,
                scored: selected.scored
            )
        } catch {
            throw Self.memoryError(error, config: memoryConfig)
        }
    }

    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        let scope = await resolvedScope(scope)
        do {
            let page = try await service.all(scope: scope)
            let edges = try await service.graph().edges
            let manual = MemoryLinkStore.load(memoryLinks)
            let nodes = MemoryGraph.nodes(rows: page.rows)
            let links = MemoryGraph.links(rows: page.rows, edges: edges, manual: manual)
            return RemoteMemoryGraphPayload(
                nodes: nodes.map {
                    RemoteMemoryGraphNode(id: Self.nodeID($0.id), label: $0.label, scope: $0.scope ?? "")
                },
                links: links.map { link in
                    RemoteMemoryGraphLink(
                        a: Self.nodeID(link.a),
                        b: Self.nodeID(link.b),
                        kind: Self.kind(link.kind),
                        score: Self.score(link.kind)
                    )
                },
                total: nodes.count
            )
        } catch {
            throw Self.memoryError(error, config: memoryConfig)
        }
    }

    private func resolvedScope(_ scope: String?) async -> String? {
        if let scope, !scope.isEmpty { return scope }
        return await MemoryScope.currentProject(environment: environment)
    }

    // MARK: - Fabriques internes

    static func reason(_ reason: SkipReason) -> String {
        switch reason {
        case .invalidJSON: return "invalidJSON"
        case .unknownType: return "unknownType"
        case .malformed: return "malformed"
        }
    }

    static func kind(_ kind: SessionKind) -> String {
        switch kind {
        case .topLevel: return "topLevel"
        case .subagent: return "subagent"
        }
    }

    /// Un document de projet : `text`, `missing`, `binary` ou `unreadable`.
    /// « Absent » et « présent mais illisible » sont DISTINCTS (S-7) : un fichier
    /// existant que `contents(atPath:)` ne rend pas (droits, I/O, répertoire)
    /// donne `unreadable` avec sa raison, jamais `missing`.
    static func document(name: String, path: String) -> RemoteDocument {
        let exists = FileManager.default.fileExists(atPath: path)
        guard let data = FileManager.default.contents(atPath: path) else {
            if exists {
                return RemoteDocument(name: name, state: "unreadable", content: nil, reason: "lecture impossible")
            }
            return RemoteDocument(name: name, state: "missing", content: nil, reason: nil)
        }
        guard let text = String(data: data, encoding: .utf8) else {
            return RemoteDocument(name: name, state: "binary", content: nil, reason: "contenu non textuel")
        }
        return RemoteDocument(name: name, state: "text", content: text, reason: nil)
    }

    static func nodeID(_ id: MemoryGraphNodeID) -> String {
        switch id {
        case .memory(let memory): return "memory:\(memory)"
        case .tag(let tag): return "tag:\(tag)"
        }
    }

    static func kind(_ kind: MemoryGraphLinkKind) -> String {
        switch kind {
        case .semantic: return "semantic"
        case .tag: return "tag"
        case .manual: return "manual"
        }
    }

    static func score(_ kind: MemoryGraphLinkKind) -> Double? {
        if case .semantic(let score) = kind { return score }
        return nil
    }

    /// `limit` : entier, 1…200, défaut 50.
    static func limit(_ raw: String?) throws -> Int {
        guard let raw, !raw.isEmpty else { return RemoteLimits.memoryLimitDefault }
        guard let value = Int(raw), value >= 1, value <= RemoteLimits.memoryLimitMax else {
            throw ConsoleAPIError.badRequest("limit hors bornes")
        }
        return value
    }

    /// La traduction des pannes de la pile mémoire (S-9) : jamais un 200 vide.
    static func memoryError(_ error: Error, config: MemoryServiceConfig) -> ConsoleAPIError {
        guard let failure = error as? MemoryServiceError else { return .server("mémoire indisponible") }
        switch failure {
        case .notReachable:
            return .unavailable("la pile mémoire est injoignable : \(config.baseURL.absoluteString)")
        case .unauthorized:
            return .unavailable("la pile mémoire refuse le jeton")
        case .unexpectedStatus(let code, _):
            return .server("la pile mémoire a répondu \(code)")
        case .malformedResponse:
            return .server("réponse mémoire illisible")
        }
    }
}
