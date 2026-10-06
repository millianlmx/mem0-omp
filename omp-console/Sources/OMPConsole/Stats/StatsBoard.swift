// Le tableau d'une feature (S-3) et ses totaux (S-4) : des fonctions PURES du
// magasin — aucune E/S, aucune horloge implicite pour la construction ; les totaux
// prennent `nowMs` en paramètre, donc la durée d'un run vivant avance sans que le
// magasin change.

import ConsoleCore
import Foundation

/// Un feature du plan avec sa liste de runs (avant lecture des sessions).
struct StatsPlanFeature: Equatable, Sendable {
    var slug: String
    var runs: [StoreRun]
}

/// Le nom de dépôt d'un chemin : le dernier segment RÉEL.
func statsBasename(_ path: String) -> String {
    let name = (path as NSString).lastPathComponent
    return name.isEmpty ? path : name
}

/// Les projets du magasin, dans l'ordre `projectOrder`, avec leur libellé de
/// sélecteur : `basename(repoRoot)`, SAUF collision de ce libellé entre plusieurs
/// projets, où TOUS les projets en collision affichent `basename (dossier parent)`
/// — le dossier parent passe par `ConsoleFormat.path` ; la clé (une empreinte)
/// n'est jamais montrée (S-5, audit HIG du 2026-10-01).
func statsProjectOptions(_ snapshot: StoreSnapshot) -> [StatsProjectOption] {
    let ordered = snapshot.projects.projects.sorted(by: projectOrder)
    var counts: [String: Int] = [:]
    for project in ordered {
        counts[statsBasename(project.repoRoot), default: 0] += 1
    }
    return ordered.map { project in
        let base = statsBasename(project.repoRoot)
        guard (counts[base] ?? 0) > 1 else {
            return StatsProjectOption(id: project.repoKey, label: base)
        }
        let parent = ConsoleFormat.path((project.repoRoot as NSString).deletingLastPathComponent)
        return StatsProjectOption(id: project.repoKey, label: "\(base) (\(parent))")
    }
}

/// L'ordre du plan déplié : par segment, les features VIVANTES puis les RETIRÉES
/// (ordre d'affichage des features, S-3).
func statsPlanSlugs(of project: Project) -> [String] {
    projectPlanSections(of: project).flatMap { section in
        section.features.map(\.slug) + section.removed.map(\.slug)
    }
}

/// Le plan d'un projet : chaque slug avec le worktree de sa feature de lot (lots
/// parcourus dans l'ordre `lotOrder`, appariement par `featureKey`), puis ses runs
/// (S-1). Une feature absente de tout lot, ou au worktree vide, n'a aucun run.
func statsPlan(of snapshot: StoreSnapshot, project: Project) -> [StatsPlanFeature] {
    let projectReal = realpathOr(project.repoRoot)
    let lots = snapshot.lots.lots.sorted(by: lotOrder)
    return statsPlanSlugs(of: project).map { slug in
        var worktree: String?
        for lot in lots {
            guard featureKey(realpathOr(lot.repoRoot), slug) == featureKey(projectReal, slug) else {
                continue
            }
            if let feature = lot.features.first(where: { $0.slug == slug }) {
                worktree = feature.worktree
                break
            }
        }
        let runs = worktree.map { statsRuns(of: snapshot, worktree: $0) } ?? []
        return StatsPlanFeature(slug: slug, runs: runs)
    }
}

/// Le projet affiché : celui dont `repoKey == selectedKey`, sinon le PREMIER de
/// l'ordre `projectOrder`.
func statsDisplayedProject(_ snapshot: StoreSnapshot, selectedKey: String?) -> Project? {
    let ordered = snapshot.projects.projects.sorted(by: projectOrder)
    guard !ordered.isEmpty else { return nil }
    return ordered.first { $0.repoKey == selectedKey } ?? ordered.first
}

/// Construit le tableau du projet affiché. `read` n'est appelé QUE pour les runs
/// du projet affiché (aucune lecture pour les autres), et une seule fois par
/// `sessionFile`. Rend `nil` quand le magasin ne porte aucun projet.
func statsBoard(
    snapshot: StoreSnapshot,
    selectedKey: String?,
    read: (String) -> RunMetricsState
) -> StatsBoard? {
    guard let project = statsDisplayedProject(snapshot, selectedKey: selectedKey) else {
        return nil
    }

    var cache: [String: RunMetricsState] = [:]
    func readOnce(_ sessionFile: String) -> RunMetricsState {
        if let known = cache[sessionFile] { return known }
        let value = read(sessionFile)
        cache[sessionFile] = value
        return value
    }

    var features: [FeatureStats] = []
    var hidden = 0
    for planFeature in statsPlan(of: snapshot, project: project) {
        let runs = planFeature.runs.map { run in
            RunStats(
                id: run.sessionFile,
                sessionFile: run.sessionFile,
                phase: run.phase,
                isLive: storeRunIsLive(run),
                metrics: readOnce(run.sessionFile)
            )
        }
        // Une feature est LISTÉE si, et seulement si, elle porte au moins un run
        // LISIBLE ; un run illisible reste listé sur sa ligne mais ne peut jamais
        // rendre sa feature listée à lui seul.
        let listed = runs.contains { if case .measured = $0.metrics { return true } else { return false } }
        if listed {
            features.append(FeatureStats(id: planFeature.slug, slug: planFeature.slug, runs: runs))
        } else {
            hidden += 1
        }
    }

    let options = statsProjectOptions(snapshot)
    let label = options.first { $0.id == project.repoKey }?.label ?? statsBasename(project.repoRoot)
    return StatsBoard(
        project: ProjectStats(
            repoKey: project.repoKey,
            label: label,
            features: features,
            hiddenPlanFeatures: hidden
        )
    )
}

/// Sommes sur les runs LISIBLES d'une feature (S-4).
func featureTotals(_ feature: FeatureStats, nowMs: Double) -> StatsTotals {
    var totals = StatsTotals.zero
    for run in feature.runs {
        guard case .measured(let metrics) = run.metrics else { continue }
        totals.input += metrics.input
        totals.output += metrics.output
        totals.turns += metrics.turns
        totals.durationMs += durationMs(metrics, isLive: run.isLive, nowMs: nowMs) ?? 0
    }
    return totals
}

/// Sommes des totaux des features LISTÉES d'un projet — rien d'autre n'y entre
/// (ni `hiddenPlanFeatures`, ni les runs des autres projets).
func projectTotals(_ project: ProjectStats, nowMs: Double) -> StatsTotals {
    var totals = StatsTotals.zero
    for feature in project.features {
        let feature = featureTotals(feature, nowMs: nowMs)
        totals.input += feature.input
        totals.output += feature.output
        totals.turns += feature.turns
        totals.durationMs += feature.durationMs
    }
    return totals
}
