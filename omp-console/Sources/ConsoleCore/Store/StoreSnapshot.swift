// Enveloppes d'un instantané du magasin d'état (S-2 … S-6) : disponibilité,
// entrées rendues, entrées écartées NOMMÉES.
//
// Une enveloppe par store plutôt qu'un type générique : les noms de champs sont
// ceux du dépôt (`lots`, `projects`), et un instantané complet se lit d'un coup
// d'œil dans `StoreSnapshot`.

import Foundation

/// « magasin absent » (le répertoire n'existe pas, ou n'est pas un répertoire)
/// contre « magasin vide » (il existe, aucune entrée) : deux états distincts, un
/// lecteur ne doit jamais les confondre (B-6, S-8).
public enum StoreAvailability: String, Sendable, Equatable, Codable {
    case absent
    case present
}

/// POURQUOI une entrée a été écartée (BR-1) : la raison exacte que le bandeau du
/// tableau nomme (S-8). Un contenu qui n'est pas du JSON n'est pas la même chose
/// qu'un JSON valide au schéma incomplet — les deux se disent séparément.
public enum DiscardReason: String, Sendable, Equatable, Codable {
    /// `JSONValue.parse` a échoué : le contenu n'est pas du JSON.
    case unparsable
    /// Le JSON est valide mais le validateur du store a rendu `nil` (schéma
    /// incomplet, version étrangère, champ hors vocabulaire).
    case schema
}

/// Une entrée écartée, NOMMÉE : le fichier (`<store>/<nom>`) et la raison. Le
/// chemin porte le store parce qu'un bandeau qui n'aurait que le nom de fichier
/// ne dirait pas OÙ regarder — et deux stores peuvent porter le même nom.
public struct DiscardedEntry: Sendable, Equatable, Codable {
    /// `<store>/<fichier>` : `running/a1b2….json`, `lots/d0ef9a50f7dc3a37.json`…
    public var file: String
    public var reason: DiscardReason

    public init(file: String, reason: DiscardReason) {
        self.file = file
        self.reason = reason
    }
}

/// `running/` : les pipelines en cours, triées par `phaseStartedAt` croissant puis
/// `cwd` croissant, bornées à `PipelineStore.runningReadLimit`.
public struct RunningEnvelope: Sendable, Equatable, Codable {
    public var availability: StoreAvailability
    public var entries: [RunningEntry]
    public var discardedEntries: [DiscardedEntry]

    /// Le compte, calculé : une seule vérité, celle des entrées nommées.
    public var discarded: Int { discardedEntries.count }

    public init(availability: StoreAvailability, entries: [RunningEntry], discardedEntries: [DiscardedEntry]) {
        self.availability = availability
        self.entries = entries
        self.discardedEntries = discardedEntries
    }
}

/// `history/` : les pipelines closes, triées par `endedAt` décroissant puis `cwd`
/// croissant, bornées à `PipelineStore.historyReadLimit`.
public struct HistoryEnvelope: Sendable, Equatable, Codable {
    public var availability: StoreAvailability
    public var entries: [HistoryEntry]
    public var discardedEntries: [DiscardedEntry]

    public var discarded: Int { discardedEntries.count }

    public init(availability: StoreAvailability, entries: [HistoryEntry], discardedEntries: [DiscardedEntry]) {
        self.availability = availability
        self.entries = entries
        self.discardedEntries = discardedEntries
    }
}

/// `lots/` : un lot par dépôt, fichiers triés par nom.
public struct LotEnvelope: Sendable, Equatable, Codable {
    public var availability: StoreAvailability
    public var lots: [Lot]
    public var discardedEntries: [DiscardedEntry]

    public var discarded: Int { discardedEntries.count }

    public init(availability: StoreAvailability, lots: [Lot], discardedEntries: [DiscardedEntry]) {
        self.availability = availability
        self.lots = lots
        self.discardedEntries = discardedEntries
    }
}

/// `projects/` : un projet par dépôt, fichiers triés par nom.
public struct ProjectEnvelope: Sendable, Equatable, Codable {
    public var availability: StoreAvailability
    public var projects: [Project]
    public var discardedEntries: [DiscardedEntry]

    public var discarded: Int { discardedEntries.count }

    public init(availability: StoreAvailability, projects: [Project], discardedEntries: [DiscardedEntry]) {
        self.availability = availability
        self.projects = projects
        self.discardedEntries = discardedEntries
    }
}

/// `inbox/` : les boîtes des runs, triées par nom. `discardedEntries` est toujours
/// vide — une livraison illisible est RENDUE avec `payload == nil`, jamais écartée
/// (S-5) ; le champ existe pour l'uniformité de l'enveloppe.
public struct InboxEnvelope: Sendable, Equatable, Codable {
    public var availability: StoreAvailability
    public var boxes: [InboxBox]
    public var discardedEntries: [DiscardedEntry]

    public var discarded: Int { discardedEntries.count }

    public init(availability: StoreAvailability, boxes: [InboxBox], discardedEntries: [DiscardedEntry]) {
        self.availability = availability
        self.boxes = boxes
        self.discardedEntries = discardedEntries
    }
}

/// `audit/` : les relais battants, fichiers triés par nom.
public struct AuditEnvelope: Sendable, Equatable, Codable {
    public var availability: StoreAvailability
    public var relays: [AuditRelay]
    public var discardedEntries: [DiscardedEntry]

    public var discarded: Int { discardedEntries.count }

    public init(availability: StoreAvailability, relays: [AuditRelay], discardedEntries: [DiscardedEntry]) {
        self.availability = availability
        self.relays = relays
        self.discardedEntries = discardedEntries
    }
}

/// `audits/` et `journal/` (audit-panel-in-omp-console S-5) : les audits lancés
/// depuis la section Audit, fichiers triés par nom, et les décisions de l'arbitre
/// prises dans leur contexte (`context` = la clé d'un audit, `source` contexte ou
/// arbitrage), dans l'ordre d'écriture du journal de chaque dépôt.
///
/// `availability` est celle de `audits/` : sans audit, il n'y a aucune décision
/// d'audit à lire. Une ligne de journal illisible est ignorée sans être comptée
/// (parité `journalFor`, context.ts:300-318) ; seul un audit illisible est écarté.
///
/// `feed` : le fil des décisions de TOUS les journaux (`ArbiterDecisionFeed`),
/// le plus récent d'abord, borné — audits ou non.
public struct AuditsEnvelope: Sendable, Equatable, Codable {
    public var availability: StoreAvailability
    public var records: [AuditRecord]
    public var decisions: [AuditDecision]
    public var discardedEntries: [DiscardedEntry]
    public var feed: [ArbiterDecision]

    public var discarded: Int { discardedEntries.count }

    public init(availability: StoreAvailability, records: [AuditRecord], decisions: [AuditDecision], discardedEntries: [DiscardedEntry], feed: [ArbiterDecision] = []) {
        self.availability = availability
        self.records = records
        self.decisions = decisions
        self.discardedEntries = discardedEntries
        self.feed = feed
    }

    private enum CodingKeys: String, CodingKey {
        case availability, records, decisions, discardedEntries, feed
    }

    /// `feed` est FACULTATIF au décodage : la trame `store` d'un Mac antérieur au
    /// fil se lit avec un fil vide.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        availability = try container.decode(StoreAvailability.self, forKey: .availability)
        records = try container.decode([AuditRecord].self, forKey: .records)
        decisions = try container.decode([AuditDecision].self, forKey: .decisions)
        discardedEntries = try container.decode([DiscardedEntry].self, forKey: .discardedEntries)
        feed = try container.decodeIfPresent([ArbiterDecision].self, forKey: .feed) ?? []
    }

    /// L'enveloppe d'un magasin sans `audits/` — aussi celle d'un instantané
    /// transporté par un Mac antérieur à la section Audit.
    public static let absent = AuditsEnvelope(availability: .absent, records: [], decisions: [], discardedEntries: [])
}

/// L'instantané complet du magasin, celui que pousse le flux global (S-9). C'est
/// lui qui est comparé avant émission : un instantané identique n'émet rien.
///
/// `root` porte la disponibilité de la RACINE `<stateDir>` elle-même (S-11) :
/// `.absent` quand le répertoire n'existe pas ou n'est pas un répertoire. Elle est
/// distincte de la disponibilité des stores — un magasin jamais écrit a une
/// racine présente et des répertoires absents (ou vides), et le tableau doit dire
/// « vide », pas « absent ».
public struct StoreSnapshot: Sendable, Equatable, Codable {
    public var root: StoreAvailability
    public var running: RunningEnvelope
    public var history: HistoryEnvelope
    public var lots: LotEnvelope
    public var projects: ProjectEnvelope
    public var inbox: InboxEnvelope
    public var audit: AuditEnvelope
    public var audits: AuditsEnvelope

    public init(root: StoreAvailability, running: RunningEnvelope, history: HistoryEnvelope, lots: LotEnvelope, projects: ProjectEnvelope, inbox: InboxEnvelope, audit: AuditEnvelope, audits: AuditsEnvelope = .absent) {
        self.root = root
        self.running = running
        self.history = history
        self.lots = lots
        self.projects = projects
        self.inbox = inbox
        self.audit = audit
        self.audits = audits
    }

    private enum CodingKeys: String, CodingKey {
        case root, running, history, lots, projects, inbox, audit, audits
    }

    /// `audits` est FACULTATIF au décodage : la trame `store` d'un Mac antérieur à
    /// la section Audit (et les fixtures JSON qui la précèdent) se lit avec une
    /// enveloppe absente au lieu de faire échouer l'instantané entier.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        root = try container.decode(StoreAvailability.self, forKey: .root)
        running = try container.decode(RunningEnvelope.self, forKey: .running)
        history = try container.decode(HistoryEnvelope.self, forKey: .history)
        lots = try container.decode(LotEnvelope.self, forKey: .lots)
        projects = try container.decode(ProjectEnvelope.self, forKey: .projects)
        inbox = try container.decode(InboxEnvelope.self, forKey: .inbox)
        audit = try container.decode(AuditEnvelope.self, forKey: .audit)
        audits = try container.decodeIfPresent(AuditsEnvelope.self, forKey: .audits) ?? .absent
    }
}
