// Le modèle observable du SERVEUR DE PIPELINES, partagé par la coque Mac et l'app
// iOS : l'adresse (préférences) et le jeton (trousseau), la boîte de l'humain
// (escalades batchées, verdicts à valider, décisions prises seules, features en
// cours), le flux d'événements qui la tient à jour, et les gestes.
//
// Aucun texte ici : un échec est un `HarnessFailure`, que les écrans traduisent avec
// `PipelineServerText` (noyau partagé).

import Combine
import Foundation

@MainActor
public final class HarnessModel: ObservableObject {
    /// La préférence qui garde l'adresse du serveur.
    public static let addressKey = "harness.address"
    /// Le service et le compte du jeton dans le trousseau.
    public static let keychainService = "com.omp.console.harness"
    public static let tokenAccount = "harness"

    /// L'adresse du serveur configuré, ou `nil`.
    @Published public private(set) var address: String?
    /// La dernière boîte reçue (gardée hors ligne : on l'affiche avec un bandeau).
    @Published public private(set) var inbox: HarnessInbox?
    /// Le dernier échec, effacé par le prochain échange réussi.
    @Published public private(set) var failure: HarnessFailure?
    @Published public private(set) var isLoading = false
    /// Le flux d'événements est ouvert : la boîte se met à jour seule.
    @Published public private(set) var isLive = false
    /// Les runs dont un geste attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []
    /// Le chargement initial (préférences + trousseau) a eu lieu.
    @Published public private(set) var isLoaded = false
    /// Le catalogue du serveur, lu à la demande des écrans qui en ont besoin :
    /// dépôts déclarés, projets, audits, statistiques.
    @Published public private(set) var repos: [HarnessRepo] = []
    @Published public private(set) var projects: [HarnessProject] = []
    @Published public private(set) var audits: [HarnessAudit] = []
    @Published public private(set) var stats: HarnessStats?
    /// Les audits dont un geste attend la réponse du serveur.
    @Published public private(set) var busyAudits: Set<String> = []
    /// Un lancement (feature, projet, audit) attend la réponse du serveur.
    @Published public private(set) var isLaunching = false
    /// Le client de ce jeton (`/v1/me`) : son rôle dit si les gestes sont permis.
    /// `nil` tant qu'il n'est pas lu, ou avec un serveur antérieur aux clients multiples.
    @Published public private(set) var client: HarnessClient?
    /// Les fournisseurs LLM et les chaînes de modèles (admin), lus à la demande de leur écran.
    @Published public private(set) var providerCatalog: HarnessProviderCatalog?
    /// Une déclaration de fournisseur ou de modèles attend la réponse du serveur.
    @Published public private(set) var isSavingProviders = false
    /// Les abonnements que le serveur sait connecter (admin) ; `nil` tant qu'ils ne sont
    /// pas lus, ou avec un serveur qui ne les connaît pas (la section se cache).
    @Published public private(set) var loginProviders: [HarnessLoginProvider]?
    /// La connexion d'abonnement en cours, ou la dernière finie tant qu'elle n'est pas refermée.
    @Published public private(set) var login: HarnessLogin?

    private let transport: any HarnessTransport
    private let preferences: any ClientPreferences
    private let tokens: any TokenStore
    private let retryDelay: Duration
    private let refreshDelay: Duration
    /// Le rythme de relecture d'une connexion d'abonnement en cours.
    private let loginPollDelay: Duration
    /// Le serveur de la machine quand rien n'est enregistré (Mac : `~/.omp/harness.json`).
    private let fallback: @Sendable () -> (address: String, token: String)?
    /// Un code d'appairage accepté (Mac : écrit pour les plugins d'omp et la mémoire).
    private let onPaired: @Sendable (HarnessPairing) -> Void
    private var server: HarnessServer?
    private var liveTask: Task<Void, Never>?
    private var refreshTask: Task<Void, Never>?
    /// Un écran a demandé le catalogue : le flux le relit avec la boîte.
    private var wantsCatalog = false
    /// `/v1/me` a été demandé pour ce serveur (une fois : un serveur ancien ne l'a pas).
    private var clientAsked = false
    /// L'écran des fournisseurs est ouvert : le flux les relit avec la boîte.
    private var wantsProviders = false
    /// La relecture de la connexion d'abonnement en cours.
    private var loginTask: Task<Void, Never>?

    public init(
        transport: any HarnessTransport,
        preferences: any ClientPreferences,
        tokens: any TokenStore,
        retryDelay: Duration = .seconds(5),
        refreshDelay: Duration = .milliseconds(300),
        loginPollDelay: Duration = .seconds(1),
        fallback: @escaping @Sendable () -> (address: String, token: String)? = { nil },
        onPaired: @escaping @Sendable (HarnessPairing) -> Void = { _ in }
    ) {
        self.transport = transport
        self.preferences = preferences
        self.tokens = tokens
        self.retryDelay = retryDelay
        self.refreshDelay = refreshDelay
        self.loginPollDelay = loginPollDelay
        self.fallback = fallback
        self.onPaired = onPaired
    }

    /// La production : `URLSession`, `UserDefaults`, le trousseau ; `fallback` donne le
    /// serveur de la machine quand l'app n'en a pas enregistré, `onPaired` reçoit un
    /// code d'appairage accepté.
    public static func live(
        fallback: @escaping @Sendable () -> (address: String, token: String)? = { nil },
        onPaired: @escaping @Sendable (HarnessPairing) -> Void = { _ in }
    ) -> HarnessModel {
        HarnessModel(
            transport: URLSessionHarnessTransport(),
            preferences: UserDefaultsClientPreferences(),
            tokens: KeychainTokenStore(service: keychainService),
            fallback: fallback,
            onPaired: onPaired
        )
    }

    public var isConfigured: Bool { server != nil }

    /// Les gestes et lancements sont permis à ce jeton : vrai sauf pour un lecteur
    /// (un serveur qui ne dit rien de ses clients permet tout).
    public var canAct: Bool { client?.canAct ?? true }

    /// Ce jeton administre le serveur : fournisseurs LLM et modèles (lu dans `/v1/me`).
    public var isAdmin: Bool { client?.role == "admin" }

    // MARK: - Configuration

    /// L'adresse normalisée d'une saisie : https par défaut, sans barre finale.
    /// `nil` pour une saisie qui n'est pas une adresse http(s) avec un hôte.
    public nonisolated static func normalizedAddress(_ raw: String) -> String? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !text.contains(" ") else { return nil }
        if !text.contains("://") { text = "https://" + text }
        while text.hasSuffix("/") { text.removeLast() }
        guard let url = URL(string: text), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = url.host, !host.isEmpty
        else { return nil }
        return text
    }

    /// Lit l'adresse et le jeton enregistrés, sinon ceux de la machine (`fallback`),
    /// puis la boîte. Sans rien, rien.
    public func load() async {
        defer { isLoaded = true }
        guard server == nil else { return }
        if let stored = preferences.string(forKey: Self.addressKey),
           let normalized = Self.normalizedAddress(stored), let url = URL(string: normalized),
           let token = try? await tokens.token(for: Self.tokenAccount), !token.isEmpty {
            server = HarnessServer(baseURL: url, token: token)
            address = normalized
        } else if let shared = fallback(), let url = URL(string: shared.address) {
            server = HarnessServer(baseURL: url, token: shared.token)
            address = shared.address
        } else {
            return
        }
        await refresh()
    }

    /// Configure un serveur : l'adresse et le jeton ne sont enregistrés qu'après une
    /// boîte effectivement lue (une faute de frappe ne s'enregistre pas).
    /// Un code d'appairage (`omp1:…`) collé dans l'adresse porte l'adresse et le jeton.
    @discardableResult
    public func configure(address rawAddress: String, token tokenInput: String) async -> Bool {
        let pairing = HarnessPairing.decode(rawAddress)
        let raw = pairing?.address ?? rawAddress
        let rawToken = pairing?.token ?? tokenInput
        guard let normalized = Self.normalizedAddress(raw), let url = URL(string: normalized) else {
            failure = .invalidAddress
            return false
        }
        let token = rawToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else {
            failure = .unauthorized
            return false
        }
        let candidate = HarnessServer(baseURL: url, token: token)
        isLoading = true
        defer { isLoading = false }
        do {
            let fetched: HarnessInbox = try await perform(HarnessCall(method: "GET", path: "/v1/inbox"), on: candidate)
            try? await tokens.save(token, for: Self.tokenAccount)
            preferences.set(normalized, forKey: Self.addressKey)
            server = candidate
            address = normalized
            inbox = fetched
            client = nil
            clientAsked = false
            failure = nil
            if let pairing { onPaired(pairing) }
            await readClient()
            return true
        } catch {
            failure = Self.failure(of: error)
            return false
        }
    }

    /// Oublie le serveur : adresse, jeton et boîte.
    public func forget() async {
        stopLive()
        server = nil
        address = nil
        inbox = nil
        client = nil
        clientAsked = false
        repos = []
        projects = []
        audits = []
        stats = nil
        providerCatalog = nil
        wantsProviders = false
        loginTask?.cancel()
        loginTask = nil
        loginProviders = nil
        login = nil
        failure = nil
        preferences.set(nil, forKey: Self.addressKey)
        try? await tokens.remove(deviceId: Self.tokenAccount)
    }

    // MARK: - Lecture

    /// Relit la boîte. Un échec garde la dernière boîte reçue.
    public func refresh() async {
        guard let server else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            inbox = try await perform(HarnessCall(method: "GET", path: "/v1/inbox"), on: server)
            failure = nil
        } catch {
            failure = Self.failure(of: error)
        }
        if !clientAsked { await readClient() }
    }

    /// Lit le client de ce jeton (`/v1/me`). Un serveur antérieur aux clients multiples
    /// n'a pas cette route : rien n'est retenu, rien n'est signalé.
    private func readClient() async {
        guard let server else { return }
        clientAsked = true
        if let me: HarnessMe = try? await perform(HarnessCall(method: "GET", path: "/v1/me"), on: server) {
            client = me.client
        }
    }

    /// Relit le catalogue : dépôts, projets, audits, statistiques. Dès le premier appel,
    /// le flux le relit aussi à chaque événement.
    public func refreshCatalog() async {
        wantsCatalog = true
        guard let server else { return }
        do {
            let readStatus: HarnessStatus = try await perform(HarnessCall(method: "GET", path: "/v1/status"), on: server)
            let readProjects: HarnessProjects = try await perform(HarnessCall(method: "GET", path: "/v1/projects"), on: server)
            let readAudits: HarnessAudits = try await perform(HarnessCall(method: "GET", path: "/v1/audits"), on: server)
            let readStats: HarnessStats = try await perform(HarnessCall(method: "GET", path: "/v1/stats"), on: server)
            repos = readStatus.repos
            projects = readProjects.projects
            audits = readAudits.audits
            stats = readStats
            failure = nil
        } catch {
            failure = Self.failure(of: error)
        }
    }

    /// La vue d'un run : ses artefacts (les specs à valider), ou `nil` en cas d'échec.
    public func runView(_ runId: String) async -> HarnessRunView? {
        guard let server, let id = runId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        do {
            let view: HarnessRunView = try await perform(HarnessCall(method: "GET", path: "/v1/runs/\(id)"), on: server)
            failure = nil
            return view
        } catch {
            failure = Self.failure(of: error)
            return nil
        }
    }

    /// Ouvre le flux d'événements : chaque événement relit la boîte (regroupés), une
    /// coupure est reprise après `retryDelay`. Idempotent ; sans serveur configuré,
    /// rien ne part (l'appel qui suit une configuration réussie l'ouvrira).
    public func startLive() {
        guard liveTask == nil, server != nil else { return }
        liveTask = Task { [weak self] in
            guard let self else { return }
            await self.liveLoop()
        }
    }

    public func stopLive() {
        liveTask?.cancel()
        liveTask = nil
        refreshTask?.cancel()
        refreshTask = nil
        isLive = false
    }

    private func liveLoop() async {
        // Une boucle finie (serveur oublié) libère sa place : un `startLive` suivant repart.
        defer { if !Task.isCancelled { liveTask = nil } }
        while !Task.isCancelled {
            guard let server else { return }
            let cursor = inbox?.cursor ?? 0
            do {
                let stream = try await transport.events(HarnessCall(method: "GET", path: "/v1/events?after=\(cursor)"), server: server)
                isLive = true
                var parser = HarnessEventParser()
                for try await chunk in stream {
                    if !parser.consume(chunk).isEmpty { scheduleRefresh() }
                }
            } catch {
                if let failure = error as? HarnessFailure, failure == .unauthorized { self.failure = failure }
            }
            isLive = false
            if Task.isCancelled { return }
            try? await Task.sleep(for: retryDelay)
            if Task.isCancelled { return }
            await refresh()
        }
    }

    /// Une relecture regroupée : une rafale d'événements ne coûte qu'un appel.
    private func scheduleRefresh() {
        guard refreshTask == nil else { return }
        let delay = refreshDelay
        refreshTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            await self?.refresh()
            if self?.wantsCatalog == true { await self?.refreshCatalog() }
            if self?.wantsProviders == true { await self?.refreshProviders() }
            self?.refreshTask = nil
        }
    }

    // MARK: - Gestes

    /// Répond à TOUTES les escalades ouvertes d'un run (identifiant → réponse, et la raison
    /// facultative de chaque réponse) : le run reprend son étape quand la dernière est répondue.
    @discardableResult
    public func answer(runId: String, answers: [Int: String], reasons: [Int: String] = [:]) async -> Bool {
        let items = answers.keys.sorted().map { id in
            let reason = reasons[id]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return AnswerBody.Item(id: id, answer: answers[id] ?? "", reason: reason.isEmpty ? nil : reason)
        }
        return await gesture(runId, method: "POST", path: "/escalations", body: AnswerBody(answers: items))
    }

    /// Relance une feature en échec, ou arrêtée sur une attente : elle repart de son étape.
    @discardableResult
    public func retry(runId: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/retry", body: EmptyBody())
    }

    /// Accepte d'un coup toutes les décisions prises seules d'un run.
    @discardableResult
    public func acceptAllDecisions(runId: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/decisions/accept", body: EmptyBody())
    }

    /// Annule une feature fusionnée : son commit est inversé sur la branche principale.
    @discardableResult
    public func revert(runId: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/revert", body: EmptyBody())
    }

    /// Accepte une décision prise seule : elle tient.
    @discardableResult
    public func accept(runId: String, seq: Int) async -> Bool {
        await gesture(runId, method: "POST", path: "/decisions/\(seq)/accept", body: EmptyBody())
    }

    /// Renverse une décision : reprise au point de reprise, la raison rejoint la mémoire du projet.
    @discardableResult
    public func reverse(runId: String, seq: Int, option: String, reason: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/decisions/\(seq)/reverse", body: ReverseBody(option: option, reason: reason))
    }

    /// Valide un verdict (fusion) ou le refuse (correction, raison dans la mémoire du projet).
    @discardableResult
    public func validate(runId: String, approve: Bool, reason: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/validate", body: ValidateBody(approve: approve, reason: reason))
    }

    /// Annule une feature (sa branche reste).
    @discardableResult
    public func cancel(runId: String) async -> Bool {
        await gesture(runId, method: "POST", path: "/cancel", body: EmptyBody())
    }

    /// Change la priorité d'une feature (plus grand = admise plus tôt, de -1000 à 1000).
    @discardableResult
    public func setPriority(runId: String, priority: Int) async -> Bool {
        await gesture(runId, method: "POST", path: "/priority", body: PriorityBody(priority: priority))
    }

    // MARK: - Lancements

    /// Lance une feature : le serveur la conduit de /req au merge. `modules` (les chemins
    /// touchés) et `priority` sont facultatifs : sans eux, le serveur décide.
    @discardableResult
    public func launchRun(repo: String, title: String, request: String, modules: [String] = [], priority: Int? = nil) async -> HarnessRun? {
        let body = RunBody(repo: repo, title: title, request: request, modules: modules.isEmpty ? nil : modules, priority: priority)
        let reply: HarnessRunReply? = await launch("/v1/runs", body: body)
        return reply?.run
    }

    /// Lance un projet : ses features tournent en parallèle quand leurs modules sont disjoints.
    @discardableResult
    public func launchProject(repo: String, title: String, features: [HarnessFeatureDraft], priority: Int? = nil) async -> String? {
        let body = ProjectBody(
            repo: repo,
            title: title,
            priority: priority,
            features: features.map { ProjectBody.Feature(title: $0.title, request: $0.request, modules: $0.moduleList.isEmpty ? nil : $0.moduleList) }
        )
        let reply: HarnessProjectReply? = await launch("/v1/projects", body: body)
        return reply?.projectId
    }

    /// Lance l'audit d'un dépôt (`focus` vide : le dépôt entier).
    @discardableResult
    public func launchAudit(repo: String, focus: String) async -> HarnessAudit? {
        let reply: HarnessAuditReply? = await launch("/v1/audits", body: AuditBody(repo: repo, focus: focus))
        return reply?.audit
    }

    /// Les propositions retenues d'un audit (index) partent en projet.
    @discardableResult
    public func launchProposals(auditId: String, items: [Int], title: String) async -> String? {
        guard let id = auditId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return nil }
        busyAudits.insert(auditId)
        defer { busyAudits.remove(auditId) }
        let reply: HarnessProjectReply? = await launch("/v1/audits/\(id)/launch", body: ProposalsBody(items: items.sorted(), title: title))
        return reply?.projectId
    }

    /// Annule un audit (en file, en analyse, ou dont les propositions attendent).
    @discardableResult
    public func cancelAudit(_ auditId: String) async -> Bool {
        guard let id = auditId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return false }
        busyAudits.insert(auditId)
        defer { busyAudits.remove(auditId) }
        let reply: HarnessAuditReply? = await launch("/v1/audits/\(id)/cancel", body: EmptyBody())
        return reply != nil
    }

    private func launch<Body: Encodable, Reply: Decodable>(_ path: String, body: Body) async -> Reply? {
        guard let server else { return nil }
        guard let encoded = try? JSONEncoder().encode(body) else {
            failure = .unreadable
            return nil
        }
        isLaunching = true
        defer { isLaunching = false }
        do {
            let reply: Reply = try await perform(HarnessCall(method: "POST", path: path, body: encoded), on: server)
            failure = nil
            await refresh()
            await refreshCatalog()
            return reply
        } catch {
            failure = Self.failure(of: error)
            return nil
        }
    }

    private func gesture<Body: Encodable>(_ runId: String, method: String, path: String, body: Body) async -> Bool {
        guard let server else { return false }
        guard let encoded = try? JSONEncoder().encode(body),
              let id = runId.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else {
            failure = .unreadable
            return false
        }
        busy.insert(runId)
        defer { busy.remove(runId) }
        // La révision lue avec la boîte : un autre appareil qui a agi entre-temps fait refuser le geste.
        let headers = knownRun(runId)?.rev.map { ["If-Match": "\"\($0)\""] } ?? [:]
        do {
            let _: HarnessAck = try await perform(HarnessCall(method: method, path: "/v1/runs/\(id)\(path)", body: encoded, headers: headers), on: server)
            failure = nil
            await refresh()
            return true
        } catch {
            let failed = Self.failure(of: error)
            if failed == .stale { await refresh() }
            // Relue ou non, la boîte ne doit pas effacer la raison de l'échec.
            failure = failed
            return false
        }
    }

    /// Le run tel que la dernière boîte le montre (batches, validations, en cours).
    private func knownRun(_ runId: String) -> HarnessRun? {
        guard let inbox else { return nil }
        return inbox.batches.compactMap(\.run).first { $0.id == runId }
            ?? inbox.awaiting.first { $0.id == runId }
            ?? inbox.runs.first { $0.id == runId }
    }

    // MARK: - Fournisseurs (admin)

    /// Relit les fournisseurs et les chaînes de modèles. Dès le premier appel, le flux
    /// les relit aussi à chaque événement (un autre appareil admin a pu les changer).
    public func refreshProviders() async {
        wantsProviders = true
        guard let server else { return }
        do {
            providerCatalog = try await perform(HarnessCall(method: "GET", path: "/v1/providers"), on: server)
            failure = nil
        } catch {
            failure = Self.failure(of: error)
        }
    }

    /// Déclare ou modifie un fournisseur ; sa clé part vers le serveur et n'en revient pas.
    @discardableResult
    public func saveProvider(_ draft: HarnessProviderDraft) async -> Bool {
        guard draft.problem == nil, let name = draft.effectiveName.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else {
            failure = .rejected("")
            return false
        }
        let reply: HarnessProviderReply? = await administer("PUT", "/v1/providers/\(name)", body: draft.body)
        if reply != nil { await refreshProviders() }
        return reply != nil
    }

    /// Retire un fournisseur déclaré depuis les apps (refusé tant qu'une chaîne le nomme).
    @discardableResult
    public func removeProvider(_ name: String) async -> Bool {
        guard let id = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return false }
        let reply: HarnessAck? = await administer("DELETE", "/v1/providers/\(id)", body: nil as HarnessChainsBody?)
        if reply != nil { await refreshProviders() }
        return reply != nil
    }

    /// Remplace les chaînes de modèles ; `nil` revient à celles de la configuration du serveur.
    @discardableResult
    public func saveChains(_ chains: HarnessModelChains?) async -> Bool {
        let reply: HarnessProviderCatalog? = await administer("PUT", "/v1/models", body: HarnessChainsBody(models: chains))
        if let reply { providerCatalog = reply }
        return reply != nil
    }

    // MARK: - Abonnements (admin)

    /// Relit les abonnements et la connexion en cours (reprise si l'écran s'est rouvert).
    /// Un serveur qui ne les connaît pas laisse `loginProviders` à `nil`, sans échec affiché.
    public func refreshLogins() async {
        guard let server else { return }
        guard let catalog: HarnessLoginCatalog = try? await perform(HarnessCall(method: "GET", path: "/v1/oauth"), on: server) else {
            loginProviders = nil
            return
        }
        loginProviders = catalog.providers
        if let active = catalog.login {
            login = active
            followLogin()
        }
    }

    /// Lance la connexion d'un abonnement ; la page à ouvrir arrive dans `login`.
    @discardableResult
    public func startLogin(_ provider: String) async -> Bool {
        guard let id = provider.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) else { return false }
        let reply: HarnessLoginReply? = await administer("POST", "/v1/oauth/\(id)/login", body: nil as HarnessLoginAnswer?)
        guard let reply else { return false }
        login = reply.login
        followLogin()
        return true
    }

    /// Renvoie au serveur le code (ou l'adresse de la page finale) copié du navigateur.
    @discardableResult
    public func answerLogin(_ value: String) async -> Bool {
        let code = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let current = login, !code.isEmpty else { return false }
        let reply: HarnessLoginReply? = await administer("POST", "/v1/oauth/logins/\(current.id)/answer", body: HarnessLoginAnswer(value: code))
        guard let reply else { return false }
        login = reply.login
        followLogin()
        return true
    }

    /// Abandonne la connexion en cours : rien n'est enregistré.
    public func cancelLogin() async {
        guard let current = login, !current.isFinished else {
            login = nil
            return
        }
        let reply: HarnessLoginReply? = await administer("DELETE", "/v1/oauth/logins/\(current.id)", body: nil as HarnessLoginAnswer?)
        loginTask?.cancel()
        loginTask = nil
        login = reply?.login ?? login
    }

    /// Referme une connexion finie.
    public func dismissLogin() {
        guard login?.isFinished != false else { return }
        login = nil
    }

    /// Relit la connexion jusqu'à son issue ; à la fin, les fournisseurs et les abonnements
    /// sont relus (un abonnement connecté peut désormais figurer dans les modèles).
    private func followLogin() {
        guard loginTask == nil, let current = login, !current.isFinished else { return }
        let delay = loginPollDelay
        loginTask = Task { [weak self] in
            var id = current.id
            while !Task.isCancelled {
                try? await Task.sleep(for: delay)
                guard let self, !Task.isCancelled, let server = self.server else { break }
                guard let reply: HarnessLoginReply = try? await self.perform(HarnessCall(method: "GET", path: "/v1/oauth/logins/\(id)"), on: server)
                else { continue }
                // Une connexion relancée entre-temps a pris la place : on suit la nouvelle.
                if let shown = self.login, shown.id != id, !shown.isFinished { id = shown.id; continue }
                self.login = reply.login
                if reply.login.isFinished {
                    self.loginTask = nil
                    if reply.login.succeeded {
                        await self.refreshProviders()
                        await self.refreshLogins()
                    }
                    return
                }
            }
        }
    }

    private func administer<Body: Encodable, Reply: Decodable>(_ method: String, _ path: String, body: Body?) async -> Reply? {
        guard let server else { return nil }
        var encoded: Data?
        if let body {
            guard let data = try? JSONEncoder().encode(body) else {
                failure = .unreadable
                return nil
            }
            encoded = data
        }
        isSavingProviders = true
        defer { isSavingProviders = false }
        do {
            let reply: Reply = try await perform(HarnessCall(method: method, path: path, body: encoded), on: server)
            failure = nil
            return reply
        } catch {
            failure = Self.failure(of: error)
            return nil
        }
    }

    // MARK: - Échange

    private func perform<T: Decodable>(_ call: HarnessCall, on server: HarnessServer) async throws -> T {
        let reply = try await transport.send(call, server: server)
        switch reply.status {
        case 200, 201:
            guard let value = try? JSONDecoder().decode(T.self, from: reply.body) else { throw HarnessFailure.unreadable }
            return value
        case 401:
            throw HarnessFailure.unauthorized
        case 412:
            throw HarnessFailure.stale
        case 403:
            let message = (try? JSONDecoder().decode(HarnessErrorBody.self, from: reply.body))?.error ?? ""
            throw HarnessFailure.forbidden(message)
        default:
            let message = (try? JSONDecoder().decode(HarnessErrorBody.self, from: reply.body))?.error ?? ""
            throw HarnessFailure.rejected(message)
        }
    }

    private static func failure(of error: Error) -> HarnessFailure {
        (error as? HarnessFailure) ?? .unreachable
    }
}

private struct EmptyBody: Encodable {}

private struct AnswerBody: Encodable {
    /// `reason` absent du JSON quand il est `nil` : un serveur antérieur reçoit le même corps qu'avant.
    struct Item: Encodable {
        var id: Int
        var answer: String
        var reason: String?
    }

    var answers: [Item]
}

private struct ReverseBody: Encodable {
    var option: String
    var reason: String
}

private struct ValidateBody: Encodable {
    var approve: Bool
    var reason: String
}

private struct PriorityBody: Encodable {
    var priority: Int
}

/// Les champs facultatifs (`nil`) ne partent pas : un serveur antérieur reçoit le même corps qu'avant.
private struct RunBody: Encodable {
    var repo: String
    var title: String
    var request: String
    var modules: [String]?
    var priority: Int?
}

private struct ProjectBody: Encodable {
    struct Feature: Encodable {
        var title: String
        var request: String
        var modules: [String]?
    }

    var repo: String
    var title: String
    var priority: Int?
    var features: [Feature]
}

private struct AuditBody: Encodable {
    var repo: String
    var focus: String
}

private struct ProposalsBody: Encodable {
    var items: [Int]
    var title: String
}
