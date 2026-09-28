// Harnais de fixtures du magasin d'état (BR-1) : un magasin RÉEL sur disque.
//
// Aucun mock du système de fichiers : les critères d'acceptation portent sur des
// fichiers (publication atomique, dates de modification, veille vnode) — un mock ne
// les prouverait pas. Tout vit sous `NSTemporaryDirectory()` : la suite ne touche
// JAMAIS `~/.omp/agent/pipeline` de la machine.

import Darwin
import Foundation
@testable import OMPConsole

/// Un magasin de fixtures jetable : six répertoires (ou aucun), des écritures
/// atomiques calquées sur `writeJsonAtomic` (store.ts:315-320), des relevés de
/// noms et de dates de modification.
final class StoreFixture {
    let root: String
    private let fileManager = FileManager.default

    /// `stores` vide ⇒ ni la racine ni aucun répertoire de store n'existent : c'est
    /// littéralement le cas « magasin absent » (AC-9).
    init(stores: [PipelineStore] = PipelineStore.allCases) {
        root = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("omp-console-fixture-\(UUID().uuidString)")
        for store in stores {
            try? fileManager.createDirectory(atPath: directory(store), withIntermediateDirectories: true)
        }
    }

    deinit {
        try? fileManager.removeItem(atPath: root)
    }

    func directory(_ store: PipelineStore) -> String {
        PipelineStore.directory(store, stateDir: root)
    }

    func path(_ store: PipelineStore, _ name: String) -> String {
        joinPath(directory(store), name)
    }

    /// Écriture ATOMIQUE : temporaire `<fichier>.tmp-<pid>` dans le même répertoire,
    /// puis `rename`. C'est ce geste — et lui seul — que la veille doit voir émettre
    /// exactement une fois.
    func publish(path target: String, contents: String) {
        let tmp = "\(target).tmp-\(getpid())"
        try? Data(contents.utf8).write(to: URL(fileURLWithPath: tmp))
        rename(tmp, target)
    }

    func publish(_ store: PipelineStore, _ name: String, object: [String: Any]) {
        publish(path: path(store, name), contents: jsonText(object))
    }

    func publish(_ store: PipelineStore, _ name: String, text: String) {
        publish(path: path(store, name), contents: text)
    }

    /// Écriture DIRECTE, sans temporaire : pour un fichier tronqué ou un fichier
    /// étranger, qui doivent exister sans le geste de publication.
    func put(_ store: PipelineStore, _ name: String, text: String) {
        try? Data(text.utf8).write(to: URL(fileURLWithPath: path(store, name)))
    }

    func remove(_ store: PipelineStore, _ name: String) {
        try? fileManager.removeItem(atPath: path(store, name))
    }

    /// Une boîte de run : `inbox/<runId>-<n>/`.
    @discardableResult
    func createBox(_ name: String) -> String {
        let box = joinPath(directory(.inbox), name)
        try? fileManager.createDirectory(atPath: box, withIntermediateDirectories: true)
        return box
    }

    func publish(box: String, file: String, object: [String: Any]) {
        publish(path: joinPath(box, file), contents: jsonText(object))
    }

    func put(box: String, file: String, text: String) {
        try? Data(text.utf8).write(to: URL(fileURLWithPath: joinPath(box, file)))
    }

    /// Les noms d'un répertoire, triés (`contentsOfDirectory` n'en donne aucun ordre).
    func names(_ store: PipelineStore) -> [String] {
        (try? fileManager.contentsOfDirectory(atPath: directory(store)))?.sorted() ?? []
    }

    func contents(_ store: PipelineStore, _ name: String) -> String? {
        fileManager.contents(atPath: path(store, name)).map { String(decoding: $0, as: UTF8.self) }
    }

    /// `store/nom@<date de modification>@<taille>`, trié : deux relevés égaux disent
    /// qu'aucun fichier n'a été créé, modifié ni supprimé (doc §9).
    func listing(stores: [PipelineStore] = PipelineStore.allCases) -> [String] {
        var lines: [String] = []
        for store in stores {
            for name in names(store) {
                let attributes = try? fileManager.attributesOfItem(atPath: path(store, name))
                let modified = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
                let size = (attributes?[.size] as? Int) ?? -1
                lines.append("\(store.rawValue)/\(name)@\(modified)@\(size)")
            }
        }
        return lines.sorted()
    }

    private func jsonText(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else {
            return "{}"
        }
        return String(decoding: data, as: UTF8.self)
    }
}

// --- fabriques d'objets au FORMAT RÉEL du dépôt ------------------------------

/// Un identifiant d'entrée : 16 hexadécimaux minuscules (`STORE_FILE`).
func fixtureId(_ seed: Int) -> String {
    String(seed, radix: 16).padded(to: 16, with: "0")
}

/// L'instant de référence des fixtures : une horloge FIXE, pour que « périmé » ne
/// dépende jamais de l'heure qu'il est.
let fixtureT0: Double = 1_700_000_000_000

/// L'horloge figée sur `fixtureT0`.
let fixtureClock = StoreClock { fixtureT0 }

extension String {
    /// Complète à gauche (identifiants, noms d'ordre chronologique).
    func padded(to width: Int, with pad: Character) -> String {
        count >= width ? self : String(repeating: String(pad), count: width - count) + self
    }
}

/// `running/<id>.json` au format réel (champ absent = `nil` : les optionnels ne
/// sont PAS écrits quand ils n'ont pas de valeur).
func runningObject(
    id: String,
    cwd: String,
    label: String = "mem0-omp/feature",
    phase: String = "impl",
    state: String = "running",
    phaseStartedAt: Double,
    updatedAt: Double,
    ownerPid: Double,
    sessionFile: String? = nil,
    sessionId: String? = nil,
    inbox: String? = nil,
    pendingAsk: [String: Any]? = nil
) -> [String: Any] {
    var object: [String: Any] = [
        "version": 1,
        "id": id,
        "cwd": cwd,
        "label": label,
        "phase": phase,
        "state": state,
        "phaseStartedAt": phaseStartedAt,
        "updatedAt": updatedAt,
        "owner": ["pid": ownerPid],
    ]
    if let sessionFile { object["sessionFile"] = sessionFile }
    if let sessionId { object["sessionId"] = sessionId }
    if let inbox { object["inbox"] = inbox }
    if let pendingAsk { object["pendingAsk"] = pendingAsk }
    return object
}

/// `history/<id>.json` au format réel.
func historyObject(
    id: String,
    cwd: String,
    label: String = "mem0-omp/feature",
    phase: String = "review",
    finalState: String = "done",
    phaseStartedAt: Double,
    endedAt: Double,
    sessionFile: String? = nil,
    sessionId: String? = nil
) -> [String: Any] {
    var object: [String: Any] = [
        "version": 1,
        "id": id,
        "cwd": cwd,
        "label": label,
        "phase": phase,
        "finalState": finalState,
        "phaseStartedAt": phaseStartedAt,
        "endedAt": endedAt,
    ]
    if let sessionFile { object["sessionFile"] = sessionFile }
    if let sessionId { object["sessionId"] = sessionId }
    return object
}

/// Une feature de lot au format réel, tous les champs obligatoires présents.
func lotFeatureObject(
    slug: String = "client-magasin-etat",
    state: String = "running",
    phase: String = "impl",
    origin: String = "session"
) -> [String: Any] {
    [
        "slug": slug,
        "name": slug,
        "branch": "feat/\(slug)",
        "worktree": "/Users/millian/.omp/pipeline-worktrees/mem0-omp-d0ef9a5/\(slug)",
        "deps": [],
        "origin": origin,
        "state": state,
        "phase": phase,
        "waitKind": NSNull(),
        "waitPrompt": NSNull(),
        "sessionFile": NSNull(),
        "pendingTexts": [],
        "prUrl": NSNull(),
        "stopReason": NSNull(),
        "fixes": 0,
        "reviewRuns": 0,
        "unreadableRuns": 0,
        "reviewHash": NSNull(),
        "lastVerdict": NSNull(),
        "lastBlockers": 0,
        "lastRunSessionFile": NSNull(),
        "contractHash": NSNull(),
        "addedAt": 1_790_436_998_531,
        "sinceAt": 1_790_437_807_752,
        "updatedAt": 1_790_437_807_752,
        "endedAt": NSNull(),
    ]
}

/// Un lot au format réel (`lots/<repoKey>.json`).
func lotObject(
    id: String = "d0ef9a50f7dc3a37",
    features: [[String: Any]]? = nil,
    ownerPid: Double = Double(getpid()),
    heartbeatAt: Double? = nil,
    status: String = "running"
) -> [String: Any] {
    var owner: [String: Any] = ["pid": ownerPid, "sessionFile": NSNull(), "sessionId": NSNull()]
    if let heartbeatAt { owner["heartbeatAt"] = heartbeatAt }
    return [
        "version": 1,
        "id": id,
        "repoRoot": "/Users/millian/Experiments/mem0-omp",
        "status": status,
        "reviewCap": 3,
        "slotCap": 4,
        "recapAt": NSNull(),
        "owner": owner,
        "createdAt": 1_790_436_998_531,
        "launchedAt": 1_790_499_449_883,
        "features": features ?? [lotFeatureObject()],
    ]
}

/// Une feature de projet au format réel (`projects/<repoKey>.json`).
func projectFeatureObject(
    slug: String = "client-magasin-etat",
    status: String = "launched",
    prUrl: Any = NSNull(),
    failure: Any = NSNull(),
    removedReason: Any = NSNull()
) -> [String: Any] {
    [
        "slug": slug,
        "intention": "La couche de données de l'app : des modèles Swift typés et tolérants du magasin d'état.",
        "model": "opencode-go/deepseek-v4.1-flash",
        "status": status,
        "prUrl": prUrl,
        "failure": failure,
        "removedReason": removedReason,
        "updatedAt": 1_790_597_813_850,
    ]
}

/// Un projet au format réel (`projects/<repoKey>.json`).
func projectObject(
    repoKey: String = "d0ef9a50f7dc3a37",
    segments: [[String: Any]]? = nil,
    current: Int = 1,
    hostSession: Any = "/Users/millian/.omp/agent/sessions/session.jsonl",
    base: Any = NSNull()
) -> [String: Any] {
    [
        "version": 1,
        "repoKey": repoKey,
        "repoRoot": "/Users/millian/Experiments/mem0-omp",
        "relayKey": "/Users/millian/.omp/agent/pipeline/projects/\(repoKey)@1790585406349",
        "purpose": "Une salle de contrôle native macOS (SwiftUI) pour les pipelines mem0-omp.",
        "function": "L'app lit le magasin d'état partagé et conduit des projets, features et runs.",
        "status": "running",
        "segments": segments ?? [
            ["name": "Fondations", "features": [projectFeatureObject(slug: "socle-app-swift", status: "merged")]],
            ["name": "Lire le réel", "features": [projectFeatureObject()]],
        ],
        "current": current,
        "base": base,
        "hostSession": hostSession,
        "createdAt": 1_790_585_406_349,
        "updatedAt": 1_790_598_000_000,
    ]
}

/// Une livraison `text` (store.ts:337).
func textDelivery(_ text: String, sentAt: Double) -> [String: Any] {
    ["version": 1, "kind": "text", "text": text, "sentAt": sentAt]
}

/// Une livraison `ask` répondue par un choix, ou par une saisie libre.
func askDelivery(toolCallId: String, selected: String? = nil, custom: String? = nil, sentAt: Double) -> [String: Any] {
    var object: [String: Any] = ["version": 1, "kind": "ask", "toolCallId": toolCallId, "sentAt": sentAt]
    if let selected { object["selected"] = selected }
    if let custom { object["custom"] = custom }
    return object
}

/// Un relais audit au format réel (`audit/<sha1(sessionFile)[:16]>.json`).
func auditObject(
    sessionFile: String = "/Users/millian/.omp/agent/sessions/session.jsonl",
    pid: Double = Double(getpid()),
    heartbeatAt: Double
) -> [String: Any] {
    ["version": 1, "sessionFile": sessionFile, "pid": pid, "heartbeatAt": heartbeatAt]
}

/// Un pid RÉELLEMENT mort : un process enfant terminé et moissonné. On ne le devine
/// pas par une valeur arbitraire — le système pourrait l'avoir réutilisée.
func deadPid() -> Int {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/true")
    try? process.run()
    process.waitUntilExit()
    return Int(process.processIdentifier)
}

// --- outillage d'attente des tests de veille ---------------------------------

/// Un consommateur UNIQUE et de longue durée (doc §5) : il empile ce que le flux
/// lui pousse, et le test interroge l'accumulation.
final class Recorder<S: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [S] = []

    func append(_ value: S) {
        lock.lock()
        items.append(value)
        lock.unlock()
    }

    var values: [S] {
        lock.lock()
        defer { lock.unlock() }
        return items
    }

    var count: Int { values.count }

    var last: S? { values.last }
}

/// Consomme un flux jusqu'à sa terminaison, dans UNE tâche de longue durée.
func consume<S: Sendable>(_ stream: AsyncStream<S>, into recorder: Recorder<S>) -> Task<Void, Never> {
    Task {
        for await value in stream { recorder.append(value) }
    }
}

/// Échéance de test (doc §8) : attend qu'une condition devienne vraie sans jamais
/// bloquer la suite plus longtemps que prévu.
@discardableResult
func awaitTrue(timeout: Double = 1.0, _ condition: @Sendable () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return condition()
}
