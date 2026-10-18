// Preuves de la présentation pure de la section Audit (audit-ui-redesign S-1) :
// la frise des quatre étapes, les sections de la liste, les légendes, les menus,
// le compte des audits en attente, la phrase d'échec, le diagnostic, la durée
// écoulée et les étapes d'une feature lancée — sur la fixture `AuditParity`.

import ConsoleCore
import Foundation
import Testing

private func parityCard(_ id: String) throws -> AuditCard {
    try #require(AuditParity.board.card(id: id))
}

private func states(_ input: AuditProgressInput) -> [PipelineStepState] {
    AuditPresentation.steps(input).map(\.state)
}

// MARK: - AC-9 : la frise

@Test("audit-ui-redesign-core/AC-9 : la frise suit la table de S-1, titres Analyse, Propositions, Brief, Pipelines")
func auditStepsFollowTheTable() {
    #expect(AuditPresentation.steps(.analysing).map(\.title) == ["Analyse", "Propositions", "Brief", "Pipelines"])

    #expect(states(.analysing) == [.current, .upcoming, .upcoming, .upcoming])
    #expect(states(.proposed(briefReviewOpen: false)) == [.done, .current, .upcoming, .upcoming])
    #expect(states(.proposed(briefReviewOpen: true)) == [.done, .done, .current, .upcoming])
    #expect(states(.launched(pipelinesFinished: false)) == [.done, .done, .done, .current])
    #expect(states(.launched(pipelinesFinished: true)) == [.done, .done, .done, .done])

    #expect(states(.failed(at: .analysis)) == [.failed, .upcoming, .upcoming, .upcoming])
    #expect(states(.failed(at: .proposals)) == [.done, .failed, .upcoming, .upcoming])
    #expect(states(.failed(at: .brief)) == [.done, .done, .failed, .upcoming])
    #expect(states(.failed(at: .pipelines)) == [.done, .done, .done, .failed])

    // Arrêté pendant l'étape X : X et les suivantes restent à venir.
    #expect(states(.stopped(during: .analysis)) == [.upcoming, .upcoming, .upcoming, .upcoming])
    #expect(states(.stopped(during: .proposals)) == [.done, .upcoming, .upcoming, .upcoming])
    #expect(states(.stopped(during: .brief)) == [.done, .done, .upcoming, .upcoming])
    #expect(states(.stopped(during: .pipelines)) == [.done, .done, .done, .upcoming])
    #expect(states(.stopped(during: nil)) == [.done, .done, .done, .done])
}

@Test("audit-ui-redesign-core/AC-9 : l'entrée de la frise de chaque audit d'AuditParity, et la relecture refermée revient à Propositions")
func auditProgressInputOfTheFixture() throws {
    #expect(AuditPresentation.progressInput(try parityCard(AuditParity.analysingId), briefReviewOpen: false) == .analysing)
    let proposed = try parityCard(AuditParity.proposedId)
    #expect(AuditPresentation.progressInput(proposed, briefReviewOpen: false) == .proposed(briefReviewOpen: false))
    #expect(AuditPresentation.progressInput(proposed, briefReviewOpen: true) == .proposed(briefReviewOpen: true))
    // `journal-erreurs` tourne encore : les pipelines ne sont pas finies.
    #expect(AuditPresentation.progressInput(try parityCard(AuditParity.launchedId), briefReviewOpen: false) == .launched(pipelinesFinished: false))
    #expect(AuditPresentation.progressInput(try parityCard(AuditParity.stoppedId), briefReviewOpen: false) == .stopped(during: .proposals))
    #expect(AuditPresentation.progressInput(try parityCard(AuditParity.failedId), briefReviewOpen: false) == .failed(at: .analysis))

    // Ouvrir puis refermer la relecture sans lancer : Brief en cours, puis retour
    // à Propositions en cours.
    let opened = AuditPresentation.steps(AuditPresentation.progressInput(proposed, briefReviewOpen: true))
    let closed = AuditPresentation.steps(AuditPresentation.progressInput(proposed, briefReviewOpen: false))
    #expect(AuditPresentation.focusTitle(opened) == "Brief")
    #expect(closed.map(\.state) == [.done, .current, .upcoming, .upcoming])
    // La relecture n'a d'effet que sur un audit proposed.
    #expect(AuditPresentation.progressInput(try parityCard(AuditParity.launchedId), briefReviewOpen: true) == .launched(pipelinesFinished: false))
}

@Test("audit-ui-redesign-core/AC-9 : lancé sans feature, lancé tout livré, arrêté après livraison, arrêté ou en échec aux pipelines")
func auditProgressInputEdgeCases() throws {
    var launched = try parityCard(AuditParity.launchedId)

    // Toutes refusées : aucune feature lancée, les pipelines sont finies.
    var refused = launched
    refused.features = []
    #expect(AuditPresentation.progressInput(refused, briefReviewOpen: false) == .launched(pipelinesFinished: true))

    // PR créée, livrée, annulée : terminées ; un échec ou un blocage ne l'est pas.
    launched.features = launched.features.map { row in
        var row = row
        row.waiting = .done
        return row
    }
    launched.features[0].waiting = .prCreated
    launched.features[1].waiting = .cancelled
    #expect(AuditPresentation.progressInput(launched, briefReviewOpen: false) == .launched(pipelinesFinished: true))
    var failedFeature = launched
    failedFeature.features[0].waiting = .failed
    #expect(AuditPresentation.progressInput(failedFeature, briefReviewOpen: false) == .launched(pipelinesFinished: false))
    var blockedFeature = launched
    blockedFeature.features[0].waiting = .blocked
    #expect(AuditPresentation.progressInput(blockedFeature, briefReviewOpen: false) == .launched(pipelinesFinished: false))

    // Arrêté après la livraison de tout : 4 faites.
    var deliveredThenStopped = launched
    deliveredThenStopped.status = .stopped
    #expect(AuditPresentation.progressInput(deliveredThenStopped, briefReviewOpen: false) == .stopped(during: nil))
    #expect(states(.stopped(during: nil)) == [.done, .done, .done, .done])

    // Arrêté pendant les pipelines.
    var stoppedRunning = try parityCard(AuditParity.launchedId)
    stoppedRunning.status = .stopped
    #expect(AuditPresentation.progressInput(stoppedRunning, briefReviewOpen: false) == .stopped(during: .pipelines))

    // Arrêté pendant l'analyse : aucune proposition.
    var stoppedAnalysing = try parityCard(AuditParity.analysingId)
    stoppedAnalysing.status = .stopped
    #expect(AuditPresentation.progressInput(stoppedAnalysing, briefReviewOpen: false) == .stopped(during: .analysis))

    // Échec après des propositions : l'étape atteinte est en échec.
    var failedAfterProposals = try parityCard(AuditParity.proposedId)
    failedAfterProposals.status = .failed
    #expect(AuditPresentation.progressInput(failedAfterProposals, briefReviewOpen: false) == .failed(at: .proposals))
}

// MARK: - AC-2 : les sections

@Test("audit-ui-redesign-core/AC-2 : « En cours » porte exactement analysing, proposed, launched ; « Terminés » exactement stopped et failed")
func auditSectionsSplitByStatus() {
    let sections = AuditPresentation.sections(AuditParity.board)
    #expect(sections.map(\.kind) == [.running, .finished])
    #expect(sections.map(\.title) == [AuditText.sectionRunning, AuditText.sectionFinished])
    #expect(sections.map(\.title) == ["En cours", "Terminés"])
    #expect(sections[0].cards.map(\.id) == [AuditParity.analysingId, AuditParity.proposedId, AuditParity.launchedId])
    #expect(sections[1].cards.map(\.id) == [AuditParity.stoppedId, AuditParity.failedId])
    #expect(AuditStatus.allCases.filter(AuditPresentation.isRunning) == [.analysing, .proposed, .launched])
}

@Test("audit-ui-redesign-core/AC-2 : une section sans audit n'est pas rendue, une ardoise vide n'en rend aucune")
func auditEmptySectionIsOmitted() {
    let board = AuditParity.board
    let running = AuditBoard(audits: board.audits.filter { AuditPresentation.isRunning($0.status) })
    #expect(AuditPresentation.sections(running).map(\.kind) == [.running])
    let finished = AuditBoard(audits: board.audits.filter { !AuditPresentation.isRunning($0.status) })
    #expect(AuditPresentation.sections(finished).map(\.kind) == [.finished])
    #expect(AuditPresentation.sections(AuditBoard(audits: [])).isEmpty)
}

// MARK: - AC-3 : la rangée

@Test("audit-ui-redesign-core/AC-3 : la légende de rangée lit « dépôt · étape · âge » sur une ligne, le dépôt une seule fois, et la pastille suit le statut")
func auditRowCaption() throws {
    let launched = try parityCard(AuditParity.launchedId)
    let nowMs = launched.createdAt + 180_000
    let age = ConsoleFormat.relative(ms: launched.createdAt, nowMs: nowMs)
    let caption = AuditPresentation.rowCaption(launched, briefReviewOpen: false, nowMs: nowMs)
    #expect(caption == "depot · Pipelines · " + age)
    #expect(!caption.contains("\n"))
    #expect(caption.components(separatedBy: launched.repoName).count == 2, "le dépôt n'est écrit qu'une fois")
    #expect(!launched.orientation.contains(launched.repoName))

    let proposed = try parityCard(AuditParity.proposedId)
    #expect(AuditPresentation.rowCaption(proposed, briefReviewOpen: false, nowMs: nowMs).hasPrefix("depot · Propositions · "))
    #expect(AuditPresentation.rowCaption(proposed, briefReviewOpen: true, nowMs: nowMs).hasPrefix("depot · Brief · "))
    #expect(AuditPresentation.rowCaption(try parityCard(AuditParity.stoppedId), briefReviewOpen: false, nowMs: nowMs).hasPrefix("depot · Propositions · "))
    #expect(AuditPresentation.rowCaption(try parityCard(AuditParity.failedId), briefReviewOpen: false, nowMs: nowMs).hasPrefix("depot · Analyse · "))

    // Toutes faites : la dernière étape résume la frise.
    #expect(AuditPresentation.focusTitle(AuditPresentation.steps(.launched(pipelinesFinished: true))) == "Pipelines")

    #expect(AuditStatus.allCases.map(AuditPresentation.tone) == [.info, .attention, .success, .neutral, .danger])
    #expect(AuditText.pendingQuestions(2) == "2 questions en attente")
}

@Test("audit-ui-redesign-core/AC-8 : la légende d'en-tête lit « dépôt · lancé à HH:MM »")
func auditHeaderCaption() throws {
    let card = try parityCard(AuditParity.launchedId)
    #expect(AuditPresentation.headerCaption(card) == "depot · lancé à " + ConsoleFormat.time(ms: card.createdAt))
}

// MARK: - AC-5 : les menus et « Ouvrir dans Projet »

@Test("audit-ui-redesign-core/AC-5 : le menu copie le chemin complet, ouvre dans Projet, et n'offre « Arrêter » qu'à un audit en cours")
func auditMenuItems() throws {
    for id in [AuditParity.analysingId, AuditParity.proposedId, AuditParity.launchedId] {
        #expect(AuditPresentation.menu(for: try parityCard(id)) == [.copyPath("/tmp/omp-audit-parity/depot"), .openInProject, .stop])
    }
    for id in [AuditParity.stoppedId, AuditParity.failedId] {
        #expect(AuditPresentation.menu(for: try parityCard(id)) == [.copyPath("/tmp/omp-audit-parity/depot"), .openInProject])
    }
    var deep = try parityCard(AuditParity.launchedId)
    deep.repoRoot = "/Users/quelqu’un/Développement/clients/un-très-long-nom-de-dépôt/sous-module"
    #expect(AuditPresentation.menu(for: deep).first == .copyPath(deep.repoRoot), "le chemin n'est jamais abrégé")
    #expect(deep.repoKey == "0123456789abcdef", "la carte porte la clé de l'enregistrement")
}

@Test("audit-ui-redesign-core/AC-5 : « Ouvrir dans Projet » montre le dépôt piloté, propose de piloter ce dépôt, ou refuse quand un autre est piloté")
func auditProjectOpening() {
    #expect(AuditPresentation.projectOpening(auditRepoKey: "a", pilotedRepoKey: "a", pilotActive: true) == .show)
    #expect(AuditPresentation.projectOpening(auditRepoKey: "a", pilotedRepoKey: "b", pilotActive: true) == .refuse)
    #expect(AuditPresentation.projectOpening(auditRepoKey: "a", pilotedRepoKey: nil, pilotActive: false) == .proposeLaunch)
    // Un pilotage terminé du même dépôt ne compte plus : on propose de relancer.
    #expect(AuditPresentation.projectOpening(auditRepoKey: "a", pilotedRepoKey: "a", pilotActive: false) == .proposeLaunch)
}

// MARK: - AC-6 : les audits en attente

/// L'instantané de la fixture, questions répondues et plus rien de proposed.
private func settledSnapshot() -> StoreSnapshot {
    var snapshot = AuditParity.snapshot
    for lot in snapshot.lots.lots.indices {
        for feature in snapshot.lots.lots[lot].features.indices {
            snapshot.lots.lots[lot].features[feature].escalation = nil
        }
    }
    for record in snapshot.audits.records.indices where snapshot.audits.records[record].status == .proposed {
        snapshot.audits.records[record].status = .launched
    }
    return snapshot
}

@Test("audit-ui-redesign-core/AC-6 : la fixture compte 2 audits en attente (le proposed et le launched à question), 0 une fois tout répondu et lancé")
func auditAwaitingUserCount() {
    #expect(AuditParity.board.awaitingUserCount == 2)
    #expect(AuditBoard.awaitingUserCount(in: AuditParity.snapshot) == 2)
    #expect(AuditParity.board(nowMs: 1_800_000_000_000).awaitingUserCount == 2)

    let settled = settledSnapshot()
    #expect(AuditBoard.of(settled).awaitingUserCount == 0)
    #expect(AuditBoard.awaitingUserCount(in: settled) == 0)
}

@Test("audit-ui-redesign-core/AC-6 : le compte lu de l'instantané égale celui de l'ardoise, escalade inconnue ignorée et audit compté une fois")
func auditAwaitingUserCountMatchesTheBoard() throws {
    var unknownKind = AuditParity.snapshot
    let escalated = try #require(unknownKind.lots.lots[0].features.firstIndex { $0.escalation != nil })
    unknownKind.lots.lots[0].features[escalated].escalation?.key = "cap:reprise-pipeline:1"

    // Une question sur l'audit proposed : il reste UN audit en attente.
    var questionOnProposed = AuditParity.snapshot
    questionOnProposed.lots.lots[0].features[escalated].auditSession = "/tmp/omp-audit-parity/state/audits/\(AuditParity.proposedId)"

    var noAudit = AuditParity.snapshot
    noAudit.audits = .absent

    let cases: [(StoreSnapshot, Int)] = [
        (AuditParity.snapshot, 2),
        (AuditParity.snapshot(nowMs: 1_800_000_000_000), 2),
        (settledSnapshot(), 0),
        (unknownKind, 1),
        (questionOnProposed, 1),
        (noAudit, 0),
        (HomeParity.snapshot, 0),
    ]
    for (snapshot, expected) in cases {
        #expect(AuditBoard.awaitingUserCount(in: snapshot) == expected)
        #expect(AuditBoard.awaitingUserCount(in: snapshot) == AuditBoard.of(snapshot).awaitingUserCount)
    }
}

// MARK: - AC-14 : échec, diagnostic, durée écoulée

@Test("audit-ui-redesign-core/AC-14 : la phrase d'échec est rognée, capitalisée et ponctuée ; sans phrase, la cause inconnue")
func auditFailureSentence() {
    #expect(AuditPresentation.failureSentence("l'analyse a été interrompue") == "L'analyse a été interrompue.")
    #expect(AuditPresentation.failureSentence("  écran figé \n") == "Écran figé.")
    #expect(AuditPresentation.failureSentence("déjà fini.") == "Déjà fini.")
    #expect(AuditPresentation.failureSentence("quota épuisé !") == "Quota épuisé !")
    #expect(AuditPresentation.failureSentence("pourquoi ?") == "Pourquoi ?")
    #expect(AuditPresentation.failureSentence("coupé…") == "Coupé…")
    #expect(AuditPresentation.failureSentence(nil) == AuditText.failureUnknown)
    #expect(AuditPresentation.failureSentence("") == AuditText.failureUnknown)
    #expect(AuditPresentation.failureSentence(" \n\t") == AuditText.failureUnknown)
    #expect(AuditText.failureUnknown == "La cause de l\u{2019}échec n\u{2019}a pas été transmise.")
}

@Test("audit-ui-redesign-core/AC-14 : le diagnostic porte l'audit, le dépôt complet, l'orientation et l'échec brut, sur quatre lignes")
func auditDiagnostic() throws {
    let failed = try parityCard(AuditParity.failedId)
    #expect(failed.orientation.count >= 280)
    #expect(AuditPresentation.diagnostic(failed) == [
        "Audit\u{00A0}: a0d1700000000005",
        "Dépôt\u{00A0}: /tmp/omp-audit-parity/depot",
        "Orientation\u{00A0}: \(failed.orientation)",
        "Échec\u{00A0}: l'analyse a été interrompue",
    ].joined(separator: "\n"))

    var silent = failed
    silent.failure = "   "
    #expect(AuditPresentation.diagnostic(silent).hasSuffix("Échec\u{00A0}: " + AuditText.failureUnknown))
    #expect(AuditPresentation.failureSentence(failed.failure) == "L'analyse a été interrompue.")
}

@Test("audit-ui-redesign-core/AC-14 : la durée écoulée se lit m:ss puis h:mm:ss, zéro pour une durée négative ou non finie")
func auditElapsed() {
    #expect(AuditPresentation.elapsed(ms: 0) == "0:00")
    #expect(AuditPresentation.elapsed(ms: 999) == "0:00")
    #expect(AuditPresentation.elapsed(ms: 65_000) == "1:05")
    #expect(AuditPresentation.elapsed(ms: 3_599_000) == "59:59")
    #expect(AuditPresentation.elapsed(ms: 3_600_000) == "1:00:00")
    #expect(AuditPresentation.elapsed(ms: 3_725_000) == "1:02:05")
    #expect(AuditPresentation.elapsed(ms: -5_000) == "0:00")
    #expect(AuditPresentation.elapsed(ms: .nan) == "0:00")
    #expect(AuditPresentation.elapsed(ms: .infinity) == "0:00")
    #expect(AuditText.analysisElapsed(AuditPresentation.elapsed(ms: 65_000)) == "Analyse en cours depuis 1:05")

    // La fixture datée : l'analyse a démarré 65 s avant l'instant donné.
    let nowMs = 1_800_000_000_000.0
    let analysing = AuditParity.board(nowMs: nowMs).card(id: AuditParity.analysingId)
    #expect(analysing.map { AuditPresentation.elapsed(ms: nowMs - $0.createdAt) } == "1:05")
    #expect(AuditParity.board(nowMs: nowMs).audits.map(\.id) == AuditParity.board.audits.map(\.id))
}

// MARK: - Étapes d'une feature lancée, blocs du corps des pipelines

@Test("audit-ui-redesign-core/AC-13 : les cinq étapes d'une feature lancée suivent son attente et sa phase")
func auditFeatureSteps() {
    func steps(_ waiting: AuditWaiting, _ phase: PipelinePhase?) -> [PipelineStepState] {
        AuditPresentation.featureSteps(AuditFeatureRow(slug: "f", phase: phase, waiting: waiting, prUrl: nil)).map(\.state)
    }
    #expect(AuditPresentation.featureSteps(AuditFeatureRow(slug: "f", phase: .impl, waiting: .running, prUrl: nil)).map(\.title) == KanbanText.progressSteps)
    #expect(steps(.prCreated, .release) == [.done, .done, .done, .done, .current])
    #expect(steps(.done, .release) == [.done, .done, .done, .done, .upcoming])
    #expect(steps(.done, nil) == [.done, .done, .done, .done, .upcoming])
    #expect(steps(.notStarted, nil) == [.upcoming, .upcoming, .upcoming, .upcoming, .upcoming])
    #expect(steps(.cancelled, .specs) == [.done, .upcoming, .upcoming, .upcoming, .upcoming])
    #expect(steps(.failed, .impl) == [.done, .done, .failed, .upcoming, .upcoming])
    #expect(steps(.blocked, .review) == [.done, .done, .done, .failed, .upcoming])
    #expect(steps(.running, .impl) == [.done, .done, .current, .upcoming, .upcoming])
    #expect(steps(.escalated, .req) == [.current, .upcoming, .upcoming, .upcoming, .upcoming])
    #expect(steps(.arbiterDeciding, .specs) == [.done, .current, .upcoming, .upcoming, .upcoming])
    #expect(steps(.waiting, .review) == [.done, .done, .done, .current, .upcoming])
}

@Test("audit-ui-redesign-core/AC-13 : les questions viennent en premier, puis l'avancement, les non lancées et les décisions ; un arrêt avant lancement n'a que son état vide")
func auditFollowUpBlocks() throws {
    let launched = try parityCard(AuditParity.launchedId)
    #expect(AuditPresentation.followUpBlocks(launched) == [.escalations, .progress, .notLaunched, .decisions])
    var quiet = launched
    quiet.escalations = []
    quiet.decisions = []
    #expect(AuditPresentation.followUpBlocks(quiet) == [.progress, .notLaunched])
    #expect(AuditPresentation.followUpBlocks(try parityCard(AuditParity.stoppedId)) == [.stoppedBeforeLaunch])
    var stoppedLaunched = launched
    stoppedLaunched.status = .stopped
    #expect(AuditPresentation.followUpBlocks(stoppedLaunched) == [.escalations, .progress, .notLaunched, .decisions])
}

// MARK: - Textes de la refonte

@Test("audit-ui-redesign-core/AC-12 : la barre compte « 0 cochée », « 1 cochée », « 3 cochées » ; dépendances « après X » et pastille « déjà prise »")
func auditProposalTexts() {
    #expect(AuditText.checkedCount(0) == "0 cochée")
    #expect(AuditText.checkedCount(1) == "1 cochée")
    #expect(AuditText.checkedCount(3) == "3 cochées")
    #expect(AuditText.after(["journal-erreurs"]) == "après journal-erreurs")
    #expect(AuditText.after(["a", "b"]) == "après a, b")
    #expect(AuditText.taken == "déjà prise")
    #expect(AuditText.reviewBrief == "Relire le brief →")
}

@Test("audit-ui-redesign-core/AC-10 : la frise se lit d'un bloc, chaque étape avec son état")
func auditStepsAccessibility() {
    #expect(AuditText.stepsAccessibility(AuditPresentation.steps(.proposed(briefReviewOpen: false)))
        == "Analyse\u{00A0}: fait, Propositions\u{00A0}: en cours, Brief\u{00A0}: à venir, Pipelines\u{00A0}: à venir")
    #expect(AuditText.stepsAccessibility(AuditPresentation.steps(.failed(at: .analysis))).hasPrefix("Analyse\u{00A0}: en échec, "))
    // « Analyse en cours » n'est écrit que par la durée de la carte d'analyse.
    #expect(!AuditText.stepsAccessibility(AuditPresentation.steps(.analysing)).contains("Analyse en cours"))
}
