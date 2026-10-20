// Les routes de LECTURE : la version, la mémoire du projet, les composants et la
// liste des appareils.
//
// Aucune lecture disque propre à l'API : tout vient des couches existantes —
// `MemoryServing`, `DeviceRegistry`, l'état des composants injecté par la racine.
// C'est ce qui garantit que l'API dit l'état RÉEL de la coque à l'instant de la
// requête (AC-6).

import ConsoleCore
import Foundation

@MainActor
final class RemoteReads {
    let registry: DeviceRegistry
    let service: any MemoryServing
    let memoryConfig: MemoryServiceConfig
    let memoryLinks: URL
    let environment: [String: String]
    let clock: RemoteClock
    /// L'état des composants et de la préparation (S-4), injecté par la racine
    /// macOS : une seule source de vérité, aucune lecture propre à l'API.
    let componentsProvider: @MainActor () -> RemoteComponentsPayload

    init(
        registry: DeviceRegistry,
        service: any MemoryServing,
        memoryConfig: MemoryServiceConfig,
        memoryLinks: URL,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        clock: RemoteClock = .live,
        components: @escaping @MainActor () -> RemoteComponentsPayload = {
            RemoteComponentsPayload(ompInstalled: false, ompPath: nil, setupBanner: nil)
        }
    ) {
        self.registry = registry
        self.service = service
        self.memoryConfig = memoryConfig
        self.memoryLinks = memoryLinks
        self.environment = environment
        self.clock = clock
        self.componentsProvider = components
    }

    // MARK: - Socle

    func version() -> RemoteVersionPayload {
        RemoteVersionPayload(protocolVersion: ConsoleAPI.protocolVersion)
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

    // MARK: - Composants

    /// L'état des composants et de la préparation (S-4), rendu par la fermeture
    /// injectée : l'API ne relit jamais les modèles elle-même.
    func components() -> RemoteComponentsPayload {
        componentsProvider()
    }

    // MARK: - Mémoire

    /// Une page du sommaire d'une portée (S-1) : les bornes `offset`/`limit` sont
    /// vérifiées AVANT toute lecture, la portée est résolue ensuite, et une portée
    /// nulle rend la page vide SANS appeler le service — c'est le signal « aucun
    /// projet ouvert ». Sinon UNE lecture du service, dont on sert la tranche
    /// `[offset, offset+limit)` dans l'ordre du service (`pagePayload`).
    func memoryPage(scope: String?, offset rawOffset: String?, limit rawLimit: String?) async throws -> RemoteMemoryPagePayload {
        let offset = try Self.memoryOffset(rawOffset)
        let limit = try Self.memoryLimit(rawLimit) ?? RemoteLimits.memoryPageSize
        let scope = await resolvedScope(scope)
        guard let scope else {
            return RemoteMemoryPagePayload(scope: nil, total: 0, offset: 0, rows: [], nextOffset: nil)
        }
        do {
            let page = try await service.all(scope: scope)
            return Self.pagePayload(
                scope: scope,
                total: page.total,
                rows: page.rows,
                offset: offset,
                limit: limit
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

    /// Le graphe d'UNE portée, en LECTURE SEULE (S-6) : la portée est résolue
    /// comme pour la liste et la recherche (explicite, sinon le projet courant) ;
    /// sans portée résolue, un graphe vide `scope: nil` SANS appel au service.
    /// Nœuds et liens sont dérivés par le noyau sur les SEULES lignes de la
    /// portée : arêtes et liens manuels dont une extrémité est hors portée
    /// n'apparaissent pas. La coque macOS lit `MemoryServing` directement et
    /// n'est pas concernée.
    ///
    /// Aucune borne en NOMBRE ; la borne d'OCTETS est celle du graphe
    /// (`RemoteLimits.memoryGraphBody`) : au-delà seulement, on retire la moitié
    /// de la queue et l'on RE-DÉRIVE nœuds et liens sur les lignes gardées.
    func memoryGraph(scope: String?) async throws -> RemoteMemoryGraphPayload {
        let scope = await resolvedScope(scope)
        guard let scope else {
            return RemoteMemoryGraphPayload(scope: nil, nodes: [], links: [], total: 0, truncated: false)
        }
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
        return Self.memoryGraph(scope: scope, rows: page.rows, edges: edges, manual: manual)
    }

    private func resolvedScope(_ scope: String?) async -> String? {
        if let scope, !scope.isEmpty { return scope }
        return await MemoryScope.currentProject(environment: environment)
    }

    // MARK: - Fabriques internes

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

    /// Le graphe borné (S-6) : la dérivation partagée de toutes les lignes, bornée
    /// en OCTETS seulement (`bodyLimit`) — chaque retrait RE-DÉRIVE nœuds et liens,
    /// donc aucun lien orphelin ni nœud-étiquette sans porteur.
    static func memoryGraph(
        scope: String,
        rows: [MemoryRow],
        edges: [MemoryGraphEdge],
        manual: Set<MemoryLink>,
        bodyLimit: Int = RemoteLimits.memoryGraphBody
    ) -> RemoteMemoryGraphPayload {
        var kept = rows
        var truncated = false
        var payload = graphPayload(scope: scope, rows: kept, edges: edges, manual: manual, truncated: truncated)
        while (try? HTTPJSON.encode(payload))?.count ?? 0 > bodyLimit, kept.count > 0 {
            kept = Array(kept.dropLast(max(1, kept.count / 2)))
            truncated = true
            payload = graphPayload(scope: scope, rows: kept, edges: edges, manual: manual, truncated: truncated)
        }
        return payload
    }

    /// La projection filaire des faits du noyau : `text`/`tags` pour les seuls
    /// nœuds-souvenirs, `score` pour les seules arêtes `semantic`.
    private static func graphPayload(
        scope: String,
        rows: [MemoryRow],
        edges: [MemoryGraphEdge],
        manual: Set<MemoryLink>,
        truncated: Bool
    ) -> RemoteMemoryGraphPayload {
        let nodes = MemoryGraph.nodes(rows: rows)
        let links = MemoryGraph.links(rows: rows, edges: edges, manual: manual)
        return RemoteMemoryGraphPayload(
            scope: scope,
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

    /// `offset` : entier FACULTATIF ≥ 0, 0 quand il est absent ; non entier ou
    /// négatif → 400.
    static func memoryOffset(_ raw: String?) throws -> Int {
        guard let raw, !raw.isEmpty else { return 0 }
        guard let value = Int(raw), value >= 0 else {
            throw ConsoleAPIError.badRequest("offset hors bornes")
        }
        return value
    }

    /// La tranche `[offset, offset+limit)` des lignes du service, dans SON ordre
    /// (`updated_at` décroissant), puis la borne d'OCTETS : tant que la charge
    /// dépasse `RemoteLimits.responseBody` et que la tranche compte plus d'une
    /// ligne, on retire la moitié de la QUEUE — une ligne au moins est toujours
    /// servie. `nextOffset` vaut `offset + rows.count` tant qu'il reste des lignes
    /// au service, absent sinon ; un `offset` au-delà de la fin rend une page vide.
    static func pagePayload(
        scope: String,
        total: Int,
        rows: [MemoryRow],
        offset: Int,
        limit: Int
    ) -> RemoteMemoryPagePayload {
        let start = min(max(0, offset), rows.count)
        var kept = Array(rows[start...].prefix(max(1, limit)).map(RemoteMemoryRow.init))
        func page() -> RemoteMemoryPagePayload {
            let next = start + kept.count
            return RemoteMemoryPagePayload(
                scope: scope,
                total: total,
                offset: offset,
                rows: kept,
                nextOffset: next < rows.count ? next : nil
            )
        }
        var payload = page()
        while (try? HTTPJSON.encode(payload))?.count ?? 0 > RemoteLimits.responseBody, kept.count > 1 {
            kept = Array(kept.dropLast(max(1, kept.count / 2)))
            payload = page()
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
