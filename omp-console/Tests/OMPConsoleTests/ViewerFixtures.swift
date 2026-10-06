// Harnais de fixtures des preuves de la visionneuse de session : une session
// RÉELLE sur disque (un `.jsonl` lu par le vrai lecteur), jamais un mock.
//
// Deux invariants du dépôt gouvernent l'emplacement et la forme :
//   — les fixtures vivent sous `NSTemporaryDirectory()`, jamais `~/.omp`, jamais
//     un `.jsonl` du dépôt (invariant `lecteur-de-sessions-omp/AC-11`) ;
//   — les lignes JSON sont ASSEMBLÉES par `JSONSerialization`, jamais par des
//     chaînes brutes Swift : dans une chaîne brute `#"…"#`, un guillemet fermant
//     collé au délimiteur est avalé et produit un JSON invalide SILENCIEUX
//     (piège mesuré à l'écriture des fixtures du lecteur).

import CryptoKit
import Foundation

/// Une session synthétique dans son propre répertoire temporaire.
final class ViewerSessionFixture {
    let directory: URL
    let file: URL

    init(fileName: String = "2026-09-28T15-07-55-136Z_01a0e88e-e980-4f5a-9d0d-2b0d2c0e9a11.jsonl") throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("visionneuse-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        file = directory.appendingPathComponent(fileName)
    }

    var path: String { file.path }

    func write(_ lines: [String]) throws {
        try Data(bytes(of: lines)).write(to: file)
    }

    /// Un ajout APPEND-ONLY, comme le writer de l'hôte.
    func append(_ lines: [String]) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: handle.seekToEnd())
        try handle.write(contentsOf: Data(bytes(of: lines)))
    }

    func append(_ text: String) throws {
        let handle = try FileHandle(forWritingTo: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: handle.seekToEnd())
        try handle.write(contentsOf: Data(text.utf8))
    }

    func remove() { try? FileManager.default.removeItem(at: directory) }

    var size: Int {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.intValue ?? -1
    }

    /// L'empreinte du fichier : la seule mesure qui contredise une écriture qui
    /// conserverait la taille.
    var digest: String {
        guard let data = FileManager.default.contents(atPath: path) else { return "absent" }
        return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// Les noms du répertoire, triés : aucun fichier annexe ne doit apparaître.
    var listing: [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []).sorted()
    }

    private func bytes(of lines: [String]) -> [UInt8] {
        Array((lines.joined(separator: "\n") + "\n").utf8)
    }
}

/// Échéance des preuves de la visionneuse, sur le FIL PRINCIPAL (les modèles y
/// vivent) : elle attend qu'une condition devienne vraie, sans jamais bloquer la
/// suite au-delà de l'échéance.
///
/// 15 s, pas 5 : la reprise après un `chmod` passe par la veille de repli
/// (FSEvents sur le répertoire quand le fichier n'est pas ouvrable), dont la
/// latence n'est pas bornée — mesuré sur `check (macos-latest)` : le
/// `visionneuse-de-session/AC-13` de `unreadableFileIsReportedThenResumesByItself`
/// a dépassé 2 s sur un runner chargé (2026-09-28), puis 5 s (2026-10-06, même
/// test, même runner). L'échéance ne coûte rien quand la condition se réalise
/// (sondage toutes les 5 ms).
@MainActor
func awaitViewer(_ timeout: Double = 15.0, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}

/// Les lignes d'une session synthétique, au FORMAT RÉEL de l'hôte.
enum ViewerLines {
    static let stamp = "2026-09-28T15:07:55.136Z"

    static func json(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return "{}"
        }
        return String(decoding: data, as: UTF8.self)
    }

    private static func entry(_ type: String, _ id: String, _ payload: [String: Any]) -> String {
        var object: [String: Any] = ["type": type, "id": id, "timestamp": stamp]
        for (key, value) in payload { object[key] = value }
        return json(object)
    }

    private static func message(_ id: String, _ message: [String: Any]) -> String {
        entry("message", id, ["parentId": NSNull(), "message": message])
    }

    static func header(id: String = "session-1") -> String {
        entry(
            "session",
            id,
            ["id": id, "timestamp": stamp, "cwd": "/tmp/projet", "version": 3]
        )
    }

    static func user(_ body: String, id: String = "e1") -> String {
        message(id, ["role": "user", "content": [["type": "text", "text": body]]])
    }

    static func assistant(
        id: String = "e2",
        text: String = "voici",
        thinking: String? = nil,
        model: String? = "opencode-go/deepseek-v4.1-flash",
        calls: [[String: Any]] = []
    ) -> String {
        var content: [[String: Any]] = []
        if let thinking { content.append(["type": "thinking", "thinking": thinking]) }
        content.append(["type": "text", "text": text])
        content.append(contentsOf: calls)
        var payload: [String: Any] = ["role": "assistant", "content": content]
        if let model { payload["model"] = model }
        return message(id, payload)
    }

    static func call(id: String, name: String, arguments: [String: Any]) -> [String: Any] {
        ["type": "toolCall", "id": id, "name": name, "arguments": arguments]
    }

    static func askCall(id: String, question: String, options: [[String: Any]], header: String? = nil) -> [String: Any] {
        var item: [String: Any] = ["id": "q1", "question": question, "options": options]
        if let header { item["header"] = header }
        return call(id: id, name: "ask", arguments: ["questions": [item]])
    }

    static func toolResult(
        id: String = "e3",
        callId: String? = "call-1",
        name: String? = "read",
        body: String = "contenu",
        diff: String? = nil,
        isError: Bool = false
    ) -> String {
        var payload: [String: Any] = ["role": "toolResult", "content": [["type": "text", "text": body]]]
        if let callId { payload["toolCallId"] = callId }
        if let name { payload["toolName"] = name }
        if isError { payload["isError"] = true }
        if let diff { payload["details"] = ["diff": diff] }
        return message(id, payload)
    }

    static func compaction(id: String = "e6", summary: String = "contexte compacté", tokensBefore: Int? = 4200) -> String {
        var payload: [String: Any] = ["summary": summary]
        if let tokensBefore { payload["tokensBefore"] = tokensBefore }
        return entry("compaction", id, payload)
    }

    static func branchSummary(id: String = "e7", summary: String = "résumé de branche", fromId: String = "root") -> String {
        entry("branch_summary", id, ["summary": summary, "fromId": fromId])
    }

    /// Le format RÉEL d'un `details.diff` d'édition d'OMP : `<marqueur><numéro>|<texte>`.
    static let editDiff = " 616|// AC-1 exige\n-618|// et saut\n+620|  // L'AC-1"
}

/// Le catalogue complet d'une session de référence, utilisé par plusieurs preuves.
func viewerReferenceLines() -> [String] {
    [
        ViewerLines.header(),
        ViewerLines.user("Bonjour, lis le fichier"),
        ViewerLines.assistant(
            id: "e2",
            text: "je lis le fichier",
            thinking: "je réfléchis",
            calls: [
                ViewerLines.call(id: "call-1", name: "read", arguments: ["path": "/tmp/a.txt", "offset": 2]),
                ViewerLines.askCall(
                    id: "call-2",
                    question: "Quel plan ?",
                    options: [["label": "A"], ["label": "B", "description": "le second"]],
                    header: "Plan"
                ),
            ]
        ),
        ViewerLines.toolResult(id: "e3", callId: "call-1", name: "read", body: "contenu du fichier"),
        ViewerLines.toolResult(id: "e4", callId: "call-9", name: "bash", body: "sortie orpheline"),
        ViewerLines.compaction(),
        ViewerLines.branchSummary(),
    ]
}
