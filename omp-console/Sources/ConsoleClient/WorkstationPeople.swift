// Le GRAPHE DES PERSONNES du poste côté client, partagé par la coque Mac et l'app iOS : les
// collègues que le serveur tient (alimentés par les canaux lus et les observations du poste)
// et leur correction champ par champ (routes `/v1/workstation/people*` d'omp-harness,
// capacité `workstation-people`).
//
// Comme tout le poste, la lecture est au PROPRIÉTAIRE : un jeton restreint reçoit 403, le
// modèle passe en `.reserved` et rien n'est montré, sans échec. Un serveur qui ne sert pas
// la route (antérieur, ou poste désactivé) rend 404 : `.absent`, la page disparaît.
//
// Corriger est un geste de l'appareil approbateur : `PATCH /v1/workstation/people/{id}` ne
// porte QUE les champs changés (un champ absent reste), une valeur donnée fige le champ contre
// l'alimentation automatique, `null` le relâche ; `If-Match` porte la révision lue. Une
// personne changée depuis (412) fait relire la liste et revient en `.stale`.
//
// Il est porté par `HarnessModel` (`server.people`) et relit la liste à chaque événement
// `workstation_person` du flux de la boîte. Aucun texte ici : un échec est un
// `HarnessFailure`, que les écrans traduisent.

import Foundation

// MARK: - Contrat JSON

/// Une personne du graphe, telle que `GET /v1/workstation/people` la rend.
public struct WorkstationPerson: Codable, Equatable, Sendable, Identifiable {
    /// Un champ corrigeable, sous son nom du contrat.
    public enum Field: String, CaseIterable, Codable, Sendable {
        case name
        case emails
        case slackIds
        case role
        case team
        case projects
        case tone
        case delegation
        case topics

        /// Un champ qui porte une liste de valeurs (les autres portent un texte).
        public var isList: Bool {
            switch self {
            case .emails, .slackIds, .projects, .topics: true
            case .name, .role, .team, .tone, .delegation: false
            }
        }
    }

    /// Les niveaux de délégation, dans l'ordre du serveur.
    public static let delegations = ["jamais", "brouillon", "réponse"]

    public var id: String
    public var name: String?
    public var emails: [String]
    public var slackIds: [String]
    public var role: String?
    public var team: String?
    public var projects: [String]
    public var tone: String?
    public var delegation: String
    public var topics: [String]
    /// Pour chaque champ (`Field.rawValue`), s'il est corrigé par l'humain.
    public var corrected: [String: Bool]
    public var rev: Int
    public var createdAt: Double
    public var updatedAt: Double

    public func isCorrected(_ field: Field) -> Bool { corrected[field.rawValue] ?? false }

    /// La valeur d'un champ en texte : une liste jointe par des virgules, un champ vide en "".
    public func text(_ field: Field) -> String {
        switch field {
        case .name: name ?? ""
        case .emails: emails.joined(separator: ", ")
        case .slackIds: slackIds.joined(separator: ", ")
        case .role: role ?? ""
        case .team: team ?? ""
        case .projects: projects.joined(separator: ", ")
        case .tone: tone ?? ""
        case .delegation: delegation
        case .topics: topics.joined(separator: ", ")
        }
    }
}

/// `GET /v1/workstation/people`.
public struct WorkstationPeopleReply: Codable, Equatable, Sendable {
    public var people: [WorkstationPerson]
}

/// `PATCH /v1/workstation/people/{id}`.
public struct WorkstationPersonReply: Codable, Equatable, Sendable {
    public var person: WorkstationPerson
}

/// Ce qu'une correction fait d'un champ : l'écrire (et le figer), ou le relâcher.
public enum WorkstationPersonChange: Equatable, Sendable {
    case set(String)
    case release
}

// MARK: - Modèle

@MainActor
public final class WorkstationPeopleModel: ObservableObject {
    /// Ce que le serveur relié dit du graphe.
    public enum Availability: Equatable, Sendable {
        case unknown
        case available
        /// Le serveur ne sert pas la route (antérieur au graphe, ou poste désactivé).
        case absent
        /// Le jeton n'est pas celui du propriétaire : rien n'est montré.
        case reserved
    }

    @Published public private(set) var availability: Availability = .unknown
    @Published public private(set) var people: [WorkstationPerson] = []
    /// Le dernier échec de lecture, effacé par la prochaine lecture réussie.
    @Published public private(set) var failure: HarnessFailure?
    /// Les personnes dont une correction attend la réponse du serveur.
    @Published public private(set) var busy: Set<String> = []

    weak var harness: HarnessModel?
    private let reloadDelay: Duration
    private var reloadTask: Task<Void, Never>?
    private var reloadAgain = false

    init(harness: HarnessModel, reloadDelay: Duration) {
        self.harness = harness
        self.reloadDelay = reloadDelay
    }

    /// Ce jeton est celui de l'appareil approbateur, seul à corriger.
    public var isApprover: Bool { harness?.client?.approver ?? false }

    public func person(_ id: String) -> WorkstationPerson? {
        people.first { $0.id == id }
    }

    // MARK: - Lecture

    /// Relit le graphe. Un serveur sans la route (404) ou un jeton qui n'est pas celui du
    /// propriétaire (403) ne montre rien, sans échec.
    public func refresh() async {
        guard let harness, harness.isConfigured else { return }
        let call = HarnessCall(method: "GET", path: "/v1/workstation/people")
        do {
            let reply = try await harness.exchange(call)
            if reply.status == 404 {
                clear(.absent)
                return
            }
            let read: WorkstationPeopleReply = try harness.decode(reply, for: call)
            people = read.people
            availability = .available
            failure = nil
        } catch HarnessFailure.forbidden {
            clear(.reserved)
        } catch {
            failure = HarnessModel.failure(of: error)
        }
    }

    /// `workstation_person` fait relire (regroupé : une rafale ne coûte qu'une relecture).
    func receive(_ names: [String]) {
        guard names.contains("workstation_person") else { return }
        switch availability {
        case .absent, .reserved: return
        case .unknown, .available: break
        }
        guard reloadTask == nil else {
            reloadAgain = true
            return
        }
        scheduleReload()
    }

    private func scheduleReload() {
        let delay = reloadDelay
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled, let self else { return }
            reloadAgain = false
            await refresh()
            guard !Task.isCancelled else { return }
            reloadTask = nil
            if reloadAgain {
                reloadAgain = false
                scheduleReload()
            }
        }
    }

    /// Oublie tout ce qui a été lu : le serveur a changé (ou a été oublié).
    func reset() {
        reloadTask?.cancel()
        reloadTask = nil
        reloadAgain = false
        clear(.unknown)
        busy = []
    }

    private func clear(_ next: Availability) {
        availability = next
        people = []
        failure = nil
    }

    // MARK: - Correction (appareil approbateur)

    /// Corrige les champs donnés de la personne LUE (`person.rev` part en If-Match) ; les
    /// autres restent. Une liste se saisit séparée par des virgules. Rend la personne écrite.
    @discardableResult
    public func correct(_ person: WorkstationPerson, _ changes: [WorkstationPerson.Field: WorkstationPersonChange]) async throws -> WorkstationPerson {
        guard let harness, harness.isConfigured else { throw HarnessFailure.unreachable }
        let body = PatchBody(changes: changes)
        guard let encoded = try? JSONEncoder().encode(body) else { throw HarnessFailure.unreadable }
        let call = HarnessCall(
            method: "PATCH",
            path: "/v1/workstation/people/\(HarnessModel.pathComponent(person.id))",
            body: encoded,
            headers: ["If-Match": "\"\(person.rev)\""]
        )
        busy.insert(person.id)
        defer { busy.remove(person.id) }
        do {
            let reply: WorkstationPersonReply = try harness.decode(try await harness.exchange(call), for: call)
            if let index = people.firstIndex(where: { $0.id == reply.person.id }) { people[index] = reply.person }
            return reply.person
        } catch {
            // Une personne changée depuis la lecture (412) : la liste est relue.
            if case HarnessFailure.stale = error { await refresh() }
            if let failure = HarnessModel.failure(of: error) { throw failure }
            throw error
        }
    }
}

/// Le corps d'un PATCH : un champ changé porte sa valeur (texte, ou liste pour un champ à
/// plusieurs valeurs), un champ relâché porte `null`, un champ absent n'y figure pas.
struct PatchBody: Encodable {
    let changes: [WorkstationPerson.Field: WorkstationPersonChange]

    private struct Key: CodingKey {
        var stringValue: String
        var intValue: Int? { nil }
        init(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Key.self)
        for (field, change) in changes {
            let key = Key(stringValue: field.rawValue)
            switch change {
            case .release:
                try container.encodeNil(forKey: key)
            case .set(let text):
                if field.isList {
                    let items = text.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
                    try container.encode(items, forKey: key)
                } else {
                    try container.encode(text.trimmingCharacters(in: .whitespacesAndNewlines), forKey: key)
                }
            }
        }
    }
}
