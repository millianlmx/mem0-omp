// Preuves de S-5 (all-in-one-app, BR-5 ; omp-console-sans-podman S-5) : la chaîne
// de préparation (composants → migration → service mémoire → oMLX), ses échecs
// typés, l'attente d'un choix devant des rejets, la reprise, la non-réentrance,
// et le fait que la feuille se pilote sans interrompre le travail.
//
// Les machines sont des DOUBLURES injectées : aucun réseau, aucun binaire,
// aucun conteneur ; les preuves de bout en bout câblent les VRAIS `PodmanLegacy`
// et `MemoryAgent` sur leurs doublures de commandes (jamais launchd, podman ni
// les ports 8321/6333 réels).

import AppKit
import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

/// Ce que la préparation a émis, dans l'ordre — et l'état du modèle au moment de
/// chaque émission. (Nom préfixé : `Recorder` existe déjà dans `TestWaiting`.)
@MainActor
private final class SetupRecorder {
    weak var model: SetupModel?
    var states: [SetupState] = []
    var installSteps: [ComponentInstallStep] = []
    var migrationSteps: [MigrationStep] = []
    var agentSteps: [AgentStep] = []
    /// Le journal des appels : `install`, `migrate`, `switchOver`, `ensureAgent`.
    var calls: [String] = []
    var installCalls = 0
    var onReadyCalls = 0
    var installError: ComponentInstallError?
    var migrationError: PodmanMigrationError?
    var migrationOutcome: PodmanMigrationOutcome = .switched
    var agentError: MemoryAgentError?
    var unexpectedAgentError: Error?
    var switchOverError: PodmanMigrationError?
    /// Les rapports reçus par `switchOver`.
    var switchedReports: [ImportReport] = []
    var omlx: OMLXStatus = .reachable
    var gate: Gate?
    /// Le binaire d'OMP « placé » au rappel `.ompInstall` (résolveur fictif).
    var placesOmp: OmpSwitch?

    func count(_ name: String) -> Int { calls.filter { $0 == name }.count }

    func record() {
        if let model { states.append(model.state) }
    }

    func install(_ progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws {
        installCalls += 1
        calls.append("install")
        record()
        if let gate { await gate.wait() }
        if let installError { throw installError }
        let steps: [ComponentInstallStep] = [
            .omp(downloaded: 0, total: 100),
            .omp(downloaded: 100, total: 100),
            .ompInstall,
        ]
        for step in steps {
            installSteps.append(step)
            if case .ompInstall = step { placesOmp?.present = true }
            progress(step)
            record()
            await Task.yield()
        }
    }

    func migrate(_ progress: @escaping @MainActor (MigrationStep) -> Void) async throws -> PodmanMigrationOutcome {
        calls.append("migrate")
        if let migrationError { throw migrationError }
        for step in [MigrationStep.start, .importing, .stop] {
            migrationSteps.append(step)
            progress(step)
            record()
            await Task.yield()
        }
        return migrationOutcome
    }

    func switchOver(_ report: ImportReport, _ progress: @escaping @MainActor (MigrationStep) -> Void) async throws {
        calls.append("switchOver")
        switchedReports.append(report)
        record()
        if let switchOverError { throw switchOverError }
        progress(.stop)
        record()
    }

    func ensureAgent(_ progress: @escaping @MainActor (AgentStep) -> Void) async throws {
        calls.append("ensureAgent")
        if let agentError { throw agentError }
        if let unexpectedAgentError { throw unexpectedAgentError }
        for step in [AgentStep.agent, .health] {
            agentSteps.append(step)
            progress(step)
            record()
            await Task.yield()
        }
    }

    func probe() async -> OMLXStatus {
        record()
        return omlx
    }
}

/// Une porte d'attente : la préparation est bloquée tant que le test ne l'ouvre pas.
@MainActor
private final class Gate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var open = false

    func wait() async {
        if open { return }
        await withCheckedContinuation { self.continuation = $0 }
    }

    func release() {
        open = true
        continuation?.resume()
        continuation = nil
    }
}

@MainActor
private func makeModel(_ recorder: SetupRecorder, autoPrepare: Bool = false) -> SetupModel {
    SetupModel(
        install: { progress in try await recorder.install(progress) },
        migrate: { progress in try await recorder.migrate(progress) },
        switchOver: { report, progress in try await recorder.switchOver(report, progress) },
        ensureAgent: { progress in try await recorder.ensureAgent(progress) },
        probeOMLX: { await recorder.probe() },
        onReady: {
            recorder.onReadyCalls += 1
            recorder.record()
        },
        autoPrepare: autoPrepare
    )
}

/// Attend qu'une condition devienne vraie (au plus `timeout` secondes), en
/// rendant la main — les tests de préparation ne bloquent jamais le fil principal.
@MainActor
private func waitUntil(_ timeout: Double = 5, _ condition: () -> Bool) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !condition(), Date() < deadline {
        try? await Task.sleep(for: .milliseconds(1))
    }
}

/// La présence d'OMP vue par un `OmpPresenceModel` de test : le résolveur réussit tant
/// que `present` est vrai. (Pas `@MainActor` : le résolveur n'est pas isolé.)
private final class OmpSwitch {
    var present: Bool

    init(present: Bool) {
        self.present = present
    }

    func resolve(_: [String: String]) -> Result<URL, OmpBinaryError> {
        present
            ? .success(URL(fileURLWithPath: "/usr/local/bin/omp"))
            : .failure(.binaryNotFound(searched: ["/a/omp"], override: nil))
    }
}

/// Un `OmpPresenceModel` sur le résolveur fictif.
@MainActor
private func makeHome(_ omp: OmpSwitch) -> OmpPresenceModel {
    OmpPresenceModel(resolve: { omp.resolve($0) }, environment: { [:] })
}

/// Le câblage de `OMPConsoleApp` : `refreshOmp` et `onReady` relisent OMP.
@MainActor
private func wire(_ model: SetupModel, to home: OmpPresenceModel, recorder: SetupRecorder? = nil) {
    model.refreshOmp = {
        home.recheck()
        return home.canLaunch
    }
    model.onReady = {
        recorder?.onReadyCalls += 1
        home.recheck()
    }
}

/// Vrai quand la feuille de préparation est due.
@MainActor
private func sheet(_ home: OmpPresenceModel, _ model: SetupModel) -> Bool {
    SetupSheetPolicy.isShown(omp: home.omp, setup: model.state, dismissed: model.dismissed)
}

/// Laisse tourner les tâches en attente : ce qui devait démarrer a démarré.
@MainActor
private func settle() async {
    for _ in 0..<10 { await Task.yield() }
    try? await Task.sleep(for: .milliseconds(20))
}

// MARK: - AC-2 : la chaîne et son succès

@MainActor
@Test("all-in-one-app/AC-2 : la préparation publie chaque étape puis `ready`, et `onReady` est appelé")
func setupChainPublishesEveryStepThenReady() async {
    let recorder = SetupRecorder()
    let model = makeModel(recorder)
    recorder.model = model
    await model.prepare()

    #expect(model.state == .ready)
    #expect(recorder.onReadyCalls == 1)
    #expect(recorder.installSteps == [
        .omp(downloaded: 0, total: 100),
        .omp(downloaded: 100, total: 100),
        .ompInstall,
    ])
    #expect(recorder.migrationSteps == [.start, .importing, .stop])
    #expect(recorder.agentSteps == [.agent, .health])

    // L'état publié suit les étapes : composants, puis migration, puis service,
    // puis prérequis — et il finit prêt.
    #expect(recorder.states.first == .preparing(.omp(downloaded: 0, total: 0)))
    #expect(recorder.states.contains(.preparing(.omp(downloaded: 100, total: 100))))
    #expect(recorder.states.contains(.preparing(.migrationImport)))
    #expect(recorder.states.contains(.preparing(.agent)))
    #expect(recorder.states.contains(.preparing(.health)))
    #expect(recorder.states.contains(.preparing(.prerequisites)))
    #expect(recorder.states.last == .ready)
    // L'ordre migration → service est réel : les états sont émis dans l'ordre.
    let migrationIndex = recorder.states.firstIndex(of: .preparing(.migrationImport))
    let agentIndex = recorder.states.firstIndex(of: .preparing(.agent))
    #expect(migrationIndex != nil && agentIndex != nil && migrationIndex! < agentIndex!)
}

@MainActor
@Test("all-in-one-app/AC-2 : oMLX injoignable ne bloque pas la préparation et son état est publié")
func omlxUnreachableDoesNotBlockPreparation() async {
    let recorder = SetupRecorder()
    recorder.omlx = .unreachable(detail: "connexion refusée")
    let model = makeModel(recorder)
    await model.prepare()

    #expect(model.state == .ready)
    #expect(model.omlx == .unreachable(detail: "connexion refusée"))
    #expect(model.dismissed == false)
}

// MARK: - AC-2 : les échecs

@MainActor
@Test("all-in-one-app/AC-2 : un échec réseau arrête la chaîne et nomme le composant")
func installFailureStopsTheChain() async {
    let recorder = SetupRecorder()
    recorder.installError = .network(component: "OMP", detail: "hors ligne")
    let model = makeModel(recorder)
    await model.prepare()

    #expect(model.state == .failed(.components(.network(component: "OMP", detail: "hors ligne"))))
    #expect(recorder.migrationSteps.isEmpty, "les étapes suivantes ne tournent pas")
    #expect(recorder.agentSteps.isEmpty)
    #expect(recorder.onReadyCalls == 0)
    #expect(SetupText.failureMessage(.components(.network(component: "OMP", detail: "hors ligne")))
        == "Pas de réseau : « OMP » n’a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez.")
}

@MainActor
@Test("all-in-one-app/AC-2 : chaque machine a son classement d'échec (composants, migration, service)")
func failuresAreClassifiedByMachine() async {
    let migration = SetupRecorder()
    migration.migrationError = .importFailed(code: 1, detail: "disque plein")
    let migrationModel = makeModel(migration)
    await migrationModel.prepare()
    #expect(migrationModel.state == .failed(.migration(.importFailed(code: 1, detail: "disque plein"))))
    #expect(migration.agentSteps.isEmpty)

    let agent = SetupRecorder()
    agent.agentError = .portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))
    let agentModel = makeModel(agent)
    await agentModel.prepare()
    #expect(agentModel.state == .failed(.agent(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711)))))

    // Une erreur inattendue est dite dans le vocabulaire du service mémoire.
    struct Unexpected: Error {}
    let other = SetupRecorder()
    other.unexpectedAgentError = Unexpected()
    let otherModel = makeModel(other)
    await otherModel.prepare()
    guard case .failed(.agent(.launchctlFailed(command: "préparation", _))) = otherModel.state else {
        Issue.record("état inattendu : \(otherModel.state)")
        return
    }

    let checksum = SetupRecorder()
    checksum.installError = .checksum(component: "OMP")
    let checksumModel = makeModel(checksum)
    await checksumModel.prepare()
    #expect(checksumModel.state == .failed(.components(.checksum(component: "OMP"))))
}

// MARK: - AC-2 : reprise, feuille, non-réentrance

@MainActor
@Test("all-in-one-app/AC-2 : « Réessayer » relance la chaîne entière depuis l'échec")
func retryRestartsTheWholeChain() async {
    let recorder = SetupRecorder()
    recorder.installError = .install(component: "OMP", detail: "binaire illisible")
    let model = makeModel(recorder)
    await model.prepare()
    #expect(model.state == .failed(.components(.install(component: "OMP", detail: "binaire illisible"))))

    // OMP présent (feuille fermable) : « Réessayer » relance tout.
    recorder.installError = nil
    model.refreshOmp = { true }
    model.retry()
    #expect(model.dismissed == false)
    #expect(model.retryMissed == false)
    await waitUntil { model.state == .ready }
    #expect(model.state == .ready)
    #expect(recorder.installCalls == 2)
    #expect(recorder.onReadyCalls == 1)
}

@MainActor
@Test("all-in-one-app/AC-2 : « Fermer » laisse la préparation continuer, le bandeau la résume")
func dismissDoesNotStopPreparation() async {
    let recorder = SetupRecorder()
    let gate = Gate()
    recorder.gate = gate
    let model = makeModel(recorder)
    recorder.model = model

    let preparation = Task { await model.prepare() }
    await waitUntil { recorder.installCalls == 1 }
    model.dismiss()
    #expect(model.dismissed)
    #expect(SetupText.banner(state: model.state, dismissed: model.dismissed)
        == "Préparation en cours — \(SetupText.stepDetail(SetupStep.omp(downloaded: 0, total: 0)))")
    #expect(SetupText.banner(state: model.state, dismissed: false) == nil)

    gate.release()
    await preparation.value
    #expect(model.state == .ready)
    #expect(SetupText.banner(state: .ready, dismissed: true) == nil, "terminée : le bandeau disparaît")

    // « Reprendre… » ramène la feuille, sans relancer une préparation finie.
    model.present()
    #expect(model.dismissed == false)
    #expect(recorder.installCalls == 1)
}

@MainActor
@Test("all-in-one-app/AC-2 : une seconde préparation concurrente est sans effet")
func prepareIsNotReentrant() async {
    let recorder = SetupRecorder()
    let gate = Gate()
    recorder.gate = gate
    let model = makeModel(recorder)

    let first = Task { await model.prepare() }
    await waitUntil { recorder.installCalls == 1 }
    await model.prepare()
    #expect(recorder.installCalls == 1)

    gate.release()
    await first.value
    #expect(model.state == .ready)
    #expect(recorder.installCalls == 1)
}

@MainActor
@Test("all-in-one-app/AC-2 : `autoPrepare` lance la chaîne à la construction, sans intervention")
func autoPrepareStartsTheChain() async {
    let recorder = SetupRecorder()
    let model = makeModel(recorder, autoPrepare: true)
    await waitUntil { model.state == .ready }
    #expect(model.state == .ready)
    #expect(recorder.installCalls == 1)
}

// MARK: - mac-omp-manquant-non-bloquant : la feuille bloquante tant qu'OMP manque

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-1 : OMP absent au lancement, rien ne se télécharge et la feuille bloquante s'impose")
func missingOmpAtLaunchDownloadsNothing() async {
    let omp = OmpSwitch(present: false)
    let recorder = SetupRecorder()
    let home = makeHome(omp)
    // Le câblage de `OMPConsoleApp` : `autoPrepare: home.canLaunch`.
    let model = makeModel(recorder, autoPrepare: home.canLaunch)
    wire(model, to: home)
    await settle()
    #expect(home.canLaunch == false)
    #expect(model.state == .idle)
    #expect(recorder.installCalls == 0, "aucun téléchargement avant « Installer »")
    #expect(sheet(home, model))
    // « Fermer » n'existe pas, mais même un `dismissed` forcé ne la ferme pas.
    model.dismiss()
    #expect(sheet(home, model))
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-7 : OMP supprimé pendant une session précédente, la relance impose la feuille bloquante")
func relaunchAfterOmpRemovalShowsBlockingSheet() async {
    // Session précédente : OMP présent, la préparation se fait d'office.
    let omp = OmpSwitch(present: true)
    let before = SetupRecorder()
    let firstHome = makeHome(omp)
    let firstLaunch = makeModel(before, autoPrepare: firstHome.canLaunch)
    wire(firstLaunch, to: firstHome)
    await waitUntil { firstLaunch.state == .ready }
    #expect(before.installCalls == 1)
    #expect(!sheet(firstHome, firstLaunch))

    // Le binaire est supprimé, puis l'app relancée : modèles neufs.
    omp.present = false
    let after = SetupRecorder()
    let home = makeHome(omp)
    let model = makeModel(after, autoPrepare: home.canLaunch)
    wire(model, to: home)
    await settle()
    #expect(home.omp == .missing)
    #expect(model.state == .idle)
    #expect(after.installCalls == 0)
    #expect(sheet(home, model))
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-3 : « Réessayer » sans OMP ne télécharge rien et la feuille reste bloquante")
func retryWithoutOmpKeepsTheBlockingSheet() async {
    let omp = OmpSwitch(present: false)
    let recorder = SetupRecorder()
    let model = makeModel(recorder)
    let home = makeHome(omp)
    wire(model, to: home, recorder: recorder)

    model.retry()
    model.retry()
    await settle()
    #expect(model.retryMissed)
    #expect(model.state == .idle)
    #expect(recorder.installCalls == 0, "« Réessayer » relit la présence, sans télécharger")
    #expect(sheet(home, model))

    // `.ready` alors qu'OMP manque (chaîne finie, OMP retiré) : relu absent, la
    // feuille repasse à `.idle`.
    model.refreshOmp = nil
    await model.prepare()
    #expect(model.state == .ready)
    wire(model, to: home, recorder: recorder)
    model.retry()
    #expect(model.state == .idle)
    #expect(model.retryMissed)
    #expect(recorder.installCalls == 1)
    #expect(sheet(home, model))
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-4 : OMP présent au lancement, la préparation démarre d'office et « Fermer » la laisse continuer")
func ompPresentAtLaunchGivesDismissableSheet() async {
    let omp = OmpSwitch(present: true)
    let recorder = SetupRecorder()
    let gate = Gate()
    recorder.gate = gate
    let home = makeHome(omp)
    let model = makeModel(recorder, autoPrepare: home.canLaunch)
    wire(model, to: home)
    await waitUntil { recorder.installCalls == 1 }
    #expect(sheet(home, model))

    model.dismiss()
    #expect(!sheet(home, model), "OMP présent : la feuille fermée cède la place à l'app")
    gate.release()
    await waitUntil { model.state == .ready }
    #expect(model.state == .ready, "fermer n'interrompt pas la préparation")
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-4 : dès que le binaire d'OMP est placé, la feuille bloquante devient fermable (S-2)")
func placingOmpMakesTheSheetDismissable() async {
    let omp = OmpSwitch(present: false)
    let gate = Gate()
    /// Chaque relecture d'OMP : sa réponse et l'état du modèle à ce moment-là.
    final class RefreshLog {
        var reads: [(present: Bool, state: SetupState)] = []
    }
    let log = RefreshLog()
    let model = SetupModel(
        install: { progress in
            progress(.omp(downloaded: 0, total: 20))
            progress(.omp(downloaded: 10, total: 20))
            progress(.omp(downloaded: 20, total: 20))
            omp.present = true
            progress(.ompInstall)
        },
        migrate: { progress in
            progress(.start)
            await gate.wait()
            return .notNeeded
        },
        switchOver: { _, _ in },
        ensureAgent: { _ in },
        probeOMLX: { .unknown },
        autoPrepare: false
    )
    let home = makeHome(omp)
    wire(model, to: home)
    let refresh = model.refreshOmp
    model.refreshOmp = { [unowned model] in
        let present = refresh?() ?? true
        log.reads.append((present, model.state))
        return present
    }
    #expect(sheet(home, model))

    model.startInstall()
    await waitUntil { model.state == .preparing(.migrationStart) }
    // Un appel par CAS d'étape (.omp, .ompInstall), pas par rappel d'octets, puis
    // un au retour de l'installateur.
    #expect(log.reads.map(\.present) == [false, true, true])
    #expect(log.reads.map(\.state) == [
        .preparing(.omp(downloaded: 0, total: 20)), .preparing(.ompInstall), .preparing(.ompInstall),
    ])
    #expect(home.canLaunch)
    #expect(model.state == .preparing(.migrationStart))
    model.dismiss()
    #expect(!sheet(home, model), "OMP placé : la feuille se ferme, la préparation continue")

    gate.release()
    await waitUntil { model.state == .ready }
    #expect(log.reads.map(\.present) == [false, true, true], "OMP n'est plus relu après l'installateur")
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-5 : le badge (OMP présent) rouvre la feuille et relance la chaîne, jamais deux fois")
func reopenWithOmpRestartsTheChain() async {
    let recorder = SetupRecorder()
    let model = makeModel(recorder)
    model.refreshOmp = { true }
    await model.prepare()
    #expect(recorder.installCalls == 1)

    model.dismiss()
    model.reopen()
    #expect(model.dismissed == false)
    await waitUntil { recorder.installCalls == 2 && model.state == .ready }
    #expect(recorder.installCalls == 2, "OMP présent : la chaîne repart pour installer ce qui manque")

    // Pendant une préparation, le clic rouvre la feuille sans rien relancer.
    let gate = Gate()
    recorder.gate = gate
    let running = Task { await model.prepare() }
    await waitUntil { recorder.installCalls == 3 }
    model.dismiss()
    model.reopen()
    #expect(model.dismissed == false)
    gate.release()
    await running.value
    await settle()
    #expect(recorder.installCalls == 3)
    #expect(model.state == .ready)
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-6 : OMP disparu en cours de session, rien ne s'impose, et le badge ouvre la feuille bloquante")
func reopenWithoutOmpGivesTheBlockingSheet() async {
    let omp = OmpSwitch(present: true)
    let recorder = SetupRecorder()
    let model = makeModel(recorder)
    let home = makeHome(omp)
    wire(model, to: home, recorder: recorder)
    await model.prepare()
    #expect(model.state == .ready)
    #expect(!sheet(home, model))

    // Le binaire disparaît : seule la veille du badge le voit, `OmpPresenceModel.omp`
    // n'est pas relu, aucune feuille ne s'impose.
    omp.present = false
    await settle()
    #expect(home.canLaunch)
    #expect(!sheet(home, model))

    model.reopen()
    #expect(home.omp == .missing)
    #expect(model.state == .idle)
    #expect(model.dismissed == false)
    await settle()
    #expect(recorder.installCalls == 1, "le badge ne télécharge rien quand OMP manque")
    #expect(sheet(home, model))
    model.dismiss()
    #expect(sheet(home, model), "bloquante : rien ne la ferme")
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-8 : « Installer » mène à `.ready` et la politique ferme la feuille d'elle-même")
func installClosesTheSheetAtReady() async {
    let omp = OmpSwitch(present: false)
    let recorder = SetupRecorder()
    recorder.placesOmp = omp
    let model = makeModel(recorder)
    let home = makeHome(omp)
    wire(model, to: home, recorder: recorder)
    model.retry()
    #expect(model.retryMissed)
    #expect(sheet(home, model))

    model.startInstall()
    model.startInstall()
    #expect(model.retryMissed == false)
    await waitUntil { model.state == .ready }
    await settle()
    #expect(recorder.installCalls == 1, "deux clics, une seule préparation")
    #expect(recorder.onReadyCalls == 1)
    #expect(home.canLaunch)
    #expect(!sheet(home, model), "la feuille se ferme sans autre clic")
}

@MainActor
@Test("mac-omp-manquant-non-bloquant/AC-8 : « Réessayer » qui trouve OMP relance la chaîne, et `.ready` ferme la feuille")
func retryFindingOmpClosesTheSheetAtReady() async {
    let omp = OmpSwitch(present: false)
    let recorder = SetupRecorder()
    let model = makeModel(recorder)
    let home = makeHome(omp)
    wire(model, to: home, recorder: recorder)
    model.retry()
    #expect(model.retryMissed)

    omp.present = true
    model.retry()
    #expect(model.retryMissed == false)
    #expect(home.canLaunch)
    await waitUntil { model.state == .ready }
    #expect(recorder.installCalls == 1)
    #expect(!sheet(home, model))
}

// MARK: - omp-console-sans-podman AC-9 : rejets de l'import, le choix de l'utilisateur

/// Trois éléments laissés de côté : deux sans vecteur, un sans texte.
private let threeRejects = ImportReport(
    rejects: [
        ImportReject(element: "souvenir", id: "1", raison: "vecteur_absent", detail: "point sans vecteur"),
        ImportReject(element: "souvenir", id: "2", raison: "texte_absent", detail: "payload sans texte"),
        ImportReject(element: "souvenir", id: "3", raison: "vecteur_absent", detail: "point sans vecteur"),
    ],
    totalRejected: 3,
    raw: #"{"agents":[],"totaux":{"rejetes":3}}"# + "\n"
)

@MainActor
@Test("omp-console-sans-podman/AC-9 : un import avec rejets affiche le nombre et les raisons, propose Basculer quand même et Réessayer, et ne démarre pas l'agent")
func ac9RejectedImportAwaitsChoice() async {
    let recorder = SetupRecorder()
    recorder.migrationOutcome = .rejected(threeRejects)
    let model = makeModel(recorder)
    model.refreshOmp = { true }
    model.dismiss()
    await model.prepare()

    #expect(model.state == .awaitingSwitch(threeRejects))
    #expect(model.dismissed == false, "la feuille revient : un choix est attendu")
    #expect(recorder.count("ensureAgent") == 0)
    #expect(recorder.count("switchOver") == 0)
    #expect(recorder.onReadyCalls == 0)

    let rows = SetupPresentation.rows(state: model.state, omlx: .unknown, blocking: false)
    let migration = rows.first { $0.kind == .migration }
    #expect(migration?.status == .awaiting)
    #expect(rows.first { $0.kind == .components }?.status == .done)
    #expect(rows.first { $0.kind == .service }?.status == .upcoming)
    let summary = SetupText.rejectedSummary(threeRejects)
    #expect(migration?.detail == summary)
    #expect(summary == "L\u{2019}import a laissé de côté 3 éléments : vecteur absent (2), texte absent (1).")
    #expect(migration?.note == SetupText.rejectedChoice)

    let footer = SetupPresentation.footer(state: model.state, blocking: false)
    #expect(footer.trailing == [.switchAnyway, .retry, .close])
    #expect(footer.prominent == .retry)
    #expect(SetupPresentation.diagnostic(state: model.state) == threeRejects.raw)

    let banner = SetupText.banner(state: model.state, dismissed: true)
    #expect(banner == SetupText.bannerAwaitingSwitch)
    for shown in [summary, SetupText.rejectedChoice, banner ?? ""] {
        #expect(forbiddenTokens(in: shown).isEmpty, "\(shown)")
    }

    // Le badge montre la feuille SANS relancer l'import.
    model.dismiss()
    model.reopen()
    await settle()
    #expect(model.dismissed == false)
    #expect(recorder.count("migrate") == 1)
    #expect(model.state == .awaitingSwitch(threeRejects))
}

@MainActor
@Test("omp-console-sans-podman/AC-9 : Basculer quand même arrête l'ancienne mémoire puis démarre l'agent ; Réessayer relance l'import")
func ac9SwitchAnywayThenRetry() async {
    let recorder = SetupRecorder()
    recorder.migrationOutcome = .rejected(threeRejects)
    let model = makeModel(recorder)
    recorder.model = model
    await model.prepare()
    #expect(model.state == .awaitingSwitch(threeRejects))

    await model.switchAnyway()
    #expect(recorder.calls == ["install", "migrate", "switchOver", "ensureAgent"])
    #expect(recorder.switchedReports == [threeRejects])
    #expect(recorder.states.contains(.preparing(.migrationStop)))
    #expect(model.state == .ready)
    #expect(recorder.onReadyCalls == 1)

    // Un second modèle : « Réessayer » relance l'import, sans bascule.
    let second = SetupRecorder()
    second.migrationOutcome = .rejected(threeRejects)
    let retried = makeModel(second)
    retried.refreshOmp = { true }
    await retried.prepare()
    retried.retry()
    await waitUntil { second.count("migrate") == 2 && retried.state == .awaitingSwitch(threeRejects) }
    #expect(second.count("migrate") == 2)
    #expect(second.count("switchOver") == 0)
    #expect(second.count("ensureAgent") == 0)

    // Le nouvel import passe : la chaîne va au bout.
    second.migrationOutcome = .switched
    retried.retry()
    await waitUntil { retried.state == .ready }
    #expect(retried.state == .ready)
    #expect(second.count("switchOver") == 0)
}

@MainActor
@Test("omp-console-sans-podman/AC-9 : switchAnyway n'agit que depuis l'attente d'un choix")
func ac9SwitchAnywayOnlyFromAwaiting() async {
    let idle = SetupRecorder()
    let idleModel = makeModel(idle)
    await idleModel.switchAnyway()
    #expect(idleModel.state == .idle)
    #expect(idle.calls.isEmpty)

    let failed = SetupRecorder()
    failed.migrationError = .importFailed(code: 1, detail: "boom")
    let failedModel = makeModel(failed)
    await failedModel.prepare()
    await failedModel.switchAnyway()
    #expect(failedModel.state == .failed(.migration(.importFailed(code: 1, detail: "boom"))))
    #expect(failed.count("switchOver") == 0)
    #expect(failed.count("ensureAgent") == 0)

    let ready = SetupRecorder()
    let readyModel = makeModel(ready)
    await readyModel.prepare()
    await readyModel.switchAnyway()
    #expect(readyModel.state == .ready)
    #expect(ready.count("switchOver") == 0)
    #expect(ready.count("ensureAgent") == 1)
    #expect(ready.onReadyCalls == 1)
}

// MARK: - omp-console-sans-podman AC-8 : échecs de migration

@MainActor
@Test("omp-console-sans-podman/AC-8 : chaque échec de migration s'affiche lisible (forbiddenTokens vide) avec Réessayer, sans démarrer l'agent")
func ac8MigrationFailuresAreReadable() async {
    let cases: [(PodmanMigrationError, String)] = [
        (.podmanMissing(path: "/Users/moi/Library/Application Support/com.omp.console/components/podman/bin/podman"),
         "L\u{2019}ancienne mémoire est introuvable sur ce Mac : elle ne peut pas être reprise, la nouvelle ne démarre pas."),
        (.machineFailed(detail: "Error: vfkit exited 125"),
         "L\u{2019}ancienne mémoire n\u{2019}a pas démarré : elle ne peut pas être reprise, la nouvelle ne démarre pas."),
        (.qdrantUnreachable(detail: "readyz sans réponse"),
         "L\u{2019}ancienne mémoire ne répond pas : elle ne peut pas être reprise, la nouvelle ne démarre pas."),
        (.historyCopyFailed(detail: "Error: no such container"),
         "L\u{2019}historique de l\u{2019}ancienne mémoire n\u{2019}a pas pu être copié : la nouvelle ne démarre pas."),
        (.importFailed(code: 2, detail: "stderr: dimension 768"),
         "L\u{2019}import des souvenirs a échoué : la nouvelle mémoire ne démarre pas, l\u{2019}ancienne reste en place."),
        (.stopFailed(detail: "Error: 125"),
         "L\u{2019}ancienne mémoire n\u{2019}a pas pu être arrêtée : la nouvelle ne peut pas démarrer."),
        (.stateWriteFailed(path: "/x/bascule.json", detail: "disque plein"),
         "La bascule n\u{2019}a pas pu être enregistrée : la nouvelle mémoire ne démarre pas."),
    ]
    for (error, consequence) in cases {
        let recorder = SetupRecorder()
        recorder.migrationError = error
        let model = makeModel(recorder)
        model.refreshOmp = { true }
        await model.prepare()

        #expect(model.state == .failed(.migration(error)))
        #expect(recorder.count("ensureAgent") == 0, "\(error)")
        #expect(recorder.onReadyCalls == 0)
        let rows = SetupPresentation.rows(state: model.state, omlx: .unknown, blocking: false)
        let failedRows = rows.filter { $0.status == .failed }
        #expect(failedRows.map(\.kind) == [.migration], "\(error)")
        let summary = SetupText.failureSummary(.migration(error))
        #expect(failedRows.first?.detail == summary)
        #expect(summary == "\(consequence) \(SetupText.failureRetryGesture)", "\(error)")
        let banner = SetupText.banner(state: model.state, dismissed: true) ?? ""
        #expect(banner == "Préparation incomplète. \(consequence)")
        for shown in [summary, banner] {
            #expect(forbiddenTokens(in: shown).isEmpty, "\(error) : \(shown)")
        }
        let footer = SetupPresentation.footer(state: model.state, blocking: false)
        #expect(footer.trailing == [.retry, .close])
        #expect(footer.prominent == .retry)

        // La cause corrigée, « Réessayer » va au bout.
        recorder.migrationError = nil
        recorder.migrationOutcome = .switched
        model.retry()
        await waitUntil { model.state == .ready }
        #expect(model.state == .ready, "\(error)")
        #expect(recorder.count("ensureAgent") == 1)
    }
}

// MARK: - omp-console-sans-podman : la chaîne réelle sur doublures

/// Un journal partagé entre les doublures podman et launchd : l'ordre global des
/// commandes. `@unchecked Sendable` : tous les accès viennent du MainActor.
private final class CommandLog: @unchecked Sendable {
    var entries: [String] = []
}

private func logged(_ runner: CommandRunner, _ log: CommandLog, as name: String) -> CommandRunner {
    CommandRunner { binary, arguments, environment, timeout in
        log.entries.append("\(name) \(arguments.first ?? "")")
        return try await runner(binary, arguments, environment, timeout)
    }
}

/// Le `/health` de NOTRE mem0-rs : il rend le jeton d'installation du disque.
private func installedHealth(_ paths: AppPaths) -> () -> Data? {
    {
        guard let token = InstallationTokenStore.load(at: paths.installationToken) else { return nil }
        return memoryJSON(["ok": true, "mem0": "mem0-rs 0.1.0", "user": "moi", "installation": token])
    }
}

@MainActor
private func makeChainAgent(paths: AppPaths, executable: URL, double: AgentDouble, run: CommandRunner? = nil) -> MemoryAgent {
    let agent = MemoryAgent(
        paths: paths,
        executable: executable,
        port: 8321,
        environment: [:],
        run: run ?? double.runner,
        uid: 501,
        healthProbe: double.healthProbe
    )
    agent.healthBudget = 0.2
    agent.portFreeBudget = 0.05
    agent.unloadBudget = 0.5
    agent.pollInterval = 0.01
    return agent
}

/// La chaîne de `SetupModel.standard`, mais sur les doublures : `PodmanLegacy` et
/// `MemoryAgent` RÉELS sur la MÊME racine de support, une installation qui ne fait
/// rien, et les étapes observées.
@MainActor
private final class RealChain {
    let sandbox: LegacySandbox
    let legacyDouble: LegacyDouble
    let agentDouble = AgentDouble()
    let log = CommandLog()
    var steps: [SetupStep] = []
    var onReadyCalls = 0
    private(set) var model: SetupModel!

    init(collection: Bool) throws {
        sandbox = try LegacySandbox(collection: collection)
        legacyDouble = LegacyDouble(sandbox: sandbox)
        agentDouble.healthBody = installedHealth(sandbox.paths)
        let legacy = PodmanLegacy(
            paths: sandbox.paths,
            executable: sandbox.executable,
            environment: ["HOME": "/Users/recette", "PATH": "/usr/bin:/bin"],
            run: logged(legacyDouble.runner, log, as: "podman"),
            readyProbe: legacyDouble.readyProbe
        )
        legacy.readyBudget = 0.05
        legacy.pollInterval = 0.01
        let agent = makeChainAgent(
            paths: sandbox.paths,
            executable: sandbox.executable,
            double: agentDouble,
            run: logged(agentDouble.runner, log, as: "agent")
        )
        model = SetupModel(
            install: { _ in },
            migrate: { [unowned self] progress in
                try await legacy.migrate { step in
                    self.steps.append(SetupStep(step))
                    progress(step)
                }
            },
            switchOver: { [unowned self] report, progress in
                try await legacy.switchOver(forced: true, report: report) { step in
                    self.steps.append(SetupStep(step))
                    progress(step)
                }
            },
            ensureAgent: { [unowned self] progress in
                try await agent.ensureRunning { step in
                    self.steps.append(SetupStep(step))
                    progress(step)
                }
            },
            probeOMLX: { .unknown },
            onReady: { [unowned self] in self.onReadyCalls += 1 },
            autoPrepare: false
        )
    }
}

@MainActor
@Test("omp-console-sans-podman/AC-6 : la chaîne complète migre, bascule puis démarre l'agent et atteint .ready")
func ac6FullChainMigratesThenStartsAgent() async throws {
    let chain = try RealChain(collection: true)
    defer { chain.sandbox.remove() }

    await chain.model.prepare()

    #expect(chain.model.state == .ready)
    #expect(chain.onReadyCalls == 1)
    #expect(chain.steps == [.migrationStart, .migrationImport, .migrationStop, .agent, .health])
    // L'ancienne pile est arrêtée AVANT le premier bootstrap de l'agent.
    let stop = chain.log.entries.firstIndex(of: "podman stop")
    let bootstrap = chain.log.entries.firstIndex(of: "agent bootstrap")
    #expect(stop != nil && bootstrap != nil && stop! < bootstrap!, "\(chain.log.entries)")
    #expect(chain.agentDouble.launchctlVerbs.filter { $0 == "bootstrap" }.count == 1)
    #expect(FileManager.default.fileExists(atPath: chain.sandbox.paths.switchState.path))
}

@MainActor
@Test("omp-console-sans-podman/AC-2 : sans ancienne pile, la chaîne ne lance aucune commande podman et démarre l'agent")
func ac2NoPodmanLeftoversStartsAgentWithoutPodman() async throws {
    let chain = try RealChain(collection: false)
    defer { chain.sandbox.remove() }
    // Le bac à sable pose un faux podman pour les autres preuves : ici, aucun.
    try FileManager.default.removeItem(at: chain.sandbox.paths.componentsRoot.appendingPathComponent("podman"))

    await chain.model.prepare()

    #expect(chain.model.state == .ready)
    #expect(chain.legacyDouble.journal.isEmpty, "\(chain.legacyDouble.journal)")
    #expect(!chain.log.entries.contains { $0.hasPrefix("podman") })
    #expect(chain.agentDouble.launchctlVerbs.filter { $0 == "bootstrap" }.count == 1)
    #expect(chain.agentDouble.loaded)
    #expect(!FileManager.default.fileExists(
        atPath: chain.sandbox.paths.componentsRoot.appendingPathComponent("podman").path
    ))
}

@MainActor
@Test("omp-console-sans-podman/AC-5 : Réessayer après libération du port charge l'agent et rend la préparation prête")
func ac5RetryAfterPortFreedReachesReady() async throws {
    let sandbox = try AgentSandbox()
    defer { sandbox.remove() }
    let double = AgentDouble()
    double.healthBody = installedHealth(sandbox.paths)
    double.portHolder = (4711, "nc", "nc -l 127.0.0.1 8321")
    let agent = makeChainAgent(paths: sandbox.paths, executable: sandbox.executable, double: double)
    let model = SetupModel(
        install: { _ in },
        migrate: { _ in .alreadyDone },
        switchOver: { _, _ in Issue.record("aucune bascule attendue") },
        ensureAgent: { progress in try await agent.ensureRunning(progress: progress) },
        probeOMLX: { .unknown },
        autoPrepare: false
    )
    model.refreshOmp = { true }

    await model.prepare()
    #expect(model.state == .failed(.agent(.portConflict(port: 8321, owner: .foreign(process: "nc", pid: 4711)))))
    #expect(!double.launchctlVerbs.contains("bootstrap"))

    double.portHolder = nil
    model.retry()
    await waitUntil { model.state == .ready }
    #expect(model.state == .ready)
    #expect(double.launchctlVerbs.filter { $0 == "bootstrap" }.count == 1)
}

// MARK: - AC-2 : les textes figés

@Test("all-in-one-app/AC-2 : les textes de la préparation sont ceux du contrat, mot pour mot")
func setupTextsAreFrozen() {
    #expect([
        SetupText.title,
        SetupText.body,
        SetupText.homeMissingTitle,
        SetupText.homeMissingBody,
        SetupText.retry,
        SetupText.close,
        SetupText.install,
        SetupText.quit,
        SetupText.ompMissingBody,
        SetupText.retryMissed,
        SetupText.showDetail,
        SetupText.hideDetail,
        SetupText.resume,
        SetupText.done,
        SetupText.componentsBadgeHelp,
        SetupText.componentsRow,
        SetupText.migrationRow,
        SetupText.serviceRow,
        SetupText.prerequisitesRow,
        SetupText.switchAnyway,
    ] == [
        "Préparation d’OMP Console",
        "OMP Console installe OMP, reprend si besoin l’ancienne mémoire, puis démarre son service mémoire. Cette étape n’a lieu qu’une fois.",
        "OMP n’est pas installé",
        "Installez OMP depuis la feuille de préparation : les fonctions qui en dépendent se débloquent à la fin de l’installation.",
        "Réessayer",
        "Fermer",
        "Installer",
        "Quitter",
        "OMP n’est pas installé sur ce Mac. Installez-le pour utiliser OMP Console, ou quittez l’app.",
        "OMP n’est toujours pas installé.",
        "Afficher le détail",
        "Masquer le détail",
        "Reprendre…",
        "Préparation terminée.",
        "Afficher la préparation d’OMP Console",
        "Composants",
        "Migration de la mémoire",
        "Service mémoire",
        "Prérequis",
        "Basculer quand même",
    ])

    #expect(SetupText.stepDetail(.omp(downloaded: 0, total: 0)) == "Téléchargement d’OMP…")
    #expect(SetupText.stepDetail(.omp(downloaded: 12, total: 100)) == "Téléchargement d’OMP — 12 %")
    #expect(SetupText.stepDetail(.omp(downloaded: 200, total: 100)) == "Téléchargement d’OMP — 100 %")
    #expect(SetupText.stepDetail(.ompInstall) == "Installation d’OMP…")
    #expect(SetupText.stepDetail(.migrationStart) == "Démarrage de l’ancienne mémoire…")
    #expect(SetupText.stepDetail(.migrationImport) == "Reprise des souvenirs de l’ancienne mémoire…")
    #expect(SetupText.stepDetail(.migrationStop) == "Arrêt de l’ancienne mémoire…")
    #expect(SetupText.stepDetail(.agent) == "Démarrage du service mémoire…")
    #expect(SetupText.stepDetail(.health) == "Attente de la mémoire…")
    #expect(SetupText.stepDetail(.prerequisites) == "Vérification des prérequis…")

    #expect(SetupText.omlxWord(.unknown) == "Non vérifié")
    #expect(SetupText.omlxWord(.reachable) == "Disponible")
    #expect(SetupText.omlxWord(.unauthorized) == "Clé refusée")
    #expect(SetupText.omlxWord(.unreachable(detail: "x")) == "Injoignable")

    // Le DIAGNOSTIC copiable garde le brut, mot pour mot (S-5).
    #expect(SetupText.failureDiagnostic(.components(.unsupportedMac)) == "Ce Mac n’est pas pris en charge (arm64 requis).")
    #expect(SetupText.failureDiagnostic(.components(.checksum(component: "OMP")))
        == "« OMP » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue.")
    #expect(SetupText.failureDiagnostic(.components(.install(component: "OMP", detail: "binaire illisible")))
        == "L’installation de « OMP » a échoué : binaire illisible")
    #expect(SetupText.failureDiagnostic(.migration(.podmanMissing(path: "/p/podman"))) == "podman introuvable : /p/podman")
    #expect(SetupText.failureDiagnostic(.migration(.machineFailed(detail: "libkrun absent")))
        == "La machine podman omp-console n’a pas démarré : libkrun absent")
    #expect(SetupText.failureDiagnostic(.migration(.qdrantUnreachable(detail: "délai")))
        == "Qdrant (127.0.0.1:6333, conteneur omp-console-qdrant) injoignable : délai")
    #expect(SetupText.failureDiagnostic(.migration(.historyCopyFailed(detail: "absent")))
        == "podman cp omp-console-mem0-http:/home/mem0/.mem0/history.db a échoué : absent")
    #expect(SetupText.failureDiagnostic(.migration(.importFailed(code: 2, detail: "boom")))
        == "mem0-rs import a échoué (code 2) : boom")
    #expect(SetupText.failureDiagnostic(.migration(.stopFailed(detail: "socket fermé")))
        == "podman stop omp-console-mem0-http omp-console-qdrant a échoué : socket fermé")
    #expect(SetupText.failureDiagnostic(.migration(.stateWriteFailed(path: "/s/bascule.json", detail: "disque plein")))
        == "État de bascule non inscriptible (/s/bascule.json) : disque plein")
    #expect(SetupText.failureDiagnostic(.agent(.binaryMissing(path: "/a/mem0-rs")))
        == "mem0-rs absent ou non exécutable : /a/mem0-rs")
    #expect(SetupText.failureDiagnostic(.agent(.launchctlFailed(command: "bootstrap", detail: "EIO")))
        == "launchctl bootstrap a échoué : EIO")
    #expect(SetupText.failureDiagnostic(.agent(.plistWriteFailed(path: "/l/x.plist", detail: "lecture seule")))
        == "Plist de l’agent non inscriptible (/l/x.plist) : lecture seule")
    #expect(SetupText.failureDiagnostic(.agent(.healthTimeout(seconds: 30, log: "panic")), logPath: "/j/mem0-rs.log")
        == "Le service mémoire n’a pas répondu dans le délai imparti (30 s).\nJournal : /j/mem0-rs.log\npanic")
    #expect(SetupText.failureDiagnostic(.agent(.portConflict(port: 8321, owner: .foreign(process: "nc", pid: 4711))))
        == "Le port 8321 est déjà tenu par un autre programme (nc, pid 4711) : la mémoire ne peut pas démarrer.\nGeste : arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)")

    // La PHRASE affichée : conséquence, puis geste (S-3, S-5).
    #expect(SetupText.failureMessage(.components(.unsupportedMac)) == "Ce Mac n’est pas pris en charge (arm64 requis).")
    let retry = "Réessayez ; si l’échec revient, copiez le diagnostic pour le signaler."
    #expect(SetupText.failureRetryGesture == retry)
    #expect(SetupText.failureMessage(.migration(.stopFailed(detail: "socket fermé")))
        == "L’ancienne mémoire n’a pas pu être arrêtée : la nouvelle ne peut pas démarrer. \(retry)")
    #expect(SetupText.failureMessage(.agent(.binaryMissing(path: "/a/mem0-rs")))
        == "Le service mémoire manque dans l’app : les souvenirs sont indisponibles. Réinstallez OMP Console.")
    #expect(SetupText.failureMessage(.agent(.launchctlFailed(command: "bootstrap", detail: "EIO")))
        == "Le service mémoire n’a pas pu être lancé : les souvenirs sont indisponibles. \(retry)")
    #expect(SetupText.failureMessage(.agent(.plistWriteFailed(path: "/l", detail: "x")))
        == "Le service mémoire n’a pas pu être lancé : les souvenirs sont indisponibles. \(retry)")
    #expect(SetupText.failureMessage(.agent(.healthTimeout(seconds: 30, log: "")))
        == "Le service mémoire n’a pas répondu : les souvenirs sont indisponibles. \(retry)")
    #expect(SetupText.failureMessage(.agent(.installationFailed(detail: "disque plein")))
        == "L’identité de la mémoire n’a pas pu être écrite : les souvenirs sont indisponibles. \(retry)")
    #expect(SetupText.failureMessage(.agent(.portConflict(port: 8321, owner: .foreign(process: "nc", pid: 4711))))
        == "Le programme « nc » occupe la place réservée à la mémoire : celle-ci ne peut pas démarrer. Quittez-le, puis réessayez.")
    #expect(SetupText.failureMessage(.agent(.portConflict(port: 8321, owner: .unknown(detail: "lsof absent"))))
        == "La place réservée à la mémoire est occupée : celle-ci ne peut pas démarrer. \(retry)")
}

/// Les échecs de la migration et du service mémoire (S-5, avec chacun des
/// propriétaires de port), leur commande et leur détail brut : ce que la feuille
/// ne doit pas montrer.
private let podmanFailures: [(failure: SetupFailure, raw: [String])] = [
    (.migration(.machineFailed(detail: "Error: vfkit exited 125")), ["vfkit exited 125"]),
    (.migration(.qdrantUnreachable(detail: "connexion refusée")), ["connexion refusée", "6333"]),
    (.migration(.historyCopyFailed(detail: "no such container")), ["no such container", "history.db"]),
    (.migration(.importFailed(code: 2, detail: "dimension 768")), ["dimension 768", "code 2"]),
    (.migration(.stopFailed(detail: "code HTTP 500")), ["code HTTP 500", "omp-console-qdrant"]),
    (.agent(.launchctlFailed(command: "préparation", detail: "")), ["launchctl préparation"]),
    (.agent(.launchctlFailed(command: "bootstrap", detail: "Input/output error")), ["bootstrap", "Input/output error"]),
    (.agent(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))), ["8321", "4711", "lsof"]),
    (.agent(.portConflict(port: 8321, owner: .ours(process: "mem0-rs", pid: 99))), ["8321", "le service mémoire d'OMP Console"]),
    (.agent(.portConflict(port: 8321, owner: .free)), ["8321"]),
    (.agent(.portConflict(port: 8321, owner: .unknown(detail: "lsof absent"))), ["8321", "lsof absent"]),
]

@Test("jargon-technique-expose-mac-et-ios/AC-6 : un échec Podman s'affiche en conséquence + geste, sans commande, stderr, port ni code, dans la feuille comme dans le bandeau")
func podmanFailuresAreReadable() {
    for (failure, raw) in podmanFailures {
        let message = SetupText.failureMessage(failure)
        let banner = SetupText.banner(state: .failed(failure), dismissed: true) ?? ""
        for shown in [message, banner] {
            #expect(forbiddenTokens(in: shown).isEmpty, "\(failure) : \(shown)")
            for fragment in raw {
                #expect(!shown.contains(fragment), "\(failure) montre « \(fragment) » : \(shown)")
            }
        }
        // Le geste suit la conséquence ; le bandeau ne porte que la conséquence.
        let consequence = SetupText.failureConsequence(failure)
        #expect(message.hasPrefix(consequence + " "))
        #expect(message.count > consequence.count + 1)
        #expect(banner == "Préparation incomplète. \(consequence)")
    }
    // Le geste nomme le bouton qui règle le cas : « Réessayer » (S-5).
    #expect(SetupText.failureMessage(.migration(.machineFailed(detail: "x"))).hasSuffix(SetupText.failureRetryGesture))
    // La ligne Prérequis d'une clé oMLX refusée ne cite plus de code.
    #expect(forbiddenTokens(in: SetupText.omlxWord(.unauthorized)).isEmpty)
}

@MainActor
@Test("jargon-technique-expose-mac-et-ios/AC-7 : le diagnostic d'un échec Podman, copié, met dans le presse-papiers la commande, le stderr, le port et le geste shell")
func podmanDiagnosticsKeepTheRawDetail() {
    // Un presse-papiers nommé unique : jamais celui de l'utilisateur (D-1).
    let pasteboard = NSPasteboard.withUniqueName()
    defer { pasteboard.releaseGlobally() }
    for (failure, raw) in podmanFailures {
        // Ce que « Copier le diagnostic » du pied de feuille copie (SetupView).
        DiagnosticPasteboard.copy(SetupText.failureDiagnostic(failure), to: pasteboard)
        let copied = pasteboard.string(forType: .string) ?? ""
        #expect(copied == SetupText.failureDiagnostic(failure))
        for fragment in raw {
            #expect(copied.contains(fragment), "\(failure) : « \(fragment) » absent de \(copied)")
        }
    }
}
