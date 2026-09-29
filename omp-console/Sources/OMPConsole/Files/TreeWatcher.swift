// La veille d'une cible : UN descripteur FSEvents sur la racine, récursif, sans
// scrutation (S-7).
//
// Quatre faits MESURÉS gouvernent ce fichier (## Documentation §2) :
//  1. `import CoreServices` se lie tout seul dans un paquet SwiftPM (aucun
//     `linkerSettings`), et compile en mode Swift 6 ;
//  2. le rappel reçoit `numEvents` en `Int` ;
//  3. un flux créé sur un RÉPERTOIRE est RÉCURSIF : creuser trois niveaux sous la
//     racine délivre bien des événements ;
//  4. `Create` + `SetDispatchQueue` + `Start` suffisent — pas de run loop.
//
// Le rappel s'exécute SUR la file donnée : l'état du veilleur reste confiné à une
// file série (même discipline que `StoreWatcher`), et `stop()` — comme le `deinit` —
// s'y synchronise avant de libérer le flux. C'est ce qui rend le `deinit` sûr avec
// un contexte C qui pointe le veilleur : plus aucun rappel ne peut être en vol
// quand `teardown()` a rendu la main.

import CoreServices
import Dispatch
import Foundation

final class TreeWatcher: @unchecked Sendable {
    /// Sert à reconnaître la file du veilleur : un `queue.sync` depuis sa propre
    /// file interbloquerait, et le `deinit` doit pouvoir s'en apercevoir.
    private static let queueKey = DispatchSpecificKey<Void>()

    let path: String
    /// `false` quand l'armement a échoué : la vue le dit alors (S-7) au lieu de
    /// laisser croire que la cible est surveillée.
    private(set) var isArmed = false

    private let queue: DispatchQueue
    private let latency: CFTimeInterval
    private var stream: FSEventStreamRef?
    private var subscribers: [UUID: AsyncStream<Void>.Continuation] = [:]
    private var stopped = false

    init(
        watch path: String,
        latency: CFTimeInterval = 0.2,
        queue: DispatchQueue = DispatchQueue(label: "omp.console.files.watch")
    ) {
        self.path = path
        self.latency = latency
        self.queue = queue
        queue.setSpecific(key: Self.queueKey, value: ())
        arm()
    }

    /// Un abonnement indépendant : un élément par LOT d'événements, jamais un par
    /// fichier. Aucun élément initial — contrairement aux veilles de store, l'état
    /// courant n'est pas un événement, et l'appelant vient de le lire.
    func changes() -> AsyncStream<Void> {
        let (stream, continuation) = AsyncStream<Void>.makeStream()
        let id = UUID()
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            self.queue.async { [weak self] in self?.subscribers[id] = nil }
        }
        queue.sync {
            guard !stopped else {
                continuation.finish()
                return
            }
            subscribers[id] = continuation
        }
        return stream
    }

    /// Désarme la veille et TERMINE tous les flux. Idempotent.
    func stop() {
        if DispatchQueue.getSpecific(key: Self.queueKey) != nil {
            teardown()
        } else {
            queue.sync { teardown() }
        }
    }

    deinit {
        // Sans `queue.sync` depuis la file elle-même (interblocage) : `teardown` y
        // vérifie où il tourne.
        stop()
    }

    // MARK: - Cycle de vie du flux

    private func arm() {
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, _, _, _ in
            guard let info, count > 0 else { return }
            let watcher = Unmanaged<TreeWatcher>.fromOpaque(info).takeUnretainedValue()
            watcher.handleEvents()
        }
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer
        )
        guard let stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            [path] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            latency,
            flags
        ) else {
            isArmed = false
            return
        }
        FSEventStreamSetDispatchQueue(stream, queue)
        if FSEventStreamStart(stream) {
            self.stream = stream
            isArmed = true
        } else {
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            isArmed = false
        }
    }

    /// `Stop` → `Invalidate` → `Release` : l'ordre exigé par l'en-tête. Après
    /// `Invalidate`, plus aucun rappel n'est déposé sur la file — et ceux déjà
    /// déposés ont été drainés par le `sync` de l'appelant.
    private func teardown() {
        guard !stopped else { return }
        stopped = true
        if let stream {
            FSEventStreamStop(stream)
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            self.stream = nil
        }
        for continuation in subscribers.values { continuation.finish() }
        subscribers.removeAll()
    }

    /// Un lot d'événements, quel qu'il soit : la cible a bougé, l'appelant relit.
    ///
    /// Un lot qui signale `MustScanSubDirs` (dossier renommé, file interne
    /// débordée) est traité PAREIL : la réaction à un lot est déjà une relecture
    /// COMPLÈTE de l'arbre, qui est exactement le « rescan » exigé par S-7 — il n'y
    /// a donc rien à réarmer ici.
    private func handleEvents() {
        guard !stopped else { return }
        for continuation in subscribers.values { continuation.yield(()) }
    }
}
