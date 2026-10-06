// Les anomalies du magasin vues par le tableau (S-8, S-9, S-10) : la déduplication
// des sources, les lignes de la bulle des problèmes et les marques portées par
// les cartes.
//
// Chaque anomalie porte DEUX textes : une phrase pour l'utilisateur, qui nomme la
// pipeline quand c'est possible, et le détail technique EXACT (fichier, pid,
// identité — testé à l'octet), affiché seulement sous « Détails techniques ».
// Trois règles :
//  - S-8 « entrée illisible » : une ligne par fichier écarté des quatre stores du
//    tableau, avec sa raison — `JSONValue.parse` qui échoue n'est pas un schéma
//    incomplet ;
//  - S-9 « propriétaire mort » : une entrée morte est NOMMÉE, marquée, et une
//    carte `en-cours` dont le conducteur est mort passe en `echec` (parité
//    `reconcileStore`, Doc-5 — le tableau, lui, ne réconcilie rien) ;
//  - S-10 « doublon » : deux sources vivantes qui décrivent la même chose ne
//    laissent qu'UNE carte, marquée, et le bandeau cite les deux sources.
//
// `pidAlive` de la couche de lecture est la SEULE autorité de vivacité : ce
// fichier ne réimplémente rien (BR-3).

import ConsoleCore
import Foundation

/// Le résultat de la déduplication (S-10) : les entités RETENUES, les sources
/// GAGNANTES d'une collision (elles seules portent la marque `doublon`) et les
/// lignes de bandeau, déjà triées par identité croissante.
///
/// La déduplication a lieu AVANT le rangement en colonne et AVANT l'appariement
/// projet ↔ lot : un lot perdant ne s'apparie donc à rien, et les cartes des
/// sources perdantes ne sont jamais produites.
struct KanbanDedup: Sendable {
    var running: [RunningEntry]
    var history: [HistoryEntry]
    /// Les lots retenus, leurs features DÉJÀ dédupliquées (D3).
    var lots: [Lot]
    /// Les projets retenus, leurs segments DÉJÀ dédupliqués (D4).
    var projects: [Project]
    var doublonRunIDs: Set<String>
    var doublonHistoryIDs: Set<String>
    /// Les lots gagnants d'une collision D5 : toutes leurs cartes sont marquées.
    var doublonLotIDs: Set<String>
    /// Les projets gagnants d'une collision D6, par `repoKey`.
    var doublonProjectRepoKeys: Set<String>
    /// Les features gagnantes d'une collision D3/D4, par clé `(dépôt réel, slug)`.
    var doublonLotFeatureKeys: Set<String>
    var doublonProjectFeatureKeys: Set<String>
    var anomalies: [KanbanAnomaly]

    static func apply(snapshot: StoreSnapshot) -> KanbanDedup {
        var collisions: [(identity: String, anomaly: KanbanAnomaly)] = []
        var doublonRunIDs = Set<String>()
        var doublonHistoryIDs = Set<String>()
        var doublonLotIDs = Set<String>()
        var doublonProjectRepoKeys = Set<String>()
        var doublonLotFeatureKeys = Set<String>()
        var doublonProjectFeatureKeys = Set<String>()

        // D1 — deux entrées `running` du même `cwd` RÉEL (un lien symbolique et sa
        // cible sont la même chose : la comparaison passe par `realpath`).
        var running: [RunningEntry] = []
        var seenCwd: [String: RunningEntry] = [:]
        for entry in snapshot.running.entries {
            let real = realpathOr(entry.cwd)
            if let kept = seenCwd[real] {
                doublonRunIDs.insert(kept.id)
                collisions.append(collision(
                    identity: "cwd \(real)",
                    name: entry.label,
                    a: "running/\(kept.id).json",
                    b: "running/\(entry.id).json"
                ))
                continue
            }
            seenCwd[real] = entry
            running.append(entry)
        }

        // D2 — deux entrées `history` de même (`cwd` réel, `endedAt`).
        var history: [HistoryEntry] = []
        var seenClose: [String: HistoryEntry] = [:]
        for entry in snapshot.history.entries {
            let real = realpathOr(entry.cwd)
            let key = "\(real)\u{1}\(entry.endedAt)"
            let identity = "clôture \(real) à \(numberText(entry.endedAt))"
            if let kept = seenClose[key] {
                doublonHistoryIDs.insert(kept.id)
                collisions.append(collision(
                    identity: identity,
                    name: entry.label,
                    a: "history/\(kept.id).json",
                    b: "history/\(entry.id).json"
                ))
                continue
            }
            seenClose[key] = entry
            history.append(entry)
        }

        // D5 — deux lots du même dépôt RÉEL (clés de fichier différentes) : le
        // premier dans l'ordre du lot (S-5) garde sa carte, l'autre disparaît.
        var lots: [Lot] = []
        var seenLotRepo: [String: Lot] = [:]
        for lot in snapshot.lots.lots.sorted(by: lotOrder) {
            let real = realpathOr(lot.repoRoot)
            if let kept = seenLotRepo[real] {
                doublonLotIDs.insert(kept.id)
                collisions.append(collision(
                    identity: "cwd \(real)",
                    name: nil,
                    a: lotRef(kept),
                    b: lotRef(lot)
                ))
                continue
            }
            seenLotRepo[real] = lot
            lots.append(lot)
        }

        // D6 — deux projets du même dépôt RÉEL.
        var projects: [Project] = []
        var seenProjectRepo: [String: Project] = [:]
        for project in snapshot.projects.projects.sorted(by: projectOrder) {
            let real = realpathOr(project.repoRoot)
            if let kept = seenProjectRepo[real] {
                doublonProjectRepoKeys.insert(kept.repoKey)
                collisions.append(collision(
                    identity: "cwd \(real)",
                    name: nil,
                    a: projectRef(kept),
                    b: projectRef(project)
                ))
                continue
            }
            seenProjectRepo[real] = project
            projects.append(project)
        }

        // D3 — deux features de lot du même slug dans le même dépôt RÉEL.
        var retainedLots: [Lot] = []
        var seenLotFeature: [String: String] = [:]
        for lot in lots {
            let real = realpathOr(lot.repoRoot)
            let repoKey = KanbanRepoKey.key(forRoot: lot.repoRoot)
            var features: [LotFeature] = []
            for feature in lot.features {
                let key = featureKey(real, feature.slug)
                let citation = "lots/\(repoKey).json · feature « \(feature.slug) »"
                if let kept = seenLotFeature[key] {
                    doublonLotFeatureKeys.insert(key)
                    collisions.append(collision(
                        identity: "feature « \(feature.slug) »",
                        name: feature.slug,
                        a: kept,
                        b: citation
                    ))
                    continue
                }
                seenLotFeature[key] = citation
                features.append(feature)
            }
            var retained = lot
            retained.features = features
            retainedLots.append(retained)
        }

        // D4 — deux features de projet du même slug dans le même dépôt RÉEL. Un
        // fichier falsifié peut les porter dans le MÊME fichier : le lecteur ne
        // vérifie pas l'unicité des slugs, et les deux citations désignent alors le
        // même `projects/<repoKey>.json` — c'est admis, l'anomalie reste nommée.
        var retainedProjects: [Project] = []
        var seenProjectFeature: [String: String] = [:]
        for project in projects {
            let real = realpathOr(project.repoRoot)
            var segments: [ProjectSegment] = []
            for segment in project.segments {
                var features: [ProjectFeature] = []
                for feature in segment.features {
                    let key = featureKey(real, feature.slug)
                    let citation = "projects/\(project.repoKey).json · feature « \(feature.slug) »"
                    if let kept = seenProjectFeature[key] {
                        doublonProjectFeatureKeys.insert(key)
                        collisions.append(collision(
                            identity: "feature « \(feature.slug) »",
                            name: feature.slug,
                            a: kept,
                            b: citation
                        ))
                        continue
                    }
                    seenProjectFeature[key] = citation
                    features.append(feature)
                }
                segments.append(ProjectSegment(name: segment.name, features: features))
            }
            var retained = project
            retained.segments = segments
            retainedProjects.append(retained)
        }

        return KanbanDedup(
            running: running,
            history: history,
            lots: retainedLots,
            projects: retainedProjects,
            doublonRunIDs: doublonRunIDs,
            doublonHistoryIDs: doublonHistoryIDs,
            doublonLotIDs: doublonLotIDs,
            doublonProjectRepoKeys: doublonProjectRepoKeys,
            doublonLotFeatureKeys: doublonLotFeatureKeys,
            doublonProjectFeatureKeys: doublonProjectFeatureKeys,
            anomalies: collisions
                .sorted { ($0.identity, $0.anomaly.detail) < ($1.identity, $1.anomaly.detail) }
                .map(\.anomaly)
        )
    }
}

/// Les lignes de bandeau et les prédicats d'anomalie — des fonctions pures, donc
/// testables sans magasin ni vue.
enum KanbanAnomalies {
    // --- S-8 : entrées illisibles --------------------------------------------

    /// La raison telle que le détail technique l'écrit (S-8) : deux échecs distincts.
    static func reasonText(_ reason: DiscardReason) -> String {
        switch reason {
        case .unparsable: "JSON illisible"
        case .schema: "schéma incomplet ou inconnu"
        }
    }

    /// Une ligne par entrée écartée des QUATRE stores du tableau, dans l'ordre de
    /// la bulle : `running`, `history`, `lots`, `projects`, puis par nom de fichier
    /// (l'ordre de la couche de lecture). `inbox/` et `audit/` sont hors périmètre.
    static func illisibleLines(snapshot: StoreSnapshot) -> [KanbanAnomaly] {
        let groups = [
            snapshot.running.discardedEntries,
            snapshot.history.discardedEntries,
            snapshot.lots.discardedEntries,
            snapshot.projects.discardedEntries,
        ]
        return groups.flatMap { entries in
            entries.map { entry in
                KanbanAnomaly(
                    kind: .illisible,
                    text: "Une entrée de pipeline est illisible.",
                    detail: "entrée illisible — \(entry.file) : \(reasonText(entry.reason))"
                )
            }
        }
    }

    /// Les clés de dépôt citées par les fichiers écartés d'un store
    /// (`lots/<clé>.json` → `<clé>`), pour marquer les cartes concernées.
    static func discardedKeys(_ entries: [DiscardedEntry], store: PipelineStore) -> Set<String> {
        let prefix = "\(store.rawValue)/"
        let suffix = ".json"
        var keys = Set<String>()
        for entry in entries where entry.file.hasPrefix(prefix) && entry.file.hasSuffix(suffix) {
            keys.insert(String(entry.file.dropFirst(prefix.count).dropLast(suffix.count)))
        }
        return keys
    }

    // --- S-9 : propriétaire mort ---------------------------------------------

    /// « mort » = `pidAlive` faux, ou pid ABSENT (non entier : parité `asPid`).
    /// Le BATTEMENT périmé (`isStale`, 10 000 ms) n'est PAS une anomalie : un run
    /// vivant au repos garde un `updatedAt` figé (`publishRunning` ne le réécrit
    /// pas), et le compter comme mort enterrerait des pipelines vivantes.
    static func isDead(pid: Int?) -> Bool {
        guard let pid else { return true }
        return !pidAlive(pid)
    }

    /// Les lignes `mort`, dans l'ordre : `running` par `id`, puis `lots` par clé de
    /// dépôt. Une ligne par ENTITÉ morte — un lot mort n'en produit qu'une, pas une
    /// par feature.
    static func mortLines(running: [RunningEntry], lots: [Lot]) -> [KanbanAnomaly] {
        var lines: [KanbanAnomaly] = []
        for entry in running.sorted(by: { $0.id < $1.id }) where isDead(pid: entry.ownerPid) {
            lines.append(KanbanAnomaly(
                kind: .mort,
                text: "\(entry.label) s'est arrêtée de façon inattendue.",
                detail: mortText(target: "running/\(entry.id).json", pid: entry.ownerPid)
            ))
        }
        let deadLots = lots
            .filter { isDead(pid: $0.owner.pid) }
            .sorted { KanbanRepoKey.key(forRoot: $0.repoRoot) < KanbanRepoKey.key(forRoot: $1.repoRoot) }
        for lot in deadLots {
            let repo = (realpathOr(lot.repoRoot) as NSString).lastPathComponent
            lines.append(KanbanAnomaly(
                kind: .mort,
                text: "Le pilote de \(repo) s'est arrêté de façon inattendue.",
                detail: mortText(target: "lots/\(KanbanRepoKey.key(forRoot: lot.repoRoot)).json", pid: lot.owner.pid)
            ))
        }
        return lines
    }

    /// Le détail technique d'une ligne `mort` : le fichier et le pid.
    static func mortText(target: String, pid: Int?) -> String {
        "propriétaire mort — \(target) : \(pid.map { "pid \($0)" } ?? "pid absent")"
    }

    // --- S-10 : doublon -------------------------------------------------------

    /// La phrase nomme la pipeline quand l'identité en désigne une (`name`) ; le
    /// détail reste `doublon — <source A> et <source B> : <identité>` (S-10).
    static func doublonLine(a: String, b: String, identity: String, name: String?) -> KanbanAnomaly {
        KanbanAnomaly(
            kind: .doublon,
            text: name.map { "Deux sources décrivent la même pipeline : \($0)." }
                ?? "Deux sources décrivent la même pipeline.",
            detail: "doublon — \(a) et \(b) : \(identity)"
        )
    }
}

// --- outils privés -----------------------------------------------------------

private func lotRef(_ lot: Lot) -> String {
    "lots/\(KanbanRepoKey.key(forRoot: lot.repoRoot)).json"
}

private func projectRef(_ project: Project) -> String {
    "projects/\(project.repoKey).json"
}

private func collision(
    identity: String,
    name: String?,
    a: String,
    b: String
) -> (identity: String, anomaly: KanbanAnomaly) {
    (identity, KanbanAnomalies.doublonLine(a: a, b: b, identity: identity, name: name))
}

/// Un nombre d'horodatage rendu sans décimale superflue : `1700000000000` plutôt
/// que `1.7e+12` ou `1700000000000.0`.
private func numberText(_ value: Double) -> String {
    value.rounded(.towardZero) == value ? String(clampedInt(value)) : String(value)
}
