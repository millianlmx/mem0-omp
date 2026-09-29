// La veille d'UN fichier quelconque (S-3 de `visionneuse-de-session`, réutilisée
// par la veille du document de projet) : une source vnode sur le fichier, jamais
// de scrutation, et un réveil seulement quand le fichier a RÉELLEMENT changé.
//
// Faits MESURÉS gouvernant ce fichier (Documentation §4, plus la sonde FSEvents du
// 2026-09-29) :
//   — une source NEUVE est créée suspendue : rien n'est délivré avant `resume()` ;
//   — `open` d'un chemin absent échoue (ENOENT) : on veille l'ancêtre existant le
//     plus proche, et l'APPARITION de la cible sous cet ancêtre est bien vue (c'est
//     ce que prouve `StoreWatchTests.absentStoreEmitsWhenItAppears`) — c'est le
//     fondement de la reprise automatique de AC-13 ;
//   — un même ajout délivre PLUSIEURS événements (masque mesuré
//     `WRITE|EXTEND`) : sans comparaison d'instantané, le lecteur serait réveillé
//     deux fois pour un octet ;
//   — ARMER PUIS LIRE : une source neuve est armée AVANT la première lecture de
//     l'appelant, sinon le changement survenu pendant la bascule est perdu ;
//   — un fichier qui EXISTE sans droit de lecture (mesuré : `open(…, O_EVTONLY)`
//     rend EACCES) ne peut PAS être veillé par vnode, et la source vnode armée sur
//     son RÉPERTOIRE ne délivre RIEN pour un changement du FICHIER (mesuré le
//     2026-09-29 : ni `chmod` ni octets ajoutés — seul un frère créé/renommé
//     délivre). C'était le trou qui laissait AC-13 sans reprise : dans ce cas
//     SEULEMENT, la veille passe à FSEvents sur le répertoire, et revient au vnode
//     dès que le fichier redevient ouvrable.
//
// L'instantané de veille se lit par `attributesOfItem` : taille, appareil, inode
// et date de modification, donc AUCUN octet de donnée du fichier.

import CoreServices
import Darwin
import Dispatch
import Foundation

/// L'instantané d'un fichier : ce qui distingue deux états sans lire un octet.
///
/// La permission fait partie de l'instantané. Sans elle, un fichier qui REDEVIENT
/// lisible (changement de mode seul : ni la taille ni la date ne bougent) ne
/// produirait aucun réveil, donc la reprise automatique de AC-13 resterait lettre
/// morte — mesuré : `open(path, O_EVTONLY)` échoue même en EACCES sur un fichier
/// sans droit de lecture.
private struct FileSnapshot: Equatable {
    var device: UInt64
    var inode: UInt64
    var size: Int
    var modified: Date?
    var permissions: Int

    /// `nil` quand le chemin n'existe pas (ou plus).
    static func read(_ path: String) -> FileSnapshot? {
        guard let attributes = try? FileManager.default.attributesOfItem(atPath: path) else { return nil }
        return FileSnapshot(
            device: (attributes[.systemNumber] as? NSNumber)?.uint64Value ?? 0,
            inode: (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0,
            size: (attributes[.size] as? NSNumber)?.intValue ?? 0,
            modified: attributes[.modificationDate] as? Date,
            permissions: (attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0
        )
    }
}

/// La veille d'UN fichier. Une veille par consommateur, jamais partagée.
///
/// `@unchecked Sendable` : tout l'état mutable est confiné à `queue`, une file
/// série — y compris les rappels de la source ET ceux du flux FSEvents, qui s'y
/// exécutent (le flux est créé par `SetDispatchQueue`, jamais par une run loop).
final class FileWatcher: @unchecked Sendable {
    /// Sert à reconnaître la file de la veille : un `queue.sync` depuis sa propre
    /// file interbloquerait, et `deinit` doit pouvoir s'en apercevoir.
    private static let queueKey = DispatchSpecificKey<Void>()

    /// Les réveils. UNE SEULE consommation, tampon `.bufferingNewest(1)` : des
    /// événements en rafale ne doivent pas empiler des réveils derrière un lecteur
    /// plus lent qu'eux.
    let changes: AsyncStream<Void>

    private let path: String
    private let queue: DispatchQueue
    private let continuation: AsyncStream<Void>.Continuation
    private var source: (any DispatchSourceFileSystemObject)?
    private var watchedPath: String?
    /// Le repli FSEvents, armé SEULEMENT quand la cible existe sans être ouvrable en
    /// `O_EVTONLY` (voir `arm()`).
    private var directoryStream: FSEventStreamRef?
    private var watchedDirectory: String?
    private var snapshot: FileSnapshot?
    private var stopped = false

    init(path: String) {
        self.path = path
        let queue = DispatchQueue(label: "omp.console.viewer.watch")
        queue.setSpecific(key: Self.queueKey, value: ())
        self.queue = queue
        let (stream, continuation) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        self.changes = stream
        self.continuation = continuation
        self.snapshot = FileSnapshot.read(path)
        // Armer PUIS laisser l'appelant lire : personne d'autre ne détient encore
        // cette instance, l'appel direct est donc sûr et évite un aller-retour.
        arm()
    }

    /// Désarme la veille et TERMINE le flux. Idempotent.
    func stop() {
        if DispatchQueue.getSpecific(key: Self.queueKey) != nil {
            teardown()
        } else {
            queue.sync { teardown() }
        }
    }

    deinit {
        // `stop()` sait où il tourne (clé de file) : le démontage FSEvents exige un
        // `sync` qui DRAINE les rappels déjà déposés avant de libérer le flux, sinon
        // un rappel en vol toucherait un contexte libéré.
        stop()
    }

    // MARK: - Événements

    /// Un événement de la source vnode : réarmer la cible courante (le nœud surveillé
    /// a pu disparaître, et le fichier a pu apparaître), puis n'émettre que si
    /// l'instantané a changé. Le ré-armement est SYNCHRONE : si le nœud surveillé a
    /// disparu, la source ne délivre plus rien, et un tour de file de retard serait
    /// une fenêtre d'aveuglement gratuite.
    private func handleVnodeEvent() {
        guard !stopped else { return }
        arm()
        emitIfChanged()
    }

    /// Un lot FSEvents (repli d'un fichier existant non ouvrable) : le ré-armement est
    /// DIFFÉRÉ d'un tour de file — libérer un flux FSEvents depuis son propre rappel
    /// n'est pas sûr —, la comparaison d'instantanés, elle, est immédiate.
    private func handleDirectoryEvent() {
        guard !stopped else { return }
        queue.async { [weak self] in self?.arm() }
        emitIfChanged()
    }

    /// Émet UN réveil si, et seulement si, l'instantané du fichier de session a changé.
    private func emitIfChanged() {
        let fresh = FileSnapshot.read(path)
        guard fresh != snapshot else { return }
        snapshot = fresh
        continuation.yield(())
    }

    // MARK: - Veille

    /// (Ré)arme la veille sur la cible courante.
    ///
    /// Chemin NOMINAL : une source vnode sur la cible — le fichier s'il existe, sinon
    /// l'ANCÊTRE EXISTANT LE PLUS PROCHE (`open` d'un chemin absent échoue, et c'est
    /// l'apparition de la cible sous cet ancêtre qui délivre l'événement).
    ///
    /// Repli MESURÉ : quand la cible EXISTE sans être ouvrable en `O_EVTONLY`, aucune
    /// source vnode ne peut être armée dessus, et la source armée sur son RÉPERTOIRE
    /// ne délivre RIEN pour le fichier lui-même. On veille alors le RÉPERTOIRE par
    /// FSEvents ; le ré-armement rend le vnode dès que le fichier redevient ouvrable.
    private func arm() {
        guard !stopped else { return }
        let target = watchTarget()
        guard let descriptor = openTarget(target) else {
            disarmVnode()
            armDirectoryWatch(directory: (target as NSString).deletingLastPathComponent)
            return
        }
        disarmDirectoryWatch()
        guard watchedPath != target || source == nil else {
            // Même cible, source déjà en place : la recréer perdrait les événements
            // déjà déposés, et viderait le tampon du noyau.
            _ = close(descriptor)
            return
        }
        disarmVnode()
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor,
            eventMask: [.write, .delete, .rename, .revoke, .attrib, .extend, .link],
            queue: queue
        )
        source.setEventHandler { [weak self] in self?.handleVnodeEvent() }
        // Un cancel handler est exigé pour les sources fondées sur un descripteur :
        // il est le SEUL endroit qui ferme le descripteur.
        source.setCancelHandler { _ = close(descriptor) }
        self.source = source
        self.watchedPath = target
        source.resume()
    }

    /// La cible NOMINALE : le fichier s'il existe, sinon l'ANCÊTRE EXISTANT LE PLUS
    /// PROCHE.
    private func watchTarget() -> String {
        var candidate = path
        while !FileManager.default.fileExists(atPath: candidate) {
            let parent = (candidate as NSString).deletingLastPathComponent
            if parent.isEmpty || parent == candidate { return candidate }
            candidate = parent
        }
        return candidate
    }

    /// Ouvre EXACTEMENT ce chemin en `O_EVTONLY`. `nil` s'il n'existe pas (ENOENT)
    /// ou s'il n'est pas ouvrable (EACCES sur un fichier sans droit de lecture).
    private func openTarget(_ candidate: String) -> Int32? {
        let descriptor = open(candidate, O_EVTONLY)
        return descriptor >= 0 ? descriptor : nil
    }

    private func disarmVnode() {
        source?.cancel()
        source = nil
        watchedPath = nil
    }

    // MARK: - Repli FSEvents

    /// Un flux FSEvents sur le RÉPERTOIRE de la cible : `FileEvents`, sans run loop
    /// (`SetDispatchQueue`), donc ses rappels s'exécutent sur `queue` et l'état du
    /// veilleur reste confiné à une file série.
    ///
    /// Le FILTRAGE par chemin est écarté volontairement : mesuré le 2026-09-29, les
    /// chemins rendus par FSEvents sont RÉSOLUS (`/private/var/…`) quand le chemin de
    /// session est `/var/…` — un filtre par égalité de chaînes serait muet, donc
    /// recréerait exactement le silence que ce repli supprime. L'unique filtre qui
    /// compte est la comparaison d'instantanés : un événement d'un frère du
    /// répertoire ne délivre aucun réveil.
    private func armDirectoryWatch(directory: String) {
        guard !directory.isEmpty else { return }
        guard watchedDirectory != directory || directoryStream == nil else { return }
        disarmDirectoryWatch()
        var context = FSEventStreamContext(
            version: 0,
            info: Unmanaged.passUnretained(self).toOpaque(),
            retain: nil,
            release: nil,
            copyDescription: nil
        )
        // Le rappel reçoit `(stream, info, numEvents, eventPaths, flags, ids)` ; seul
        // `info` sert : le contexte porte le veilleur, sans capture forte (le flux
        // FSEvents ne retient donc pas son propriétaire).
        let callback: FSEventStreamCallback = { _, info, count, _, _, _ in
            guard let info, count > 0 else { return }
            Unmanaged<FileWatcher>.fromOpaque(info).takeUnretainedValue().handleDirectoryEvent()
        }
        let flags = FSEventStreamCreateFlags(
            kFSEventStreamCreateFlagFileEvents | kFSEventStreamCreateFlagNoDefer
        )
        guard let stream = FSEventStreamCreate(
            nil,
            callback,
            &context,
            [directory] as CFArray,
            FSEventStreamEventId(kFSEventStreamEventIdSinceNow),
            0.1,
            flags
        ) else { return }
        FSEventStreamSetDispatchQueue(stream, queue)
        guard FSEventStreamStart(stream) else {
            FSEventStreamInvalidate(stream)
            FSEventStreamRelease(stream)
            return
        }
        directoryStream = stream
        watchedDirectory = directory
    }

    /// `Stop` → `Invalidate` → `Release` : l'ordre exigé par l'en-tête. Appelé sur
    /// `queue` (jamais depuis le rappel du flux lui-même, que `handleDirectoryEvent`
    /// diffère d'un tour de file), il draine donc les rappels déjà déposés.
    private func disarmDirectoryWatch() {
        guard let stream = directoryStream else { return }
        directoryStream = nil
        watchedDirectory = nil
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
    }

    // MARK: - Arrêt

    private func teardown() {
        guard !stopped else { return }
        stopped = true
        disarmVnode()
        disarmDirectoryWatch()
        continuation.finish()
    }
}
