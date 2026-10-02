// Preuves de S-16 (omp-console-redesign) : la liste « Sessions » rangée par jour,
// et le dépôt et le titre d'un run tirés de son label.

import Foundation
import Testing

@testable import OMPConsole

private func parisCalendar() -> Calendar {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "Europe/Paris")!
    return calendar
}

private func parisMs(_ calendar: Calendar, day: Int, hour: Int) -> Double {
    let date = calendar.date(from: DateComponents(year: 2026, month: 9, day: day, hour: hour))!
    return date.timeIntervalSince1970 * 1000
}

private func dayRun(_ sessionFile: String, startedAtMs: Double) -> RunChoice {
    RunChoice(
        id: sessionFile, sessionFile: sessionFile, label: "depot/f",
        repo: "depot", featureTitle: "f", startedAtMs: startedAtMs, phase: .impl,
        state: .ended(.done), isStale: false,
        target: ViewerTarget(sessionFile: sessionFile, title: "t")
    )
}

@Test("omp-console-redesign/S-16 : les sessions se rangent par jour, la plus récente en tête")
func sessionsAreGroupedByDay() throws {
    let calendar = parisCalendar()
    let now = parisMs(calendar, day: 30, hour: 15)
    let morning = dayRun("/s/a.jsonl", startedAtMs: parisMs(calendar, day: 30, hour: 10))
    let afternoon = dayRun("/s/b.jsonl", startedAtMs: parisMs(calendar, day: 30, hour: 14))
    let yesterday = dayRun("/s/c.jsonl", startedAtMs: parisMs(calendar, day: 29, hour: 9))
    let older = dayRun("/s/d.jsonl", startedAtMs: parisMs(calendar, day: 27, hour: 8))

    let days = SessionDays.group([older, morning, yesterday, afternoon], nowMs: now, calendar: calendar)

    #expect(days.map(\.title).prefix(2) == ["Aujourd'hui", "Hier"])
    #expect(days.map(\.id) == ["2026-09-30", "2026-09-29", "2026-09-27"])
    #expect(days.map { $0.choices.map(\.sessionFile) } == [
        [afternoon.sessionFile, morning.sessionFile],
        [yesterday.sessionFile],
        [older.sessionFile],
    ])
    try #require(days.count == 3)
    let olderTitle = days[2].title
    #expect(olderTitle != "Aujourd'hui" && olderTitle != "Hier")
    let initial = try #require(olderTitle.first)
    #expect(initial.isUppercase)

    // Deux runs à la même milliseconde : l'ordre suit le nom de fichier, décroissant.
    let twinA = dayRun("/s/x-a.jsonl", startedAtMs: now)
    let twinB = dayRun("/s/x-b.jsonl", startedAtMs: now)
    let twins = SessionDays.group([twinA, twinB], nowMs: now, calendar: calendar)
    #expect(twins.map { $0.choices.map(\.sessionFile) } == [[twinB.sessionFile, twinA.sessionFile]])
}

@Test("omp-console-redesign/S-16 : le titre et le dépôt d'un run viennent de son label")
func runTitleAndRepoComeFromLabel() {
    let plain = RunChoice.split(label: "mem0-omp/api-rate", cwd: "/ailleurs")
    #expect(plain.repo == "mem0-omp")
    #expect(plain.title == "api-rate")

    let nested = RunChoice.split(label: "a/b/c", cwd: "/ailleurs")
    #expect(nested.repo == "a/b")
    #expect(nested.title == "c")

    let solo = RunChoice.split(label: "solo", cwd: "/x/depot")
    #expect(solo.repo == "depot")
    #expect(solo.title == "solo")
}
