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

@Test("audit-panel-in-omp-console-mac : les identifiants d’accessibilité de BR-3 sont ceux que posent les vues")
func auditAccessibilityIdentifiersMatchTheSpec() {
    #expect(AuditAccessibility.start == "audit.start")
    #expect(AuditAccessibility.row("a0d1700000000001") == "audit.row.a0d1700000000001")
    #expect(AuditAccessibility.orientation == "audit.orientation")
    #expect(AuditAccessibility.status == "audit.status")
    #expect(AuditAccessibility.stop == "audit.stop")
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
    let loading = auditWindow(AuditView(model: model))
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

    let window = auditWindow(AuditView(model: model))
    defer { window.close() }
    #expect((window.contentView?.fittingSize.height ?? 0) > 0)
    let detail = NSHostingView(rootView: AuditDetailView(model: model, card: card).frame(width: 640))
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

    let detail = NSHostingView(rootView: AuditDetailView(model: model, card: card).frame(width: 640))
    #expect(detail.fittingSize.height > 0)
}

@MainActor
@Test("audit-panel-in-omp-console-mac : une analyse en échec rend « L’analyse n’a rien proposé… » avec `failure` en diagnostic")
func failedAnalysisRendersReadableFailure() {
    let card = AuditCard(
        id: "a0d1700000000009", repoRoot: "/tmp/depot", repoName: "depot", orientation: "fiabilité",
        status: .failed, createdAt: 1, failure: "session d'analyse morte : code 1", briefDraft: nil,
        proposals: [], launches: [], features: [], escalations: [], decisions: []
    )
    #expect(AuditDetailContent.of(card) == .failed(ReadableFailure(message: AuditText.analysisFailed, diagnostic: "session d'analyse morte : code 1")))
    let model = offlineAuditModel(snapshots: [])
    let detail = NSHostingView(rootView: AuditDetailView(model: model, card: card).frame(width: 640))
    #expect(detail.fittingSize.height > 0)
}

// MARK: - AC-9 : survie

@MainActor
@Test("audit-panel-in-omp-console-mac/AC-9 : sans service, la section ouverte sur le magasin montre l’audit, la question en attente et les décisions, sans aucun appel au service")
func sectionReadsTheStoreWithoutService() async throws {
    let counter = ClientFactoryCounter()
    let model = offlineAuditModel(snapshots: [AuditParity.snapshot], counter: counter)
    let window = auditWindow(AuditView(model: model))
    defer { window.close() }
    #expect(await awaitProject { model.isLoaded })

    #expect(model.board.audits.map(\.id).sorted() == [AuditParity.launchedId, AuditParity.proposedId, AuditParity.analysingId])
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
    #expect(model.board.audits.count == 3)

    let window = auditWindow(AuditView(model: model))
    defer { window.close() }
    #expect((window.contentView?.fittingSize.height ?? 0) > 0)
}
