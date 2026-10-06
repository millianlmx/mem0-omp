// La couche PURE du suivi de PR (S-1, S-2) : les types affichés et les fonctions
// qui les construisent, sans E/S — donc testables sans `gh` ni vue.
//
// Les trois statuts REQUIS sont ceux de `PUBLISHING.md` § Blocage du merge : les
// noms affichés des jobs, jamais des identifiants internes.

import ConsoleCore
import Foundation

/// Les trois statuts requis d'une PR, dans l'ORDRE d'affichage de S-1.
enum RequiredCheck: String, CaseIterable, Sendable, Codable {
    case ubuntu = "check (ubuntu-latest)"
    case macos = "check (macos-latest)"
    case releaseSimulation = "release-simulation"

    /// L'identifiant d'accessibilité et de test (jamais le nom affiché, qui porte
    /// espaces et parenthèses).
    var id: String {
        switch self {
        case .ubuntu: "ubuntu"
        case .macos: "macos"
        case .releaseSimulation: "release-simulation"
        }
    }

    /// Le nom GitHub exact du contexte.
    var name: String { rawValue }
}

/// L'état affiché d'un statut.
enum PRCheckState: String, Sendable, Codable {
    case green
    case red
    case pending
    case ignored

    var label: String {
        switch self {
        case .green: "vert"
        case .red: "rouge"
        case .pending: "en cours"
        case .ignored: "ignoré"
        }
    }

    /// Le rang de SÉVÉRITÉ : sur un doublon, la lecture retenue est la PIRE
    /// (`red` > `pending` > `ignored` > `green`), jamais une promotion au vert.
    var severity: Int {
        switch self {
        case .red: 3
        case .pending: 2
        case .ignored: 1
        case .green: 0
        }
    }
}

/// La traduction EXACTE de la table `bucket → state` de gh (docs §3).
func prCheckState(forBucket bucket: String?) -> PRCheckState {
    switch bucket {
    case "pass": .green
    case "fail", "cancel": .red
    case "pending": .pending
    case "skipping": .ignored
    default: .pending
    }
}

/// Un statut lu : son nom GitHub, son état, et le lien du job quand il y en a un.
struct PRCheckReading: Equatable, Sendable {
    var name: String
    var state: PRCheckState
    var link: String?
}

/// Le résultat d'une lecture réussie : la PR et ses trois statuts requis, dans
/// l'ordre de S-1 (`checks` porte toujours exactement trois entrées normalisées).
struct PRSnapshot: Equatable, Sendable {
    var title: String
    var headOid: String
    var body: String
    var checks: [PRCheckReading]
}

/// L'âge d'une connaissance : jamais lue, fraîche (dernière lecture réussie), ou
/// périmée (dernière lecture en échec).
enum PRFreshness: String, Equatable, Sendable, Codable {
    case unknown
    case fresh
    case stale
}

/// Ce que le modèle sait d'une PR entre deux rafraîchissements : la dernière lecture
/// réussie (ou rien), sa fraîcheur, et l'URL qui a produit cette connaissance (une
/// `prUrl` changée fait oublier la ligne, S-1).
struct PRKnowledge: Equatable, Sendable {
    var snapshot: PRSnapshot?
    var freshness: PRFreshness
    var url: String?

    static let unknown = PRKnowledge(snapshot: nil, freshness: .unknown, url: nil)
}

/// Une PR suivie : la feature du projet qui la porte.
struct FollowedPR: Equatable, Sendable {
    let slug: String
    let url: String
    let number: Int?
}

/// Une ligne de statut prête à afficher.
struct PRCheckRow: Equatable, Sendable, Codable {
    let required: RequiredCheck
    let state: PRCheckState
    let link: String?
}

/// Une ligne de PR prête à afficher (S-1).
struct ProjectPRRow: Equatable, Sendable, Codable {
    let slug: String
    let number: Int?
    let title: String?
    let url: String
    let checks: [PRCheckRow]
    let freshness: PRFreshness

    /// Vrai si, et seulement si, les trois statuts requis sont verts : la relecture
    /// fraîche de S-5 est le vrai verrou du geste.
    var isMergeAvailable: Bool {
        checks.count == RequiredCheck.allCases.count && checks.allSatisfy { $0.state == .green }
    }

    /// « PR #<n> — <titre> », « PR #<n> », ou l'URL quand aucun numéro n'est connu.
    var headline: String {
        if let number, let title, !title.isEmpty { return "PR #\(number) — \(title)" }
        if let number { return "PR #\(number)" }
        return url
    }
}

/// La fusion proposée après une relecture fraîche (S-5) : tout vient de la relecture.
struct PRMergeProposal: Equatable, Sendable {
    let slug: String
    let number: Int?
    let title: String
    let url: String
    let headOid: String
}

/// L'adresse d'une PR ACCEPTÉE, ou `nil` : validation TEXTUELLE de la chaîne BRUTE,
/// jamais un aller-retour par `URL` (docs §7 — `URL(string:)` normalise `%20`,
/// l'espace final, les composants vides et la barre finale, et `HTTPS://GitHub.COM`
/// conserve la casse de `.host` : autant de formes qu'un contrôle textuel doit
/// refuser). Seul le schéma est insensible à la casse ; l'hôte est comparé à
/// `github.com` en ignorant la casse, entièrement (ni sous-domaine, ni port, ni
/// identifiants). Le rendu est la chaîne REÇUE, inchangée.
func validatedPRURL(_ raw: String) -> String? {
    guard raw.count > 8, raw.prefix(8).lowercased() == "https://" else { return nil }
    let rest = String(raw.dropFirst(8))
    let parts = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 5 else { return nil }
    guard parts[0].lowercased() == "github.com" else { return nil }
    guard parts[3] == "pull" else { return nil }
    let owner = parts[1]
    let repository = parts[2]
    let number = parts[4]
    guard !owner.isEmpty, owner.allSatisfy(isPRURLSegmentCharacter) else { return nil }
    guard !repository.isEmpty, repository.allSatisfy(isPRURLSegmentCharacter) else { return nil }
    guard !number.isEmpty, number.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
    guard number.first != "0" else { return nil }
    return raw
}

/// `[A-Za-z0-9._-]`, en ASCII seulement : un propriétaire ou un dépôt GitHub ne
/// porte rien d'autre.
private func isPRURLSegmentCharacter(_ character: Character) -> Bool {
    guard character.isASCII else { return false }
    return character.isLetter
        || character.isNumber
        || character == "."
        || character == "_"
        || character == "-"
}

/// Le dernier composant du chemin d'une URL http(s) quand c'est un nombre : c'est le
/// numéro de PR, sans appel réseau.
func pullRequestNumber(in url: String) -> Int? {
    guard
        let parsed = URL(string: url),
        let scheme = parsed.scheme?.lowercased(),
        scheme == "http" || scheme == "https"
    else { return nil }
    let last = parsed.pathComponents.last(where: { $0 != "/" && !$0.isEmpty })
    guard let last, !last.isEmpty, last.allSatisfy({ $0.isNumber }) else { return nil }
    return Int(last)
}

/// L'identifiant d'un run à partir du lien d'un statut : le dernier composant non
/// vide du chemin d'une URL http(s) (`…/job/109789011950` → `109789011950`).
func runIdentifier(of link: String?) -> String? {
    guard
        let link,
        let parsed = URL(string: link),
        let scheme = parsed.scheme?.lowercased(),
        scheme == "http" || scheme == "https"
    else { return nil }
    return parsed.pathComponents.last(where: { !$0.isEmpty && $0 != "/" })
}

/// Les PR suivies d'un projet, dans l'ORDRE DU PLAN (segments puis features), sans
/// exception. Une feature est suivie si, et seulement si, son statut est `pr` et que
/// son `prUrl` est une chaîne non vide (S-1).
func followedPRs(of project: Project?) -> [FollowedPR] {
    guard let project else { return [] }
    var followed: [FollowedPR] = []
    for segment in project.segments {
        for feature in segment.features where feature.status == .pr {
            guard let url = feature.prUrl, !url.isEmpty else { continue }
            followed.append(FollowedPR(slug: feature.slug, url: url, number: pullRequestNumber(in: url)))
        }
    }
    return followed
}

/// Les lignes affichées, dans l'ordre du plan. `checks` porte TOUJOURS les trois
/// statuts requis, dans l'ordre de S-1 : un nom absent de la connaissance est
/// `pending`, sans lien.
func projectPRRows(followed: [FollowedPR], knowledge: [String: PRKnowledge]) -> [ProjectPRRow] {
    followed.map { pr in
        let known = knowledge[pr.slug] ?? .unknown
        let checks = RequiredCheck.allCases.map { required -> PRCheckRow in
            let reading = known.snapshot?.checks.first { $0.name == required.name }
            return PRCheckRow(
                required: required,
                state: reading?.state ?? .pending,
                link: reading?.link
            )
        }
        return ProjectPRRow(
            slug: pr.slug,
            number: pr.number,
            title: known.snapshot?.title,
            url: pr.url,
            checks: checks,
            freshness: known.freshness
        )
    }
}

/// La sortie de `gh pr view --json title,headRefOid,body`, décodée.
func parsePRView(_ stdout: String) throws -> (title: String, headOid: String, body: String) {
    let object = try parseJSONObject(stdout)
    guard let title = object["title"] as? String, let headOid = object["headRefOid"] as? String else {
        throw PRParseError(detail: "les champs title et headRefOid sont absents")
    }
    let body = object["body"] as? String ?? ""
    return (title, headOid, body)
}

/// La sortie de `gh pr checks --json name,bucket,link`, décodée et classée : la table
/// `bucket → state` de S-1, un doublon réduit au PIRE.
func parseChecks(_ stdout: String) throws -> [PRCheckReading] {
    let data = Data(stdout.utf8)
    guard let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        throw PRParseError(detail: "la sortie n'est pas un tableau d'objets JSON")
    }
    var worst: [String: PRCheckReading] = [:]
    for item in raw {
        guard let name = item["name"] as? String else {
            throw PRParseError(detail: "un statut est sans nom")
        }
        let state = prCheckState(forBucket: item["bucket"] as? String)
        let link = item["link"] as? String
        let reading = PRCheckReading(name: name, state: state, link: link)
        if let kept = worst[name], kept.state.severity > state.severity { continue }
        worst[name] = reading
    }
    // L'ordre de gh (`eliminateDuplicates` trie par StartedAt décroissant) ne nous
    // appartient pas : l'ordre d'affichage est celui des trois statuts requis, donc
    // la normalisation suffit et rien n'est reclassé ici.
    return worst.values.sorted { $0.name < $1.name }
}

/// Ramène une lecture à EXACTEMENT les trois statuts requis, dans l'ordre de S-1 :
/// un nom absent devient `pending` sans lien.
func normalizedRequiredChecks(_ readings: [PRCheckReading]) -> [PRCheckReading] {
    RequiredCheck.allCases.map { required in
        readings.first { $0.name == required.name }
            ?? PRCheckReading(name: required.name, state: .pending, link: nil)
    }
}

/// Une sortie de `gh` que l'app n'a pas su décoder (S-2).
struct PRParseError: Error, Equatable, Sendable {
    let detail: String
}

private func parseJSONObject(_ stdout: String) throws -> [String: Any] {
    let data = Data(stdout.utf8)
    guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw PRParseError(detail: "la sortie n'est pas un objet JSON")
    }
    return object
}
