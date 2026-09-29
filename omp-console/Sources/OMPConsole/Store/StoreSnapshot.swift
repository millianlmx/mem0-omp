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
enum StoreAvailability: Sendable, Equatable {
    case absent
    case present
}

/// POURQUOI une entrée a été écartée (BR-1) : la raison exacte que le bandeau du
/// tableau nomme (S-8). Un contenu qui n'est pas du JSON n'est pas la même chose
/// qu'un JSON valide au schéma incomplet — les deux se disent séparément.
enum DiscardReason: Sendable, Equatable {
    /// `JSONValue.parse` a échoué : le contenu n'est pas du JSON.
    case unparsable
    /// Le JSON est valide mais le validateur du store a rendu `nil` (schéma
    /// incomplet, version étrangère, champ hors vocabulaire).
    case schema
}

/// Une entrée écartée, NOMMÉE : le fichier (`<store>/<nom>`) et la raison. Le
/// chemin porte le store parce qu'un bandeau qui n'aurait que le nom de fichier
/// ne dirait pas OÙ regarder — et deux stores peuvent porter le même nom.
struct DiscardedEntry: Sendable, Equatable {
    /// `<store>/<fichier>` : `running/a1b2….json`, `lots/d0ef9a50f7dc3a37.json`…
    var file: String
    var reason: DiscardReason
}

/// `running/` : les pipelines en cours, triées par `phaseStartedAt` croissant puis
/// `cwd` croissant, bornées à `PipelineStore.runningReadLimit`.
struct RunningEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var entries: [RunningEntry]
    var discardedEntries: [DiscardedEntry]

    /// Le compte, calculé : une seule vérité, celle des entrées nommées.
    var discarded: Int { discardedEntries.count }
}

/// `history/` : les pipelines closes, triées par `endedAt` décroissant puis `cwd`
/// croissant, bornées à `PipelineStore.historyReadLimit`.
struct HistoryEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var entries: [HistoryEntry]
    var discardedEntries: [DiscardedEntry]

    var discarded: Int { discardedEntries.count }
}

/// `lots/` : un lot par dépôt, fichiers triés par nom.
struct LotEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var lots: [Lot]
    var discardedEntries: [DiscardedEntry]

    var discarded: Int { discardedEntries.count }
}

/// `projects/` : un projet par dépôt, fichiers triés par nom.
struct ProjectEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var projects: [Project]
    var discardedEntries: [DiscardedEntry]

    var discarded: Int { discardedEntries.count }
}

/// `inbox/` : les boîtes des runs, triées par nom. `discardedEntries` est toujours
/// vide — une livraison illisible est RENDUE avec `payload == nil`, jamais écartée
/// (S-5) ; le champ existe pour l'uniformité de l'enveloppe.
struct InboxEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var boxes: [InboxBox]
    var discardedEntries: [DiscardedEntry]

    var discarded: Int { discardedEntries.count }
}

/// `audit/` : les relais battants, fichiers triés par nom.
struct AuditEnvelope: Sendable, Equatable {
    var availability: StoreAvailability
    var relays: [AuditRelay]
    var discardedEntries: [DiscardedEntry]

    var discarded: Int { discardedEntries.count }
}

/// L'instantané complet du magasin, celui que pousse le flux global (S-9). C'est
/// lui qui est comparé avant émission : un instantané identique n'émet rien.
///
/// `root` porte la disponibilité de la RACINE `<stateDir>` elle-même (S-11) :
/// `.absent` quand le répertoire n'existe pas ou n'est pas un répertoire. Elle est
/// distincte de la disponibilité des six stores — un magasin jamais écrit a une
/// racine présente et six répertoires absents (ou vides), et le tableau doit dire
/// « vide », pas « absent ».
struct StoreSnapshot: Sendable, Equatable {
    var root: StoreAvailability
    var running: RunningEnvelope
    var history: HistoryEnvelope
    var lots: LotEnvelope
    var projects: ProjectEnvelope
    var inbox: InboxEnvelope
    var audit: AuditEnvelope
}
