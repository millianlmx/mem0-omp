// L'écrivain du canal côté app (S-1, S-2, S-4, S-11) : les SEULES écritures de
// l'app — une livraison dans la boîte publiée d'un run, une commande dans le canal
// — et la lecture seule des accusés que le pilote écrit.
//
// Atomicité (`rename(2)`, man 2 rename) : temporaire `<fichier>.tmp-<pid>` dans le
// répertoire CIBLE, puis `rename` — exactement la règle de `writeJsonAtomic`
// (store.ts:315-320) et de `writeCommand` (commands.ts). Un lecteur ne voit donc
// jamais un JSON partiel.
//
// Aucune autre écriture n'existe ici : ni `lots/`, ni `running/`, ni `history/`,
// ni `projects/`, ni `audit/`, ni `commands/acks/` (S-11).

import Darwin
import Foundation

/// L'échec d'une écriture, à motif STABLE : `écriture impossible (<strerror>)`,
/// jamais `localizedDescription` (BR-1).
struct PipelineWriteFailure: Error, Equatable {
    let reason: String
}

struct PipelineWriter: Sendable {
    let stateDir: String

    init(stateDir: String = PipelineStore.stateDir()) {
        self.stateDir = stateDir
    }

    /// `<stateDir>/commands` — le canal.
    var commandDir: String { joinPath(stateDir, "commands") }

    /// `<stateDir>/commands/acks` — les accusés, un fichier par identifiant traité.
    var commandAckDir: String { joinPath(commandDir, "acks") }

    /// Le nom d'un fichier de livraison COMME d'une commande :
    /// `<sentAt 16 chiffres>-<salt 4 hex>.json` — les suffixes `-1`, `-2`… sont
    /// ajoutés à l'écriture quand le nom est pris (parité `writeDelivery`).
    static func fileName(sentAt: Double, salt: String) -> String {
        "\(stamp(sentAt))-\(salt).json"
    }

    /// Le chemin de l'accusé d'un identifiant : `<stateDir>/commands/acks/<id>.json`.
    func ackPath(id: String) -> String {
        joinPath(commandAckDir, "\(id).json")
    }

    // --- livraisons ----------------------------------------------------------

    /// Écrit une livraison dans la boîte d'un run : dossier créé au besoin,
    /// temporaire puis `rename(2)`. Rend le chemin écrit.
    @discardableResult
    func writeDelivery(
        inbox: String,
        delivery: OutgoingDelivery,
        sentAt: Double,
        salt: String
    ) throws -> String {
        try ensureDirectory(inbox)
        let name = uniqueName(in: inbox, sentAt: sentAt, salt: salt)
        return try writeObject(delivery.object(sentAt: sentAt), to: joinPath(inbox, name))
    }

    // --- commandes -----------------------------------------------------------

    /// Écrit une commande dans le canal et **ne la retire jamais** (seul le pilote
    /// le fait, après avoir écrit l'accusé). Rend le chemin écrit.
    @discardableResult
    func writeCommand(_ command: OutgoingCommand, sentAt: Double, salt: String) throws -> String {
        try ensureDirectory(commandDir)
        let name = uniqueName(in: commandDir, sentAt: sentAt, salt: salt)
        return try writeObject(command.object(sentAt: sentAt), to: joinPath(commandDir, name))
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

    // --- outillage d'écriture ------------------------------------------------

    /// Le premier nom NON PRIS de la famille (`-1`, `-2`…), comme `writeDelivery`
    /// et `writeCommand` du dépôt.
    private func uniqueName(in directory: String, sentAt: Double, salt: String) -> String {
        let base = Self.fileName(sentAt: sentAt, salt: salt)
        guard FileManager.default.fileExists(atPath: joinPath(directory, base)) else { return base }
        let stem = String(base.dropLast(".json".count))
        var index = 1
        while true {
            let candidate = "\(stem)-\(index).json"
            if !FileManager.default.fileExists(atPath: joinPath(directory, candidate)) { return candidate }
            index += 1
        }
    }

    private func writeObject(_ object: [String: Any], to target: String) throws -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            throw PipelineWriteFailure(reason: "écriture impossible (\(String(cString: strerror(EINVAL))))")
        }
        return try writeAtomic(data, to: target)
    }

    /// Temporaire `<fichier>.tmp-<pid>` dans le répertoire cible, puis `rename(2)`.
    private func writeAtomic(_ data: Data, to target: String) throws -> String {
        let temporary = "\(target).tmp-\(getpid())"
        // Un `open` en écriture : `errno` porte alors le motif exact (droits,
        // répertoire absent), sans passer par la traduction Foundation.
        let descriptor = open(temporary, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
        guard descriptor >= 0 else { throw failure() }
        var written = 0
        var failureErrno: Int32 = 0
        data.withUnsafeBytes { buffer in
            guard let base = buffer.baseAddress else { return }
            while written < buffer.count {
                let count = write(descriptor, base.advanced(by: written), buffer.count - written)
                if count <= 0 {
                    failureErrno = errno
                    return
                }
                written += count
            }
        }
        close(descriptor)
        if written != data.count {
            try? FileManager.default.removeItem(atPath: temporary)
            throw PipelineWriteFailure(
                reason: "écriture impossible (\(String(cString: strerror(failureErrno == 0 ? EIO : failureErrno))))"
            )
        }
        guard rename(temporary, target) == 0 else {
            let code = errno
            try? FileManager.default.removeItem(atPath: temporary)
            throw PipelineWriteFailure(reason: "écriture impossible (\(String(cString: strerror(code))))")
        }
        return target
    }

    /// `mkdir` composant par composant : `EEXIST` est un succès (le répertoire est
    /// là), tout autre échec porte son `errno`.
    private func ensureDirectory(_ directory: String) throws {
        guard !directory.isEmpty else { return }
        var path = ""
        for component in directory.split(separator: "/", omittingEmptySubsequences: true) {
            path += "/" + component
            if mkdir(path, 0o755) != 0 && errno != EEXIST {
                throw failure()
            }
        }
    }

    private func failure() -> PipelineWriteFailure {
        let code = errno
        return PipelineWriteFailure(
            reason: "écriture impossible (\(String(cString: strerror(code == 0 ? EIO : code))))"
        )
    }
}
