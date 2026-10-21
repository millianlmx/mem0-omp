// Les preuves Swift du traducteur des pannes de la mémoire du serveur : une panne
// de lecture devient une cause, un remède, jamais un détail technique.

import ConsoleClient
import ConsoleCore
import Foundation
import Testing

@testable import OMPConsoleIOS

/// Le prédicat « lisible » : ni adresse, ni JSON, ni code HTTP à trois chiffres.
private func isReadable(_ text: String) -> Bool {
    let forbidden = ["localhost", "://", "{", "\"detail\""]
    guard !forbidden.contains(where: text.contains) else { return false }
    return text.range(of: #"\b\d{3}\b"#, options: .regularExpression) == nil
}

@Suite("ios-erreurs-serveur-lisibles — les pannes de la mémoire")
struct IOSMemoryErrorTests {
    @Test("chaque panne de lecture donne sa cause")
    func everyReadErrorHasItsCause() {
        #expect(IOSMemoryFailure.of(MemoryReadError.unreachable) == .unreachable)
        #expect(IOSMemoryFailure.of(MemoryReadError.timedOut) == .timedOut)
        #expect(IOSMemoryFailure.of(MemoryReadError.unavailable) == .serviceUnavailable)
        #expect(IOSMemoryFailure.of(MemoryReadError.unauthorized) == .refused)
        #expect(IOSMemoryFailure.of(MemoryReadError.outdated) == .serviceOutdated)
        #expect(IOSMemoryFailure.of(MemoryReadError.failed) == .generic)
        #expect(IOSMemoryFailure.of(CancellationError()) == .generic)
    }

    @Test("chaque cause a son remède, deux à deux différents, et son message porte cause et remède, sans Mac")
    func everyCauseHasItsOwnRemedy() {
        let causes: [IOSMemoryFailure] = [.unreachable, .timedOut, .serviceUnavailable, .refused, .generic]
        for failure in causes {
            let message = IOSMemoryErrorText.message(for: failure)
            #expect(message.contains(IOSMemoryErrorText.cause(failure)))
            #expect(message.contains(IOSMemoryErrorText.remedy(failure)))
            #expect(isReadable(message))
            #expect(!message.contains("Mac"))
        }
        #expect(Set(causes.map(IOSMemoryErrorText.remedy)).count == causes.count)
        // La cause du service trop ancien garde son texte, entier.
        #expect(IOSMemoryErrorText.message(for: .serviceOutdated) == IOSMemoryText.graphServiceOutdated)
    }

    @Test("un jeton refusé renvoie au code d'appairage du serveur")
    func refusedPointsToThePairingCode() {
        #expect(IOSMemoryErrorText.remedy(.refused).contains("code d’appairage"))
    }
}
