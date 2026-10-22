// L'outillage d'attente des tests de veille et de flux : un consommateur unique et
// de longue durée, et des échéances qui ne bloquent jamais la suite plus que prévu.

import Foundation

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

/// La même échéance, pour un état isolé au FIL PRINCIPAL (les modèles SwiftUI) :
/// `awaitTrue` prend une fermeture `@Sendable` non isolée, qui ne peut pas lire un
/// `@Published` d'une classe `@MainActor`.
@MainActor
@discardableResult
func awaitMainTrue(timeout: Double = 2.0, _ condition: @MainActor () -> Bool) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if condition() { return true }
        try? await Task.sleep(for: .milliseconds(10))
    }
    return condition()
}

/// Les jetons interdits d'un texte affiché (conventions des specs) : `\b\d{3}\b`
/// couvre un code HTTP ; `/` est l'indice d'un chemin. Partagé par les gardes de
/// jargon-technique-expose-mac-et-ios.
func forbiddenTokens(in text: String) -> [String] {
    let literal = ["pid", "JSON", "http", "OMLX_API_TOKEN", "PTY", "podman", "lsof", "stderr", "/", ".json", ".jsonl"]
    var found = literal.filter { text.localizedCaseInsensitiveContains($0) }
    if text.range(of: #"\b\d{3}\b"#, options: .regularExpression) != nil { found.append("nombre à 3 chiffres") }
    if text.range(of: #"\bmort\b"#, options: .regularExpression) != nil { found.append("mort") }
    return found
}
