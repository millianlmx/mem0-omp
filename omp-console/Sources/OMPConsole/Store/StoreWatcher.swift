// Veille d'UN store par notification du système de fichiers (S-9) : une source
// vnode sur le répertoire du store, jamais de scrutation.
//
// Quatre faits MESURÉS gouvernent ce fichier (Documentation §1-§3) :
//  1. une source NEUVE est créée suspendue : rien n'est délivré avant `resume()` ;
//  2. `open` d'un chemin absent échoue (ENOENT) : on veille l'ancêtre existant le
//     plus proche, et la création du répertoire surveillé est bien vue (masque
//     WRITE|LINK sur son parent) — mais AUCUNE écriture dans un petit-fils ne l'est ;
//  3. une source dont le nœud a été supprimé n'est pas annulée par le système et ne
//     délivre plus rien : il faut la désarmer et en armer une neuve ;
//  4. ARMER PUIS LIRE : relire avant de réarmer perd le changement survenu pendant
//     la bascule (mesuré) — l'ordre inverse ferme la course.
//
// FSEvents est écarté (Documentation §10) : il coalesce par le TEMPS, or l'unicité
// d'émission exigée par AC-13 se déduit d'une comparaison d'instantanés, jamais
// d'une fenêtre temporelle (qui fusionnerait aussi deux publications distinctes).

import Darwin
import Dispatch
import Foundation

/// Une veille et ses abonnés. `S` doit être `Equatable` : c'est la comparaison
/// d'instantanés qui décide d'émettre, et c'est elle qui rend l'émission UNIQUE
/// pour une publication atomique (deux événements `.write` mesurés, un seul
/// instantané neuf).
///
/// `@unchecked Sendable` : tout l'état mutable (`source`, `latest`, `subscribers`)
/// est confiné à `queue`, une file série — y compris les rappels de la source, qui
/// s'exécutent dessus.
final class StoreWatcher<S: Sendable & Equatable>: @unchecked Sendable {
    /// Comment lire ce store. Fourni à l'initialisation : la veille est une seule
    /// classe, jamais six copies, et le type lu en découle.
    typealias Read = @Sendable (String, StoreClock) -> S

    let store: PipelineStore
    private let stateDir: String
    private let clock: StoreClock
    private let read: Read
    private let queue: DispatchQueue
    private var source: (any DispatchSourceFileSystemObject)?
    private var watchedPath: String?
    private var latest: S?
    private var emitted: S?
    private var subscribers: [UUID: AsyncStream<S>.Continuation] = [:]
    private var stopped = false

    /// `nowMs` est injectable : un test de péremption fixe son instant au lieu de
    /// dépendre de l'horloge murale.
    init(
        store: PipelineStore,
        stateDir: String = PipelineStore.stateDir(),
        nowMs: @escaping @Sendable () -> Double = { StoreClock.live.nowMs() },
        read: @escaping Read
    ) {
        self.store = store
        self.stateDir = stateDir
        self.clock = StoreClock(nowMs: nowMs)
        self.read = read
        self.queue = DispatchQueue(label: "omp.console.store.\(store.rawValue)")
        // Armement PUIS lecture : la course « lire avant d'armer » perdrait le
        // changement survenu juste après la relecture (mesuré).
        arm()
        refresh()
    }

    /// L'instantané courant, tenu à jour par la veille (aucun accès disque s'il a
    /// déjà été lu).
    func current() -> S {
        queue.sync { latest ?? read(stateDir, clock) }
    }

    /// Un abonnement INDÉPENDANT. Son PREMIER élément est l'instantané courant —
    /// un abonné neuf n'attend donc pas un changement pour voir l'état — puis un
    /// élément par changement réel, poussé à TOUS les abonnés vivants (multicast).
    func snapshots() -> AsyncStream<S> {
        let (stream, continuation) = AsyncStream<S>.makeStream()
        let id = UUID()
        // Une `Task` d'itération annulée termine le flux (doc §5) : on retire alors
        // l'abonné. Aucune capture forte de `self` dans un bloc de file : la
        // dernière référence pourrait être relâchée SUR la file (interblocage au
        // `queue.sync` de `stop()`).
        continuation.onTermination = { [weak self] _ in
            guard let self else { return }
            self.queue.async { [weak self] in self?.removeSubscriber(id) }
        }
        queue.sync {
            guard !stopped else {
                continuation.finish()
                return
            }
            subscribers[id] = continuation
            continuation.yield(latest ?? read(stateDir, clock))
        }
        return stream
    }

    /// Désarme la veille et TERMINE tous les flux. Idempotent.
    func stop() {
        queue.sync {
            guard !stopped else { return }
            stopped = true
            disarm()
            for continuation in subscribers.values { continuation.finish() }
            subscribers.removeAll()
        }
    }

    deinit {
        // Pas de `queue.sync` ici : libérer la dernière référence DEPUIS la file y
        // bloquerait. `cancel()` est sûr depuis n'importe quelle file et déclenche
        // le cancel handler, qui ferme le descripteur.
        source?.cancel()
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers[id] = nil
    }

    /// Un événement : la cible peut avoir changé (le nœud surveillé a disparu), on
    /// réarme ; puis on relit — et on n'émet que si l'instantané a changé.
    private func handleEvent() {
        guard !stopped else { return }
        arm()
        refresh()
    }

    /// (Ré)arme la source sur la cible courante. Sans changement de cible, garde la
    /// source en place : la réarmer à chaque événement perdrait des événements.
    private func arm() {
        let target = watchTarget()
        guard target != watchedPath else { return }
        disarm()
        let fd = open(target, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .delete, .rename, .revoke, .attrib, .extend, .link],
            queue: queue
        )
        source.setEventHandler { [weak self] in self?.handleEvent() }
        // Un cancel handler est exigé pour les sources fondées sur un descripteur :
        // il est le SEUL endroit qui ferme le descripteur (S-10).
        source.setCancelHandler { _ = close(fd) }
        self.source = source
        self.watchedPath = target
        // Une source neuve est suspendue : sans `resume()`, aucun événement.
        source.resume()
    }

    private func disarm() {
        source?.cancel()
        source = nil
        watchedPath = nil
    }

    /// Le store s'il existe, sinon l'ancêtre existant le plus proche (`open` d'un
    /// chemin absent échoue ENOENT : il n'y a rien à veiller).
    private func watchTarget() -> String {
        var candidate = PipelineStore.directory(store, stateDir: stateDir)
        while !FileManager.default.fileExists(atPath: candidate) {
            let parent = (candidate as NSString).deletingLastPathComponent
            if parent.isEmpty || parent == candidate { return candidate }
            candidate = parent
        }
        return candidate
    }

    /// Relit le store et émet SI ET SEULEMENT SI l'instantané a changé.
    ///
    /// C'est ce qui donne exactement une émission par publication atomique : le
    /// `rename` délivre deux événements `.write` (mesuré), la première relecture
    /// rend un instantané identique (le `.tmp-<pid>` est filtré, S-8) et n'émet
    /// donc rien ; la seconde rend l'instantané neuf et émet une fois.
    private func refresh() {
        let fresh = read(stateDir, clock)
        latest = fresh
        guard emitted != fresh else { return }
        emitted = fresh
        for continuation in subscribers.values { continuation.yield(fresh) }
    }
}
