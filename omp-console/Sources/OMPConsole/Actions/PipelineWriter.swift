// L'écrivain du canal côté app (S-1, S-2, S-4, S-11) : les SEULES écritures de
// l'app — une livraison dans la boîte publiée d'un run, une commande dans le canal
// — et la lecture seule des accusés que le pilote écrit.
//
// Publication EXCLUSIVE et ATOMIQUE (`link(2)`, man 2 link, §4) : le contenu est
// écrit dans un temporaire `<fichier>.tmp-<pid>` du répertoire CIBLE, puis publié
// par `link(temp, cible)` — un seul appel qui rend `EEXIST` si la cible existe
// déjà, et qui n'expose donc la cible qu'ABSENTE ou COMPLÈTE, jamais partielle.
// `rename(2)` est écarté (contrat) : il REMPLACE la cible (« If new exists, it is
// first removed »), donc deux écritures au même nom s'écraseraient.
//
// La création du temporaire est elle-même EXCLUSIVE (`O_CREAT|O_EXCL`, §3). Après
// un `EINTR`, l'existence du fichier est NON SPÉCIFIÉE : on passe au nom suivant au
// lieu de réessayer le même. Aucune pré-vérification `fileExists` n'a lieu — c'est
// la course que B-3 ferme.
//
// Confinement (B-1) : `writeDelivery` REFUSE tout chemin `inbox` qui sort de
// `<stateDir>/inbox/`, AVANT toute création de dossier — la canonisation décide,
// jamais l'écriture.
//
// Aucune autre écriture n'existe ici : ni `lots/`, ni `running/`, ni `history/`,
// ni `projects/`, ni `audit/`, ni `commands/acks/` (S-11).

import Darwin
import Foundation

/// L'échec d'une écriture, à motif STABLE : `écriture impossible (<strerror>)`,
/// jamais `localizedDescription` (BR-1). Le refus de confinement porte, lui, le
/// motif `chemin refusé (<chemin brut>) : hors de <stateDir>/inbox` (B-1).
struct PipelineWriteFailure: Error, Equatable {
    let reason: String
}

/// Les appels système de la publication, derrière un seam injectable (patron
/// `StoreClock`) : les preuves pilotent `EINTR`, `EEXIST` et `EIO` sans dépendre
/// d'une course réelle sur le disque.
struct PipelineFileOps: Sendable {
    /// `open(chemin, O_WRONLY|O_CREAT|O_EXCL, 0o644)` — `(descripteur, errno)`,
    /// `errno == 0` quand le descripteur est valide.
    var createExclusive: @Sendable (String) -> (Int32, Int32)
    /// UN `write(2)` des octets à partir de l'offset — `(octets écrits, errno)`.
    var write: @Sendable (Int32, Data, Int) -> (Int, Int32)
    /// `close(2)` — `0` ou son `errno`.
    var close: @Sendable (Int32) -> Int32
    /// `link(temp, cible)` — `0` ou son `errno` (`EEXIST` quand la cible existe).
    var link: @Sendable (String, String) -> Int32
    /// `unlink(2)` — `0` ou son `errno`.
    var unlink: @Sendable (String) -> Int32
    /// `mkdir(2)` — `0` ou son `errno`.
    var mkdir: @Sendable (String, mode_t) -> Int32

    static let live = PipelineFileOps(
        createExclusive: { path in
            // `O_EXCL` échoue même sur un lien symbolique, fût-il mort (§3).
            let descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL, 0o644)
            return descriptor >= 0 ? (descriptor, 0) : (-1, errno)
        },
        write: { descriptor, data, offset in
            let count = data.withUnsafeBytes { buffer -> Int in
                guard let base = buffer.baseAddress else { return 0 }
                return Darwin.write(descriptor, base.advanced(by: offset), buffer.count - offset)
            }
            return count >= 0 ? (count, 0) : (-1, errno)
        },
        close: { descriptor in
            Darwin.close(descriptor) == 0 ? 0 : errno
        },
        link: { source, target in
            Darwin.link(source, target) == 0 ? 0 : errno
        },
        unlink: { path in
            Darwin.unlink(path) == 0 ? 0 : errno
        },
        mkdir: { path, mode in
            Darwin.mkdir(path, mode) == 0 ? 0 : errno
        }
    )
}

struct PipelineWriter: Sendable {
    let stateDir: String
    private let fileOps: PipelineFileOps

    init(stateDir: String = PipelineStore.stateDir(), fileOps: PipelineFileOps = .live) {
        self.stateDir = stateDir
        self.fileOps = fileOps
    }

    /// La borne du nombre de noms candidats d'une publication (B-3) : au-delà,
    /// `écriture impossible (aucun nom libre)`.
    static let uniqueNameLimit = 1000

    /// `<stateDir>/commands` — le canal.
    var commandDir: String { joinPath(stateDir, "commands") }

    /// `<stateDir>/commands/acks` — les accusés, un fichier par identifiant traité.
    var commandAckDir: String { joinPath(commandDir, "acks") }

    /// `<stateDir>/inbox` — la SEULE zone où une livraison peut être déposée (B-1).
    var inboxRoot: String { joinPath(stateDir, "inbox") }

    /// Le nom d'un fichier de livraison COMME d'une commande :
    /// `<sentAt 16 chiffres>-<salt 4 hex>.json` — les suffixes `-1`, `-2`… sont
    /// ajoutés à la publication quand le nom est pris (parité `writeDelivery`).
    static func fileName(sentAt: Double, salt: String) -> String {
        "\(stamp(sentAt))-\(salt).json"
    }

    /// Le chemin de l'accusé d'un identifiant : `<stateDir>/commands/acks/<id>.json`.
    func ackPath(id: String) -> String {
        joinPath(commandAckDir, "\(id).json")
    }

    // --- confinement (B-1) ---------------------------------------------------

    /// Le chemin RÉEL d'un chemin ABSOLU, `nil` s'il ne l'est pas : `realpath`
    /// quand il réussit, sinon le plus long préfixe qu'il résout suivi de la queue
    /// repliée lexicalement (`.` ignoré, `..` dépile, jamais au-dessus de `/`).
    /// La queue non existante peut donc porter `.` et `..` ; un `..` placé derrière
    /// un composant EXISTANT est résolu par le noyau, comme `realpath` le ferait.
    static func canonicalPath(_ path: String) -> String? {
        guard path.hasPrefix("/") else { return nil }
        let components = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        var base = "/"
        var tail = components[...]
        for length in stride(from: components.count, through: 1, by: -1) {
            let candidate = "/" + components[0..<length].joined(separator: "/")
            guard let resolved = resolvedPath(candidate) else { continue }
            base = resolved
            tail = components[length...]
            break
        }
        for component in tail {
            switch component {
            case ".":
                continue
            case "..":
                guard let slash = base.lastIndex(of: "/"), slash > base.startIndex else {
                    base = "/"
                    continue
                }
                base = String(base[base.startIndex..<slash])
            default:
                base = joinPath(base, component)
            }
        }
        return base
    }

    /// Vrai si, et seulement si `inbox` vaut `inboxRoot` ou vit SOUS lui (B-1) : un
    /// chemin vide, relatif, ou hors zone est refusé. La comparaison porte sur les
    /// chemins RÉELS des deux côtés (une zone traversant `/var` → `/private/var`
    /// reste donc admise).
    func isConfinedInbox(_ inbox: String) -> Bool {
        guard let root = Self.canonicalPath(inboxRoot), let candidate = Self.canonicalPath(inbox) else {
            return false
        }
        return candidate == root || candidate.hasPrefix(root + "/")
    }

    /// `realpath(3)`, ou `nil` quand le noyau ne résout pas le chemin.
    private static func resolvedPath(_ path: String) -> String? {
        var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(path, &buffer) != nil else { return nil }
        let bytes = buffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) }
        return String(decoding: bytes, as: UTF8.self)
    }

    // --- livraisons ----------------------------------------------------------

    /// Écrit une livraison dans la boîte d'un run : zone VÉRIFIÉE d'abord, dossier
    /// créé au besoin, puis publication exclusive. Rend le chemin écrit.
    @discardableResult
    func writeDelivery(
        inbox: String,
        delivery: OutgoingDelivery,
        sentAt: Double,
        salt: String
    ) throws -> String {
        guard isConfinedInbox(inbox) else {
            throw PipelineWriteFailure(reason: "chemin refusé (\(inbox)) : hors de \(inboxRoot)")
        }
        try ensureDirectory(inbox)
        return try publish(delivery.object(sentAt: sentAt), in: inbox, sentAt: sentAt, salt: salt)
    }

    // --- commandes -----------------------------------------------------------

    /// Écrit une commande dans le canal et **ne la retire jamais** (seul le pilote
    /// le fait, après avoir écrit l'accusé). Rend le chemin écrit.
    @discardableResult
    func writeCommand(_ command: OutgoingCommand, sentAt: Double, salt: String) throws -> String {
        try ensureDirectory(commandDir)
        return try publish(command.object(sentAt: sentAt), in: commandDir, sentAt: sentAt, salt: salt)
    }

    /// L'accusé d'une commande : `nil` s'il est ABSENT, ILLISIBLE ou hors schéma
    /// (`asCommandAck`, commands.ts:150-162) — l'entrée de journal reste alors en
    /// attente, sans exception.
    func readAck(id: String) -> PipelineCommandAck? {
        guard PipelineId.isValid(id) else { return nil }
        guard let data = FileManager.default.contents(atPath: ackPath(id: id)) else { return nil }
        guard let json = JSONValue.parse(data), case .object(let a) = json else { return nil }
        guard isVersion1(a["version"]) else { return nil }
        guard let fileId = asString(a["id"]), fileId == id, PipelineId.isValid(fileId) else { return nil }
        guard asString(a["repo"]) != nil else { return nil }
        let kind = a["kind"]
        if kind != .null, asString(kind) == nil { return nil }
        guard let state = CommandAckState(rawValue: asString(a["state"]) ?? "") else { return nil }
        let rawReason = a["reason"]
        var reason: String?
        if rawReason != .null {
            guard let text = asString(rawReason) else { return nil }
            reason = text
        }
        guard let at = asNumber(a["at"]) else { return nil }
        return PipelineCommandAck(id: fileId, state: state, reason: reason, at: at)
    }

    // --- publication exclusive (B-3) ------------------------------------------

    /// Publie `object` dans `directory` sous le PREMIER nom libre de la famille
    /// `<stamp 16>-<salt>.json`, `-1`, `-2`… Rend le chemin publié.
    private func publish(
        _ object: [String: Any],
        in directory: String,
        sentAt: Double,
        salt: String
    ) throws -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            throw Self.failure(EINVAL)
        }
        let base = Self.fileName(sentAt: sentAt, salt: salt)
        let stem = String(base.dropLast(".json".count))
        for index in 0..<Self.uniqueNameLimit {
            let candidate = index == 0 ? base : "\(stem)-\(index).json"
            let target = joinPath(directory, candidate)
            if try publishAtomic(data, to: target) { return target }
        }
        throw PipelineWriteFailure(reason: "écriture impossible (aucun nom libre)")
    }

    /// Écrit un temporaire puis le PUBLIE sur `target` sans jamais l'écraser :
    /// `false` quand `target` était pris (le nom suivant sera essayé), `true` quand
    /// il a publié, une levée sur tout autre échec. Tout échec retire le temporaire
    /// en meilleur effort (§4 : un temporaire non `.json` est invisible du pilote).
    private func publishAtomic(_ data: Data, to target: String) throws -> Bool {
        let (temporary, descriptor) = try createTemporary(for: target)
        var descriptorOpen = true
        do {
            try writeAll(data, to: descriptor)
            let closed = fileOps.close(descriptor)
            descriptorOpen = false
            // `EINTR` sur `close` est ignoré : le descripteur n'est plus utile (§6).
            if closed != 0 && closed != EINTR { throw Self.failure(closed) }
            var code = fileOps.link(temporary, target)
            while code == EINTR { code = fileOps.link(temporary, target) }
            _ = fileOps.unlink(temporary)
            if code == 0 { return true }
            if code == EEXIST { return false }
            throw Self.failure(code)
        } catch {
            if descriptorOpen { _ = fileOps.close(descriptor) }
            _ = fileOps.unlink(temporary)
            throw error
        }
    }

    /// Crée un temporaire EXCLUSIF à côté de `target` : `"\(target).tmp-\(pid)"`,
    /// puis `-1`, `-2`… `EEXIST` comme `EINTR` passent au candidat suivant (§3 :
    /// après `EINTR`, l'existence du fichier est NON SPÉCIFIÉE).
    private func createTemporary(for target: String) throws -> (path: String, descriptor: Int32) {
        let base = "\(target).tmp-\(getpid())"
        for index in 0..<Self.uniqueNameLimit {
            let candidate = index == 0 ? base : "\(base)-\(index)"
            let (descriptor, code) = fileOps.createExclusive(candidate)
            if descriptor >= 0 { return (candidate, descriptor) }
            if code != EEXIST && code != EINTR { throw Self.failure(code) }
        }
        throw PipelineWriteFailure(reason: "écriture impossible (aucun nom libre)")
    }

    /// `write(2)` en boucle : une écriture PARTIELLE avance l'offset, `EINTR`
    /// retente la MÊME écriture (§6).
    private func writeAll(_ data: Data, to descriptor: Int32) throws {
        var offset = 0
        while offset < data.count {
            let (count, code) = fileOps.write(descriptor, data, offset)
            if count > 0 {
                offset += count
                continue
            }
            if code == EINTR { continue }
            throw Self.failure(code)
        }
    }

    /// `mkdir` composant par composant : `EEXIST` est un succès (le répertoire est
    /// là), tout autre échec porte son `errno`.
    private func ensureDirectory(_ directory: String) throws {
        guard !directory.isEmpty else { return }
        var path = ""
        for component in directory.split(separator: "/", omittingEmptySubsequences: true) {
            path += "/" + component
            let code = fileOps.mkdir(path, 0o755)
            if code != 0 && code != EEXIST { throw Self.failure(code) }
        }
    }

    /// Le motif STABLE d'un échec : `écriture impossible (<strerror>)`.
    private static func failure(_ code: Int32) -> PipelineWriteFailure {
        PipelineWriteFailure(
            reason: "écriture impossible (\(String(cString: strerror(code == 0 ? EIO : code))))"
        )
    }
}
