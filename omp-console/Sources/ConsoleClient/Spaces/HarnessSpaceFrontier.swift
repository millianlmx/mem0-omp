// L'espace comme FRONTIÈRE d'un client (omp-harness spaces.ts, isolation.ts, space-usage.ts ;
// capacités `space-policy`, `space-scope`, `space-knowledge`) : sa politique de modèles, son
// étanchéité (ce qui le laisse encore lire, écrire ou parler hors de lui), l'état de sa
// connexion Atlassian, l'accueil d'un client (ce qu'il reste à faire) et sa consommation
// (ce qu'on facture).
//
// Chaque forme décode un serveur antérieur : un champ absent prend la valeur qui dit « rien »
// ou « inconnu ». Aucun texte ici : les phrases du serveur (`text`) sont portées telles
// quelles, les écrans écrivent les leurs à partir des codes.

import Foundation

// MARK: - Politique de modèles

/// La politique de modèles d'un espace, croisée par le serveur au plus strict avec celle de
/// chaque dépôt. Un champ absent ne restreint rien.
public struct HarnessSpacePolicy: Codable, Equatable, Sendable {
    /// La confidentialité qui n'admet que des modèles locaux.
    public static let localOnly = "local-only"

    /// `standard` ou `local-only` ; `nil` : celle de chaque dépôt.
    public var privacy: String?
    /// Les fournisseurs permis ; `nil` : ceux de chaque dépôt. Une liste vide refuse tout.
    public var providers: [String]?
    /// Les chaînes de modèles par niveau (`fast`, `standard`, `heavy`), chacune en `fournisseur/modèle`.
    public var models: [String: [String]]?

    public init(privacy: String? = nil, providers: [String]? = nil, models: [String: [String]]? = nil) {
        self.privacy = privacy
        self.providers = providers
        self.models = models
    }

    /// Seuls des modèles locaux servent cet espace.
    public var isLocalOnly: Bool { privacy == Self.localOnly }

    /// La politique ne restreint rien.
    public var isEmpty: Bool { privacy == nil && providers == nil && (models ?? [:]).isEmpty }
}

// MARK: - Étanchéité

/// Ce qui laisse un espace lire, écrire ou parler hors de sa frontière (`ISOLATION_CODES` du serveur).
public enum HarnessIsolationCode: String, CaseIterable, Sendable {
    /// Sa portée mémoire est aussi celle d'un dépôt d'un autre espace, ou hors espace.
    case sharedScope = "shared_scope"
    /// Sa portée mémoire est celle du service.
    case reservedScope = "reserved_scope"
    /// Sans jeton mémoire propre : ses agents lisent toutes les portées.
    case globalMemoryToken = "global_memory_token"
    /// Sans compte de forge ou identité git propres : il parle sous le compte du service.
    case serviceForgeIdentity = "service_forge_identity"
    /// Il pousse avec la clé du service.
    case serviceSSHKey = "service_ssh_key"
    /// Des projets Jira ou un dépôt branché, sans connexion Atlassian de l'espace.
    case noAtlassian = "no_atlassian"
    /// Le poste est attendu, mais aucun navigateur n'est rattaché.
    case noBrowser = "no_browser"
    /// La vigie ne publie que hors de l'espace.
    case publicRepoTarget = "public_repo_target"
}

/// Une lacune d'étanchéité : son code, le dépôt concerné (`nil` : l'espace entier) et la phrase du serveur.
public struct HarnessIsolationGap: Codable, Equatable, Sendable, Identifiable {
    public var code: String
    public var repo: String?
    public var text: String

    public init(code: String, repo: String? = nil, text: String = "") {
        self.code = code
        self.repo = repo
        self.text = text
    }

    public var id: String { code + "/" + (repo ?? "") }

    /// Le code connu, ou `nil` pour une lacune apparue après cette version de l'app.
    public var kind: HarnessIsolationCode? { HarnessIsolationCode(rawValue: code) }
}

/// L'étanchéité d'un espace, recalculée par le serveur à chaque lecture.
public struct HarnessIsolation: Codable, Equatable, Sendable {
    /// Aucune lacune.
    public var sealed: Bool
    public var gaps: [HarnessIsolationGap]

    public init(sealed: Bool = true, gaps: [HarnessIsolationGap] = []) {
        self.sealed = sealed
        self.gaps = gaps
    }
}

/// La connexion Atlassian d'un espace, telle que la liste des espaces la résume.
public struct HarnessSpaceAtlassian: Codable, Equatable, Sendable {
    public var connected: Bool
    /// L'adresse du site branché ; `nil` tant qu'il n'y en a pas.
    public var site: String?

    public init(connected: Bool = false, site: String? = nil) {
        self.connected = connected
        self.site = site
    }
}

// MARK: - Accueil d'un client

/// Ce que l'app sait faire d'une étape restante après l'accueil d'un client.
public enum HarnessOnboardGesture: String, CaseIterable, Sendable {
    /// Ajouter des dépôts à l'espace.
    case addRepos
    /// Connecter Jira et Confluence à l'espace.
    case connectAtlassian
    /// Rattacher un navigateur du poste à l'espace.
    case attachBrowser
}

/// Une étape qu'il reste à faire après l'accueil d'un client : une lacune à combler, ou un
/// branchement facultatif.
public struct HarnessOnboardStep: Codable, Equatable, Sendable, Identifiable {
    /// Un code de lacune (`HarnessIsolationCode`), `no_repos`, `connect_atlassian` ou `attach_browser`.
    public var code: String
    public var text: String

    public init(code: String, text: String = "") {
        self.code = code
        self.text = text
    }

    public var id: String { code }

    /// La lacune que l'étape comble, s'il y en a une.
    public var gap: HarnessIsolationCode? { HarnessIsolationCode(rawValue: code) }

    /// Le geste que l'app offre pour cette étape ; `nil` : elle se règle dans la configuration du serveur.
    public var gesture: HarnessOnboardGesture? {
        switch code {
        case "no_repos": .addRepos
        case "connect_atlassian", HarnessIsolationCode.noAtlassian.rawValue: .connectAtlassian
        case "attach_browser", HarnessIsolationCode.noBrowser.rawValue: .attachBrowser
        default: nil
        }
    }
}

/// Ce que rend l'accueil d'un client : l'espace créé, son étanchéité et ce qu'il reste à faire.
public struct HarnessSpaceOnboarding: Equatable, Sendable {
    public var space: HarnessSpace
    /// `nil` d'un serveur qui ne calcule pas l'étanchéité.
    public var isolation: HarnessIsolation?
    public var next: [HarnessOnboardStep]

    public init(space: HarnessSpace, isolation: HarnessIsolation? = nil, next: [HarnessOnboardStep] = []) {
        self.space = space
        self.isolation = isolation
        self.next = next
    }
}

/// `POST /v1/spaces/onboard`.
struct HarnessSpaceOnboardReply: Decodable {
    var space: HarnessSpace
    var isolation: HarnessIsolation?
    var next: [HarnessOnboardStep]?
}

// MARK: - Consommation

/// La nature d'une consommation (`USAGE_KINDS` du serveur).
public enum HarnessUsageKind: String, CaseIterable, Sendable {
    case feature, audit, poste, demande, reve, autre
}

/// La consommation d'un jour UTC (`AAAA-MM-JJ`).
public struct HarnessSpaceUsageDay: Codable, Equatable, Sendable, Identifiable {
    public var day: String
    public var cost: Double
    public var input: Int
    public var output: Int

    public init(day: String, cost: Double = 0, input: Int = 0, output: Int = 0) {
        self.day = day
        self.cost = cost
        self.input = input
        self.output = output
    }

    public var id: String { day }
}

/// La consommation d'un dépôt.
public struct HarnessSpaceUsageRepo: Codable, Equatable, Sendable, Identifiable {
    public var repo: String
    public var cost: Double

    public init(repo: String, cost: Double = 0) {
        self.repo = repo
        self.cost = cost
    }

    public var id: String { repo }
}

/// La consommation d'un modèle.
public struct HarnessSpaceUsageModel: Codable, Equatable, Sendable, Identifiable {
    public var model: String
    public var cost: Double
    public var input: Int
    public var output: Int

    public init(model: String, cost: Double = 0, input: Int = 0, output: Int = 0) {
        self.model = model
        self.cost = cost
        self.input = input
        self.output = output
    }

    public var id: String { model }
}

/// La consommation d'une nature de travail.
public struct HarnessSpaceUsageKind: Codable, Equatable, Sendable, Identifiable {
    /// `feature`, `audit`, `poste`, `demande`, `reve` ou `autre`.
    public var kind: String
    public var cost: Double

    public init(kind: String, cost: Double = 0) {
        self.kind = kind
        self.cost = cost
    }

    public var id: String { kind }

    /// La nature connue, ou `nil` pour une nature apparue après cette version de l'app.
    public var nature: HarnessUsageKind? { HarnessUsageKind(rawValue: kind) }
}

/// La consommation d'un espace sur une fenêtre (`GET /v1/spaces/{id}/usage`) : ce que ses
/// dépôts et ce qui lui est imputé sans dépôt (Demandes, poste) ont coûté.
public struct HarnessSpaceUsage: Codable, Equatable, Sendable {
    public var since: Double
    /// La borne haute, exclue.
    public var until: Double
    /// En dollars.
    public var total: Double
    /// Par jour, du plus ancien au plus récent ; seuls les jours qui ont consommé.
    public var days: [HarnessSpaceUsageDay]
    /// Par dépôt, du plus cher au moins cher ; ce qui n'a pas de dépôt se lit dans `kinds`.
    public var repos: [HarnessSpaceUsageRepo]
    public var models: [HarnessSpaceUsageModel]
    public var kinds: [HarnessSpaceUsageKind]

    public init(
        since: Double = 0, until: Double = 0, total: Double = 0, days: [HarnessSpaceUsageDay] = [], repos: [HarnessSpaceUsageRepo] = [],
        models: [HarnessSpaceUsageModel] = [], kinds: [HarnessSpaceUsageKind] = []
    ) {
        self.since = since
        self.until = until
        self.total = total
        self.days = days
        self.repos = repos
        self.models = models
        self.kinds = kinds
    }

    /// Ce qui a été consommé sans dépôt (Demandes, poste) : le total moins la part des dépôts.
    public var unattributed: Double { max(0, total - repos.reduce(0) { $0 + $1.cost }) }
}

/// `GET /v1/spaces/{id}/usage`.
struct HarnessSpaceUsageReply: Decodable {
    var usage: HarnessSpaceUsage
}
