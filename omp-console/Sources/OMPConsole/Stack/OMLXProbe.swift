// La sonde oMLX (S-6, BR-2) : oMLX est un prérequis SYSTÈME (natif sur le Mac,
// port 8000) que l'app ne configure pas — elle nomme seulement son absence.
//
// La sonde n'échoue jamais bruyamment : `unreachable(detail)` est un ÉTAT, pas une
// exception, et la vue qui l'affiche est une information, pas une erreur de l'app.
// Budget de 5 s : au-delà, l'état « injoignable » est publié et la prochaine
// actualisation reprend.

import Foundation

enum OMLXStatus: Equatable, Sendable {
    case unknown
    case reachable
    case unauthorized
    case unreachable(detail: String)
}

enum OMLXProbe {
    /// Le budget de la sonde, en secondes.
    static let timeout: Double = 5

    /// Sonde l'URL dérivée de la configuration (`StackConfig.omlxProbeURL`), avec
    /// le jeton configuré s'il y en a un : un 401 signifie alors « jeton refusé »,
    /// pas « pas de jeton ».
    static func status(config: StackConfig, session: URLSession = .shared) async -> OMLXStatus {
        await status(url: config.omlxProbeURL, token: config.omlxApiToken, session: session)
    }

    /// Le statut d'une URL donnée (la forme utilisée par les tests).
    static func status(url: URL, token: String, session: URLSession = .shared) async -> OMLXStatus {
        var configured = URLRequest(url: url)
        configured.httpMethod = "GET"
        configured.timeoutInterval = timeout
        if !token.isEmpty {
            configured.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        // `let` avant le groupe de tâches : une closure `sending` ne peut pas
        // capturer une `var` (mode langage 6).
        let request = configured
        do {
            let status = try await withThrowingTaskGroup(of: OMLXStatus.self) { group in
                group.addTask {
                    let (_, response) = try await session.data(for: request)
                    guard let http = response as? HTTPURLResponse else {
                        return OMLXStatus.unreachable(detail: "réponse illisible")
                    }
                    switch http.statusCode {
                    case 200..<300: return .reachable
                    case 401, 403: return .unauthorized
                    default: return .unreachable(detail: "HTTP \(http.statusCode)")
                    }
                }
                group.addTask {
                    try await Task.sleep(for: .seconds(OMLXProbe.timeout))
                    return OMLXStatus.unreachable(detail: "délai dépassé (\(Int(OMLXProbe.timeout)) s)")
                }
                guard let first = try await group.next() else {
                    return OMLXStatus.unreachable(detail: "délai dépassé (\(Int(OMLXProbe.timeout)) s)")
                }
                group.cancelAll()
                return first
            }
            return status
        } catch {
            return .unreachable(detail: error.localizedDescription)
        }
    }
}
