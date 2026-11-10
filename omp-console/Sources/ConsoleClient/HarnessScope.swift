// La PORTÉE D'ESPACE du client : l'espace courant (`HarnessModel.scope` — un client de
// l'utilisateur, ou `nil` pour tous les espaces), gardé par serveur d'un lancement à l'autre
// (`ConsoleSpacePreference`), restauré quand les espaces sont lus, oublié s'il n'existe plus.
//
// Ce que le serveur COMPOSE (brief, chiffres, propositions) se lit avec `?space=<id>` quand
// une portée est posée, et se relit quand elle change. Ce qui vient de la BOÎTE (features,
// décisions, sessions locales, poste) reste lu en entier et se filtre dans l'app
// (`OSSpaces`).
//
// Le serveur annonce ce qu'il sait faire (`GET /v1/health`, `features`) : `space-scope`,
// `space-knowledge`, `space-workstation`, `space-policy`. Rien de ce qui en dépend ne part
// vers un serveur qui ne l'annonce pas — ni paramètre `space`, ni route nouvelle : la portée
// se borne alors dans l'app, par les dépôts de l'espace. Aucun texte ici.

import Foundation

/// Une capacité du multi-client, telle que `GET /v1/health` l'annonce dans `features`.
public enum HarnessCapability: String, CaseIterable, Sendable {
    /// `?space=` sur les lectures, l'espace d'une Demande, la pause et la consommation d'un espace.
    case spaceScope = "space-scope"
    /// Les consignes d'espace et la connexion Atlassian d'un espace.
    case spaceKnowledge = "space-knowledge"
    /// Le navigateur d'un espace, la demande au poste dans un espace, son profil.
    case spaceWorkstation = "space-workstation"
    /// La politique de modèles d'un espace, son étanchéité, l'accueil d'un client.
    case spacePolicy = "space-policy"
}

/// Une lecture faite dans la portée courante.
struct HarnessScopedRead<Value> {
    /// La réponse décodée ; `nil` : la route n'est pas servie (404).
    var value: Value?
    /// L'espace de la portée au départ de la lecture ; `nil` : tous les espaces.
    var space: HarnessSpace?
    /// Le serveur a borné la réponse lui-même (`?space=`).
    var byServer: Bool

    /// L'espace auquel il reste à borner la réponse dans l'app : le serveur ne l'a pas fait.
    var filter: HarnessSpace? { byServer ? nil : space }
}

extension HarnessModel {
    // MARK: - Capacités

    /// Le serveur relié annonce cette capacité ; faux tant que ses capacités ne sont pas lues.
    public func serves(_ capability: HarnessCapability) -> Bool {
        capabilities?.contains(capability.rawValue) ?? false
    }

    /// Lit les capacités du serveur relié (`GET /v1/health`), une fois par serveur ; un serveur
    /// injoignable les laisse inconnues, et le prochain appel réessaie.
    public func loadCapabilities() async {
        if capabilities != nil { return }
        if let running = capabilitiesTask {
            await running.value
            return
        }
        guard let server else { return }
        let epoch = serverEpoch
        let task = Task { [weak self] in
            guard let self else { return }
            await self.readCapabilities(from: server, epoch: epoch)
        }
        capabilitiesTask = task
        await task.value
        if capabilitiesTask == task { capabilitiesTask = nil }
    }

    private func readCapabilities(from server: HarnessServer, epoch: Int) async {
        guard let reply = try? await transport.send(HarnessCall(method: "GET", path: "/v1/health"), server: server),
              epoch == serverEpoch
        else { return }
        switch reply.status {
        case 200, 503:
            // 503 au moindre échec, corps lisible quand même ; illisible : un serveur qui n'annonce rien.
            capabilities = Set((try? JSONDecoder().decode(HarnessHealth.self, from: reply.body))?.features ?? [])
        case 404:
            capabilities = []
        default:
            // Une panne de passage : les capacités restent inconnues, le prochain appel réessaie.
            break
        }
    }

    /// Les capacités lues si elles ne l'étaient pas, puis ce que le serveur dit de celle-ci.
    func supports(_ capability: HarnessCapability) async -> Bool {
        await loadCapabilities()
        return serves(capability)
    }

    // MARK: - Portée

    /// Pose l'espace courant (`nil` : tous les espaces). Le choix est gardé pour ce serveur ;
    /// ce que le serveur compose pour la portée (brief, chiffres, propositions) est vidé puis
    /// relu, et les consignes en portée sont republiées.
    public func setScope(_ space: HarnessSpace?) {
        let changed = space?.id != scope?.id
        if scope != space { scope = space }
        guard changed else { return }
        if let address { spacePreference.choose(space?.id, forServer: address) }
        scopeChanged()
    }

    /// La portée a changé : toute lecture en vol pour l'ancienne est abandonnée, et les
    /// modèles déjà lus se relisent pour la nouvelle.
    private func scopeChanged() {
        scopeEpoch += 1
        brief.rescope()
        scoreboard.rescope()
        proposals.rescope()
        rules.rescope()
    }

    /// Les espaces viennent d'être lus : l'espace gardé pour ce serveur redevient la portée ;
    /// la portée suit l'espace relu (ses chiffres, sa révision), et tombe — choix oublié — si
    /// l'espace n'existe plus.
    func spacesRead(_ list: [HarnessSpace]) {
        guard let address else { return }
        if let current = scope {
            if let fresh = list.first(where: { $0.id == current.id }) {
                if fresh != current { scope = fresh }
            } else {
                scope = nil
                spacePreference.choose(nil, forServer: address)
                scopeChanged()
            }
            return
        }
        guard let stored = spacePreference.spaceId(forServer: address) else { return }
        if let space = list.first(where: { $0.id == stored }) {
            scope = space
            scopeChanged()
        } else {
            spacePreference.choose(nil, forServer: address)
        }
    }

    /// Avant la première lecture bornée : si un espace est gardé pour ce serveur et que les
    /// espaces n'ont pas encore été lus, ils le sont — la portée est restaurée AVANT la
    /// lecture, qui ne montre donc jamais tous les espaces à la place du sien.
    private func restoreScope() async {
        guard scope == nil, let address, spacePreference.spaceId(forServer: address) != nil, spaces.availability == .unknown else { return }
        if let running = scopeRestoreTask {
            await running.value
            return
        }
        let task = Task { [weak self] in
            guard let self else { return }
            await self.spaces.refresh()
        }
        scopeRestoreTask = task
        await task.value
        if scopeRestoreTask == task { scopeRestoreTask = nil }
    }

    /// `path`, complété de `space=<id>`.
    nonisolated static func path(_ path: String, space id: String) -> String {
        path + (path.contains("?") ? "&" : "?") + "space=" + queryValue(id)
    }

    /// Une lecture que le serveur compose, dans la portée courante : avec `?space=` quand un
    /// espace est choisi et que le serveur annonce `capability` ; sinon telle quelle, et
    /// `filter` dit l'espace auquel la borner dans l'app. Liée au serveur comme `readBound`,
    /// et à la portée : si elle a changé avant la réponse, la lecture lève `CancellationError`
    /// (celle de la nouvelle portée est déjà partie).
    func readScoped<T: Decodable>(_ path: String, capability: HarnessCapability = .spaceScope) async throws -> HarnessScopedRead<T> {
        await restoreScope()
        if scope != nil { await loadCapabilities() }
        let epoch = scopeEpoch
        let space = scope
        let byServer = space != nil && serves(capability)
        do {
            let value: T? = try await readBound(space.map { byServer ? Self.path(path, space: $0.id) : path } ?? path)
            // 404 sous `?space=` : l'espace a disparu du serveur. Les espaces relus font tomber la portée.
            if value == nil, byServer { await spaces.refresh() }
            guard epoch == scopeEpoch else { throw CancellationError() }
            return HarnessScopedRead(value: value, space: space, byServer: byServer)
        } catch {
            guard epoch == scopeEpoch else { throw CancellationError() }
            throw error
        }
    }

    // MARK: - Atlassian dans la portée

    /// Relit la connexion Atlassian par défaut et celle de chaque espace branché (la liste des
    /// espaces dit lesquels) : de quoi montrer tout ce qui attend l'humain, client par client.
    public func refreshAtlassianConnections() async {
        await atlassian.refresh()
        for space in spaces.spaces where space.atlassian?.connected == true {
            await atlassianConnection(for: space).refresh()
        }
    }

    /// Les commentaires Jira proposés qui attendent l'humain dans `space` : ceux de sa
    /// connexion ; sans espace (`nil`), ceux de la connexion par défaut puis de chaque
    /// connexion d'espace déjà lue, dans l'ordre des espaces. Chaque écriture dit son espace (`space`).
    public func atlassianProposals(in space: HarnessSpace?) -> [AtlassianWrite] {
        let connections = space.map { [spaceConnections[$0.id]].compactMap { $0 } }
            ?? [atlassian] + spaces.spaces.compactMap { spaceConnections[$0.id] }
        return connections.filter { $0.availability == .available }.flatMap(\.proposals)
    }
}
