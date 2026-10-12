// Le nettoyage CONFIRMÉ de l'ancien moteur de conteneurs (S-6
// d'omp-console-sans-podman ; AC-10), porté par un bandeau en tête de la section
// Mémoire macOS.
//
// Après la bascule (`bascule.json` présent), la machine podman « omp-console » et
// le moteur installé par l'app occupent encore de la place. Le bandeau le dit et
// propose leur suppression ; RIEN n'est supprimé sans la confirmation de
// l'utilisateur. La suppression elle-même vit dans `PodmanLegacy.removeLeftovers`
// (seul code podman restant) : ce modèle ne tient que l'état d'écran.

import ConsoleCore
import Foundation

/// Les états du bandeau de nettoyage (S-6).
enum PodmanCleanupState: Equatable, Sendable {
    /// Rien à proposer : pas encore basculé, ou plus rien de l'ancien moteur.
    case hidden
    /// Le bandeau et son bouton « Supprimer l’ancien moteur… ».
    case offered
    /// La confirmation est à l'écran : rien n'a encore été touché.
    case confirming
    /// La suppression tourne.
    case removing
    /// La suppression a échoué ; le diagnostic brut est copiable.
    case failed(diagnostic: String)
}

@MainActor
final class PodmanCleanupModel: ObservableObject {
    @Published private(set) var state: PodmanCleanupState = .hidden

    private let paths: AppPaths
    private let legacy: PodmanLegacy

    init(
        paths: AppPaths = .standard(),
        environment: [String: String] = ProcessInfo.processInfo.environment,
        run: CommandRunner = .live
    ) {
        self.paths = paths
        legacy = PodmanLegacy(paths: paths, environment: environment, run: run)
    }

    /// `.offered` ssi la bascule a eu lieu ET qu'il reste `components/podman`,
    /// `config` ou `data` ; sinon `.hidden`. Une suppression en cours n'est pas
    /// interrompue. Appelé à l'apparition de la section et quand la préparation
    /// devient prête.
    func refresh() {
        guard state != .removing else { return }
        evaluate()
    }

    /// « Supprimer l’ancien moteur… » (ou « Réessayer » après un échec) : ouvre
    /// la confirmation, sans rien toucher.
    func requestRemoval() {
        switch state {
        case .offered, .failed: state = .confirming
        case .hidden, .confirming, .removing: break
        }
    }

    /// « Annuler » (ou ⎋) : la confirmation se referme, rien n'est touché.
    func cancel() {
        guard state == .confirming else { return }
        state = .offered
    }

    /// « Supprimer » dans la confirmation : la machine, puis le moteur et ses
    /// dossiers. Succès ⇒ le bandeau disparaît ; échec ⇒ `.failed` lisible.
    ///
    /// `.removing` est posé AVANT de rendre la main : le bouton du dialogue
    /// s'exécute avant sa fermeture, dont la liaison appelle `cancel()` — qui ne
    /// trouve alors plus `.confirming` et ne défait rien. La suppression tourne
    /// dans la tâche rendue (que les tests attendent).
    @discardableResult
    func confirm() -> Task<Void, Never>? {
        guard state == .confirming else { return nil }
        state = .removing
        return Task { await remove() }
    }

    private func remove() async {
        do {
            try await legacy.removeLeftovers()
            evaluate()
        } catch let error as PodmanCleanupError {
            state = .failed(diagnostic: MemoryText.podmanCleanupDiagnostic(error))
        } catch {
            state = .failed(diagnostic: error.localizedDescription)
        }
    }

    private func evaluate() {
        let switched = FileManager.default.fileExists(atPath: paths.switchState.path)
        state = switched && PodmanLegacy.hasLeftovers(paths: paths) ? .offered : .hidden
    }
}
