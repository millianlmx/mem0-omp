// Preuves de la SURFACE de la section Audit (audit-panel-in-omp-console S-6,
// BR-3) : chaque état (chargement, vide, propositions, suivi, échec) se dérive de
// l'ardoise et se REND dans une vraie `NSWindow` hors écran (`NSHostingView`), ce
// qui exécute les `ViewBuilder` sur le modèle réel.
//
// Sous `swift test`, SwiftUI ne construit pas l'arbre d'accessibilité d'une
// `NSHostingView` (constat de `DevicesSettingsTests`) : les identifiants se
// prouvent par `AuditAccessibility`, la seule table que les vues emploient ; la
// lecture AX de la fenêtre réelle est la capture de recette (BR-3, étape 6).

import AppKit
import ConsoleCore
import Foundation
import SwiftUI
import Testing
@testable import OMPConsole

/// Rend une vue dans une `NSWindow` hors écran et laisse SwiftUI s'installer
/// (patron `DevicesSettingsTests` ; `isReleasedWhenClosed = false` : sans lui,
/// `close()` sur-rend la fenêtre et le test suivant meurt).
@MainActor
private func auditWindow(_ view: some View) -> NSWindow {
    _ = NSApplication.shared
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 960, height: 640),
        styleMask: [.titled, .closable, .resizable],
        backing: .buffered,
        defer: false
    )
    window.isReleasedWhenClosed = false
    window.contentView = NSHostingView(rootView: view)
    RunLoop.main.run(until: Date().addingTimeInterval(0.25))
    return window
}

/// Compte les fabrications de client : une section qui ne fait que LIRE n'en
/// fabrique aucune.
private final class ClientFactoryCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var calls: Int { lock.withLock { count } }

    func make() throws -> ServiceClient {
        lock.withLock { count += 1 }
        throw ServiceUnavailable.stopped
    }
}

/// Un modèle sans service : le client ne se fabrique jamais (service arrêté),
/// les instantanés viennent du flux donné.
@MainActor
private func offlineAuditModel(
    snapshots: [StoreSnapshot],
    counter: ClientFactoryCounter = ClientFactoryCounter(),
    urlOpener: RecordingURLOpener = RecordingURLOpener()
) -> AuditConsoleModel {
    AuditConsoleModel(
        stateDir: "/tmp/omp-audit-absent",
        snapshots: {
            AsyncStream { continuation in
                for snapshot in snapshots { continuation.yield(snapshot) }
            }
        },
        makeClient: { try counter.make() },
        urlOpener: urlOpener,
        defaults: UserDefaults(suiteName: "audit-view-tests-\(UUID().uuidString)")!
    )
}

private var emptySnapshot: StoreSnapshot {
    var snapshot = AuditParity.snapshot
    snapshot.audits = .absent
    return snapshot
}

// MARK: - Identifiants

@Test("audit-panel-in-omp-console-mac, audit-ui-redesign-mac/AC-15 : les identifiants d’accessibilité conservés gardent leur valeur, les neufs sont ceux de S-13")
func auditAccessibilityIdentifiersMatchTheSpec() {
    #expect(AuditAccessibility.start == "audit.start")
    #expect(AuditAccessibility.list == "audit.list")
    #expect(AuditAccessibility.row("a0d1700000000001") == "audit.row.a0d1700000000001")
    #expect(AuditAccessibility.orientation == "audit.orientation")
    #expect(AuditAccessibility.stop == "audit.stop")
    #expect(AuditAccessibility.analysing == "audit.analysing")
    #expect(AuditAccessibility.checkedCount == "audit.checkedCount")
    #expect(AuditAccessibility.progress == "audit.progress")
    #expect(AuditAccessibility.notLaunched("tableau-fiabilite") == "audit.notLaunched.tableau-fiabilite")
    #expect(AuditAccessibility.escalations == "audit.escalations")
    #expect(AuditAccessibility.decision(0) == "audit.decision.0")
    #expect(AuditAccessibility.analysisFailed == "audit.analysisFailed")
    #expect(AuditAccessibility.analysisDiagnostic == "audit.analysisFailed.diagnostic")
    #expect(AuditAccessibility.loading == "audit.loading")
    #expect(AuditAccessibility.emptyStart == "audit.empty.start")
    #expect([AuditAccessibility.failure, AuditAccessibility.failureDiagnostic, AuditAccessibility.retry]
        == ["audit.failure", "audit.failure.diagnostic", "audit.retry"])
    // Neufs (S-3, S-6, S-7, S-9, S-10, S-11).
    #expect(AuditAccessibility.rowMenu("a0d1700000000001", .copyPath("/tmp/depot")) == "audit.row.a0d1700000000001.copyPath")
    #expect(AuditAccessibility.rowMenu("a0d1700000000001", .openInProject) == "audit.row.a0d1700000000001.openProject")
    #expect(AuditAccessibility.rowMenu("a0d1700000000001", .stop) == "audit.row.a0d1700000000001.stop")
    #expect([AuditAccessibility.headerMenu(.copyPath("/tmp/depot")), AuditAccessibility.headerMenu(.openInProject), AuditAccessibility.headerMenu(.stop)]
        == ["audit.menu.copyPath", "audit.menu.openProject", "audit.menu.stop"])
    #expect(AuditAccessibility.menu == "audit.menu")
    #expect(AuditAccessibility.orientationToggle == "audit.orientation.toggle")
    #expect(AuditAccessibility.stepper == "audit.stepper")
    #expect([AuditAccessibility.proposalsWeaknesses, AuditAccessibility.proposalsFeatures] == ["audit.proposals.weaknesses", "audit.proposals.features"])
    #expect(AuditAccessibility.notLaunchedGroup == "audit.notLaunched")
    #expect(AuditAccessibility.stoppedEmpty == "audit.stoppedEmpty")
    #expect(AuditAccessibility.relaunch == "audit.relaunch")
    #expect(AuditAccessibility.proposal("cache-demarrage") == "audit.proposal.cache-demarrage")
    #expect(AuditAccessibility.reviewBrief == "audit.reviewBrief")
    #expect(AuditAccessibility.feature("rapport-erreurs") == "audit.feature.rapport-erreurs")
    #expect(AuditAccessibility.featurePR("rapport-erreurs") == "audit.feature.rapport-erreurs.pr")
    #expect(AuditAccessibility.decisions == "audit.decisions")
    #expect([
        AuditAccessibility.launchRepository, AuditAccessibility.launchChoose, AuditAccessibility.launchOrientation,
        AuditAccessibility.launchCancel, AuditAccessibility.launchCommit,
    ] == ["audit.launch.repository", "audit.launch.choose", "audit.launch.orientation", "audit.launch.cancel", "audit.launch.commit"])
    #expect([
        AuditAccessibility.briefEditor, AuditAccessibility.briefError, AuditAccessibility.briefCancel, AuditAccessibility.briefCommit,
    ] == ["audit.brief.editor", "audit.brief.error", "audit.brief.cancel", "audit.brief.commit"])
    #expect(AuditAccessibility.escalation("reprise-pipeline") == "audit.escalation.reprise-pipeline")
    #expect(AuditAccessibility.escalationText("reprise-pipeline") == "audit.escalation.reprise-pipeline.text")
    #expect(AuditAccessibility.escalationAnswer("reprise-pipeline") == "audit.escalation.reprise-pipeline.answer")
}

// MARK: - États

@MainActor
@Test("audit-panel-in-omp-console-mac : chargement puis vide — magasin non lu, puis aucun audit, la section se rend")
func loadingThenEmptyStatesRender() async {
    let model = offlineAuditModel(snapshots: [emptySnapshot])
    #expect(!model.isLoaded)
    let loading = auditWindow(AuditView(model: model, openInProject: { _ in }))
    defer { loading.close() }
    #expect(await awaitProject { model.isLoaded })
    #expect(model.board.audits.isEmpty)
    #expect(model.selection == nil)
    #expect((loading.contentView?.fittingSize.width ?? 0) > 0)
}

@MainActor
@Test("audit-panel-in-omp-console-mac : propositions — faiblesses puis features, la proposition déjà dans le lot est désactivée, le détail se rend")
func proposedStateRendersWithTakenDisabled() throws {
    let model = offlineAuditModel(snapshots: [])
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.proposedId
    let card = try #require(model.selectedCard)
    guard case let .proposals(weaknesses, features) = AuditDetailContent.of(card) else {
        Issue.record("un audit proposed rend ses cases")
        return
    }
    #expect(weaknesses.map(\.slug) == ["relecture-complete", "cache-ignore"])
    #expect(features.map(\.slug) == ["cache-demarrage", "index-sessions", "mesure-demarrage"])
    #expect(features.filter(\.taken).map(\.slug) == ["cache-demarrage"])
    #expect(!model.canReviewBrief(card))

    let window = auditWindow(AuditView(model: model, openInProject: { _ in }))
    defer { window.close() }
    #expect((window.contentView?.fittingSize.height ?? 0) > 0)
    let detail = NSHostingView(rootView: AuditDetailView(model: model, viewState: AuditViewState(), card: card, openInProject: { _ in }).frame(width: 640))
    #expect(detail.fittingSize.height > 0)
    // Les deux feuilles se rendent sur le même modèle.
    model.setChecked("relecture-complete", in: card.id, true)
    model.presentBrief()
    #expect(model.isBriefSheetPresented)
    #expect(NSHostingView(rootView: AuditBriefSheet(model: model)).fittingSize.height > 0)
    model.cancelBrief()
    #expect(NSHostingView(rootView: AuditLaunchSheet(model: model)).fittingSize.height > 0)
}

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-7 : l’avancement montre chaque feature avec sa phase, son libellé d’attente et « Ouvrir la PR » quand une PR existe")
func followUpRowsCarryPhaseWaitingAndPR() throws {
    let opener = RecordingURLOpener()
    let model = offlineAuditModel(snapshots: [], urlOpener: opener)
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.launchedId
    let card = try #require(model.selectedCard)
    #expect(AuditDetailContent.of(card) == .followUp)

    let rows = Dictionary(uniqueKeysWithValues: card.features.map { ($0.slug, $0) })
    #expect(rows["journal-erreurs"]?.phase == .impl)
    #expect(rows["journal-erreurs"].map { AuditText.waiting($0.waiting) } == AuditText.waitingRunning)
    #expect(rows["reprise-pipeline"].map { AuditText.waiting($0.waiting) } == AuditText.waitingEscalated)
    #expect(rows["alerte-quota"].map { AuditText.waiting($0.waiting) } == AuditText.waitingCancelled)
    let withPR = try #require(rows["rapport-erreurs"])
    #expect(AuditText.waiting(withPR.waiting) == AuditText.waitingPRCreated)
    #expect(card.features.filter { $0.prUrl != nil }.map(\.slug) == ["rapport-erreurs"])
    // Les non lancées sont listées avec leur motif.
    #expect(card.launches.map(\.slug) == ["tableau-fiabilite"])
    #expect(card.launches.first?.reason != nil)

    // « Ouvrir la PR » passe par l'ouvreur injecté.
    model.openPR(withPR)
    #expect(opener.opened == [URL(string: "https://example.com/pr/7")!])

    let detail = NSHostingView(rootView: AuditDetailView(model: model, viewState: AuditViewState(), card: card, openInProject: { _ in }).frame(width: 640))
    #expect(detail.fittingSize.height > 0)
}

@MainActor
@Test("audit-panel-in-omp-console-mac : une analyse en échec rend sa phrase d’échec lisible, le diagnostic complet à copier")
func failedAnalysisRendersReadableFailure() {
    let card = AuditCard(
        id: "a0d1700000000009", repoRoot: "/tmp/depot", repoKey: "0123456789abcdef", repoName: "depot", orientation: "fiabilité",
        status: .failed, createdAt: 1, failure: "session d'analyse morte : code 1", briefDraft: nil,
        proposals: [], launches: [], features: [], escalations: [], decisions: []
    )
    #expect(AuditDetailContent.of(card) == .failed(ReadableFailure(
        message: "Session d'analyse morte : code 1.",
        diagnostic: AuditPresentation.diagnostic(card)
    )))
    let model = offlineAuditModel(snapshots: [])
    let detail = NSHostingView(rootView: AuditDetailView(model: model, viewState: AuditViewState(), card: card, openInProject: { _ in }).frame(width: 640))
    #expect(detail.fittingSize.height > 0)
}

// MARK: - AC-9 : survie

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-9 : sans service, la section ouverte sur le magasin montre l’audit, la question en attente et les décisions, sans aucun appel au service")
func sectionReadsTheStoreWithoutService() async throws {
    let counter = ClientFactoryCounter()
    let model = offlineAuditModel(snapshots: [AuditParity.snapshot], counter: counter)
    let window = auditWindow(AuditView(model: model, openInProject: { _ in }))
    defer { window.close() }
    #expect(await awaitProject { model.isLoaded })

    #expect(model.board.audits.map(\.id).sorted() == [AuditParity.launchedId, AuditParity.proposedId, AuditParity.analysingId, AuditParity.stoppedId, AuditParity.failedId])
    model.selection = AuditParity.launchedId
    let card = try #require(model.selectedCard)
    #expect(card.escalations.map(\.slug) == ["reprise-pipeline"])
    #expect(card.escalations.first?.options.count == 2)
    #expect(card.decisions.count == 3)
    // Antéchronologique, chaque source en mots.
    #expect(card.decisions.map(\.at) == card.decisions.map(\.at).sorted(by: >))
    #expect(card.decisions.map { AuditText.source($0.source) } == [AuditText.sourceArbitrage, AuditText.sourceArbitrage, AuditText.sourceContexte])
    try? await Task.sleep(for: .milliseconds(100))

    // Quitter n'appelle aucune route d'audit : l'arrêt du modèle ne fabrique
    // aucun client.
    model.stop()
    #expect(counter.calls == 0)
    #expect(model.failure == nil)
}

@MainActor
@Test("audit-panel-in-omp-console-mac : un geste sans service pose le bandeau « service arrêté » ; la lecture du magasin reste affichée")
func serviceDownBannerKeepsTheStoreVisible() async {
    let counter = ClientFactoryCounter()
    let model = offlineAuditModel(snapshots: [], counter: counter)
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.launchedId
    model.requestStop()
    #expect(await model.confirmStop() == false)
    #expect(counter.calls == 1)
    #expect(model.serviceDown)
    #expect(model.failure?.message == AuditText.stopFailed)
    #expect(model.failure?.diagnostic == ServiceUnavailable.stopped.userMessage)
    #expect(model.board.audits.count == 5)

    let window = auditWindow(AuditView(model: model, openInProject: { _ in }))
    defer { window.close() }
    #expect((window.contentView?.fittingSize.height ?? 0) > 0)
}

// MARK: - audit-ui-redesign (BR-2, Mac)

/// La première `NSTableView` d'une hiérarchie : la `List` SwiftUI en est servie
/// (`SwiftUIOutlineListView`, Doc-6).
@MainActor
private func firstTable(in view: NSView?) -> NSTableView? {
    guard let view else { return nil }
    if let table = view as? NSTableView { return table }
    for sub in view.subviews {
        if let table = firstTable(in: sub) { return table }
    }
    return nil
}

/// Une ardoise déjà lue, l'audit `selection` sélectionné.
@MainActor
private func loadedAuditModel(_ snapshot: StoreSnapshot = AuditParity.snapshot, selection: String?) -> AuditConsoleModel {
    let model = offlineAuditModel(snapshots: [])
    model.apply(snapshot)
    model.selection = selection
    return model
}

/// La fixture, les audits `ids` retirés.
private func snapshot(removing ids: Set<String>) -> StoreSnapshot {
    var snapshot = AuditParity.snapshot
    snapshot.audits.records.removeAll { ids.contains($0.id) }
    return snapshot
}

/// La fixture, le statut de l'audit `id` remplacé.
private func snapshot(_ id: String, status: AuditStatus) -> StoreSnapshot {
    var snapshot = AuditParity.snapshot
    if let index = snapshot.audits.records.firstIndex(where: { $0.id == id }) {
        snapshot.audits.records[index].status = status
    }
    return snapshot
}

private func states(_ steps: [PipelineStep]) -> [PipelineStepState] {
    steps.map(\.state)
}

@MainActor
@Test("audit-ui-redesign-mac/AC-1 : la barre d’outils de la section porte « Nouvel audit » (libellé visible, symbole text.magnifyingglass) et aucun « plus » ; le geste ouvre la feuille de lancement")
func newAuditToolbarButtonOpensTheLaunchSheet() {
    let model = loadedAuditModel(selection: AuditParity.launchedId)
    _ = NSApplication.shared
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 960, height: 640),
        styleMask: [.titled, .closable, .resizable],
        backing: .buffered,
        defer: false
    )
    window.isReleasedWhenClosed = false
    defer { window.close() }
    let hosting = NSHostingView(rootView: AuditView(model: model, openInProject: { _ in }))
    // La barre d'outils SwiftUI n'est remise à la fenêtre que si l'hôte la relaie.
    hosting.sceneBridgingOptions = [.toolbars]
    window.contentView = hosting
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))

    let items = window.toolbar?.items ?? []
    let labelled = items.filter { $0.label == AuditText.newAudit }
    #expect(labelled.count == 1, "un seul bouton « Nouvel audit » : \(items.map(\.label))")
    #expect(!items.contains { $0.label == AuditText.startAudit }, "plus de bouton « Lancer un audit… » en icône")
    let plus = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)?.tiffRepresentation
    #expect(!items.contains { $0.image?.tiffRepresentation == plus && plus != nil }, "aucun « plus » dans la barre de la section")
    if let item = labelled.first {
        #expect(item.isEnabled)
        #expect(item.toolTip == AuditText.startAudit)
    }

    #expect(!model.isLaunchSheetPresented)
    model.presentLaunchSheet()
    #expect(model.isLaunchSheetPresented)
}

@MainActor
@Test("audit-ui-redesign-mac/AC-2 : la liste rendue montre « En cours » (3 audits) puis « Terminés » (2 audits) ; une section sans audit n’est pas rendue")
func listRendersRunningThenFinishedSections() throws {
    let model = loadedAuditModel(selection: AuditParity.launchedId)
    let sections = AuditPresentation.sections(model.board)
    #expect(sections.map(\.title) == [AuditText.sectionRunning, AuditText.sectionFinished])
    #expect(Set(sections[0].cards.map(\.id)) == [AuditParity.analysingId, AuditParity.proposedId, AuditParity.launchedId])
    #expect(Set(sections[1].cards.map(\.id)) == [AuditParity.stoppedId, AuditParity.failedId])
    let window = auditWindow(AuditView(model: model, openInProject: { _ in }))
    defer { window.close() }
    let table = try #require(firstTable(in: window.contentView))
    // 5 rangées d'audit + 2 en-têtes de section.
    #expect(table.numberOfRows == 7)

    let running = loadedAuditModel(snapshot(removing: [AuditParity.stoppedId, AuditParity.failedId]), selection: AuditParity.launchedId)
    #expect(AuditPresentation.sections(running.board).map(\.kind) == [.running])
    let runningWindow = auditWindow(AuditView(model: running, openInProject: { _ in }))
    defer { runningWindow.close() }
    let runningTable = try #require(firstTable(in: runningWindow.contentView))
    // 3 rangées + 1 seul en-tête : « Terminés » n'est pas rendu.
    #expect(runningTable.numberOfRows == 4)
}

@MainActor
@Test("audit-ui-redesign-mac/AC-3 : une rangée à orientation longue et 2 questions tient sur 2 lignes d’orientation et 1 ligne de légende ; le dépôt n’est que dans la légende")
func rowClampsOrientationAndCaption() throws {
    let base = try #require(AuditParity.board.card(id: AuditParity.launchedId))
    var long = base
    long.orientation = String(repeating: "robustesse du service OMP et reprise des pipelines ", count: 20)
    long.escalations = base.escalations + base.escalations.map { var other = $0; other.key += ".2"; return other }
    #expect(long.escalations.count == 2)
    var short = base
    short.orientation = "fiabilité"

    let longHeight = NSHostingView(rootView: AuditListRow(card: long, briefReviewOpen: false).frame(width: 240)).fittingSize.height
    let shortHeight = NSHostingView(rootView: AuditListRow(card: short, briefReviewOpen: false).frame(width: 240)).fittingSize.height
    // Une ligne d'orientation de plus au plus (≈ 16 pt), jamais les ~20 lignes du texte entier.
    #expect(longHeight > shortHeight)
    #expect(longHeight - shortHeight < 24, "orientation bornée à 2 lignes : \(shortHeight) → \(longHeight)")

    let caption = AuditPresentation.rowCaption(long, briefReviewOpen: false, nowMs: long.createdAt + 180_000)
    #expect(caption.components(separatedBy: long.repoName).count == 2, "le dépôt une seule fois dans la légende")
    #expect(!long.orientation.contains(long.repoName))
    // La relecture ouverte pour CETTE carte fait dire « Brief » à la légende.
    let proposed = try #require(AuditParity.board.card(id: AuditParity.proposedId))
    #expect(AuditPresentation.rowCaption(proposed, briefReviewOpen: true, nowMs: proposed.createdAt).contains(AuditText.stepTitles[2]))
}

@MainActor
@Test("audit-ui-redesign-mac/AC-4 : la colonne de liste est une NSTableView de style inset (pas une barre latérale) large de 220 à 260 pt")
func listColumnIsInsetAndBounded() throws {
    let model = loadedAuditModel(selection: AuditParity.launchedId)
    let window = auditWindow(AuditView(model: model, openInProject: { _ in }))
    defer { window.close() }
    RunLoop.main.run(until: Date().addingTimeInterval(0.5))
    let table = try #require(firstTable(in: window.contentView))
    #expect(table.style == .inset)
    #expect(table.style != .sourceList)
    let width = try #require(table.enclosingScrollView?.frame.width)
    #expect((220...260).contains(width), "largeur mesurée : \(width)")
}

@MainActor
@Test("audit-ui-redesign-mac/AC-5 : « Ouvrir dans Projet » bascule sur Projet et prépare le pilotage de ce dépôt ; « Copier le chemin » copie le chemin complet ; « Arrêter l’audit… » confirmé poste DELETE et l’audit rejoint « Terminés »")
func menuGesturesCopyOpenAndStop() async throws {
    let card = try #require(AuditParity.board.card(id: AuditParity.launchedId))

    // Ouvrir dans Projet, sans pilotage en cours : la feuille préremplie.
    let console = ConsoleModel()
    let stateDir = (NSTemporaryDirectory() as NSString).appendingPathComponent("omp-audit-project-\(UUID().uuidString)")
    let project = makeProjectModel(host: ServiceSessionModel(purpose: "project", makeClient: { throw ServiceUnavailable.stopped }), stateDir: stateDir)
    #expect(console.selection != .project)
    AuditProjectBridge.open(card, console: console, project: project)
    #expect(console.selection == .project)
    #expect(project.draftRepository?.path == card.repoRoot)
    #expect(project.draftName == card.repoName)
    #expect(project.isLaunchSheetPresented)

    // Copier le chemin : le chemin COMPLET, sur un presse-papiers privé.
    let menu = AuditPresentation.menu(for: card)
    #expect(menu == [.copyPath(card.repoRoot), .openInProject, .stop])
    guard case let .copyPath(path) = menu[0] else {
        Issue.record("la première entrée copie le chemin")
        return
    }
    let pasteboard = NSPasteboard(name: NSPasteboard.Name("audit-ui-redesign-\(UUID().uuidString)"))
    defer { pasteboard.releaseGlobally() }
    DiagnosticPasteboard.copy(path, to: pasteboard)
    #expect(pasteboard.string(forType: .string) == card.repoRoot)

    // Arrêter : l'entrée pose la confirmation existante, confirmée → DELETE.
    let transport = ScriptedServiceTransport()
    transport.stubJSON("DELETE", "/v1/audits/\(card.id)", ["cancelled": ["journal-erreurs"], "kept": ["rapport-erreurs"], "refused": []])
    let model = AuditConsoleModel(
        stateDir: "/tmp/omp-audit-absent",
        snapshots: { AsyncStream { $0.finish() } },
        makeClient: { scriptedClient(transport) },
        urlOpener: RecordingURLOpener(),
        defaults: UserDefaults(suiteName: "audit-ui-redesign-\(UUID().uuidString)")!
    )
    model.apply(AuditParity.snapshot)
    model.pendingStop = card.id
    #expect(await model.confirmStop())
    #expect(transport.requests.map(\.method) == ["DELETE"])
    #expect(transport.requests.first?.path.hasSuffix("/v1/audits/\(card.id)") == true)
    // L'instantané suivant le dit arrêté : il passe sous « Terminés », sans « Arrêter ».
    model.apply(snapshot(card.id, status: .stopped))
    let finished = AuditPresentation.sections(model.board).first { $0.kind == .finished }
    #expect(finished?.cards.map(\.id).contains(card.id) == true)
    let stopped = try #require(model.board.card(id: card.id))
    #expect(!AuditPresentation.menu(for: stopped).contains(.stop))
}

@MainActor
@Test("audit-ui-redesign-mac/AC-6 : la rangée Audit de la barre latérale porte le nombre d’audits qui attendent l’utilisateur ; 0 → aucun badge")
func sidebarBadgesAuditsAwaitingTheUser() {
    let model = loadedAuditModel(selection: nil)
    // proposed + launched à 1 question ; analysing sans question ne compte pas.
    #expect(model.board.awaitingUserCount == 2)
    #expect(HomePresentation.sidebarBadge(for: .audit, attention: 3, auditsAwaiting: model.board.awaitingUserCount) == 2)
    #expect(HomePresentation.sidebarBadge(for: .home, attention: 3, auditsAwaiting: 2) == 3)
    for section in ConsoleSection.allCases where section != .home && section != .audit {
        #expect(HomePresentation.sidebarBadge(for: section, attention: 3, auditsAwaiting: 2) == 0)
    }
    #expect(HomePresentation.sidebarBadge(for: .audit, attention: 0, auditsAwaiting: -1) == 0)

    // Questions répondues et propositions lancées : plus rien n'attend.
    var resolved = snapshot(AuditParity.proposedId, status: .launched)
    resolved.lots.lots = resolved.lots.lots.map { lot in
        var lot = lot
        lot.features = lot.features.map { var feature = $0; feature.escalation = nil; return feature }
        return lot
    }
    model.apply(resolved)
    #expect(model.board.awaitingUserCount == 0)
    #expect(HomePresentation.sidebarBadge(for: .audit, attention: 0, auditsAwaiting: model.board.awaitingUserCount) == 0)
}

@MainActor
@Test("audit-ui-redesign-mac/AC-8 : l’en-tête lit « dépôt · lancé à HH:MM » ; une orientation de plus de 2 lignes est détectée tronquée et « Afficher l’orientation complète » la déplie")
func headerCaptionAndOrientationToggle() throws {
    let model = loadedAuditModel(selection: AuditParity.failedId)
    let failed = try #require(model.selectedCard)
    #expect(AuditPresentation.headerCaption(failed) == AuditText.headerCaption(repo: failed.repoName, time: ConsoleFormat.time(ms: failed.createdAt)))
    #expect(!AuditPresentation.headerCaption(failed).contains(AuditText.status(failed.status)))

    let state = AuditViewState()
    let detail = { (card: AuditCard) in
        AuditDetailView(model: model, viewState: state, card: card, openInProject: { _ in }).frame(width: 480)
    }
    let window = auditWindow(detail(failed))
    defer { window.close() }
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    #expect(state.truncatedOrientations.contains(failed.id), "l’orientation de \(failed.orientation.count) caractères dépasse 2 lignes")
    #expect(state.offersOrientationToggle(failed.id))
    let collapsed = NSHostingView(rootView: detail(failed)).fittingSize.height
    state.toggleOrientation(failed.id)
    #expect(state.isOrientationExpanded(failed.id))
    let expanded = NSHostingView(rootView: detail(failed)).fittingSize.height
    #expect(expanded > collapsed, "dépliée, l’orientation entière s’affiche : \(collapsed) → \(expanded)")
    state.toggleOrientation(failed.id)
    #expect(!state.isOrientationExpanded(failed.id))

    // Une orientation courte n'offre aucun dépliage.
    let analysing = try #require(model.board.card(id: AuditParity.analysingId))
    let shortWindow = auditWindow(detail(analysing))
    defer { shortWindow.close() }
    RunLoop.main.run(until: Date().addingTimeInterval(0.3))
    #expect(!state.truncatedOrientations.contains(analysing.id))
    #expect(!state.offersOrientationToggle(analysing.id))
}

@MainActor
@Test("audit-ui-redesign-mac/AC-10 : la frise rendue pour chaque audit est exactement celle de la fonction pure")
func stepperMatchesThePureSteps() throws {
    let model = loadedAuditModel(selection: nil)
    let expected: [String: (AuditProgressInput, [PipelineStepState])] = [
        AuditParity.analysingId: (.analysing, [.current, .upcoming, .upcoming, .upcoming]),
        AuditParity.proposedId: (.proposed(briefReviewOpen: false), [.done, .current, .upcoming, .upcoming]),
        AuditParity.launchedId: (.launched(pipelinesFinished: false), [.done, .done, .done, .current]),
        AuditParity.stoppedId: (.stopped(during: .proposals), [.done, .upcoming, .upcoming, .upcoming]),
        AuditParity.failedId: (.failed(at: .analysis), [.failed, .upcoming, .upcoming, .upcoming]),
    ]
    for card in model.board.audits {
        let (input, want) = try #require(expected[card.id])
        model.selection = card.id
        let rendered = AuditDetailView.stepperSteps(card, model: model)
        #expect(rendered == AuditPresentation.steps(input), "\(card.id)")
        #expect(states(rendered) == want, "\(card.id)")
        #expect(rendered.map(\.title) == AuditText.stepTitles)
        let view = NSHostingView(rootView: AuditDetailView(model: model, viewState: AuditViewState(), card: card, openInProject: { _ in }).frame(width: 640))
        #expect(view.fittingSize.height > 0)
    }
}

@MainActor
@Test("audit-ui-redesign-mac/AC-11 : la carte d’analyse montre une durée qui augmente, la phrase sur la suite, « Arrêter l’audit… » discret ; « Analyse en cours » n’apparaît qu’une fois dans le détail")
func analysisCardShowsGrowingElapsedOnce() throws {
    let nowMs = 1_700_000_000_000.0
    let model = loadedAuditModel(AuditParity.snapshot(nowMs: nowMs), selection: AuditParity.analysingId)
    let card = try #require(model.selectedCard)
    #expect(AuditDetailContent.of(card) == .analysing)

    let first = AuditText.analysisElapsed(AuditPresentation.elapsed(ms: nowMs - card.createdAt))
    let later = AuditText.analysisElapsed(AuditPresentation.elapsed(ms: nowMs + 3_000 - card.createdAt))
    #expect(first == AuditText.analysisElapsed("1:05"))
    #expect(later == AuditText.analysisElapsed("1:08"))

    // Tous les textes affichés par le détail d'un audit analysing (en-tête, menu,
    // frise, carte) : seul `analysisElapsed` dit « Analyse en cours ».
    let marker = "Analyse en cours"
    let others = [
        AuditPresentation.headerCaption(card), card.orientation,
        AuditText.showFullOrientation, AuditText.hideFullOrientation,
        AuditText.moreActions, AuditText.copyPath, AuditText.openInProject,
        AuditText.analysisCardTitle, AuditText.analysisNext, AuditText.stopAudit,
    ] + AuditDetailView.stepperSteps(card, model: model).map(\.title)
    #expect(others.allSatisfy { !$0.contains(marker) }, "\(others.filter { $0.contains(marker) })")
    #expect(later.components(separatedBy: marker).count == 2)

    let window = auditWindow(AuditDetailView(model: model, viewState: AuditViewState(), card: card, openInProject: { _ in }).frame(width: 640))
    defer { window.close() }
    #expect((window.contentView?.fittingSize.height ?? 0) > 0)
    // Le bouton discret pose la confirmation existante.
    model.requestStop()
    #expect(model.pendingStop == card.id)
}

@MainActor
@Test("audit-ui-redesign-mac/AC-12 : cartes Faiblesses et Features, « après X », « déjà prise » ; cocher 2 → « 2 cochées » ; « Relire le brief → » met Brief en cours, fermer sans lancer ramène Propositions")
func proposalsCardsCountAndBriefStep() throws {
    let model = loadedAuditModel(selection: AuditParity.proposedId)
    let card = try #require(model.selectedCard)
    guard case let .proposals(weaknesses, features) = AuditDetailContent.of(card) else {
        Issue.record("un audit proposed rend ses deux cartes")
        return
    }
    #expect(!weaknesses.isEmpty && !features.isEmpty)
    let dependent = try #require(features.first { !$0.deps.isEmpty })
    #expect(AuditText.after(dependent.deps) == AuditText.after(["cache-demarrage"]))
    #expect(features.filter(\.taken).map(\.slug) == ["cache-demarrage"])

    #expect(AuditText.checkedCount(model.checkedCount(of: card)) == AuditText.checkedCount(0))
    model.setChecked("relecture-complete", in: card.id, true)
    model.setChecked("index-sessions", in: card.id, true)
    model.setChecked("cache-demarrage", in: card.id, true)
    #expect(model.checkedCount(of: card) == 2, "la proposition déjà prise ne se coche pas")
    #expect(AuditText.checkedCount(model.checkedCount(of: card)) == "2 cochées")
    model.setChecked("index-sessions", in: card.id, false)
    #expect(AuditText.checkedCount(model.checkedCount(of: card)) == "1 cochée")
    model.setChecked("index-sessions", in: card.id, true)

    // La barre se rend sur l'audit proposé (posée en `safeAreaInset` par AuditView).
    #expect(NSHostingView(rootView: AuditProposalsBar(model: model, card: card).frame(width: 640)).fittingSize.height > 0)
    let window = auditWindow(AuditView(model: model, openInProject: { _ in }))
    defer { window.close() }

    #expect(states(AuditDetailView.stepperSteps(card, model: model)) == [.done, .current, .upcoming, .upcoming])
    model.presentBrief()
    #expect(model.isBriefSheetPresented)
    #expect(states(AuditDetailView.stepperSteps(card, model: model)) == [.done, .done, .current, .upcoming])
    model.cancelBrief()
    #expect(states(AuditDetailView.stepperSteps(card, model: model)) == [.done, .current, .upcoming, .upcoming])
}

@MainActor
@Test("audit-ui-redesign-mac/AC-13 : questions d’abord, puis avancement (barre et attente, « Ouvrir la PR »), non lancées avec motif, décisions repliées dans un groupe qui affiche leur nombre")
func pipelinesBodyOrderAndFoldedDecisions() throws {
    let model = loadedAuditModel(selection: AuditParity.launchedId)
    let card = try #require(model.selectedCard)
    #expect(AuditDetailContent.of(card) == .followUp)
    #expect(AuditPresentation.followUpBlocks(card) == [.escalations, .progress, .notLaunched, .decisions])
    #expect(card.features.allSatisfy { AuditPresentation.featureSteps($0).count == KanbanText.progressSteps.count })
    #expect(card.features.filter { $0.prUrl != nil }.map(\.slug) == ["rapport-erreurs"])
    #expect(card.launches.map(\.slug) == ["tableau-fiabilite"] && card.launches[0].reason != nil)
    #expect(AuditText.decisionsGroupTitle(card.decisions.count) == AuditText.decisionsGroupTitle(3))

    // Replié par défaut : le déplier allonge le détail rendu.
    let state = AuditViewState()
    #expect(!state.decisionsExpanded(card.id).wrappedValue)
    let render = { AuditDetailView(model: model, viewState: state, card: card, openInProject: { _ in }).frame(width: 640) }
    let folded = NSHostingView(rootView: render()).fittingSize.height
    state.decisionsExpanded(card.id).wrappedValue = true
    let unfolded = NSHostingView(rootView: render()).fittingSize.height
    #expect(unfolded > folded, "décisions dépliées : \(folded) → \(unfolded)")

    // Un audit arrêté avant tout lancement : l'état vide, sans autre bloc.
    let stopped = try #require(model.board.card(id: AuditParity.stoppedId))
    #expect(AuditDetailContent.of(stopped) == .stoppedBeforeLaunch)
}

@MainActor
@Test("audit-ui-redesign-mac/AC-14 : un audit en échec montre sa phrase d’échec ; « Relancer avec la même orientation » poste le même dépôt et la même orientation, sélectionne le nouvel audit, l’échoué reste dans « Terminés »")
func failedAuditRelaunchesWithTheSameOrientation() async throws {
    let newId = "a0d17000000000aa"
    let transport = ScriptedServiceTransport()
    transport.stubJSON("POST", "/v1/audits", ["id": newId, "status": "analysing"])
    let model = AuditConsoleModel(
        stateDir: "/tmp/omp-audit-absent",
        snapshots: { AsyncStream { $0.finish() } },
        makeClient: { scriptedClient(transport) },
        urlOpener: RecordingURLOpener(),
        defaults: UserDefaults(suiteName: "audit-ui-redesign-\(UUID().uuidString)")!
    )
    model.apply(AuditParity.snapshot)
    model.selection = AuditParity.failedId
    let card = try #require(model.selectedCard)
    guard case let .failed(failure) = AuditDetailContent.of(card) else {
        Issue.record("un audit failed rend l’état d’échec")
        return
    }
    #expect(failure.message == AuditPresentation.failureSentence(card.failure))
    #expect(failure.message != AuditText.failureUnknown)
    #expect(failure.diagnostic == AuditPresentation.diagnostic(card))

    // Le geste du bouton « Relancer avec la même orientation ».
    #expect(await model.submitStart(repoRoot: card.repoRoot, orientation: card.orientation))
    let requests = transport.requests
    #expect(requests.count == 1)
    #expect(requests.first?.method == "POST")
    #expect(requests.first?.path.hasSuffix("/v1/audits") == true)
    #expect(requests.first?.body?["repo"] as? String == card.repoRoot)
    #expect(requests.first?.body?["orientation"] as? String == card.orientation)
    #expect(model.selection == newId)
    model.apply(AuditParity.snapshot)
    let finished = AuditPresentation.sections(model.board).first { $0.kind == .finished }
    #expect(finished?.cards.map(\.id).contains(AuditParity.failedId) == true)
    #expect(model.board.card(id: AuditParity.failedId)?.status == .failed)
}
