// Construction de l'ardoise : les quatre sources du magasin mêlées en une seule
// ardoise, une carte par pipeline (S-2), rangée dans EXACTEMENT une colonne (S-1)
// et portant ce que l'entité porte vraiment (S-4).
//
// Le fichier porte aussi les textes de PARITÉ avec le panneau `/pipelines`
// (Doc-5) : `elapsedLabel`, `lotStateLabel`, `lotWaitLabel` et `liveStateLabel`
// reprennent MOT POUR MOT leurs homologues TypeScript, et les commentaires nomment
// la fonction reproduite — la relecture se fait donc par comparaison, pas par
// confiance. Le titre d'une carte de lot, lui, est le seul slug : dépendances,
// modèle et messages en file sont des détails du terminal, pas de la carte.
//
// VIT DANS `ConsoleCore` : les deux coques partagent la dérivation.

import Foundation

// --- textes de parité (Doc-5) ------------------------------------------------

/// `elapsedLabel` (store.ts:172-181) : `<m>:<ss>` sous une heure, `<h>:<mm>:<ss>`
/// au-delà, zéros à gauche. Un écart négatif (horloge reculée, entrée future) vaut
/// `0:00` plutôt qu'un signe — d'où le `max(0, …)` AVANT le calcul des heures.
public func elapsedLabel(ms: Double) -> String {
    let total = ms.isFinite ? clampedInt(max(0, ms / 1000)) : 0
    let seconds = String(format: "%02d", total % 60)
    let minutes = (total / 60) % 60
    let hours = total / 3600
    return hours == 0 ? "\(minutes):\(seconds)" : "\(hours):\(String(format: "%02d", minutes)):\(seconds)"
}

/// `lotStateLabel` (lot.ts:247-263) : les mots d'un état de feature de lot.
public func lotStateLabel(_ state: LotFeatureState) -> String {
    switch state {
    case .pending: "à venir"
    case .running: "en cours"
    case .waiting: "attend"
    case .blocked: "bloqué"
    case .failed: "échoué"
    case .done: "terminé"
    case .cancelled: "annulé"
    }
}

/// `lotWaitLabel` (lot.ts:268-275) : le libellé du JALON attendu, `nil` quand la
/// feature n'attend rien de nommable.
public func lotWaitLabel(_ waitKind: LotWaitKind?) -> String? {
    switch waitKind {
    case .answer: "attend réponse"
    case .specs: "attend validation"
    case .review: "attend accord"
    case nil: nil
    }
}

/// Les mots d'un statut de FEATURE de projet (S-4) : ce que la carte écrit pour
/// une feature de projet sans lot. Aucune valeur inventée — le statut vient du
/// magasin `projects`.
public func projectStateLabel(_ status: ProjectFeatureStatus) -> String {
    switch status {
    case .planned: "prévue"
    case .launched: "lancée"
    case .pr: "PR ouverte"
    case .merged: "fusionnée"
    case .failed: "échouée"
    case .removed: "retirée"
    }
}

/// `liveStateLabel` (panelRows.ts:713-716) : l'état d'un run VIVANT dans les mots
/// du panneau. Une question `ask` en vol est une ATTENTE DE RÉPONSE ; `waiting`
/// sans question est l'inactivité ou un run non conduit, donc « attend ».
public func liveStateLabel(_ entry: RunningEntry) -> String {
    if entry.pendingAsk != nil { return "attend réponse" }
    return entry.state == .waiting ? "attend" : "tourne"
}


/// Les modèles RÉSOLUS d'une feature de lot, ou `nil` quand elle n'en porte aucun.
private func modelSlots(of feature: LotFeature) -> ModelSlots? {
    ModelSlots.resolve(
        legacy: feature.model,
        reqSpecs: feature.modelReqSpecs,
        implReview: feature.modelImplReview
    )
}

/// Les modèles RÉSOLUS d'une feature de projet, ou `nil`.
private func modelSlots(of feature: ProjectFeature) -> ModelSlots? {
    ModelSlots.resolve(
        legacy: feature.model,
        reqSpecs: feature.modelReqSpecs,
        implReview: feature.modelImplReview
    )
}

// --- l'ardoise ---------------------------------------------------------------

extension KanbanBoard {
    /// Construit l'ardoise depuis un instantané du magasin.
    ///
    /// FONCTION PURE : aucune E/S, aucun accès horloge implicite. `nowMs` est
    /// l'instant de la lecture, passé explicitement : il borne les livraisons
    /// closes (`deliveredWindowMs`). La durée AFFICHÉE, elle, se recalcule depuis
    /// l'instant de rendu (`KanbanCard.elapsedText(nowMs:)`), donc une carte
    /// ouverte avance sans que le magasin change (S-7).
    ///
    /// `prFacts` : l'état GitHub des PR, indexé par URL exacte
    /// (`PullRequestFacts.index`). Une URL sans fait est une PR à l'état INCONNU,
    /// rangée « PR créée » — jamais « PR ouverte » par défaut.
    public static func build(
        snapshot: StoreSnapshot,
        nowMs: Double,
        isAlive: PipelineLiveness,
        prFacts: [String: PullRequestFact]
    ) -> KanbanBoard {
        let dedup = KanbanDedup.apply(snapshot: snapshot)

        // Appariement feature de projet ↔ feature de lot (S-2) : même dépôt RÉEL et
        // même slug. C'est un appariement NORMAL — jamais marqué « doublon » (AC-3).
        var projectByFeature: [String: (project: Project, feature: ProjectFeature)] = [:]
        for project in dedup.projects {
            let repoReal = realpathOr(project.repoRoot)
            for feature in projectFeatures(project) {
                let key = featureKey(repoReal, feature.slug)
                if projectByFeature[key] == nil { projectByFeature[key] = (project, feature) }
            }
        }
        // Appariement run ↔ feature de lot (S-2) : `realpath(cwd) == realpath(worktree)`
        // et `worktree != ""` — une feature `pending` (worktree vide) n'absorbe pas
        // l'entrée du dépôt principal (parité `readPanelModel`, Doc-5). D1 a rendu
        // les `cwd` uniques, donc un run au plus par worktree.
        var runByCwd: [String: RunningEntry] = [:]
        for entry in dedup.running { runByCwd[realpathOr(entry.cwd)] = entry }

        var drafts: [CardDraft] = []
        var absorbedRuns = Set<String>()
        var pairedProjects = Set<String>()
        // Le worktree RÉEL de chaque feature de lot (tous états) → l'indice de sa
        // carte : c'est là que se rattachent ses clôtures de `history/` (bloc 4).
        var featureDraftByWorktree: [String: Int] = [:]

        // (1) Les cartes de feature de lot, lots triés par `repoRoot` puis `id`,
        // features dans l'ordre du fichier. Une carte fusionnée projet + lot prend
        // la position de sa feature de lot.
        for lot in dedup.lots.sorted(by: { lotOrder($0, $1) }) {
            let repoReal = realpathOr(lot.repoRoot)
            let repoKey = KanbanRepoKey.key(forRoot: lot.repoRoot)
            for feature in lot.features {
                let key = featureKey(repoReal, feature.slug)
                let pair = projectByFeature[key]
                if pair != nil { pairedProjects.insert(key) }
                var run: RunningEntry?
                if feature.worktree != "" {
                    let worktree = realpathOr(feature.worktree)
                    if let candidate = runByCwd[worktree], !absorbedRuns.contains(candidate.id) {
                        run = candidate
                        absorbedRuns.insert(candidate.id)
                    }
                    if featureDraftByWorktree[worktree] == nil { featureDraftByWorktree[worktree] = drafts.count }
                }
                let prUrl = firstNonEmpty(pair?.feature.prUrl, feature.prUrl)
                let fact = prUrl.flatMap { prFacts[$0] }
                var sources: [KanbanSource] = []
                if let pair {
                    sources.append(KanbanSource(
                        kind: .project,
                        ref: "projects/\(pair.project.repoKey).json · feature « \(pair.feature.slug) »"
                    ))
                }
                sources.append(KanbanSource(
                    kind: .lot,
                    ref: "lots/\(repoKey).json · feature « \(feature.slug) »"
                ))
                if let run {
                    sources.append(KanbanSource(kind: .run, ref: "running/\(run.id).json"))
                }
                drafts.append(CardDraft(
                    card: KanbanCard(
                        id: "feature:\(repoKey):\(feature.slug)",
                        column: rankColumn(
                            lot: lot, feature: feature, project: pair?.feature, run: run, history: nil,
                            prUrl: prUrl, fact: fact
                        ),
                        repo: basename(repoReal),
                        title: feature.slug,
                        state: lotWaitLabel(feature.waitKind) ?? lotStateLabel(feature.state),
                        // Le maillon : celui du run apparié, sinon celui de la feature.
                        phase: run?.phase ?? feature.phase,
                        // Les modèles RÉSOLUS et la PR du projet priment (le plan
                        // fait autorité) ; à défaut, ceux de la feature du lot.
                        models: pair.flatMap { modelSlots(of: $0.feature) } ?? modelSlots(of: feature),
                        prUrl: prUrl,
                        // Une entrée publiée ne fait jamais reculer l'horloge : la
                        // durée part de l'instant le PLUS ANCIEN des deux.
                        startMs: run.map { min(feature.sinceAt, $0.phaseStartedAt) } ?? feature.sinceAt,
                        endMs: feature.endedAt,
                        marks: [],
                        sources: sources,
                        action: KanbanCardAction(
                            repoRoot: lot.repoRoot,
                            repoKey: repoKey,
                            worktree: feature.worktree.isEmpty ? nil : feature.worktree,
                            slug: feature.slug,
                            waitKind: feature.waitKind,
                            featureState: feature.state,
                            run: run.map(cardRun),
                            waitPrompt: feature.waitPrompt
                        )
                    ),
                    run: run,
                    lot: lot,
                    lotRepoKey: repoKey,
                    project: pair?.project,
                    projectFeature: pair?.feature,
                    fact: fact,
                    doublon: isDoublon(
                        dedup, repoReal: repoReal, slug: feature.slug,
                        run: run, lot: lot, project: pair?.project, history: nil
                    )
                ))
            }
        }

        // (2) Les cartes de projet SANS feature de lot du même dépôt : un AJOUT
        // assumé du tableau au regard de `/pipelines` (les statuts du magasin
        // `projects` font partie des sources, S-12).
        for project in dedup.projects.sorted(by: { projectOrder($0, $1) }) {
            let repoReal = realpathOr(project.repoRoot)
            for feature in projectFeatures(project) {
                if pairedProjects.contains(featureKey(repoReal, feature.slug)) { continue }
                let prUrl = firstNonEmpty(feature.prUrl)
                let fact = prUrl.flatMap { prFacts[$0] }
                drafts.append(CardDraft(
                    card: KanbanCard(
                        id: "project:\(project.repoKey):\(feature.slug)",
                        column: rankColumn(
                            lot: nil, feature: nil, project: feature, run: nil, history: nil,
                            prUrl: prUrl, fact: fact
                        ),
                        repo: basename(repoReal),
                        title: feature.slug,
                        state: projectStateLabel(feature.status),
                        phase: nil,
                        models: modelSlots(of: feature),
                        prUrl: prUrl,
                        startMs: feature.updatedAt,
                        endMs: nil,
                        marks: [],
                        sources: [KanbanSource(
                            kind: .project,
                            ref: "projects/\(project.repoKey).json · feature « \(feature.slug) »"
                        )],
                        action: KanbanCardAction(
                            repoRoot: project.repoRoot,
                            repoKey: project.repoKey,
                            slug: nil,
                            waitKind: nil,
                            featureState: nil,
                            run: nil
                        )
                    ),
                    run: nil,
                    lot: nil,
                    lotRepoKey: nil,
                    project: project,
                    projectFeature: feature,
                    fact: fact,
                    doublon: isDoublon(
                        dedup, repoReal: repoReal, slug: feature.slug,
                        run: nil, lot: nil, project: project, history: nil
                    )
                ))
            }
        }

        // (3) Les runs NON appariés, dans l'ordre de lecture du store.
        for entry in dedup.running where !absorbedRuns.contains(entry.id) {
            drafts.append(CardDraft(
                card: KanbanCard(
                    id: "run:\(entry.id)",
                    column: rankColumn(
                        lot: nil, feature: nil, project: nil, run: entry, history: nil, prUrl: nil, fact: nil
                    ),
                    repo: repoFromLabel(entry.label),
                    title: entry.label,
                    state: liveStateLabel(entry),
                    phase: entry.phase,
                    models: nil,
                    prUrl: nil,
                    startMs: entry.phaseStartedAt,
                    endMs: nil,
                    marks: [],
                    sources: [KanbanSource(kind: .run, ref: "running/\(entry.id).json")],
                    action: KanbanCardAction(
                        repoRoot: nil,
                        slug: nil,
                        waitKind: nil,
                        featureState: nil,
                        run: cardRun(entry)
                    )
                ),
                run: entry,
                lot: nil,
                lotRepoKey: nil,
                project: nil,
                doublon: isDoublon(
                    dedup, repoReal: "", slug: nil,
                    run: entry, lot: nil, project: nil, history: nil
                )
            ))
        }

        // (4) Les clôtures de `history/` (après D2), rattachées par worktree RÉEL :
        // omp-mem0-req en écrit une par MAILLON, donc une feature en accumule
        // plusieurs. Une clôture dont le `cwd` est le worktree d'une feature de lot
        // (tous états) ne fait AUCUNE carte : elle devient une source de la carte
        // de cette feature. Les autres sont groupées par `cwd` réel, et chaque
        // groupe fait UNE carte, celle de la clôture la plus récente ; les autres
        // clôtures du groupe en deviennent des sources. Les groupes suivent l'ordre
        // de lecture du store (première clôture lue).
        var absorbedHistory: [Int: [HistoryEntry]] = [:]
        var groupOrder: [String] = []
        var groups: [String: [HistoryEntry]] = [:]
        for entry in dedup.history {
            let key = realpathOr(entry.cwd)
            if let index = featureDraftByWorktree[key] {
                absorbedHistory[index, default: []].append(entry)
                continue
            }
            if groups[key] == nil { groupOrder.append(key) }
            groups[key, default: []].append(entry)
        }
        for (index, entries) in absorbedHistory {
            for entry in entries.sorted(by: historyRecency) {
                drafts[index].card.sources.append(historySource(entry))
                if dedup.doublonHistoryIDs.contains(entry.id) { drafts[index].doublon = true }
            }
        }
        for key in groupOrder {
            let entries = (groups[key] ?? []).sorted(by: historyRecency)
            guard let entry = entries.first else { continue }
            let others = entries.dropFirst()
            drafts.append(CardDraft(
                card: KanbanCard(
                    id: "history:\(entry.id)",
                    column: rankColumn(
                        lot: nil, feature: nil, project: nil, run: nil, history: entry, prUrl: nil, fact: nil
                    ),
                    repo: repoFromLabel(entry.label),
                    title: entry.label,
                    state: entry.finalState == .done ? "terminée" : "échouée",
                    phase: entry.phase,
                    models: nil,
                    prUrl: nil,
                    startMs: entry.phaseStartedAt,
                    endMs: entry.endedAt,
                    marks: [],
                    sources: entries.map(historySource)
                ),
                run: nil,
                lot: nil,
                lotRepoKey: nil,
                project: nil,
                doublon: isDoublon(
                    dedup, repoReal: "", slug: nil,
                    run: nil, lot: nil, project: nil, history: entry
                ) || others.contains { dedup.doublonHistoryIDs.contains($0.id) }
            ))
        }

        // Les marques, dans l'ordre d'affichage : illisible, mort, doublon. Aucune
        // marque ne change la colonne — sauf « mort », qui bascule une carte
        // `en-cours` en `echec` (S-9, parité `reconcileStore`).
        let illisibleLotKeys = KanbanAnomalies.discardedKeys(snapshot.lots.discardedEntries, store: .lots)
        let illisibleProjectKeys = KanbanAnomalies.discardedKeys(
            snapshot.projects.discardedEntries, store: .projects
        )
        for index in drafts.indices {
            var marks: [KanbanMark] = []
            // Un `lots/<clé>.json` illisible marque les cartes du PROJET de ce dépôt ;
            // un `projects/<clé>.json` illisible, les cartes du LOT de ce dépôt. Un
            // `running`/`history` illisible ne marque aucune carte : il n'y a pas de
            // carte pour une entité invisible.
            if let key = drafts[index].project?.repoKey, illisibleLotKeys.contains(key) {
                marks.append(.illisible)
            }
            if let key = drafts[index].lotRepoKey, illisibleProjectKeys.contains(key) {
                marks.append(.illisible)
            }
            if drafts[index].hasDriver, !isAlive.isAlive(drafts[index].driverPid) {
                if drafts[index].card.column == .enCours { drafts[index].card.column = .echec }
                marks.append(.mort)
            }
            if drafts[index].doublon { marks.append(.doublon) }
            drafts[index].card.marks = marks
        }

        // La borne des livraisons CLOSES : une carte « Livrées » fusionnée, fermée
        // ou sans PR, close depuis plus de `deliveredWindowMs`, quitte l'ardoise.
        // « PR ouverte » et « PR créée » restent quel que soit leur âge.
        let cards = drafts.filter { !isExpiredDelivery($0, nowMs: nowMs) }.map(\.card)

        // Le bandeau : les entrées illisibles (S-8), puis les propriétaires morts
        // (S-9), puis les doublons (S-10) — déjà triés par identité croissante. Le
        // geste d'un lot mort se résout sur l'ardoise FINALE : « Reprendre » ne
        // vise jamais une carte que le tableau ne montre pas.
        var anomalies = KanbanAnomalies.illisibleLines(snapshot: snapshot)
        anomalies += KanbanAnomalies.mortLines(
            running: dedup.running, lots: dedup.lots, isAlive: isAlive, cards: cards
        )
        anomalies += dedup.anomalies
        return KanbanBoard(cards: cards, anomalies: anomalies)
    }

    /// La fenêtre de « Livrées récemment » : 7 × 24 h. Une livraison CLOSE
    /// (fusionnée, fermée, sans PR) plus ancienne quitte l'ardoise.
    public static let deliveredWindowMs: Double = 604_800_000
}

extension KanbanBoardState {
    /// L'état publié pour un instantané (S-11), dans cet ordre : racine absente,
    /// puis magasin vide (aucune carte ET aucune anomalie), puis le tableau. Le cas
    /// « racine présente, aucune carte mais des anomalies » rend donc le TABLEAU —
    /// les anomalies ne sont jamais tues, et aucune carte n'est inventée.
    public static func derive(
        snapshot: StoreSnapshot,
        nowMs: Double,
        stateDir: String,
        isAlive: PipelineLiveness,
        prFacts: [String: PullRequestFact]
    ) -> KanbanBoardState {
        guard snapshot.root == .present else { return .storeAbsent(dir: stateDir) }
        let board = KanbanBoard.build(snapshot: snapshot, nowMs: nowMs, isAlive: isAlive, prFacts: prFacts)
        guard board.cards.isEmpty && board.anomalies.isEmpty else { return .board(board) }
        return .storeEmpty(dir: stateDir)
    }
}

// --- rangement en colonne (S-1) ----------------------------------------------

/// Le rangement d'une carte : le PREMIER cas vrai, dans l'ordre de S-1. La fonction
/// est TOTALE — une carte a toujours une source, donc toujours une colonne.
///
/// Une carte livrée AVEC PR (feature de lot `done` + `prUrl`, feature de projet
/// `pr`/`merged`) se range selon le FAIT GitHub, qui prime toujours sur le statut
/// du magasin ; sans fait, l'état est inconnu : « PR créée », sauf une feature de
/// projet que le magasin dit déjà `merged`.
private func rankColumn(
    lot: Lot?,
    feature: LotFeature?,
    project: ProjectFeature?,
    run: RunningEntry?,
    history: HistoryEntry?,
    prUrl: String?,
    fact: PullRequestFact?
) -> KanbanColumn {
    // 1 à 4 : les statuts de la FEATURE de projet priment (un projet `merged` dont
    // la feature de lot a échoué va en « fusionné »).
    if let project {
        switch project.status {
        case .merged: return deliveredColumn(fact, unknown: .fusionne)
        case .removed: return .annuleeRetiree
        case .failed: return .echec
        case .pr: return deliveredColumn(fact, unknown: .prCreee)
        case .planned, .launched: break
        }
    }
    // 5 : une question `ask` EN VOL. `waiting` sans `pendingAsk` n'en est pas une
    // (Doc-5 : `waiting` couvre aussi l'inactivité et le run non conduit).
    if run?.pendingAsk != nil { return .questionEnVol }
    // 6 à 8 : le jalon nommé de la feature de lot.
    if let waitKind = feature?.waitKind {
        switch waitKind {
        case .answer: return .questionEnVol
        case .specs: return .jalonSpecs
        case .review: return .jalonReview
        }
    }
    // 9 à 12 : les états terminaux et bloqués de la feature de lot.
    if let feature {
        switch feature.state {
        case .blocked: return .bloquee
        case .cancelled: return .annuleeRetiree
        case .failed: return .echec
        case .done: return prUrl != nil ? deliveredColumn(fact, unknown: .prCreee) : .termineeSansPr
        case .pending, .running, .waiting: break
        }
    }
    // 13 : une clôture — `done` est une livraison sans PR, `failed` un échec.
    if let history { return history.finalState == .done ? .termineeSansPr : .echec }
    // 14 et 15 : une feature de lot encore vivante. `waiting` sans `waitKind` nommé
    // retombe en « en cours » : son état est vivant, aucun jalon n'est nommable.
    if let feature {
        return feature.state == .pending ? .enAttente : .enCours
    }
    // 16 et 17 : une carte de projet seule.
    if let project { return project.status == .planned ? .enAttente : .enCours }
    // 18 : un run hors lot et hors projet.
    return .enCours
}

/// La colonne d'une carte livrée avec PR : celle du fait GitHub, `unknown` sans
/// fait.
private func deliveredColumn(_ fact: PullRequestFact?, unknown: KanbanColumn) -> KanbanColumn {
    switch fact?.state {
    case .open: return .prOuverte
    case .merged: return .fusionne
    case .closed: return .prFermee
    case nil: return unknown
    }
}

// --- borne des livraisons closes ---------------------------------------------

/// Une carte RETIRÉE de l'ardoise : voie « Livrées », colonne close (fusionnée,
/// fermée, sans PR) et date de référence plus ancienne que `deliveredWindowMs`
/// (strictement). Référence, dans cet ordre : la clôture GitHub datée, la fin de
/// pipeline (`endMs`), la date de la feature de projet ; sans référence, la carte
/// reste. Une référence future (horloge décalée) donne un âge négatif : gardée.
private func isExpiredDelivery(_ draft: CardDraft, nowMs: Double) -> Bool {
    let card = draft.card
    guard KanbanLane.of(card) == .livrees else { return false }
    switch card.column {
    case .fusionne, .prFermee, .termineeSansPr: break
    default: return false
    }
    let closedAt: Double? = switch draft.fact?.state {
    case .merged, .closed: draft.fact?.closedAtMs
    case .open, nil: nil
    }
    let projectAt = draft.projectFeature.map(\.updatedAt).flatMap { $0 > 0 ? $0 : nil }
    guard let reference = closedAt ?? card.endMs ?? projectAt else { return false }
    return nowMs - reference > KanbanBoard.deliveredWindowMs
}

// --- clôtures de `history/` --------------------------------------------------

/// La source citable d'une clôture.
private func historySource(_ entry: HistoryEntry) -> KanbanSource {
    KanbanSource(kind: .history, ref: "history/\(entry.id).json")
}

/// L'ordre des clôtures d'une même feature : la plus récente d'abord, à égalité
/// le plus petit `id`.
private func historyRecency(_ left: HistoryEntry, _ right: HistoryEntry) -> Bool {
    left.endedAt != right.endedAt ? left.endedAt > right.endedAt : left.id < right.id
}

// --- brouillon de carte ------------------------------------------------------

/// Une carte en cours de construction, avec le CONTEXTE qui a servi à la bâtir :
/// c'est lui qui porte les règles de marque (S-8 par clé de dépôt, S-9 par
/// conducteur, S-10 par source gagnante) sans ajouter un seul champ au modèle
/// public `KanbanCard`.
private struct CardDraft {
    var card: KanbanCard
    var run: RunningEntry?
    var lot: Lot?
    var lotRepoKey: String?
    var project: Project?
    /// La feature de projet de la carte (appariée ou seule) : sa date sert de
    /// dernière référence à la borne des livraisons closes.
    var projectFeature: ProjectFeature? = nil
    /// Le fait GitHub de la PR de la carte, quand il est connu.
    var fact: PullRequestFact? = nil
    var doublon: Bool

    /// Le conducteur de la carte : le run apparié (ou la carte de run elle-même),
    /// sinon le lot qui porte la feature. Une carte d'historique et une carte de
    /// projet seule n'ont AUCUN conducteur : elles ne peuvent pas porter `mort`.
    var hasDriver: Bool { run != nil || lot != nil }

    var driverPid: Int? { run?.ownerPid ?? lot?.owner.pid }
}

// --- outils ------------------------------------------------------------------

/// La marque `doublon` d'une carte : une de ses sources est GAGNANTE d'une
/// collision D1…D6 (S-10). Les règles départagent par l'ordre de lecture, jamais
/// par une préférence de source.
private func isDoublon(
    _ dedup: KanbanDedup,
    repoReal: String,
    slug: String?,
    run: RunningEntry?,
    lot: Lot?,
    project: Project?,
    history: HistoryEntry?
) -> Bool {
    if let run, dedup.doublonRunIDs.contains(run.id) { return true }
    if let lot, dedup.doublonLotIDs.contains(lot.id) { return true }
    if let project, dedup.doublonProjectRepoKeys.contains(project.repoKey) { return true }
    if let history, dedup.doublonHistoryIDs.contains(history.id) { return true }
    // Une carte fusionnée porte les DEUX sources : une collision de slug du côté
    // lot comme du côté projet la marque légitimement.
    if let slug {
        let key = featureKey(repoReal, slug)
        if dedup.doublonLotFeatureKeys.contains(key) { return true }
        if dedup.doublonProjectFeatureKeys.contains(key) { return true }
    }
    return false
}

/// Le run d'une carte (S-10) : les valeurs publiées, jamais un chemin recalculé —
/// `inbox` vient de `RunningEntry.inbox`, la question de `RunningEntry.pendingAsk`.
public func cardRun(_ entry: RunningEntry) -> KanbanCardRun {
    KanbanCardRun(id: entry.id, label: entry.label, inbox: entry.inbox, pendingAsk: entry.pendingAsk)
}

/// Le nom du dépôt d'une carte de lot ou de projet : le dernier segment du chemin
/// RÉEL.
private func basename(_ path: String) -> String {
    let trimmed = path.hasSuffix("/") ? String(path.dropLast()) : path
    guard let slash = trimmed.lastIndex(of: "/") else { return trimmed }
    return String(trimmed[trimmed.index(after: slash)...])
}

/// Le dépôt d'une carte de run ou d'historique : le premier segment de `label`
/// coupé au premier `/`, le label entier quand il n'en porte pas. C'est le nom que
/// le dépôt a lui-même écrit (`pipelineLabel`, Doc-5) — aucune seconde convention.
private func repoFromLabel(_ label: String) -> String {
    guard let slash = label.firstIndex(of: "/") else { return label }
    return String(label[label.startIndex..<slash])
}

/// Les features d'un projet, segments dans l'ordre du fichier puis features.
private func projectFeatures(_ project: Project) -> [ProjectFeature] {
    project.segments.flatMap(\.features)
}

/// La première valeur NON VIDE : le projet prime sur le lot pour le modèle et pour
/// l'URL de PR, et une chaîne vide vaut absence (jamais une valeur inventée).
private func firstNonEmpty(_ values: String?...) -> String? {
    for value in values {
        if let value, !value.isEmpty { return value }
    }
    return nil
}

/// L'ordre du LOT (S-5) : `repoRoot` croissant puis `id`.
public func lotOrder(_ left: Lot, _ right: Lot) -> Bool {
    if left.repoRoot != right.repoRoot { return left.repoRoot < right.repoRoot }
    return left.id < right.id
}

/// L'ordre du PROJET (S-5) : `repoRoot` croissant puis `repoKey`.
public func projectOrder(_ left: Project, _ right: Project) -> Bool {
    if left.repoRoot != right.repoRoot { return left.repoRoot < right.repoRoot }
    return left.repoKey < right.repoKey
}
