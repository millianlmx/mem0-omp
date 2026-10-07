// La découverte Bonjour (S-3) : `NWBrowser` sur le type de service annoncé par la
// coque, AU PLUS un Mac conservé — le plus petit nom d'instance en UTF-8.
//
// L'endpoint d'un résultat n'est PAS résolu : il ne porte ni hôte ni port. On le
// résout par une sonde `NWConnection(to:using: .tcp)` refermée dès `.ready`
// (Doc-1). Une adresse résolue est un INSTANTANÉ, jamais un cache.
//
// Le TXT `v` est lu AVANT toute connexion (Doc-1) : une version différente est
// remontée par `onProtocolVersion`, et le modèle verrouille sans rien tenter.

import ConsoleCore
import Foundation
import Network

/// La source de découverte, acteur principal (le modèle l'est aussi).
@MainActor
public protocol DiscoverySource: AnyObject {
    /// Appelé avec ZÉRO ou UN Mac résolu (au plus un, trié par nom).
    var onChange: (([DiscoveredMac]) -> Void)? { get set }
    /// La version d'API annoncée par le Mac retenu, lue dans son TXT `v`.
    var onProtocolVersion: ((Int) -> Void)? { get set }
    /// `true` quand le privilège réseau local est refusé à l'app (Doc-2).
    var onDenied: ((Bool) -> Void)? { get set }
    func start(serviceType: String)
    func stop()
}

/// La production : `NWBrowser` + sonde de résolution.
@MainActor
public final class BonjourDiscoverySource: DiscoverySource {
    public var onChange: (([DiscoveredMac]) -> Void)?
    public var onProtocolVersion: ((Int) -> Void)?
    public var onDenied: ((Bool) -> Void)?

    private let queue = DispatchQueue(label: "com.omp.console.client.bonjour")
    private var browser: NWBrowser?
    private var probes: [String: NWConnection] = [:]
    private var resolved: [String: DiscoveredMac] = [:]
    private var versions: [String: Int] = [:]
    private var running = false

    public init() {}

    public func start(serviceType: String) {
        guard !running else { return }
        running = true
        resolved.removeAll()
        versions.removeAll()
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjour(type: serviceType, domain: nil), using: parameters)
        self.browser = browser
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor [weak self] in self?.apply(results) }
        }
        browser.stateUpdateHandler = { [weak self] state in
            guard case .failed(let error) = state else { return }
            Task { @MainActor [weak self] in self?.reportDenied(error) }
        }
        browser.start(queue: queue)
    }

    public func stop() {
        running = false
        browser?.cancel()
        browser = nil
        for probe in probes.values { probe.cancel() }
        probes.removeAll()
        resolved.removeAll()
        versions.removeAll()
    }

    // MARK: - Résolution

    private func apply(_ results: Set<NWBrowser.Result>) {
        guard running else { return }
        var announced: Set<String> = []
        for result in results {
            guard case .service(let name, _, _, _) = result.endpoint else { continue }
            announced.insert(name)
            if case .bonjour(let record) = result.metadata,
               let entry = record.getEntry(for: "v"),
               case .string(let raw) = entry,
               let value = Int(raw) {
                versions[name] = value
            }
            if resolved[name] == nil, probes[name] == nil {
                probe(name: name, endpoint: result.endpoint)
            }
        }
        for (name, _) in resolved where !announced.contains(name) {
            resolved[name] = nil
            versions[name] = nil
        }
        publish()
    }

    private func probe(name: String, endpoint: NWEndpoint) {
        let probe = NWConnection(to: endpoint, using: .tcp)
        probes[name] = probe
        probe.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                let remote = probe.currentPath?.remoteEndpoint
                var host: String?
                var port: Int?
                if case .hostPort(let foundHost, let foundPort)? = remote {
                    host = "\(foundHost)"
                    port = Int(foundPort.rawValue)
                }
                Task { @MainActor [weak self] in
                    self?.settle(name: name, host: host, port: port)
                }
                probe.cancel()
            case .failed, .cancelled:
                Task { @MainActor [weak self] in self?.probes[name] = nil }
            default:
                break
            }
        }
        probe.start(queue: queue)
    }

    private func settle(name: String, host: String?, port: Int?) {
        probes[name] = nil
        guard running, let host, let port else { return }
        resolved[name] = DiscoveredMac(
            name: name,
            endpoint: .bonjour(name: name, host: host, port: port)
        )
        publish()
    }

    private func publish() {
        // Au plus un : le plus petit nom d'instance en comparaison UTF-8.
        let only = resolved.values.min { left, right in
            Array(left.name.utf8).lexicographicallyPrecedes(Array(right.name.utf8))
        }
        onChange?(only.map { [$0] } ?? [])
        if let only, let version = versions[only.name] {
            onProtocolVersion?(version)
        }
    }

    private func reportDenied(_ error: NWError) {
        if case .dns(let code) = error, code == -65570 {
            onDenied?(true)
        }
    }
}
