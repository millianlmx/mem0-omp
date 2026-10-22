// Les preuves Swift de la feature `ios-finitions-titres-icones` : les décisions
// PURES des finitions de la coque iOS (icônes de section, …). Chaque test PORTE
// l'id d'acceptation qu'il prouve.

@testable import OMPConsoleIOS
import ConsoleCore
import Testing
import UIKit

@MainActor
@Suite("ios-finitions-titres-icones")
struct IOSFinitionsTests {
    @Test("ios-finitions-titres-icones/AC-5 : « Sommaire » et « Liste » portent deux icônes différentes")
    func summaryAndListIconsDiffer() {
        #expect(IOSMemoryText.summarySymbol != IOSMemoryText.listSymbol)
        #expect(UIImage(systemName: IOSMemoryText.summarySymbol) != nil)
        #expect(UIImage(systemName: IOSMemoryText.listSymbol) != nil)
    }
}
