// Preuves du vocabulaire commun (S-11 de omp-console-redesign) : durées, comptes,
// chemins et dates. Aucune chaîne de Foundation n'est figée (Doc-10) : les
// formateurs sont vérifiés par leurs bornes.

import Foundation
import Testing
@testable import OMPConsole
@testable import ConsoleCore

@Test("omp-console-redesign/S-11 : une durée négative ou non finie est bornée à zéro")
func durationIsBoundedAtZero() {
    // Aucune chaîne Foundation figée : la borne se vérifie par égalité.
    #expect(ConsoleFormat.duration(ms: -5_000) == ConsoleFormat.duration(ms: 0))
    #expect(ConsoleFormat.duration(ms: .nan) == ConsoleFormat.duration(ms: 0))
}

@Test("audit HIG : au-delà d'une minute, une durée est arrondie à la minute — les secondes ne défilent plus")
func durationDropsSecondsAboveAMinute() {
    // Au-delà d'une minute, les secondes ne comptent plus (Foundation arrondit à
    // la minute la plus proche) ; en deçà, elles restent.
    #expect(ConsoleFormat.duration(ms: 3_610_000) == ConsoleFormat.duration(ms: 3_600_000))
    #expect(ConsoleFormat.duration(ms: 125_000) == ConsoleFormat.duration(ms: 120_000))
    #expect(ConsoleFormat.duration(ms: 59_000) != ConsoleFormat.duration(ms: 58_000))
}

@Test("audit HIG : un compte prend un vrai pluriel, 0 et 1 au singulier")
func countUsesFrenchPlural() {
    #expect(ConsoleFormat.count(0, "souvenir", "souvenirs") == "0 souvenir")
    #expect(ConsoleFormat.count(1, "souvenir", "souvenirs") == "1 souvenir")
    #expect(ConsoleFormat.count(2, "souvenir", "souvenirs") == "2 souvenirs")
}

@Test("audit HIG : un chemin s'affiche relatif à sa racine, sinon sous « ~ »")
func pathIsShortenedForDisplay() {
    let home = NSHomeDirectory()
    #expect(ConsoleFormat.path("/r/depot/src/a.swift", relativeTo: "/r/depot") == "src/a.swift")
    #expect(ConsoleFormat.path("/r/depot", relativeTo: "/r/depot") == "depot")
    #expect(ConsoleFormat.path("/r/depotbis/a", relativeTo: "/r/depot") == "/r/depotbis/a")
    #expect(ConsoleFormat.path(home + "/Experiments/x") == "~/Experiments/x")
    #expect(ConsoleFormat.path("/tmp/x") == "/tmp/x")
}

@Test("mac-feuille-appairage-debordante/AC-8 : une date complète dit le jour, le mois abrégé, l'année et l'heure")
func dateTimeShowsTheWholeDate() throws {
    let paris = try #require(TimeZone(identifier: "Europe/Paris"))
    #expect(ConsoleFormat.dateTime(ms: 1_791_662_040_000, timeZone: paris) == "10 oct. 2026 à 21:54")
    // 5 janvier 2026 09:07 et 24 décembre 2026 18:30, heure de Paris (l'heure
    // n'a pas de zéro initial en fr_FR).
    #expect(ConsoleFormat.dateTime(ms: 1_767_600_420_000, timeZone: paris) == "5 janv. 2026 à 9:07")
    #expect(ConsoleFormat.dateTime(ms: 1_798_133_400_000, timeZone: paris) == "24 déc. 2026 à 18:30")
}

@Test("feuilles-ios-presentation-et-depots/AC-7 : un chemin sous le dossier personnel donné s'abrège en « ~ », jamais un préfixe homonyme")
func pathAbbreviatesGivenHome() {
    #expect(ConsoleFormat.path("/Users/x/a", home: "/Users/x") == "~/a")
    #expect(ConsoleFormat.path("/Users/x/a", home: "/Users/x/") == "~/a")
    #expect(ConsoleFormat.path("/Users/x", home: "/Users/x") == "~")
    #expect(ConsoleFormat.path("/Users/xy/a", home: "/Users/x") == "/Users/xy/a")
    #expect(ConsoleFormat.path("/Users/x/a", home: nil) == "/Users/x/a")
    #expect(ConsoleFormat.path("/Users/x/a", home: "") == "/Users/x/a")
    // La racine du projet reste prioritaire sur le dossier personnel.
    #expect(ConsoleFormat.path("/Users/x/p/f", relativeTo: "/Users/x/p", home: "/Users/x") == "f")
    // Sur macOS, le dossier local est celui de l'utilisateur, et la forme historique en dépend.
    #expect(ConsoleFormat.localHome == NSHomeDirectory())
    #expect(ConsoleFormat.path(NSHomeDirectory() + "/a") == ConsoleFormat.path(NSHomeDirectory() + "/a", home: NSHomeDirectory()))
}

@Test("ios-pipelines-cartes-homonymes : la date d'une carte se lit à la minute")
func dateTimeShowsTheMinute() throws {
    let paris = try #require(TimeZone(identifier: "Europe/Paris"))
    let base = 1_791_549_120_000.0  // 2026-10-09 14:32 Europe/Paris
    let first = ConsoleFormat.dateTime(ms: base, timeZone: paris)
    #expect(first.contains("14:32"))
    #expect(first.contains("2026"))
    let next = ConsoleFormat.dateTime(ms: base + 60_000, timeZone: paris)
    #expect(next.contains("14:33"))
    #expect(next != first)
    // Pas de secondes : vingt secondes de plus restent dans la même minute.
    #expect(ConsoleFormat.dateTime(ms: base + 20_000, timeZone: paris) == first)
}
