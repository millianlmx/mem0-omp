// La remontée des erreurs de l'app au serveur (contrat C2, `POST /v1/client-errors`,
// rôle viewer) : une réponse illisible (le décodage d'un 2xx échoue) ou un statut HTTP
// INATTENDU (5xx, 3xx, 405…) — jamais une réponse métier (400 motivé, 401, 403, 404
// d'une route absente d'un serveur ancien, 409, 412, 428, 429) ni une coupure réseau.
//
// Bornée côté app, en plus du débit du serveur (60/min par client) : une même erreur
// (méthode, chemin sans requête, sorte, statut) ne repart pas avant dix minutes, dix
// envois au plus par minute, deux cents par lancement. Un serveur qui ne connaît pas
// la route (404, 405) coupe la remontée jusqu'au prochain serveur relié. Le chemin part
// SANS sa requête (`?path=`, `?q=` : aucune saisie de l'utilisateur ne quitte l'app).

import Foundation

/// Une erreur à remonter : le corps de `POST /v1/client-errors`.
public struct HarnessClientError: Encodable, Equatable, Sendable {
    public var source: String
    public var version: String
    public var kind: String
    public var message: String
    public var context: [String: String]?

    public init(source: String, version: String, kind: String, message: String, context: [String: String]? = nil) {
        self.source = source
        self.version = version
        self.kind = kind
        self.message = message
        self.context = context
    }
}

/// Le tri et la borne des erreurs remontées ; sans réseau, donc testable seul.
public struct HarnessErrorReporter: Sendable {
    public static let route = "/v1/client-errors"
    /// La même erreur ne repart pas avant ce délai (secondes).
    public static let repeatDelay: Double = 600
    /// Au plus tant d'envois par minute, et tant par lancement de l'app.
    public static let perMinute = 10
    public static let perLaunch = 200

    /// `mac` ou `ios` : la plateforme qui compile ce client.
    public let source: String
    public let version: String
    private var lastSent: [String: Double] = [:]
    private var recent: [Double] = []
    private var total = 0
    /// Le serveur relié ne connaît pas la route : plus rien ne part vers lui.
    public private(set) var muted = false

    public init(source: String = HarnessErrorReporter.platform, version: String = HarnessErrorReporter.appVersion) {
        self.source = source
        self.version = version
    }

    /// Une remontée coupée d'office (doublures de test qui ne jouent pas le contrat).
    public static var off: HarnessErrorReporter {
        var reporter = HarnessErrorReporter()
        reporter.muted = true
        reporter.silenced = true
        return reporter
    }

    /// Coupée d'office : même un nouveau serveur ne la rouvre pas.
    private var silenced = false

    public static var platform: String {
        #if os(iOS)
        "ios"
        #else
        "mac"
        #endif
    }

    public static var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    }

    /// La sorte d'erreur d'un statut, ou `nil` pour une réponse attendue.
    public static func kind(ofStatus status: Int) -> String? {
        switch status {
        case 200 ..< 300, 400, 401, 403, 404, 409, 412, 422, 428, 429: nil
        default: "http"
        }
    }

    /// Le chemin sans sa requête.
    public static func bare(_ path: String) -> String {
        String(path.prefix { $0 != "?" })
    }

    /// L'erreur d'une réponse inattendue, ou `nil` si rien n'est à remonter.
    public static func error(httpStatus status: Int, call: HarnessCall, serverMessage: String?) -> (kind: String, message: String, context: [String: String])? {
        guard let kind = kind(ofStatus: status) else { return nil }
        var context = ["method": call.method, "path": bare(call.path), "status": String(status)]
        if let serverMessage, !serverMessage.isEmpty { context["error"] = String(serverMessage.prefix(200)) }
        return (kind, "\(call.method) \(bare(call.path)) -> HTTP \(status)", context)
    }

    /// L'erreur d'un corps 2xx que l'app ne sait pas lire.
    public static func error(unreadable type: String, call: HarnessCall) -> (kind: String, message: String, context: [String: String]) {
        let context = ["method": call.method, "path": bare(call.path), "type": type]
        return ("decode", "\(call.method) \(bare(call.path)) -> \(type) illisible", context)
    }

    /// Admet une erreur à l'envoi (et la compte), ou la refuse : coupée, déjà envoyée
    /// il y a moins de `repeatDelay`, ou débit dépassé. `now` en secondes.
    public mutating func admit(kind: String, context: [String: String], now: Double) -> Bool {
        guard !muted, total < Self.perLaunch else { return false }
        let key = [kind, context["method"] ?? "", context["path"] ?? "", context["status"] ?? "", context["type"] ?? ""].joined(separator: " ")
        if let last = lastSent[key], now - last < Self.repeatDelay { return false }
        recent.removeAll { now - $0 >= 60 }
        guard recent.count < Self.perMinute else { return false }
        recent.append(now)
        lastSent[key] = now
        total += 1
        return true
    }

    /// Le serveur a répondu à un envoi : une route inconnue coupe la remontée.
    public mutating func received(status: Int) {
        if status == 404 || status == 405 { muted = true }
    }

    /// Un nouveau serveur est relié : la coupure et les répétitions sont oubliées (pas le total).
    public mutating func reset() {
        muted = silenced
        lastSent = [:]
        recent = []
    }
}

extension HarnessModel {
    /// Remonte un statut inattendu (sans effet pour une réponse attendue).
    func reportIfUnexpected(_ reply: HarnessReply, for call: HarnessCall) {
        let message = (try? JSONDecoder().decode(HarnessErrorBody.self, from: reply.body))?.error
        guard let error = HarnessErrorReporter.error(httpStatus: reply.status, call: call, serverMessage: message) else { return }
        send(kind: error.kind, message: error.message, context: error.context)
    }

    /// Remonte un corps 2xx illisible.
    func reportUnreadable<T>(_ call: HarnessCall, type: T.Type) {
        let error = HarnessErrorReporter.error(unreadable: String(describing: type), call: call)
        send(kind: error.kind, message: error.message, context: error.context)
    }

    private func send(kind: String, message: String, context: [String: String]) {
        guard let server, reporter.admit(kind: kind, context: context, now: Date().timeIntervalSince1970) else { return }
        let report = HarnessClientError(source: reporter.source, version: reporter.version, kind: kind, message: message, context: context)
        guard let body = try? JSONEncoder().encode(report) else { return }
        let transport = transport
        let call = HarnessCall(method: "POST", path: HarnessErrorReporter.route, body: body)
        Task { [weak self] in
            // Directement par le transport : un échec de la remontée n'est jamais remonté.
            guard let reply = try? await transport.send(call, server: server) else { return }
            self?.reporter.received(status: reply.status)
        }
    }
}
