import ConsoleCore
import Testing

@testable import OMPConsoleIOS

/// Les preuves Swift du crochet d'état `-ios.state` (S-3, BR-3) : la dernière
/// paire reconnue gagne, et une valeur absente, vide ou inconnue ne devient
/// JAMAIS une erreur.
@Suite("design-ios — le crochet d'état d'écran")
struct IOSScreenStateTests {
    @Test("design-ios/AC-4 : -ios.state lit la dernière paire reconnue, et le reste vaut ready")
    func resolveScreenState() {
        #expect(IOSScreenState.resolve([]) == .ready)
        #expect(IOSScreenState.resolve(["-ios.state"]) == .ready)
        #expect(IOSScreenState.resolve(["-ios.state", ""]) == .ready)
        #expect(IOSScreenState.resolve(["-ios.state", "inconnu"]) == .ready)
        #expect(IOSScreenState.resolve(["-ios.state", "ready"]) == .ready)
        #expect(IOSScreenState.resolve(["-ios.state", "error"]) == .error(IOSText.recipeError))

        // La DERNIÈRE paire reconnue gagne ; une paire inconnue plus loin ne
        // défait pas un choix valide.
        #expect(IOSScreenState.resolve(["-ios.state", "error", "-ios.state", "ready"]) == .ready)
        #expect(IOSScreenState.resolve(["-ios.state", "error", "-ios.state", "inconnu"]) == .error(IOSText.recipeError))
    }

    @Test("design-ios/AC-4 : seul l'état d'erreur porte un bandeau, et il est danger")
    func onlyErrorCarriesBanner() {
        #expect(IOSScreenState.ready.banner == nil)
        #expect(IOSScreenState.ready.bannerMessage == nil)
        #expect(IOSScreenState.error(IOSText.recipeError).banner == ConsoleStatus(text: IOSText.recipeError, tone: .danger))
        #expect(IOSScreenState.error(IOSText.recipeError).bannerMessage == IOSText.recipeError)
    }
}
