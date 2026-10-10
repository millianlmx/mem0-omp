// Lecture incrémentale, tirée par l'appelant, d'un fichier de session OMP.
//
// Ce que le lecteur NE fait jamais, et qui est le cœur du contrat (S-2) :
//   — aucune écriture, aucun verrou, aucun fichier annexe : la session d'un run
//     vivant reste lisible sans jamais le perturber (AC-9) ;
//   — aucun descripteur gardé entre deux `read()` : chaque appel `stat` puis
//     ouvre, lit et referme ;
//   — aucune exception vers l'appelant : tout incident devient un `SessionIssue`
//     ou une ligne ignorée tracée (S-3).
//
// Un seul fichier à la fois : le chemin est un paramètre, aucun inventaire, aucun
// autre fichier ouvert, l'ordre du fichier fait foi (l'arbre `parentId` n'est
// jamais suivi).

import ConsoleCore
import Foundation

/// Un incident de lecture, rendu à l'appelant au lieu d'être levé.
public enum SessionIssue: Equatable, Sendable {
    /// Le chemin n'existe pas (ou plus).
    case fileMissing
    /// `stat` ou ouverture en lecture refusés pour une autre cause. La chaîne est
    /// la description OS de l'erreur, jamais un secret.
    case unreadable(String)
    /// La taille courante a reculé sous le curseur : réécriture en place plus
    /// courte. Aucun octet n'a été lu.
    case truncated(previousBytes: Int, currentBytes: Int)
    /// L'identité du fichier au même chemin a changé (`rename` d'un nouveau
    /// fichier) : le contenu n'est plus celui qui a été lu.
    case replaced
}

/// Le delta d'un `read()` : ce que cet appel a ajouté, et l'incident éventuel.
public struct SessionRead: Equatable, Sendable {
    /// Entrées de conversation AJOUTÉES par cet appel, dans l'ordre du fichier.
    public var added: [ConversationEntry]
    /// Entrées ignorées AJOUTÉES par cet appel, dans l'ordre du fichier.
    public var skipped: [SkippedEntry]
    /// `nil` si tout est cohérent.
    public var issue: SessionIssue?
    /// Nombre d'octets du fichier RÉELLEMENT consommés par cet appel : c'est la
    /// seule mesure honnête du coût d'une relecture (un fait en cours d'écriture
    /// n'est pas consommé). `0` dès qu'aucun octet n'est consommé — tous les
    /// `issue`, et une absence de nouveauté.
    public var bytesRead: Int

    public init(
        added: [ConversationEntry],
        skipped: [SkippedEntry],
        issue: SessionIssue?,
        bytesRead: Int = 0
    ) {
        self.added = added
        self.skipped = skipped
        self.issue = issue
        self.bytesRead = bytesRead
    }
}

/// Lecteur d'un fichier de session, à curseur en mémoire seulement.
public final class SessionReader {
    public let path: String

    /// Premier octet NON consommé : toujours le début d'une ligne non consommée,
    /// ou la fin du fichier. Il ne recule jamais.
    private var cursor = 0
    /// Identité du fichier telle qu'observée à la dernière lecture cohérente.
    private var identity: FileIdentity?
    /// Taille observée à la dernière lecture cohérente — sert de `previousBytes`.
    private var lastSize: Int?
    /// Le modèle accumulé. Vide avant le premier `read()`.
    private var model = SessionConversation(header: nil, kind: nil, entries: [], skipped: [])

    public init(path: String) {
        self.path = path
    }

    /// Le modèle accumulé, vide avant le premier `read()`.
    public var conversation: SessionConversation { model }

    /// Lit ce qui a été ajouté depuis l'appel précédent. Ne lève jamais.
    @discardableResult
    public func read() -> SessionRead {
        let stat: FileStat
        switch statFile() {
        case .found(let value): stat = value
        case .issue(let issue): return SessionRead(added: [], skipped: [], issue: issue)
        }

        // Une lecture a déjà eu lieu : l'IDENTITÉ est testée avant la taille, un
        // remplacement par un fichier plus long devant être vu comme tel (S-2).
        if let known = identity {
            if known != stat.identity {
                return SessionRead(added: [], skipped: [], issue: .replaced)
            }
            if stat.size < cursor {
                return SessionRead(
                    added: [],
                    skipped: [],
                    issue: .truncated(
                        previousBytes: lastSize ?? cursor,
                        currentBytes: stat.size
                    )
                )
            }
        }

        guard let handle = FileHandle(forReadingAtPath: path) else {
            return SessionRead(added: [], skipped: [], issue: .unreadable("ouverture en lecture refusée"))
        }
        defer { try? handle.close() }

        let chunk: Data
        do {
            try handle.seek(toOffset: UInt64(cursor))
            chunk = try handle.read(upToCount: max(0, stat.size - cursor)) ?? Data()
        } catch {
            return SessionRead(
                added: [],
                skipped: [],
                issue: .unreadable((error as NSError).localizedDescription)
            )
        }

        let delta = consume(chunk)
        cursor += delta.consumed
        lastSize = stat.size
        identity = stat.identity
        return SessionRead(added: delta.added, skipped: delta.skipped, issue: nil, bytesRead: delta.consumed)
    }

    // MARK: - Consommation des octets

    /// Découpe les octets sur `0x0A` — jamais sur une chaîne décodée, dont les
    /// offsets seraient faux dès le premier accent — et ne consomme que les lignes
    /// complètes : le fragment final sans saut de ligne est reporté au prochain
    /// `read()` (une écriture en deux temps ne rend donc jamais de message
    /// tronqué, AC-5).
    private func consume(_ chunk: Data) -> (added: [ConversationEntry], skipped: [SkippedEntry], consumed: Int) {
        let bytes = [UInt8](chunk)
        var added: [ConversationEntry] = []
        var skipped: [SkippedEntry] = []
        var consumed = 0
        var start = 0

        while start < bytes.count, let newline = bytes[start...].firstIndex(of: 0x0A) {
            let offset = cursor + start
            switch LineClassifier.classify(bytes[start..<newline]) {
            case .silent:
                break
            case .skipped(let reason):
                let entry = SkippedEntry(offset: offset, reason: reason)
                skipped.append(entry)
                model.skipped.append(entry)
            case .entry(let kind, let timestampMs):
                let entry = ConversationEntry(
                    index: model.entries.count + 1,
                    offset: offset,
                    kind: kind,
                    timestampMs: timestampMs
                )
                added.append(entry)
                model.entries.append(entry)
            case .header(let header):
                // L'en-tête est posé une fois pour toutes : une seconde ligne
                // `session` valide ne le remplace pas (S-3).
                if model.header == nil {
                    model.header = header
                    model.kind = header.parentSession.map { .subagent(parentSession: $0) } ?? .topLevel
                }
            }
            start = newline + 1
            consumed = start
        }

        return (added, skipped, consumed)
    }

    // MARK: - État du fichier

    private enum StatOutcome {
        case found(FileStat)
        case issue(SessionIssue)
    }

    private func statFile() -> StatOutcome {
        do {
            let attributes = try FileManager.default.attributesOfItem(atPath: path)
            guard let size = (attributes[.size] as? NSNumber)?.intValue else {
                return .issue(.unreadable("taille du fichier illisible"))
            }
            return .found(
                FileStat(
                    size: size,
                    identity: FileIdentity(
                        device: (attributes[.systemNumber] as? NSNumber)?.uint64Value ?? 0,
                        inode: (attributes[.systemFileNumber] as? NSNumber)?.uint64Value ?? 0
                    )
                )
            )
        } catch {
            let failure = error as NSError
            if Self.isMissing(failure) { return .issue(.fileMissing) }
            return .issue(.unreadable(failure.localizedDescription))
        }
    }

    /// `st_dev`/`st_ino` : ce qui distingue un fichier réécrit au même chemin.
    private struct FileIdentity: Equatable {
        var device: UInt64
        var inode: UInt64
    }

    private struct FileStat {
        var size: Int
        var identity: FileIdentity
    }

    private static func isMissing(_ error: NSError) -> Bool {
        if error.domain == NSCocoaErrorDomain,
            error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError
        {
            return true
        }
        return error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT)
    }
}

// MARK: - Classement d'une ligne

/// Le résultat du classement d'une ligne complète, dans l'ordre des 7 règles de
/// S-3. « Silencieux » couvre les entrées reconnues hors périmètre et les lignes
/// vides : elles ne comptent ni comme entrée, ni comme ignorée.
private enum ClassifiedLine {
    case silent
    case skipped(SkipReason)
    case entry(ConversationEntry.Kind, Double?)
    case header(SessionHeader)
}

/// L'analyseur d'horodatage PARTAGÉ (Doc-3) : `Date.ISO8601FormatStyle` est une
/// `struct` `Sendable` — une `static let` est donc légale sous concurrence stricte
/// Swift 6, contrairement à `ISO8601DateFormatter` (classe non `Sendable`) — et
/// elle lit les formes AVEC ET SANS fraction de seconde, là où un formateur unique
/// en exige une seule (mesuré le 2026-09-30, doc §3).
private let sessionTimestampStyle = Date.ISO8601FormatStyle(includingFractionalSeconds: true)

private enum LineClassifier {
    /// Les 16 types d'entrée de l'union `SessionEntry` (Doc-1), à l'exclusion des
    /// cinq retenus (`message`, `compaction`, `branch_summary`) et des deux
    /// marqueurs de structure (`session`, `title`).
    static let outOfScopeTypes: Set<String> = [
        "model_usage", "thinking_level_change", "model_change", "service_tier_change",
        "reset_boundary", "custom", "custom_message", "label", "title_change",
        "ttsr_injection", "credential_pin", "session_init", "mode_change",
    ]

    static func classify(_ line: ArraySlice<UInt8>) -> ClassifiedLine {
        // Règle 1 : vide ou espaces seulement — le résidu possible d'une écriture
        // concurrente, pas une anomalie.
        if line.allSatisfy({ $0 == 0x20 || $0 == 0x09 || $0 == 0x0D }) { return .silent }

        // Règle 2 : non décodable en UTF-8 ou JSON invalide — le JSON est analysé
        // sur les OCTETS d'origine, donc une séquence UTF-8 invalide échoue ici.
        guard let parsed = try? JSONSerialization.jsonObject(with: Data(line), options: [.fragmentsAllowed])
        else { return .skipped(.invalidJSON) }

        // Règle 3 : du JSON valide qui n'est pas un objet.
        guard let object = parsed as? [String: Any] else { return .skipped(.unknownType) }

        // Règle 4 : `type` absent, non-chaîne ou hors des types connus.
        guard let type = object["type"] as? String else { return .skipped(.unknownType) }

        switch type {
        case "session": return headerLine(object)
        case "title": return .silent
        case "message": return messageLine(object, entryTimestamp(object), line)
        case "compaction": return compactionLine(object, entryTimestamp(object))
        case "branch_summary": return branchSummaryLine(object, entryTimestamp(object))
        default: return outOfScopeTypes.contains(type) ? .silent : .skipped(.unknownType)
        }
    }

    /// L'horodatage de l'entrée (clé `timestamp` de l'objet de ligne), analysé UNE
    /// fois ici — jamais à chaque rendu (Doc-3). `nil` quand la clé est absente,
    /// non-chaîne, ou non analysable : l'entrée compte alors pour les compteurs,
    /// jamais pour les bornes de durée.
    static func entryTimestamp(_ object: [String: Any]) -> Double? {
        guard let text = object["timestamp"] as? String else { return nil }
        guard let date = try? sessionTimestampStyle.parse(text) else { return nil }
        return date.timeIntervalSince1970 * 1000
    }

    // MARK: Règle 5 — charges utiles indispensables

    private static func headerLine(_ object: [String: Any]) -> ClassifiedLine {
        guard let id = object["id"] as? String else { return .skipped(.malformed) }
        let parentSession = object["parentSession"] as? String
        return .header(
            SessionHeader(
                id: id,
                cwd: object["cwd"] as? String ?? "",
                version: (object["version"] as? NSNumber)?.intValue,
                timestamp: object["timestamp"] as? String,
                parentSession: (parentSession?.isEmpty == false) ? parentSession : nil
            )
        )
    }

    private static func messageLine(
        _ object: [String: Any],
        _ timestampMs: Double?,
        _ line: ArraySlice<UInt8>
    ) -> ClassifiedLine {
        guard let message = object["message"] as? [String: Any],
            let role = message["role"] as? String
        else { return .skipped(.malformed) }

        // Règle 6 : rôle hors des trois retenus — la ligne est valide, elle est
        // simplement hors périmètre (donc silencieuse, jamais « ignorée »).
        switch role {
        case "user":
            return .entry(.user(UserTurn(text: bodyText(message["content"]))), timestampMs)
        case "assistant":
            return .entry(.assistant(assistantTurn(message, line)), timestampMs)
        case "toolResult":
            return .entry(.toolResult(toolResultTurn(message)), timestampMs)
        default:
            return .silent
        }
    }

    private static func assistantTurn(_ message: [String: Any], _ line: ArraySlice<UInt8>) -> AssistantTurn {
        let blocks = contentBlocks(message["content"])
        let thinking = blocks
            .filter { $0["type"] as? String == "thinking" }
            .compactMap { $0["thinking"] as? String }
        var toolCalls = blocks.compactMap { block -> ToolCall? in
            guard block["type"] as? String == "toolCall" else { return nil }
            var arguments: JSONValue?
            if let raw = block["arguments"] as? [String: Any] { arguments = jsonValue(raw) }
            return ToolCall(
                id: block["id"] as? String ?? "",
                name: block["name"] as? String ?? "",
                arguments: arguments
            )
        }
        if !toolCalls.isEmpty, let texts = orderedArgumentsTexts(line, count: toolCalls.count) {
            for position in toolCalls.indices { toolCalls[position].argumentsText = texts[position] }
        }
        return AssistantTurn(
            text: bodyText(message["content"]),
            thinking: thinking.isEmpty ? nil : thinking.joined(separator: "\n"),
            // Lus sur le MESSAGE, jamais dérivés des entrées `model_change`/
            // `model_usage` (Doc-2).
            model: message["model"] as? String,
            usage: usage(message["usage"]),
            toolCalls: toolCalls,
            provider: message["provider"] as? String
        )
    }

    /// Le texte ORDONNÉ des arguments de chaque appel de la ligne (S-1) : la ligne
    /// est relue par `OrderedJSON`, seul analyseur qui garde l'ordre du fichier, et
    /// le k-ième bloc `toolCall` va au k-ième `ToolCall`. Tout ou rien : si la
    /// relecture échoue ou si le nombre de blocs diffère, `nil` — aucun appariement
    /// partiel, les appels gardent ce qu'ils ont déjà.
    private static func orderedArgumentsTexts(_ line: ArraySlice<UInt8>, count: Int) -> [String?]? {
        guard case .array(let content)? = OrderedJSON.parse(line)?.member("message")?.member("content")
        else { return nil }
        let calls = content.filter { $0.member("type") == .string("toolCall") }
        guard calls.count == count else { return nil }
        return calls.map { $0.member("arguments")?.rendered }
    }

    private static func toolResultTurn(_ message: [String: Any]) -> ToolResultTurn {
        ToolResultTurn(
            callId: message["toolCallId"] as? String,
            name: message["toolName"] as? String,
            text: bodyText(message["content"]),
            // `details.diff` n'est un diff que s'il est textuel (outil `edit`).
            diff: (message["details"] as? [String: Any])?["diff"] as? String,
            isError: isTrue(message["isError"])
        )
    }

    private static func compactionLine(_ object: [String: Any], _ timestampMs: Double?) -> ClassifiedLine {
        guard let summary = object["summary"] as? String else { return .skipped(.malformed) }
        return .entry(
            .compaction(
                CompactionMarker(
                    summary: summary,
                    tokensBefore: (object["tokensBefore"] as? NSNumber)?.intValue
                )
            ),
            timestampMs
        )
    }

    private static func branchSummaryLine(_ object: [String: Any], _ timestampMs: Double?) -> ClassifiedLine {
        guard let summary = object["summary"] as? String else { return .skipped(.malformed) }
        return .entry(
            .branchSummary(
                BranchSummaryMarker(summary: summary, fromId: object["fromId"] as? String ?? "")
            ),
            timestampMs
        )
    }

    // MARK: Charges utiles

    /// Le texte d'un `content` : une chaîne seule, ou la concaténation par `"\n"`
    /// de ses blocs `text`. Un contenu d'un type inconnu rend donc `""` — la ligne
    /// est reconnue, son contenu ne l'est pas.
    private static func bodyText(_ content: Any?) -> String {
        if let single = content as? String { return single }
        return contentBlocks(content)
            .filter { $0["type"] as? String == "text" }
            .compactMap { $0["text"] as? String }
            .joined(separator: "\n")
    }

    /// Les blocs d'un `content` tableau. Un élément qui n'est pas un objet est
    /// écarté : il ne peut pas porter de bloc connu.
    private static func contentBlocks(_ content: Any?) -> [[String: Any]] {
        guard let array = content as? [Any] else { return [] }
        return array.compactMap { $0 as? [String: Any] }
    }

    private static func usage(_ any: Any?) -> TokenUsage? {
        guard let dictionary = any as? [String: Any] else { return nil }
        func integer(_ key: String) -> Int { (dictionary[key] as? NSNumber)?.intValue ?? 0 }
        return TokenUsage(
            input: integer("input"),
            output: integer("output"),
            cacheRead: integer("cacheRead"),
            cacheWrite: integer("cacheWrite"),
            totalTokens: integer("totalTokens"),
            cost: ((dictionary["cost"] as? [String: Any])?["total"] as? NSNumber)?.doubleValue
        )
    }

    /// `true` seulement pour un VRAI booléen JSON : le nombre `1` n'est pas `true`.
    private static func isTrue(_ any: Any?) -> Bool {
        guard let number = any as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue
    }

    /// Conversion `Any` → `JSONValue`. Un booléen JSON est un `NSNumber` de type
    /// `CFBoolean` : le type CoreFoundation est testé AVANT la conversion
    /// numérique, sinon `true` deviendrait `1`.
    private static func jsonValue(_ any: Any) -> JSONValue? {
        switch any {
        case let text as String:
            return .string(text)
        case let dictionary as [String: Any]:
            var converted: [String: JSONValue] = [:]
            for (key, value) in dictionary {
                guard let element = jsonValue(value) else { return nil }
                converted[key] = element
            }
            return .object(converted)
        case let array as [Any]:
            var converted: [JSONValue] = []
            for value in array {
                guard let element = jsonValue(value) else { return nil }
                converted.append(element)
            }
            return .array(converted)
        case let number as NSNumber:
            return CFGetTypeID(number) == CFBooleanGetTypeID()
                ? .bool(number.boolValue)
                : .number(number.doubleValue)
        case is NSNull:
            return .null
        default:
            return nil
        }
    }
}
