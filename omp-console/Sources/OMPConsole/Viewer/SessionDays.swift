// La liste « Sessions » rangée par jour (S-16 de omp-console-redesign) : une
// fonction PURE — l'instant de rendu et le calendrier sont des paramètres, la vue
// passe `Calendar.current` et l'heure de son `TimelineView`.

import ConsoleCore
import Foundation

/// Un jour civil de la liste : son identité « aaaa-MM-jj », son titre, ses runs
/// du plus récent au plus ancien.
struct SessionDay: Identifiable, Equatable {
    var id: String
    var title: String
    var choices: [RunChoice]
}

enum SessionDays {
    static let todayTitle = "Aujourd'hui"
    static let yesterdayTitle = "Hier"

    /// Runs triés par `startedAtMs` décroissant (égalité : `sessionFile`
    /// décroissant), un groupe par jour civil de `calendar`, jours décroissants.
    static func group(_ choices: [RunChoice], nowMs: Double, calendar: Calendar) -> [SessionDay] {
        let sorted = choices.sorted { left, right in
            if left.startedAtMs != right.startedAtMs { return left.startedAtMs > right.startedAtMs }
            return left.sessionFile > right.sessionFile
        }
        let now = Date(timeIntervalSince1970: nowMs / 1000)
        var days: [SessionDay] = []
        for choice in sorted {
            let date = Date(timeIntervalSince1970: choice.startedAtMs / 1000)
            let id = dayIdentifier(date, calendar: calendar)
            if days.last?.id == id {
                days[days.count - 1].choices.append(choice)
            } else {
                days.append(SessionDay(id: id, title: title(date, now: now, calendar: calendar), choices: [choice]))
            }
        }
        return days
    }

    /// « aaaa-MM-jj » dans le calendrier donné.
    private static func dayIdentifier(_ date: Date, calendar: Calendar) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// « Aujourd'hui », « Hier », sinon la date complète en français, initiale
    /// en majuscule (Foundation rend « lundi 21 septembre 2026 », Doc-10).
    private static func title(_ date: Date, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return todayTitle }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
           calendar.isDate(date, inSameDayAs: yesterday) {
            return yesterdayTitle
        }
        var style = Date.FormatStyle(date: .complete, time: .omitted).locale(ConsoleFormat.locale)
        // Le jour affiché est celui du calendrier qui a formé le groupe.
        style.calendar = calendar
        style.timeZone = calendar.timeZone
        let text = date.formatted(style)
        return text.prefix(1).uppercased() + text.dropFirst()
    }
}
