// Preuves de l'Accueil et de la feuille « Nouvelle feature » (S-4, S-5, S-6 de
// omp-console-redesign) : fonctions PURES sur des cartes littérales, plus une
// garde « racine git » sur des dossiers temporaires. Aucune vue n'est rendue.

import Foundation
import Testing
@testable import OMPConsole

private func card(
    _ id: String,
    column: KanbanColumn,
    title: String? = nil,
    action: KanbanCardAction? = nil,
    marks: [KanbanMark] = []
) -> KanbanCard {
    KanbanCard(
        id: id, column: column, repo: "depot", title: title ?? id, state: "x",
        phase: .req, model: nil, prUrl: nil, startMs: 0, endMs: nil, marks: marks, sources: [],
        action: action
    )
}

private let board = KanbanBoard(cards: [], anomalies: [])
private let available = OmpStatus.available(URL(fileURLWithPath: "/usr/local/bin/omp"))

@MainActor
@Test("omp-console-redesign/AC-4 : l'app s'ouvre sur l'Accueil")
func appOpensOnHome() {
    #expect(ConsoleModel().selection == .home)
    #expect(ConsoleSection.allCases.first == .home)
}

@Test("omp-console-redesign/AC-4 : un magasin vide ou absent donne l'écran de première fois")
func emptyOrAbsentStoreGivesFirstRun() {
    #expect(HomePresentation.state(omp: available, board: .storeEmpty(dir: "/s")) == .firstRun)
    #expect(HomePresentation.state(omp: available, board: .storeAbsent(dir: "/s")) == .firstRun)
    #expect(HomePresentation.state(omp: available, board: .loading) == .loading)
    guard case .dashboard = HomePresentation.state(omp: available, board: .board(board)) else {
        Issue.record("un tableau présent doit donner le tableau de bord")
        return
    }
    // Aucune attente hors tableau de bord : pas de badge.
    #expect(HomePresentation.attentionCount(omp: available, board: .storeEmpty(dir: "/s")) == 0)
}

@Test("omp-console-redesign/AC-6 : les attentes sont mises en avant avec leur question")
func attentionsAreHighlightedWithTheirQuestion() {
    let ask = PanelPendingAsk(toolCallId: "call-1", id: "q", question: "On garde ?", options: [])
    let askCard = card("ask", column: .questionEnVol, action: KanbanCardAction(
        repoRoot: "/r", slug: "ask", waitKind: nil, featureState: .running,
        run: KanbanCardRun(id: "r1", label: "depot/ask", inbox: "/box", pendingAsk: ask)
    ))
    let answerCard = card("answer", column: .questionEnVol, action: KanbanCardAction(
        repoRoot: "/r", slug: "answer", waitKind: .answer, featureState: .waiting, run: nil,
        waitPrompt: "Quel séparateur ?"
    ))
    let specsCard = card("specs", column: .jalonSpecs)
    let reviewCard = card("review", column: .jalonReview)
    let runningCard = card("running", column: .enCours)
    let done = KanbanBoard(cards: [askCard, runningCard, answerCard, specsCard, reviewCard], anomalies: [])

    guard case .dashboard(let dashboard) = HomePresentation.state(omp: available, board: .board(done)) else {
        Issue.record("un tableau présent doit donner le tableau de bord")
        return
    }
    #expect(dashboard.attention.map(\.id) == ["ask", "answer", "specs", "review"])
    #expect(dashboard.attention.map(\.nature) == [.question, .question, .milestoneSpecs, .milestoneReview])
    #expect(dashboard.attention.map(\.prompt) == [
        "On garde ?", "Quel séparateur ?", HomeText.specsPrompt, HomeText.reviewPrompt,
    ])
    #expect(dashboard.running.map(\.id) == ["running"])
    #expect(HomePresentation.attentionCount(omp: available, board: .board(done)) == 4)

    // Une question sans texte connu garde une consigne lisible.
    let mute = card("mute", column: .questionEnVol)
    guard case .dashboard(let muted) = HomePresentation.state(
        omp: available, board: .board(KanbanBoard(cards: [mute], anomalies: []))
    ) else { return }
    #expect(muted.attention.first?.prompt == HomeText.questionWithoutText)

    // Une pipeline au pilote mort rangée en « Échec » reste « en cours » tant
    // qu'elle se reprend ; une terminée ne l'est pas.
    let deadAction = KanbanCardAction(repoRoot: "/r", slug: "dead", waitKind: nil, featureState: .running, run: nil)
    let dead = card("dead", column: .echec, action: deadAction, marks: [.mort])
    var failedAction = deadAction
    failedAction.featureState = .failed
    let failed = card("failed", column: .echec, action: failedAction, marks: [.mort])
    guard case .dashboard(let resumed) = HomePresentation.state(
        omp: available, board: .board(KanbanBoard(cards: [dead, failed], anomalies: []))
    ) else { return }
    #expect(resumed.running.map(\.id) == ["dead"])
}

@MainActor
@Test("omp-console-redesign/AC-7 : OMP introuvable donne l'écran « OMP est requis »")
func missingOmpGivesOmpRequired() {
    let home = HomeModel(
        resolve: { _ in .failure(.binaryNotFound(searched: ["/a/omp", "/b/omp"], override: "/x/omp")) },
        environment: { [:] }
    )
    #expect(home.canLaunch == false)
    let expected = HomeState.ompMissing(searched: ["/a/omp", "/b/omp"], override: "/x/omp")
    #expect(HomePresentation.state(omp: home.omp, board: .storeEmpty(dir: "/s")) == expected)
    let waiting = KanbanBoard(cards: [card("specs", column: .jalonSpecs)], anomalies: [])
    #expect(HomePresentation.state(omp: home.omp, board: .board(waiting)) == expected)
}

/// Un résolveur qui échoue tant que `found` est faux : l'utilisateur installe OMP
/// entre deux « Vérifier à nouveau ».
private final class SwitchingResolver {
    var found = false

    func resolve(_: [String: String]) -> Result<URL, SessionHostError> {
        found
            ? .success(URL(fileURLWithPath: "/usr/local/bin/omp"))
            : .failure(.binaryNotFound(searched: ["/a/omp"], override: nil))
    }
}

@MainActor
@Test("omp-console-redesign/AC-7 : OMP introuvable impose la feuille « OMP est requis » avant toute autre")
func missingOmpImposesItsSheetFirst() {
    let missing = OmpStatus.missing(searched: ["/a/omp"], override: nil)
    let boards: [KanbanBoardState] = [
        .loading, .storeAbsent(dir: "/s"), .storeEmpty(dir: "/s"),
        .board(KanbanBoard(cards: [card("ask", column: .questionEnVol)], anomalies: [])),
    ]
    for state in boards {
        for welcomeSeen in [false, true] {
            #expect(MainSheetPolicy.sheet(
                omp: missing, board: state, welcomeSeen: welcomeSeen, welcomeRequested: true,
                launchFormShown: true, answerCardID: "ask", contract: nil
            ) == .ompRequired)
            #expect(MainSheetPolicy.sheet(
                omp: missing, board: state, welcomeSeen: welcomeSeen, welcomeRequested: false,
                launchFormShown: false, answerCardID: nil, contract: nil
            ) == .ompRequired)
        }
    }

    let resolver = SwitchingResolver()
    let suite = "home-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let home = HomeModel(resolve: { resolver.resolve($0) }, environment: { [:] }, defaults: defaults)
    func policy() -> MainSheet? {
        MainSheetPolicy.sheet(
            omp: home.omp, board: .storeEmpty(dir: "/s"), welcomeSeen: home.welcomeSeen,
            welcomeRequested: home.welcomeRequested, launchFormShown: false, answerCardID: home.answerCardID,
            contract: nil
        )
    }
    #expect(home.recheckFailed == false, "aucun échec dit avant le premier « Vérifier à nouveau »")
    home.recheck()
    #expect(home.recheckFailed)
    #expect(policy() == .ompRequired)

    resolver.found = true
    home.recheck()
    #expect(home.canLaunch)
    #expect(home.recheckFailed == false)
    #expect(policy() != .ompRequired)
}

@MainActor
@Test("omp-console-redesign/AC-7 : « Choisir l'emplacement… » retient un programme et refuse un fichier ordinaire")
func choosingOmpLocationPersistsAnExecutableOnly() throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("home-tests-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: directory) }
    let plain = directory.appendingPathComponent("notes.txt")
    try Data("texte".utf8).write(to: plain)
    let binary = directory.appendingPathComponent("omp")
    try Data("#!/bin/sh\nexit 0\n".utf8).write(to: binary)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)

    let suite = "home-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    // La résolution RÉELLE (aucun résolveur injecté) : l'emplacement choisi doit
    // être lu du même domaine de préférences que celui où il est écrit.
    let home = HomeModel(environment: { ["PATH": "/nonexistent", "HOME": "/nonexistent"] }, defaults: defaults)

    home.chooseOmp(path: plain.path)
    #expect(home.chosenPathRejected)
    #expect(defaults.string(forKey: OmpBinaryResolver.chosenPathKey) == nil, "un fichier refusé n'est pas retenu")

    home.chooseOmp(path: binary.path)
    #expect(home.chosenPathRejected == false)
    #expect(defaults.string(forKey: OmpBinaryResolver.chosenPathKey) == binary.path)
    #expect(home.omp == .available(URL(fileURLWithPath: binary.path)))

    // Le lancement suivant le retrouve.
    let next = HomeModel(environment: { ["PATH": "/nonexistent", "HOME": "/nonexistent"] }, defaults: defaults)
    #expect(next.omp == .available(URL(fileURLWithPath: binary.path)))
}

@MainActor
@Test("omp-console-redesign/AC-4 : la bienvenue s'ouvre au premier lancement d'une installation neuve, une seule fois")
func welcomeOpensOnceOnAFreshInstall() {
    let suite = "home-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
    defer { defaults.removePersistentDomain(forName: suite) }
    let found: HomeModel.Resolver = { _ in .success(URL(fileURLWithPath: "/usr/local/bin/omp")) }
    let nonEmpty = KanbanBoard(cards: [card("running", column: .enCours)], anomalies: [])

    let first = HomeModel(resolve: found, environment: { [:] }, defaults: defaults)
    #expect(first.welcomeSeen == false)
    func policy(_ home: HomeModel, _ board: KanbanBoardState, launchFormShown: Bool = false) -> MainSheet? {
        MainSheetPolicy.sheet(
            omp: home.omp, board: board, welcomeSeen: home.welcomeSeen,
            welcomeRequested: home.welcomeRequested, launchFormShown: launchFormShown,
            answerCardID: home.answerCardID, contract: nil
        )
    }
    #expect(policy(first, .storeEmpty(dir: "/s")) == .welcome)
    #expect(policy(first, .storeAbsent(dir: "/s")) == .welcome)
    #expect(policy(first, .loading) == nil, "le chargement ne décide pas encore de la première fois")
    #expect(policy(first, .board(nonEmpty)) == nil, "un tableau déjà rempli n'est pas une installation neuve")
    #expect(policy(first, .storeEmpty(dir: "/s"), launchFormShown: true) == .welcome,
            "la bienvenue due passe avant « Nouvelle feature »")

    first.closeWelcome()
    #expect(defaults.bool(forKey: "home.welcomeSeen"))
    #expect(policy(first, .storeEmpty(dir: "/s"), launchFormShown: true) == .newFeature)

    let second = HomeModel(resolve: found, environment: { [:] }, defaults: defaults)
    #expect(second.welcomeSeen)
    #expect(policy(second, .storeEmpty(dir: "/s")) == nil, "la bienvenue ne revient pas au lancement suivant")

    second.requestWelcome()
    #expect(policy(second, .board(nonEmpty)) == .welcome, "Aide ▸ Bienvenue la rouvre sur demande")
    second.closeWelcome()
    #expect(second.welcomeRequested == false)
    #expect(policy(second, .board(nonEmpty)) == nil)
}

@Test("omp-console-redesign/AC-6 : « Répondre… » ouvre la feuille de la carte tant qu'elle attend une réponse")
func answerOpensTheCardSheetWhileItWaits() {
    func policy(_ board: KanbanBoardState, answerCardID: String?) -> MainSheet? {
        MainSheetPolicy.sheet(
            omp: available, board: board, welcomeSeen: true, welcomeRequested: false,
            launchFormShown: false, answerCardID: answerCardID, contract: nil
        )
    }

    let ask = PanelPendingAsk(toolCallId: "call-1", id: "q", question: "On garde ?", options: [])
    let askCard = card("ask", column: .questionEnVol, action: KanbanCardAction(
        repoRoot: "/r", slug: "ask", waitKind: nil, featureState: .running,
        run: KanbanCardRun(id: "r1", label: "depot/ask", inbox: "/box", pendingAsk: ask)
    ))
    #expect(HomePresentation.cardAction(HomeAttention(card: askCard, nature: .question, prompt: "On garde ?")) == .answer)
    let withAsk = KanbanBoardState.board(KanbanBoard(cards: [askCard], anomalies: []))
    #expect(policy(withAsk, answerCardID: "ask") == .answer(cardID: "ask"))
    #expect(policy(withAsk, answerCardID: nil) == nil)

    let replyCard = card("reply", column: .questionEnVol, action: KanbanCardAction(
        repoRoot: "/r", slug: "reply", waitKind: .answer, featureState: .waiting, run: nil,
        waitPrompt: "Quel séparateur ?"
    ))
    #expect(HomePresentation.cardAction(HomeAttention(card: replyCard, nature: .question, prompt: "Quel séparateur ?"))
        == .answer)
    let withReply = KanbanBoardState.board(KanbanBoard(cards: [replyCard], anomalies: []))
    #expect(policy(withReply, answerCardID: "reply") == .answer(cardID: "reply"))

    // La carte a quitté le tableau (question répondue ailleurs) : la feuille se ferme.
    let without = KanbanBoardState.board(KanbanBoard(cards: [askCard], anomalies: []))
    #expect(policy(without, answerCardID: "reply") == nil)

    // Devenue jalon : elle n'attend plus de réponse, pas de feuille.
    let specsCard = card("specs", column: .jalonSpecs, action: KanbanCardAction(
        repoRoot: "/r", slug: "specs", waitKind: .specs, featureState: .waiting, run: nil
    ))
    #expect(HomePresentation.cardAction(HomeAttention(card: specsCard, nature: .milestoneSpecs, prompt: HomeText.specsPrompt))
        == .validate)
    #expect(policy(.board(KanbanBoard(cards: [specsCard], anomalies: [])), answerCardID: "specs") == nil)

    let mute = card("mute", column: .questionEnVol)
    #expect(HomePresentation.cardAction(HomeAttention(card: mute, nature: .question, prompt: HomeText.questionWithoutText))
        == .open)
}

@Test("omp-console-redesign/AC-5 : la feuille n'accepte qu'une racine git et lance vers le dépôt choisi")
func sheetAcceptsOnlyGitRoots() throws {
    let base = FileManager.default.temporaryDirectory
        .appendingPathComponent("home-tests-\(UUID().uuidString)").path
    defer { try? FileManager.default.removeItem(atPath: base) }
    let withDir = joinPath(base, "avec-dossier")
    let withFile = joinPath(base, "avec-fichier")
    let without = joinPath(base, "sans-git")
    try FileManager.default.createDirectory(atPath: joinPath(withDir, ".git"), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: withFile, withIntermediateDirectories: true)
    try Data("gitdir: /ailleurs\n".utf8).write(to: URL(fileURLWithPath: joinPath(withFile, ".git")))
    try FileManager.default.createDirectory(atPath: without, withIntermediateDirectories: true)

    #expect(LaunchRepo.isGitRoot(path: withDir))
    #expect(LaunchRepo.isGitRoot(path: withFile), "un worktree lié porte un FICHIER .git")
    #expect(!LaunchRepo.isGitRoot(path: without))
    #expect(!LaunchRepo.isGitRoot(path: joinPath(base, "supprime")), "un dossier disparu n'est plus lançable")

    // Le dossier choisi s'ajoute aux dépôts connus, trié et sans doublon.
    let known = card("k", column: .enCours, action: KanbanCardAction(
        repoRoot: "/tmp", slug: nil, waitKind: nil, featureState: nil, run: nil
    ))
    let options = LaunchRepo.options(cards: [known], projectRoot: nil, chosen: "/Users/moi/dev/app")
    #expect(options == ["/Users/moi/dev/app", realpathOr("/tmp")].sorted())
    #expect(LaunchRepo.options(cards: [known], projectRoot: nil, chosen: realpathOr("/tmp")) == [realpathOr("/tmp")])
}

@Test("omp-console-redesign/AC-6 : un seul bouton proéminent, le dépôt seulement quand il y en a plusieurs")
func dashboardShowsOneProminentActionAndRepoOnlyWhenMixed() {
    let ask = PanelPendingAsk(toolCallId: "call-1", id: "q", question: "On garde ?", options: [])
    let askCard = card("ask", column: .questionEnVol, action: KanbanCardAction(
        repoRoot: "/r", slug: "ask", waitKind: nil, featureState: .running,
        run: KanbanCardRun(id: "r1", label: "depot/ask", inbox: "/box", pendingAsk: ask)
    ))
    let specsCard = card("specs", column: .jalonSpecs, action: KanbanCardAction(
        repoRoot: "/r", slug: "specs", waitKind: .specs, featureState: .waiting, run: nil
    ))
    let mute = card("mute", column: .questionEnVol)
    let sameRepo = HomePresentation.dashboard(KanbanBoard(cards: [mute, askCard, specsCard], anomalies: []))
    // « Voir dans Pipelines » n'est jamais le bouton proéminent : la première
    // carte qui offre un vrai geste l'est.
    #expect(HomePresentation.prominentAttentionID(sameRepo) == "ask")
    #expect(HomePresentation.prominentAttentionID(
        HomePresentation.dashboard(KanbanBoard(cards: [mute], anomalies: []))
    ) == nil)
    #expect(HomePresentation.showsRepo(sameRepo) == false)

    var elsewhere = card("ailleurs", column: .enCours)
    elsewhere.repo = "autre"
    let mixed = HomePresentation.dashboard(KanbanBoard(cards: [askCard, elsewhere], anomalies: []))
    #expect(HomePresentation.showsRepo(mixed))

    // La ligne sous le titre : le dépôt seulement s'il est montré ; sans étape,
    // le statut commun (« Pas commencée ») prend sa place.
    #expect(HomeText.cardSubtitle(askCard, noPhase: nil, showsRepo: true) == "depot · \(PhaseText.title(.req))")
    #expect(HomeText.cardSubtitle(askCard, noPhase: nil, showsRepo: false) == PhaseText.title(.req))
    var pending = card("pending", column: .enAttente)
    pending.phase = nil
    let notStarted = ConsoleStatus.of(card: pending).text
    #expect(HomeText.cardSubtitle(pending, noPhase: notStarted, showsRepo: false) == "Pas commencée")
    #expect(HomeText.cardSubtitle(pending, noPhase: nil, showsRepo: false) == nil)
}

@MainActor
@Test("omp-console-redesign/AC-4 : le bandeau « notifications désactivées » ne paraît que sur refus, jusqu'à « Ignorer »")
func notificationsBannerShowsOnDenialUntilIgnored() {
    #expect(HomePresentation.showsNotificationsBanner(authorization: .denied, dismissed: false))
    #expect(!HomePresentation.showsNotificationsBanner(authorization: .denied, dismissed: true))
    for authorization in [AlertAuthorization.authorized, .unknown, .unavailable] {
        #expect(!HomePresentation.showsNotificationsBanner(authorization: authorization, dismissed: false))
    }

    let suite = "home-tests-\(UUID().uuidString)"
    let defaults = UserDefaults(suiteName: suite)!
    defer { defaults.removePersistentDomain(forName: suite) }
    let found: HomeModel.Resolver = { _ in .success(URL(fileURLWithPath: "/usr/local/bin/omp")) }
    let home = HomeModel(resolve: found, environment: { [:] }, defaults: defaults)
    #expect(home.notificationsBannerDismissed == false)
    home.dismissNotificationsBanner()
    #expect(home.notificationsBannerDismissed)
    #expect(HomeModel(resolve: found, environment: { [:] }, defaults: defaults).notificationsBannerDismissed,
            "« Ignorer » vaut aussi pour les lancements suivants")
}

@Test("omp-console-redesign/AC-5 : le bandeau de lancement dit l'état de la commande, jamais masqué à tort")
func launchBannerFollowsTheLaunchCommand() {
    #expect(HomeText.launchBanner(title: "export", state: .awaitingAck) == "Lancement de « export »…")
    #expect(HomeText.launchBanner(title: "export", state: .taken) == "Pipeline « export » lancée : la collecte des besoins démarre.")
    #expect(HomeText.launchBanner(title: "!!!", state: .refused(reason: "contenu de feature vide ou illisible"))
        == "Lancement de « !!! » refusé : contenu de feature vide ou illisible")
    #expect(HomeText.launchBanner(title: "export", state: .refused(reason: nil)) == "Lancement de « export » refusé.")
    #expect(HomeText.launchBanner(title: "export", state: .unacknowledged)
        == "Lancement de « export » : \(ActionsText.unacknowledged)")

    let launch = ActionJournalEntry(id: "l1", kindLabel: ActionsText.launchLabel, targetLabel: "export", state: .taken, at: 2)
    let other = ActionJournalEntry(id: "s1", kindLabel: ActionsText.specsLabel, targetLabel: "x", state: .taken, at: 3)
    #expect(HomePresentation.launchBannerEntry(journal: [other, launch], dismissedID: nil)?.id == "l1")
    #expect(HomePresentation.launchBannerEntry(journal: [other, launch], dismissedID: "l1") == nil)
}
