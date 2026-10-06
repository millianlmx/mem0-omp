// L'horloge injectable du service distant : le code d'appairage expire sur du
// temps RÉEL, et un test doit pouvoir le faire expirer sans attendre (patron
// `StoreClock`).

import Foundation

struct RemoteClock: Sendable {
    let nowMs: @Sendable () -> Double

    init(nowMs: @escaping @Sendable () -> Double) {
        self.nowMs = nowMs
    }

    static let live = RemoteClock { Date().timeIntervalSince1970 * 1000 }
}
