// Les routes de LECTURE (S-7, S-8, S-9, S-6) : le magasin, les sessions, les
// documents, les statistiques, la mémoire et la liste des appareils.
//
// Aucune lecture disque propre à l'API : tout vient des couches existantes —
// `StoreHub.current()`, `storeRuns(of:)`, `SessionReader`, la dérivation partagée
// des statistiques (`statsBoard`/`featureTotals`), `MemoryServing`,
// `DeviceRegistry`. C'est ce qui garantit que l'API dit l'état RÉEL de la coque à
// l'instant de la requête (AC-6).

import ConsoleCore
import Foundation

@MainActor
final class RemoteReads {
    let hub: StoreHub
    let registry: DeviceRegistry
    /// Le cache de lecteurs des statistiques (D-4) : possédé par l'API, il ne
    /// consomme que les octets AJOUTÉS depuis le relevé précédent.
    private let cache = SessionMetricsCache()
    let service: any MemoryServing
    let memoryConfig: MemoryServiceConfig
    let memoryLinks: URL
    let environment: [String: String]
    let clock: RemoteClock
    /// Le tableau de bord réel : la carte d'un contrat se résout par l'ardoise
    /// DÉJÀ dérivée (`KanbanModel`), jamais par une seconde dérivation (S-6).
    let kanban: KanbanModel
    /// Le journal des gestes servi tel quel (S-5).
    let actions: ActionsModel
    /// L'état des composants et de la préparation (S-4), injecté par la racine
    /// macOS : une seule source de vérité, aucune lecture propre à l'API.
    let componentsProvider: @MainActor () -> RemoteComponentsPayload

    init(
        hub: StoreHub,
        registry: DeviceRegistry,
        service: any MemoryServing,
        memoryConfig: MemoryServiceConfig,
        memoryLinks: URL,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        clock: RemoteClock = .live,
        kanban: KanbanModel,
        actions: ActionsModel,
        components: @escaping @MainActor () -> RemoteComponentsPayload = {
            RemoteComponentsPayload(ompInstalled: false, ompPath: nil, setupBanner: nil)
        }
    ) {
        self.hub = hub
        self.registry = registry
        self.service = service
        self.memoryConfig = memoryConfig
        self.memoryLinks = memoryLinks
        self.environment = environment
        self.clock = clock
        self.kanban = kanban
        self.actions = actions
        self.componentsProvider = components
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
    /// Fichier absent → 404 ; fichier illisible → 200 avec `unreadableReason` qui le
    /// dit (le motif OS), jamais une erreur ni une entrée factice.
    func session(_ file: String) throws -> RemoteSessionPayload {
        guard FileManager.default.fileExists(atPath: file) else {
            throw ConsoleAPIError.notFound("session introuvable")
        }
        let reader = SessionReader(path: file)
        let read = reader.read()
        let conversation = reader.conversation
        let skipped = conversation.skipped.map {
            RemoteSkippedEntry(offset: $0.offset, reason: Self.reason($0.reason))
        }
        // Un incident d'ouverture est un MOTIF porté par la charge utile (S-4) : le
        // client l'affiche au-dessus du fil, au lieu d'une entrée ignorée factice.
        var unreadableReason: String?
        if case .unreadable(let reason) = (read.issue ?? nil) {
            unreadableReason = reason
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
            truncated: truncated,
            unreadableReason: unreadableReason
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
                truncated: truncated,
                unreadableReason: unreadableReason
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

    /// Le tableau du projet DEMANDÉ (S-1, S-2), dérivé par les MÊMES fonctions
    /// pures que la fenêtre macOS (`statsBoard`/`featureTotals`) : l'API ne lit
    /// plus l'état publié de `StatsModel`, elle dérive à l'instant de la requête.
    ///
    /// `project` absent, vide ou inconnu ⇒ le PREMIER projet de `projectOrder`
    /// (`statsDisplayedProject`), jamais une erreur. Un relevé ne lit QUE les
    /// runs du projet demandé et libère les lecteurs des autres.
    func statistics(project: String?) throws -> RemoteStatsPayload {
        let snapshot = hub.current()
        let board = statsBoard(snapshot: snapshot, selectedKey: project, read: cache.metrics)

        var retained: Set<String> = []
        if let project = statsDisplayedProject(snapshot, selectedKey: project) {
            for planFeature in statsPlan(of: snapshot, project: project) {
                for run in planFeature.runs { retained.insert(run.sessionFile) }
            }
        }
        cache.release(keeping: retained)

        guard let board else {
            return RemoteStatsPayload(
                projectKey: nil,
                project: "",
                projects: [],
                features: [],
                hiddenPlanFeatures: 0
            )
        }

        let nowMs = clock.nowMs()
        let features = board.project.features.map { feature -> RemoteStatsFeature in
            let totals = featureTotals(feature, nowMs: nowMs)
            return RemoteStatsFeature(
                slug: feature.slug,
                input: totals.input,
                output: totals.output,
                turns: totals.turns,
                durationMs: totals.durationMs,
                liveRuns: featureLiveRuns(feature),
                model: featureModel(feature)
            )
        }
        return RemoteStatsPayload(
            projectKey: board.project.repoKey,
            project: board.project.label,
            projects: statsProjectOptions(snapshot).map { RemoteStatsProject(key: $0.id, label: $0.label) },
            features: features,
            hiddenPlanFeatures: board.project.hiddenPlanFeatures
        )
    }

    // MARK: - Catalogue des modèles (S-14)

    /// Le catalogue `omp models --json`, chargé par `ModelCatalogLoader` (délai de
    /// garde 15 s). Un binaire absent, un code non nul ou une sortie illisible ne
    /// jetent PAS : la réponse porte `failure` et une liste vide — le client
    /// affiche le motif, ce n'est pas une erreur de transport.
    func models() async -> RemoteModelsPayload {
        switch await ModelCatalogLoader.loadDefault() {
        case .success(let selectors):
            return RemoteModelsPayload(selectors: selectors, failure: nil)
        case .failure(let error):
            return RemoteModelsPayload(selectors: [], failure: error.reason)
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

    // MARK: - Composants, journal, contrat

    /// L'état des composants et de la préparation (S-4), rendu par la fermeture
    /// injectée : l'API ne relit jamais les modèles elle-même.
    func components() -> RemoteComponentsPayload {
        componentsProvider()
    }

    /// Le journal des gestes, servi tel quel (S-5).
    func journal() -> RemoteJournalPayload {
        RemoteJournalPayload(entries: actions.journal)
    }

    /// Le contrat d'une carte (S-6) : la carte par l'ardoise déjà dérivée, le
    /// chemin par `ContractDocument.path`. 404 carte inconnue ; 409 quand la carte
    /// n'a ni moment ni worktree.
    func cardContract(cardId: String) throws -> RemoteContractPayload {
        guard let card = kanban.state.card(cardId) else {
            throw ConsoleAPIError.notFound("carte inconnue")
        }
        guard ContractDocument.moment(for: card) != nil,
              let worktree = card.action?.worktree, !worktree.isEmpty else {
            throw ConsoleAPIError.conflict("carte sans contrat")
        }
        return RemoteContractPayload(document: Self.document(
            name: "contract.md",
            path: ContractDocument.path(worktree: worktree)
        ))
    }

    // MARK: - Mémoire

    /// Le sommaire d'une portée (S-1) : la portée est résolue AVANT toute lecture,
    /// et une portée nulle rend la page vide SANS appeler le service (S-2) — c'est
    /// le signal « aucun projet ouvert », jamais un 200 muet ni une liste vide.
    /// Les lignes sont bornées en NOMBRE (`RemoteLimits.memoryRows`) puis en octets,
    /// la TÊTE (les plus récentes) conservée, `truncated` posé dès qu'une ligne est
    /// retirée.
    func memory(scope: String?, limit rawLimit: String?) async throws -> RemoteMemoryPagePayload {
        let limit = try Self.memoryLimit(rawLimit)
        let scope = await resolvedScope(scope)
        guard let scope else {
            return RemoteMemoryPagePayload(scope: nil, total: 0, rows: [], truncated: false)
        }
        do {
            let page = try await service.all(scope: scope)
            return Self.memoryPage(
                scope: scope,
                total: page.total,
                rows: page.rows,
                limit: limit ?? RemoteLimits.memoryRows
            )
        } catch {
            throw Self.memoryError(error, config: memoryConfig)
        }
    }

    /// La recherche dans la mémoire du projet (S-7) : sans portée résolue, elle est
    /// refusée AVANT toute lecture (S-2) ; sans `limit`, elle emploie le défaut de
    /// l'outil `mem0_search` (`MemorySearch.defaultLimit`), et la sélection reste
    /// celle de la coque (`MemorySearch.select`, aucun second seuil).
    func memorySearch(query: String?, scope: String?, limit rawLimit: String?) async throws -> RemoteMemorySearchPayload {
        let limit = try Self.memoryLimit(rawLimit) ?? MemorySearch.defaultLimit
        guard let query, !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw ConsoleAPIError.badRequest("requête vide")
        }
        guard let scope = await resolvedScope(scope) else {
            throw ConsoleAPIError.badRequest("aucun projet ouvert")
        }
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

    /// Le graphe complet d'une base, en LECTURE SEULE (S-1, AC-1/2/8) : les mêmes
    /// nœuds et arêtes que le mode graphe de la coque macOS pour la même base.
    ///
    /// `scope` NON VIDE ⇒ les souvenirs de cette portée ; absent ou vide ⇒ TOUTES
    /// les portées, SANS repli sur le projet courant (la coque macOS lit
    /// `service.all(scope: nil)` : un repli ferait diverger les deux graphes dès
    /// qu'un projet est ouvert).
    ///
    /// Les lignes sont bornées en NOMBRE (`RemoteLimits.memoryRows`, TÊTE conservée)
    /// puis en OCTETS : tant que la charge dépasse `RemoteLimits.responseBody`, on
    /// retire la moitié de la queue et l'on RE-DÉRIVE nœuds et liens sur les lignes
    /// gardées — jamais un lien dont une extrémité a disparu, jamais un
    /// nœud-étiquette orphelin.
    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        let scope = (scope?.isEmpty == false) ? scope : nil
        let page: MemoryPage
        do {
            page = try await service.all(scope: scope)
        } catch {
            throw Self.memoryError(error, config: memoryConfig)
        }
        let edges: [MemoryGraphEdge]
        do {
            edges = try await service.graph().edges
        } catch {
            throw Self.graphError(error, config: memoryConfig)
        }
        let manual = MemoryLinkStore.load(memoryLinks)
        return Self.memoryGraph(rows: page.rows, edges: edges, manual: manual)
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

    /// Le vocabulaire du fil, délégué au noyau PARTAGÉ (`MemoryGraphWire`, S-2) :
    /// plus de seconde table de correspondance.
    static func nodeID(_ id: MemoryGraphNodeID) -> String {
        MemoryGraphWire.id(id)
    }

    static func kind(_ kind: MemoryGraphLinkKind) -> String {
        MemoryGraphWire.name(kind)
    }

    static func score(_ kind: MemoryGraphLinkKind) -> Double? {
        if case .semantic(let score) = kind { return score }
        return nil
    }

    /// Le graphe borné (S-1) : la dérivation partagée des lignes gardées, bornée en
    /// NOMBRE (tête conservée) puis en OCTETS — chaque retrait RE-DÉRIVE nœuds et
    /// liens, donc aucun lien orphelin ni nœud-étiquette sans porteur.
    static func memoryGraph(
        rows: [MemoryRow],
        edges: [MemoryGraphEdge],
        manual: Set<MemoryLink>
    ) -> RemoteMemoryGraphPayload {
        var kept = Array(rows.prefix(max(0, RemoteLimits.memoryRows)))
        var truncated = rows.count > kept.count
        var payload = graphPayload(rows: kept, edges: edges, manual: manual, truncated: truncated)
        while (try? HTTPJSON.encode(payload))?.count ?? 0 > RemoteLimits.responseBody, kept.count > 0 {
            kept = Array(kept.dropLast(max(1, kept.count / 2)))
            truncated = true
            payload = graphPayload(rows: kept, edges: edges, manual: manual, truncated: truncated)
        }
        return payload
    }

    /// La projection filaire des faits du noyau : `text`/`tags` pour les seuls
    /// nœuds-souvenirs, `score` pour les seules arêtes `semantic`.
    private static func graphPayload(
        rows: [MemoryRow],
        edges: [MemoryGraphEdge],
        manual: Set<MemoryLink>,
        truncated: Bool
    ) -> RemoteMemoryGraphPayload {
        let nodes = MemoryGraph.nodes(rows: rows)
        let links = MemoryGraph.links(rows: rows, edges: edges, manual: manual)
        return RemoteMemoryGraphPayload(
            nodes: nodes.map { node in
                RemoteMemoryGraphNode(
                    id: MemoryGraphWire.id(node.id),
                    label: node.label,
                    scope: node.scope ?? "",
                    text: node.text,
                    tags: node.text == nil ? nil : node.tags
                )
            },
            links: links.map { link in
                RemoteMemoryGraphLink(
                    a: MemoryGraphWire.id(link.a),
                    b: MemoryGraphWire.id(link.b),
                    kind: MemoryGraphWire.name(link.kind),
                    score: score(link.kind)
                )
            },
            total: nodes.count,
            truncated: truncated
        )
    }

    /// `limit` : entier FACULTATIF, 1…`memoryLimitMax`, `nil` quand il est absent
    /// (chaque lecture choisit alors son propre défaut) ; hors bornes → 400.
    static func memoryLimit(_ raw: String?) throws -> Int? {
        guard let raw, !raw.isEmpty else { return nil }
        guard let value = Int(raw), value >= 1, value <= RemoteLimits.memoryLimitMax else {
            throw ConsoleAPIError.badRequest("limit hors bornes")
        }
        return value
    }

    /// La page bornée (S-1) : le NOMBRE d'abord (tête conservée), puis les OCTETS —
    /// tant que la charge dépasse `RemoteLimits.responseBody`, on retire la moitié
    /// de la QUEUE et l'on pose `truncated`. La tête (les plus récents, l'ordre du
    /// service est `updated_at` décroissant) est ce qu'on garde, contrairement aux
    /// sessions et aux statistiques qui gardent la fin de leur liste.
    static func memoryPage(
        scope: String,
        total: Int,
        rows: [MemoryRow],
        limit: Int
    ) -> RemoteMemoryPagePayload {
        var kept = Array(rows.prefix(max(0, limit)).map(RemoteMemoryRow.init))
        var truncated = rows.count > kept.count
        var payload = RemoteMemoryPagePayload(scope: scope, total: total, rows: kept, truncated: truncated)
        while (try? HTTPJSON.encode(payload))?.count ?? 0 > RemoteLimits.responseBody, kept.count > 0 {
            kept = Array(kept.dropLast(max(1, kept.count / 2)))
            truncated = true
            payload = RemoteMemoryPagePayload(scope: scope, total: total, rows: kept, truncated: truncated)
        }
        return payload
    }

    /// La traduction des pannes de la pile mémoire (S-3) : jamais un 200 vide, et
    /// le message est EXACTEMENT celui de la coque — l'adresse RÉELLEMENT sondée
    /// (`MemoryServiceConfig.baseURL`) puis le dernier échec, en un seul mot.
    static func memoryError(_ error: Error, config: MemoryServiceConfig) -> ConsoleAPIError {
        guard let failure = error as? MemoryServiceError else { return .server("mémoire indisponible") }
        return .unavailable(
            MemoryText.unavailableDetail(address: config.baseURL.absoluteString, error: failure.userMessage)
        )
    }

    /// La traduction d'une panne de l'appel `/memory/graph` SEUL : un 404 ou un 405
    /// amont signifie « route graphe absente côté mem0-http » (Starlette répond 405
    /// quand un motif `/memory/{id}` capte le chemin, 404 sinon) et rend le code
    /// structuré `outdated_service` ; toute autre panne reste celle de `memoryError`.
    static func graphError(_ error: Error, config: MemoryServiceConfig) -> ConsoleAPIError {
        let translated = memoryError(error, config: config)
        guard case .unexpectedStatus(let status, _)? = error as? MemoryServiceError,
              status == 404 || status == 405,
              case .unavailable(let message) = translated else {
            return translated
        }
        return .outdatedService(message)
    }
}
