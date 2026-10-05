// L'état de présence des deux composants embarqués de l'app (S-1, BR-1) : le
// binaire de chacun est-il un fichier EXÉCUTABLE ? C'est la SEULE question
// posée — jamais leur état de marche (aucun `omp --version`, aucune machine
// podman, aucun conteneur, aucun `/health`) : le badge dit « installé ou pas »,
// pas « en marche ou pas ».
//
// La lecture ne lève JAMAIS : une erreur d'accès est une absence. Les chemins
// sont ceux du manifeste épinglé, composés par `ComponentInstaller` — une seule
// composition de chemin dans toute l'app, celle où l'installateur écrit et où
// le badge veille.
//
// Le modèle vit à l'échelle de l'app : sa valeur est disponible dès l'`init`
// (lecture locale, synchrone), puis recalculée à chaque changement RÉEL de l'un
// des deux binaires — deux veilles vnode (`FileWatcher`), jamais de scrutation,
// et rien n'est publié si l'état n'a pas bougé.

import Combine
import Foundation

/// Un composant embarqué de l'app, dans l'ordre où le badge les nomme.
enum ComponentID: String, CaseIterable, Sendable {
    case omp, podman

    /// Le nom porté par les erreurs de l'installateur (`ComponentInstaller`) :
    /// une seule table de noms pour toute l'app, jamais deux graphies.
    var name: String {
        switch self {
        case .omp: ComponentInstaller.ompComponent
        case .podman: ComponentInstaller.podmanComponent
        }
    }
}

/// L'état de présence des composants embarqués : ceux dont le binaire n'est pas
/// (ou plus) un fichier exécutable.
struct ComponentPresence: Equatable, Sendable {
    /// Les composants manquants, dans l'ordre de `ComponentID.allCases` et sans
    /// doublon — l'`init` en est la garantie.
    let missing: [ComponentID]

    init(missing: [ComponentID]) {
        self.missing = ComponentID.allCases.filter(missing.contains)
    }

    var allInstalled: Bool { missing.isEmpty }

    /// Le mot et le ton du badge (S-1) : le mot est porté par `SetupText` seul,
    /// le ton ne fait que le doubler (accessibilité).
    var status: ConsoleStatus {
        ConsoleStatus(
            text: SetupText.componentsWord(missing),
            tone: allInstalled ? .success : .attention
        )
    }

    /// Lit l'état réel des deux composants sur le disque (S-1). Le prédicat de
    /// présence ne lève jamais, donc cette lecture non plus.
    @MainActor
    static func read(_ installer: ComponentInstaller) -> ComponentPresence {
        ComponentPresence(missing: ComponentID.allCases.filter { !installer.isInstalled($0) })
    }
}

/// Le recalcul continu de l'état (S-3, BR-1) : une veille par binaire, armée sur
/// le chemin du manifeste, et une publication seulement quand la présence a
/// réellement changé.
@MainActor
final class ComponentPresenceModel: ObservableObject {
    @Published private(set) var presence: ComponentPresence

    private let installer: ComponentInstaller
    private var watchers: [ComponentID: FileWatcher] = [:]
    private var watchTasks: [ComponentID: Task<Void, Never>] = [:]

    init(
        paths: AppPaths = .standard(),
        manifest: ComponentManifest = .current,
        watch: Bool = true
    ) {
        let installer = ComponentInstaller(paths: paths, manifest: manifest)
        self.installer = installer
        self.presence = ComponentPresence.read(installer)
        if watch { arm() }
    }

    deinit {
        for task in watchTasks.values { task.cancel() }
    }

    /// Arme une veille par binaire, sur le chemin EXACT du manifeste : quand le
    /// chemin n'existe pas, `FileWatcher` veille l'ancêtre existant le plus
    /// proche et voit l'apparition. Les deux chemins sont disjoints, donc aucun
    /// ordre n'est requis entre les veilles.
    private func arm() {
        for id in ComponentID.allCases {
            let watcher = FileWatcher(path: installer.binaryLocation(id).path)
            watchers[id] = watcher
            let changes = watcher.changes
            watchTasks[id] = Task { [weak self] in
                for await _ in changes {
                    guard let self else { return }
                    self.refresh()
                }
            }
        }
    }

    /// Recalcule l'état des deux composants et ne le publie que s'il a changé :
    /// les deux veilles peuvent se réveiller pour le même geste, et un
    /// rafraîchissement sans changement réel ne doit rien émettre.
    private func refresh() {
        let fresh = ComponentPresence.read(installer)
        guard fresh != presence else { return }
        presence = fresh
    }
}
