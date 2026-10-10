// Le registre UNIQUE des faits de PR du Mac (S-5 de
// pipelines-livrees-statut-pr-faux-et-doub) : l'état GitHub de chaque URL de PR
// livrée, publié à `KanbanModel` (l'ardoise) et au flux distant (iOS).
//
// Trois déclencheurs, et seulement eux — aucune minuterie :
//   1. le lancement : le premier jeu d'URLs observé est lu en entier ;
//   2. une URL jamais tentée depuis le lancement est lue une fois ;
//   3. le rafraîchissement manuel relit tout, sauf les PR fusionnées (`MERGED` est
//      terminal, Doc-2).
//
// Une relecture à la fois, au plus `concurrency` processus `gh` simultanés ; ses
// faits sont publiés en UNE affectation à la fin. Un échec RETIRE le fait de l'URL :
// l'état redevient « inconnu » (« PR créée »), jamais un fait par défaut.

import Combine
import ConsoleCore
import Foundation

@MainActor
final class PullRequestStateBook: ObservableObject {
    /// Les faits connus, par URL EXACTE du magasin.
    @Published private(set) var facts: [String: PullRequestFact] = [:]
    /// Vrai du début à la fin d'une relecture.
    @Published private(set) var refreshing = false

    nonisolated static let concurrency = 4

    /// `nil` quand `gh` est introuvable : aucune lecture, aucun fait.
    private let reader: (any PullRequestStateReading)?
    /// Le dernier jeu d'URLs observé : celui que le rafraîchissement manuel relit.
    private var latestURLs: [String] = []
    /// Les URLs déjà tentées depuis le lancement.
    private var attempted: Set<String> = []
    /// Les URLs nouvelles vues PENDANT une relecture, lues à sa fin.
    private var queued: [String] = []

    init(reader: (any PullRequestStateReading)?) {
        self.reader = reader
    }

    /// Déclencheurs 1 et 2 : chaque instantané du magasin passe ses URLs. Toute URL
    /// jamais tentée est lue, au plus tard à la fin de la relecture en cours.
    func observe(urls: [String]) {
        latestURLs = urls
        guard reader != nil else { return }
        let fresh = urls.filter { !attempted.contains($0) }
        guard !fresh.isEmpty else { return }
        attempted.formUnion(fresh)
        queued.append(contentsOf: fresh)
        if !refreshing { startQueued() }
    }

    /// Déclencheur 3 : relit toutes les URLs du dernier instantané, sauf celles
    /// dont le fait connu est `MERGED`. Sans effet pendant une relecture.
    func refresh() {
        guard reader != nil, !refreshing else { return }
        let urls = latestURLs.filter { facts[$0]?.state != .merged }
        guard !urls.isEmpty else { return }
        attempted.formUnion(urls)
        queued.append(contentsOf: urls)
        startQueued()
    }

    private func startQueued() {
        guard let reader, !queued.isEmpty else { return }
        var seen = Set<String>()
        let urls = queued.filter { seen.insert($0).inserted }
        queued = []
        refreshing = true
        Task { [weak self] in
            let results = await Self.read(urls, with: reader)
            self?.publish(urls, results)
        }
    }

    /// Publie une relecture d'un coup, puis enchaîne les URLs nouvelles reçues
    /// entre-temps ; `refreshing` ne retombe qu'une fois tout lu.
    private func publish(_ urls: [String], _ results: [String: PullRequestFact]) {
        var next = facts
        for url in urls { next[url] = results[url] }
        facts = next
        if queued.isEmpty {
            refreshing = false
        } else {
            startQueued()
        }
    }

    /// Lit `urls` par au plus `concurrency` tâches détachées qui se partagent la
    /// file. Chaque tâche DÉPOSE ses faits dans un collecteur verrouillé et ne rend
    /// rien : sur ce toolchain, rendre une `String` depuis une tâche détachée la
    /// corrompt sous `-O` (patron `PRReadCollector`).
    private nonisolated static func read(
        _ urls: [String],
        with reader: any PullRequestStateReading
    ) async -> [String: PullRequestFact] {
        let work = PullRequestStateWork(urls)
        let workers = (0..<min(concurrency, urls.count)).map { _ in
            Task.detached {
                while let url = work.next() {
                    if let fact = try? await reader.state(prUrl: url) {
                        work.store(url, fact)
                    }
                }
            }
        }
        for worker in workers { await worker.value }
        return work.facts
    }
}

/// La file partagée d'une relecture et le dépôt de ses faits, sous verrou.
private final class PullRequestStateWork: @unchecked Sendable {
    private let lock = NSLock()
    private var pending: [String]
    private var values: [String: PullRequestFact] = [:]

    init(_ urls: [String]) {
        pending = urls.reversed()
    }

    func next() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return pending.popLast()
    }

    func store(_ url: String, _ fact: PullRequestFact) {
        lock.lock()
        values[url] = fact
        lock.unlock()
    }

    var facts: [String: PullRequestFact] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}
