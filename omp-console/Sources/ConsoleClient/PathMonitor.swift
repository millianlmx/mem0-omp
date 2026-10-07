// La source de chemin réseau, derrière une couture injectable : `NWPathMonitor`
// en production, une doublure dans les tests.
//
// C'est le seul fait qui rend l'état `noNetwork` (AC-16), prioritaire sur
// `connected` comme sur `unpaired`.

import Foundation
import Network

/// La source du chemin réseau : « le réseau est-il satisfait ? ».
@MainActor
public protocol ClientPathSource: AnyObject {
    /// Appelé à chaque transition ; `true` = chemin satisfait.
    var onChange: ((Bool) -> Void)? { get set }
    func start()
    func stop()
}

/// La production : `NWPathMonitor`.
@MainActor
public final class NWPathSource: ClientPathSource {
    public var onChange: ((Bool) -> Void)?

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.omp.console.client.path")
    private var started = false

    public init() {}

    public func start() {
        guard !started else { return }
        started = true
        monitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            Task { @MainActor [weak self] in self?.onChange?(satisfied) }
        }
        monitor.start(queue: queue)
    }

    public func stop() {
        guard started else { return }
        started = false
        monitor.cancel()
    }
}
