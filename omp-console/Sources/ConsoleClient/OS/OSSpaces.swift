// « OS agentique » : l'ESPACE comme contexte de tout l'écran. Ce qui vient de la boîte
// (features, fils, décisions, sessions locales, demandes et envois du poste, Demandes) est lu
// en entier et se range ici dans un espace — par son dépôt, par le navigateur du poste d'où
// il vient, par l'espace qu'il porte — pour être filtré (un espace choisi) ou groupé (« Tous
// les espaces »). S'y ajoutent la couleur stable d'un espace et, pour un serveur qui ne
// borne pas encore ses réponses à un espace, le même bornage fait dans l'app (brief,
// chiffres, propositions).
//
// Pur : aucune vue, aucun réseau, aucun texte.

import Foundation

/// Les éléments d'un espace ; `space == nil` : ce qui n'est dans aucun espace.
public struct OSSpaceGroup<Item>: Identifiable {
    public var space: HarnessSpace?
    public var items: [Item]

    public init(space: HarnessSpace?, items: [Item]) {
        self.space = space
        self.items = items
    }

    public var id: String { space?.id ?? "" }
}

extension OSSpaceGroup: Equatable where Item: Equatable {}
extension OSSpaceGroup: Sendable where Item: Sendable {}

/// Les consignes permanentes par niveau : celles de l'espace, celles de ses dépôts, celles de partout.
public struct OSRuleLevels: Equatable, Sendable {
    public var space: [HarnessStandingRule]
    public var repos: [HarnessStandingRule]
    public var everywhere: [HarnessStandingRule]

    public init(space: [HarnessStandingRule] = [], repos: [HarnessStandingRule] = [], everywhere: [HarnessStandingRule] = []) {
        self.space = space
        self.repos = repos
        self.everywhere = everywhere
    }

    public var isEmpty: Bool { space.isEmpty && repos.isEmpty && everywhere.isEmpty }
}

public enum OSSpaces {
    // MARK: Couleur

    /// Le nombre de couleurs de la palette des espaces.
    public static let paletteSize = 6

    /// L'indice de palette (0…5) d'un espace, tiré de son identifiant : le même d'un lancement
    /// à l'autre et d'un appareil à l'autre (FNV-1a sur ses octets ; `hashValue` ne l'est pas).
    public static func colorIndex(of spaceId: String) -> Int {
        var hash: UInt32 = 2_166_136_261
        for byte in spaceId.utf8 {
            hash = (hash ^ UInt32(byte)) &* 16_777_619
        }
        return Int(hash % UInt32(paletteSize))
    }

    /// L'indice de palette de chaque espace, sans deux espaces de la même couleur tant qu'il y
    /// en a six au plus : chacun prend l'indice tiré de son identifiant, sinon le suivant
    /// libre, dans l'ordre de création (un espace ajouté ne déplace jamais la couleur d'un ancien).
    public static func colorIndexes(_ spaces: [HarnessSpace]) -> [String: Int] {
        var taken = Set<Int>()
        var indexes: [String: Int] = [:]
        for space in spaces.sorted(by: { ($0.createdAt, $0.id) < ($1.createdAt, $1.id) }) {
            var index = colorIndex(of: space.id)
            if taken.count < paletteSize {
                while taken.contains(index) { index = (index + 1) % paletteSize }
            }
            taken.insert(index)
            indexes[space.id] = index
        }
        return indexes
    }

    // MARK: Dépôts

    /// Les dépôts d'un espace ; `nil` : tous les dépôts (aucun espace choisi).
    public static func repos(of space: HarnessSpace?) -> Set<String>? {
        space.map { Set($0.repos) }
    }

    /// Ces dépôts, bornés à ceux de l'espace, dans leur ordre ; sans espace, tous.
    public static func repos(_ names: [String], in space: HarnessSpace?) -> [String] {
        guard let space else { return names }
        return names.filter(space.repos.contains)
    }

    /// Ce dépôt est dans la portée : aucun espace choisi, ou un dépôt de l'espace.
    public static func holds(_ repo: String?, in space: HarnessSpace?) -> Bool {
        guard let space else { return true }
        guard let repo else { return false }
        return space.repos.contains(repo)
    }

    // MARK: Appartenance

    /// L'espace d'un dépôt : celui qui le compte parmi les siens (un dépôt n'en a qu'un).
    public static func space(ofRepo repo: String?, spaces: [HarnessSpace]) -> HarnessSpace? {
        guard let repo else { return nil }
        return spaces.first { $0.repos.contains(repo) }
    }

    /// L'espace d'un navigateur du poste : celui auquel il est rattaché. Sans navigateur
    /// désigné, c'est celui du navigateur par défaut (où part ce qui n'en cible aucun).
    public static func space(ofBrowser id: String?, spaces: [HarnessSpace], browsers: [WorkstationBrowser]) -> HarnessSpace? {
        let browser: WorkstationBrowser?
        if let id {
            browser = browsers.first { $0.id == id }
        } else {
            browser = browsers.first(where: \.isDefault)
        }
        guard let owner = browser?.space else { return legacyPoste(spaces, browsers) }
        return spaces.first { $0.id == owner }
    }

    /// Avant le poste par espace, UN espace portait le poste entier (`poste`) : tant qu'aucun
    /// navigateur n'est rattaché à un espace, ce qui vient du poste lui revient.
    private static func legacyPoste(_ spaces: [HarnessSpace], _ browsers: [WorkstationBrowser]) -> HarnessSpace? {
        browsers.contains { $0.space != nil } ? nil : spaces.first(where: \.poste)
    }

    public static func space(of run: HarnessRun, spaces: [HarnessSpace]) -> HarnessSpace? {
        space(ofRepo: run.repo, spaces: spaces)
    }

    /// L'espace d'une session locale : celui de son dépôt.
    public static func space(of session: HarnessLocalSession, spaces: [HarnessSpace]) -> HarnessSpace? {
        space(ofRepo: session.repo, spaces: spaces)
    }

    /// L'espace d'une demande au poste : celui qu'elle porte, sinon celui de son navigateur.
    public static func space(of request: WorkstationRequest, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> HarnessSpace? {
        if let owner = request.space { return spaces.first { $0.id == owner } }
        return space(ofBrowser: request.browserId, spaces: spaces, browsers: browsers)
    }

    /// L'espace d'une action du poste (un envoi à approuver, une ligne du journal) : celui du navigateur qui l'exécute.
    public static func space(of action: WorkstationAction, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> HarnessSpace? {
        space(ofSource: action.browserId, spaces: spaces, browsers: browsers)
    }

    /// L'espace d'une réunion transcrite : celui du navigateur d'où elle vient.
    public static func space(of meeting: WorkstationMeeting, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> HarnessSpace? {
        space(ofSource: meeting.browserId, spaces: spaces, browsers: browsers)
    }

    /// L'espace d'une automatisation : celui du navigateur de ses demandes (le navigateur par défaut si elle n'en désigne aucun).
    public static func space(of automation: WorkstationAutomation, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> HarnessSpace? {
        space(ofBrowser: automation.browserId, spaces: spaces, browsers: browsers)
    }

    /// L'espace de ce qui VIENT d'un navigateur (une action, une réunion) ; sans navigateur connu, hors espace.
    private static func space(ofSource browserId: String?, spaces: [HarnessSpace], browsers: [WorkstationBrowser]) -> HarnessSpace? {
        guard let browserId else { return legacyPoste(spaces, browsers) }
        return space(ofBrowser: browserId, spaces: spaces, browsers: browsers)
    }

    /// L'espace d'une Demande : celui où elle a été posée, sinon celui de son dépôt.
    public static func space(of intake: HarnessIntake, spaces: [HarnessSpace]) -> HarnessSpace? {
        if let owner = intake.space { return spaces.first { $0.id == owner.id } }
        return space(ofRepo: intake.repo, spaces: spaces)
    }

    public static func space(of proposal: HarnessProposal, spaces: [HarnessSpace]) -> HarnessSpace? {
        space(ofRepo: proposal.repo, spaces: spaces)
    }

    /// L'espace d'une consigne : le sien (consigne d'espace), sinon celui de son dépôt ; `nil` : partout, ou hors espace.
    public static func space(of rule: HarnessStandingRule, spaces: [HarnessSpace]) -> HarnessSpace? {
        if let owner = rule.space { return spaces.first { $0.id == owner } }
        return space(ofRepo: rule.repo, spaces: spaces)
    }

    /// L'espace d'un fil : celui de son dépôt ; sans dépôt, celui de sa dernière demande au
    /// poste, sinon celui de la Demande qui l'a ouvert. `nil` : hors de tout espace.
    public static func space(of thread: OSThread, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> HarnessSpace? {
        if thread.repo != nil { return space(ofRepo: thread.repo, spaces: spaces) }
        if let request = thread.requests.last { return space(of: request, spaces: spaces, browsers: browsers) }
        if let intake = thread.intake { return space(of: intake, spaces: spaces) }
        return nil
    }

    /// L'espace d'une décision : celui de son dépôt ; un envoi du poste, par son navigateur ;
    /// une Demande, par l'espace où elle a été posée ; un commentaire Jira, par sa connexion.
    public static func space(of decision: OSDecision, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> HarnessSpace? {
        if case let .approval(action) = decision { return space(of: action, spaces: spaces, browsers: browsers) }
        if case let .intake(intake) = decision { return space(of: intake, spaces: spaces) }
        if case let .jira(write) = decision { return write.space.flatMap { owner in spaces.first { $0.id == owner } } }
        return space(ofRepo: decision.repo, spaces: spaces)
    }

    // MARK: Filtre d'un espace

    /// `owner` est dans la portée : aucun espace choisi, ou celui-là.
    private static func within(_ owner: HarnessSpace?, _ scope: HarnessSpace?) -> Bool {
        scope == nil || owner?.id == scope?.id
    }

    /// Les features de l'espace (par dépôt) ; sans espace, toutes.
    public static func runs(_ runs: [HarnessRun], in space: HarnessSpace?) -> [HarnessRun] {
        runs.filter { holds($0.repo, in: space) }
    }

    public static func localSessions(_ sessions: [HarnessLocalSession], in space: HarnessSpace?) -> [HarnessLocalSession] {
        sessions.filter { holds($0.repo, in: space) }
    }

    public static func intakes(_ intakes: [HarnessIntake], in space: HarnessSpace?) -> [HarnessIntake] {
        guard let space else { return intakes }
        return intakes.filter { within(Self.space(of: $0, spaces: [space]), space) }
    }

    public static func proposals(_ proposals: [HarnessProposal], in space: HarnessSpace?) -> [HarnessProposal] {
        proposals.filter { holds($0.repo, in: space) }
    }

    public static func requests(
        _ requests: [WorkstationRequest], in space: HarnessSpace?, spaces: [HarnessSpace], browsers: [WorkstationBrowser]
    ) -> [WorkstationRequest] {
        requests.filter { within(Self.space(of: $0, spaces: spaces, browsers: browsers), space) }
    }

    /// Les actions du poste (envois à approuver, journal) qui viennent d'un navigateur de l'espace.
    public static func actions(
        _ actions: [WorkstationAction], in space: HarnessSpace?, spaces: [HarnessSpace], browsers: [WorkstationBrowser]
    ) -> [WorkstationAction] {
        actions.filter { within(Self.space(of: $0, spaces: spaces, browsers: browsers), space) }
    }

    /// Les réunions transcrites dans un navigateur de l'espace.
    public static func meetings(
        _ meetings: [WorkstationMeeting], in space: HarnessSpace?, spaces: [HarnessSpace], browsers: [WorkstationBrowser]
    ) -> [WorkstationMeeting] {
        meetings.filter { within(Self.space(of: $0, spaces: spaces, browsers: browsers), space) }
    }

    /// Les automatisations dont le navigateur est de l'espace.
    public static func automations(
        _ automations: [WorkstationAutomation], in space: HarnessSpace?, spaces: [HarnessSpace], browsers: [WorkstationBrowser]
    ) -> [WorkstationAutomation] {
        automations.filter { within(Self.space(of: $0, spaces: spaces, browsers: browsers), space) }
    }

    /// Les navigateurs du poste rattachés à l'espace ; sans espace, tous.
    public static func browsers(_ browsers: [WorkstationBrowser], in space: HarnessSpace?) -> [WorkstationBrowser] {
        guard let space else { return browsers }
        return browsers.filter { $0.space == space.id }
    }

    public static func threads(
        _ threads: [OSThread], in space: HarnessSpace?, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []
    ) -> [OSThread] {
        guard space != nil else { return threads }
        return threads.filter { within(Self.space(of: $0, spaces: spaces, browsers: browsers), space) }
    }

    public static func decisions(
        _ decisions: [OSDecision], in space: HarnessSpace?, spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []
    ) -> [OSDecision] {
        guard space != nil else { return decisions }
        return decisions.filter { within(Self.space(of: $0, spaces: spaces, browsers: browsers), space) }
    }

    // MARK: Consignes

    /// Les consignes qui valent dans l'espace : les siennes, celles de ses dépôts et celles de
    /// partout (elles s'imposent aussi à ses fils) ; sans espace, toutes.
    public static func rules(_ rules: [HarnessStandingRule], in space: HarnessSpace?) -> [HarnessStandingRule] {
        guard let space else { return rules }
        return rules.filter { rule in
            if let owner = rule.space { return owner == space.id }
            guard let repo = rule.repo else { return true }
            return space.repos.contains(repo)
        }
    }

    /// Les mêmes consignes par niveau : cet espace (sans espace : chaque consigne d'espace), ses dépôts, partout.
    public static func ruleLevels(_ rules: [HarnessStandingRule], in space: HarnessSpace?) -> OSRuleLevels {
        let kept = Self.rules(rules, in: space)
        return OSRuleLevels(
            space: kept.filter { $0.space != nil },
            repos: kept.filter { $0.space == nil && $0.repo != nil },
            everywhere: kept.filter(\.isGlobal)
        )
    }

    // MARK: Groupement

    /// Les éléments groupés par espace, dans l'ordre de `spaces`, puis ce qui n'est dans aucun
    /// espace ; chaque groupe garde l'ordre de ses éléments. Aucun groupe vide.
    public static func grouped<Item>(_ items: [Item], spaces: [HarnessSpace], by owner: (Item) -> HarnessSpace?) -> [OSSpaceGroup<Item>] {
        var byId: [String: [Item]] = [:]
        var outside: [Item] = []
        for item in items {
            if let space = owner(item) {
                byId[space.id, default: []].append(item)
            } else {
                outside.append(item)
            }
        }
        var groups = spaces.compactMap { space in byId[space.id].map { OSSpaceGroup(space: space, items: $0) } }
        if !outside.isEmpty { groups.append(OSSpaceGroup(space: nil, items: outside)) }
        return groups
    }

    /// Les fils groupés par espace.
    public static func threadGroups(_ threads: [OSThread], spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> [OSSpaceGroup<OSThread>] {
        grouped(threads, spaces: spaces) { Self.space(of: $0, spaces: spaces, browsers: browsers) }
    }

    /// Les décisions groupées par espace.
    public static func decisionGroups(
        _ decisions: [OSDecision], spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []
    ) -> [OSSpaceGroup<OSDecision>] {
        grouped(decisions, spaces: spaces) { Self.space(of: $0, spaces: spaces, browsers: browsers) }
    }

    /// Les lots de décisions, espace par espace : un lot (« tout valider ») ne mêle JAMAIS deux espaces.
    public static func lots(_ decisions: [OSDecision], spaces: [HarnessSpace], browsers: [WorkstationBrowser] = []) -> [OSSpaceGroup<OSDecisionLot>] {
        decisionGroups(decisions, spaces: spaces, browsers: browsers).map { group in
            OSSpaceGroup(space: group.space, items: OSDecisions.lots(group.items))
        }
    }

    // MARK: Bornage dans l'app (serveur sans `?space=`)

    /// Le brief borné aux dépôts de l'espace, pour un serveur qui ne le borne pas lui-même :
    /// ses listes filtrées, sa phrase retirée (elle parlait de tous les espaces), son coût
    /// réduit à celui des fils livrés de l'espace, ses propositions non comptées.
    public static func brief(_ brief: HarnessBrief, in space: HarnessSpace?) -> HarnessBrief {
        guard let space else { return brief }
        var scoped = brief
        scoped.headline = ""
        scoped.delivered = brief.delivered.filter { space.repos.contains($0.repo) }
        scoped.waiting = brief.waiting.filter { space.repos.contains($0.repo) }
        scoped.failed = brief.failed.filter { space.repos.contains($0.repo) }
        scoped.stopped = brief.stopped.filter { space.repos.contains($0.repo) }
        scoped.decided = brief.decided.filter { space.repos.contains($0.repo) }
        scoped.blocked = brief.blocked.filter { space.repos.contains($0.repo) }
        scoped.proposals = 0
        scoped.cost = scoped.delivered.reduce(0) { $0 + ($1.cost ?? 0) }
        return scoped
    }

    /// Les chiffres bornés aux dépôts de l'espace, pour un serveur qui ne les borne pas
    /// lui-même : ses dépôts, et ce qui s'en déduit (livrées, livrées seules, arrêtées). Ce qui
    /// ne se compte pas par dépôt (décisions et leur délai, lancements, motifs d'arrêt) est remis à zéro.
    public static func scoreboard(_ board: HarnessScoreboard, in space: HarnessSpace?) -> HarnessScoreboard {
        guard let space else { return board }
        let repos = board.repos.filter { space.repos.contains($0.repo) }
        let merged = repos.reduce(0) { $0 + $1.merged }
        let alone = repos.reduce(0) { $0 + $1.mergedAlone }
        return HarnessScoreboard(
            since: board.since, until: board.until, merged: merged, mergedAlone: alone,
            aloneRate: merged > 0 ? Double(alone) / Double(merged) : nil,
            cancelled: repos.reduce(0) { $0 + $1.cancelled }, repos: repos
        )
    }
}
