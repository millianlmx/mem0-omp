// Preuves de S-5, BR-5 : la chaîne de préparation (composants → migration → pile
// → oMLX), ses échecs typés, la reprise, la non-réentrance, et le fait que la
// feuille se pilote sans interrompre le travail.
//
// Les quatre machines sont des DOUBLURES injectées : aucun réseau, aucun binaire,
// aucun conteneur.

import Foundation
import Testing
@testable import OMPConsole
import ConsoleCore

/// Ce que la préparation a émis, dans l'ordre — et l'état du modèle au moment de
/// chaque émission. (Nom préfixé : `Recorder` existe déjà dans `StoreFixtures`.)
@MainActor
private final class SetupRecorder {
    weak var model: SetupModel?
    var states: [SetupState] = []
    var installSteps: [ComponentInstallStep] = []
    var migrationSteps: [MigrationStep] = []
    var stackSteps: [StackStep] = []
    var installCalls = 0
    var onReadyCalls = 0
    var installError: ComponentInstallError?
    var migrationError: StackMigrationError?
    var stackError: MemoryStackError?
    var takeoverError: LegacyStackError?
    var omlx: OMLXStatus = .reachable
    var gate: Gate?
    var takeoverCalls = 0

    func record() {
        if let model { states.append(model.state) }
    }

    func install(_ progress: @escaping @MainActor (ComponentInstallStep) -> Void) async throws {
        installCalls += 1
        record()
        if let gate { await gate.wait() }
        if let installError { throw installError }
        let steps: [ComponentInstallStep] = [
            .omp(downloaded: 0, total: 100),
            .omp(downloaded: 100, total: 100),
            .ompInstall,
            .podman(downloaded: 0, total: 0),
            .podmanInstall,
        ]
        for step in steps {
            installSteps.append(step)
            progress(step)
            record()
            await Task.yield()
        }
    }

    func migrate(_ progress: @escaping @MainActor (MigrationStep) -> Void) async throws {
        if let migrationError { throw migrationError }
        for step in [MigrationStep.copy] {
            migrationSteps.append(step)
            progress(step)
            record()
            await Task.yield()
        }
    }

    func ensureStack(_ progress: @escaping @MainActor (StackStep) -> Void) async throws {
        if let stackError { throw stackError }
        for step in [StackStep.machine, .images, .containers, .health, .union] {
            stackSteps.append(step)
            progress(step)
            record()
            await Task.yield()
        }
    }

    /// L'arrêt de l'ancienne pile, sur ordre (S-6).
    func takeOver() async throws {
        takeoverCalls += 1
        record()
        if let takeoverError { throw takeoverError }
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
private func makeModel(
    _ recorder: SetupRecorder,
    autoPrepare: Bool = false,
    takeover: (@MainActor () async throws -> Void)? = nil
) -> SetupModel {
    SetupModel(
        install: { progress in try await recorder.install(progress) },
        migrate: { progress in try await recorder.migrate(progress) },
        ensureStack: { progress in try await recorder.ensureStack(progress) },
        probeOMLX: { await recorder.probe() },
        takeover: takeover ?? { try await recorder.takeOver() },
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
        .podman(downloaded: 0, total: 0),
        .podmanInstall,
    ])
    #expect(recorder.migrationSteps == [.copy])
    #expect(recorder.stackSteps == [.machine, .images, .containers, .health, .union])

    // L'état publié suit les étapes : composants, puis migration, puis pile, puis
    // prérequis — et il finit prêt.
    #expect(recorder.states.first == .preparing(.omp(downloaded: 0, total: 0)))
    #expect(recorder.states.contains(.preparing(.omp(downloaded: 100, total: 100))))
    #expect(recorder.states.contains(.preparing(.migrationCopy)))
    #expect(recorder.states.contains(.preparing(.machine)))
    #expect(recorder.states.contains(.preparing(.union)))
    #expect(recorder.states.contains(.preparing(.prerequisites)))
    #expect(recorder.states.last == .ready)
    // L'ordre migration → pile est réel : les états sont émis dans l'ordre.
    let migrationIndex = recorder.states.firstIndex(of: .preparing(.migrationCopy))
    let stackIndex = recorder.states.firstIndex(of: .preparing(.machine))
    #expect(migrationIndex != nil && stackIndex != nil && migrationIndex! < stackIndex!)
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
    #expect(recorder.stackSteps.isEmpty)
    #expect(recorder.onReadyCalls == 0)
    #expect(SetupText.failureMessage(.components(.network(component: "OMP", detail: "hors ligne")))
        == "Pas de réseau : « OMP » n'a pas pu être téléchargé. Vérifiez votre connexion, puis réessayez.")
}

@MainActor
@Test("all-in-one-app/AC-2 : chaque machine a son classement d'échec (composants, migration, pile)")
func failuresAreClassifiedByMachine() async {
    let migration = SetupRecorder()
    migration.migrationError = .copyFailed(detail: "disque plein")
    let migrationModel = makeModel(migration)
    await migrationModel.prepare()
    #expect(migrationModel.state == .failed(.migration(.copyFailed(detail: "disque plein"))))
    #expect(migration.stackSteps.isEmpty)

    let stack = SetupRecorder()
    stack.stackError = .portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))
    let stackModel = makeModel(stack)
    await stackModel.prepare()
    #expect(stackModel.state == .failed(.stack(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711)))))

    let checksum = SetupRecorder()
    checksum.installError = .checksum(component: "Podman")
    let checksumModel = makeModel(checksum)
    await checksumModel.prepare()
    #expect(checksumModel.state == .failed(.components(.checksum(component: "Podman"))))
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

    recorder.installError = nil
    model.present()
    #expect(model.dismissed == false)
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
    #expect(SetupText.banner(state: .ready, dismissed: true) == nil, "terminée : le bandeau disparaît")

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

// MARK: - AC-6 : la reprise de l'ancienne pile, sur ordre seulement

@MainActor
@Test("bug-embedded-podman-machine/AC-6 : la reprise publie l'arrêt, arrête l'ancienne pile puis relance la chaîne COMPLÈTE")
func takeOverStopsThenRestartsTheChain() async {
    let recorder = SetupRecorder()
    let model = makeModel(recorder)
    recorder.model = model

    await model.takeOverLegacyStack()

    #expect(recorder.takeoverCalls == 1)
    #expect(recorder.installCalls == 1, "un arrêt réussi relance toute la chaîne (même chemin que « Réessayer »)")
    #expect(model.state == .ready)
    #expect(recorder.states.contains(.preparing(.legacyStop)))
}

@MainActor
@Test("bug-embedded-podman-machine/AC-6 : un arrêt d'ancienne pile refusé rend `.failed(.legacy(…))` et ne relance RIEN")
func failedTakeOverDoesNotRestartTheChain() async {
    let recorder = SetupRecorder()
    recorder.takeoverError = .stopFailed(container: "mem0-qdrant", detail: "code HTTP 500")
    let model = makeModel(recorder)

    await model.takeOverLegacyStack()

    #expect(model.state == .failed(.legacy(.stopFailed(container: "mem0-qdrant", detail: "code HTTP 500"))))
    #expect(recorder.installCalls == 0)
    #expect(recorder.takeoverCalls == 1)
    #expect(SetupText.failureMessage(.legacy(.stopFailed(container: "mem0-qdrant", detail: "code HTTP 500")))
        == "L'ancienne pile mémoire n'a pas pu être arrêtée (mem0-qdrant) : code HTTP 500")
}

@MainActor
@Test("bug-embedded-podman-machine/AC-6 : une reprise demandée PENDANT une préparation est sans effet")
func takeOverWhilePreparingIsIgnored() async {
    let recorder = SetupRecorder()
    let gate = Gate()
    recorder.gate = gate
    let model = makeModel(recorder)

    let first = Task { await model.prepare() }
    await waitUntil { recorder.installCalls == 1 }
    await model.takeOverLegacyStack()
    #expect(recorder.takeoverCalls == 0)

    gate.release()
    await first.value
    #expect(model.state == .ready)
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
        SetupText.resume,
        SetupText.done,
        SetupText.componentsRow,
        SetupText.migrationRow,
        SetupText.stackRow,
        SetupText.prerequisitesRow,
    ] == [
        "Préparation d'OMP Console",
        "OMP Console installe ses composants — OMP, le moteur de conteneurs et la pile mémoire — puis les démarre. Cette étape n'a lieu qu'une fois.",
        "OMP Console prépare ses composants",
        "L'installation d'OMP, du moteur de conteneurs et de la pile mémoire est en cours. Les fonctions qui en dépendent se débloquent à la fin.",
        "Réessayer",
        "Fermer",
        "Reprendre…",
        "Préparation terminée.",
        "Composants",
        "Migration de la mémoire",
        "Pile mémoire",
        "Prérequis",
    ])

    #expect(SetupText.stepDetail(.omp(downloaded: 0, total: 0)) == "Téléchargement d'OMP…")
    #expect(SetupText.stepDetail(.omp(downloaded: 12, total: 100)) == "Téléchargement d'OMP — 12 %")
    #expect(SetupText.stepDetail(.ompInstall) == "Installation d'OMP…")
    #expect(SetupText.stepDetail(.podman(downloaded: 0, total: 0)) == "Téléchargement de Podman…")
    #expect(SetupText.stepDetail(.podman(downloaded: 200, total: 100)) == "Téléchargement de Podman — 100 %")
    #expect(SetupText.stepDetail(.podmanInstall) == "Installation de Podman…")
    #expect(SetupText.stepDetail(.legacyStop) == "Arrêt de l'ancienne pile mémoire…")
    #expect(SetupText.stepDetail(.migrationCopy) == "Copie de la base mémoire existante…")
    #expect(SetupText.stepDetail(.machine) == "Préparation de la machine de conteneurs…")
    #expect(SetupText.stepDetail(.images) == "Préparation des images de la pile…")
    #expect(SetupText.stepDetail(.containers) == "Démarrage de la pile mémoire…")
    #expect(SetupText.stepDetail(.health) == "Attente de la mémoire…")
    #expect(SetupText.stepDetail(.union) == "Rattrapage des souvenirs manquants…")
    #expect(SetupText.stepDetail(.prerequisites) == "Vérification des prérequis…")
    #expect(SetupText.takeover == "Arrêter l'ancienne pile et reprendre")

    #expect(SetupText.omlxWord(.unknown) == "Non vérifié")
    #expect(SetupText.omlxWord(.reachable) == "Disponible")
    #expect(SetupText.omlxWord(.unauthorized) == "Jeton refusé (401)")
    #expect(SetupText.omlxWord(.unreachable(detail: "x")) == "Injoignable")

    #expect(SetupText.failureMessage(.components(.unsupportedMac)) == "Ce Mac n'est pas pris en charge (arm64 requis).")
    #expect(SetupText.failureMessage(.components(.checksum(component: "OMP")))
        == "« OMP » téléchargé est corrompu (empreinte SHA-256 différente). La préparation a été interrompue.")
    #expect(SetupText.failureMessage(.components(.install(component: "Podman", detail: "pkgutil absent")))
        == "L'installation de « Podman » a échoué : pkgutil absent")
    #expect(SetupText.failureMessage(.legacy(.stopFailed(container: "mem0-qdrant", detail: "socket fermé")))
        == "L'ancienne pile mémoire n'a pas pu être arrêtée (mem0-qdrant) : socket fermé")
    #expect(SetupText.failureMessage(.stack(.machineFailed(detail: "libkrun absent")))
        == "La machine de conteneurs n'a pas démarré : libkrun absent")
    #expect(SetupText.failureMessage(.stack(.containerFailed(name: "omp-console-qdrant", detail: "image absente")))
        == "Le conteneur omp-console-qdrant n'a pas démarré : image absente")
    #expect(SetupText.failureMessage(.stack(.healthTimeout(seconds: 180)))
        == "La mémoire n'a pas répondu dans le délai imparti (180 s).")
    #expect(SetupText.failureMessage(.stack(.podmanFailed(command: "machine start", detail: "boom")))
        == "Podman a échoué (machine start) : boom")
    #expect(SetupText.failureMessage(.stack(.portConflict(port: 8321, owner: .foreign(process: "python3", pid: 4711))))
        == "Le port 8321 est déjà tenu par un autre programme (python3, pid 4711) : la pile mémoire ne peut pas démarrer.\nGeste : arrêtez le programme qui tient le port (lsof -nP -iTCP:<port> -sTCP:LISTEN)")
    #expect(SetupText.failureMessage(.stack(.portConflict(port: 8321, owner: .legacyStack(container: "mem0-http"))))
        == "Le port 8321 est déjà tenu par l'ancienne pile mémoire (conteneur mem0-http) : la pile mémoire ne peut pas démarrer.\nGeste : podman stop mem0-qdrant mem0-http")
    #expect(SetupText.failureMessage(.stack(.installationFailed(detail: "disque plein")))
        == "L'identité d'installation de la pile n'a pas pu être écrite : disque plein")
}
