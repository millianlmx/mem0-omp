// Enveloppes d'un instantané du magasin d'état (S-2 … S-6) : disponibilité,
// entrées rendues, compteur d'entrées écartées.
//
// Une enveloppe par store plutôt qu'un type générique : les noms de champs sont
// ceux du dépôt (`lots`, `projects`), et un instantané complet se lit d'un coup
// d'œil dans `StoreSnapshot`.

import Foundation

/// « magasin absent » (le répertoire n'existe pas, ou n'est pas un répertoire)
/// contre « magasin vide » (il existe, aucune entrée) : deux états distincts, un
/// lecteur ne doit jamais les confondre (B-6, S-8).
enum StoreAvailability: Sendable, Equatable {
    case absent
    case present
}

/// `running/` : les pipelines en cours, triées par `phaseStartedAt` croissant puis
/// `cwd` croissant, bornées à `PipelineStore.runningReadLimit`.
struct RunningEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var entries: [RunningEntry]
    var discarded: Int
}

/// `history/` : les pipelines closes, triées par `endedAt` décroissant puis `cwd`
/// croissant, bornées à `PipelineStore.historyReadLimit`.
struct HistoryEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var entries: [HistoryEntry]
    var discarded: Int
}

/// `lots/` : un lot par dépôt, fichiers triés par nom.
struct LotEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var lots: [Lot]
    var discarded: Int
}

/// `projects/` : un projet par dépôt, fichiers triés par nom.
struct ProjectEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var projects: [Project]
    var discarded: Int
}

/// `inbox/` : les boîtes des runs, triées par nom. `discarded` vaut toujours 0 —
/// une livraison illisible est RENDUE avec `payload == nil`, jamais écartée (S-5) ;
/// le champ existe pour l'uniformité de l'enveloppe.
struct InboxEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var boxes: [InboxBox]
    var discarded: Int
}

/// `audit/` : les relais battants, fichiers triés par nom.
struct AuditEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var relays: [AuditRelay]
    var discarded: Int
}

/// L'instantané complet du magasin, celui que pousse le flux global (S-9). C'est
/// lui qui est comparé avant émission : un instantané identique n'émet rien.
struct StoreSnapshot: Sendable, Equatable {
    var running: RunningEnvelope
    var history: HistoryEnvelope
    var lots: LotEnvelope
    var projects: ProjectEnvelope
    var inbox: InboxEnvelope
    var audit: AuditEnvelope
}
