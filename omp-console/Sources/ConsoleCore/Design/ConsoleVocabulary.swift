// Le vocabulaire commun des écrans (S-11 de omp-console-redesign) : un état se dit
// en UN MOT doublé d'un ton ; durées, tokens et dates passent par les formateurs
// de Foundation.
//
// Fonctions PURES, dans `ConsoleCore` : les deux coques les partagent.

import Foundation

/// Le ton d'un état : la couleur du badge le double, le mot le porte.
public enum ConsoleTone: String, Equatable, Sendable, Codable {
    case neutral, info, attention, success, danger, paused
}

/// L'état affiché d'une carte, d'un run ou d'un fil : un mot et un ton.
public struct ConsoleStatus: Equatable, Sendable, Codable {
    public var text: String
    public var tone: ConsoleTone

    public init(text: String, tone: ConsoleTone) {
        self.text = text
        self.tone = tone
    }
}

/// Durées, tokens et dates des écrans, en français (Doc-10). Les chaînes rendues
/// par Foundation ne sont jamais figées en test.
public enum ConsoleFormat {
    public static let locale = Locale(identifier: "fr_FR")

    /// « 14 min », « 3 h et 32 min », « 45 s » : à la minute dès qu'un écart
    /// dépasse la minute (une durée qui défile à la seconde est du bruit, audit
    /// HIG 2026-10-01) ; un écart négatif ou non fini vaut zéro.
    public static func duration(ms: Double) -> String {
        let bounded = ms.isFinite ? max(0, ms) : 0
        let milliseconds = bounded >= Double(Int64.max) ? Int64.max : Int64(bounded)
        let units: Set<Duration.UnitsFormatStyle.Unit> = milliseconds >= 60_000
            ? [.days, .hours, .minutes]
            : [.seconds]
        return Duration.milliseconds(milliseconds).formatted(
            .units(
                allowed: units,
                width: .abbreviated,
                maximumUnitCount: 2
            ).locale(locale)
        )
    }

    /// « 1 souvenir », « 829 souvenirs », « 0 feature » : un vrai pluriel, jamais
    /// « souvenir(s) ». En français, 0 et 1 prennent le singulier.
    public static func count(_ n: Int, _ singular: String, _ plural: String) -> String {
        "\(n.formatted(.number.locale(locale))) \(abs(n) <= 1 ? singular : plural)"
    }

    /// Le dossier personnel de CETTE machine : celui de l'utilisateur sur macOS,
    /// aucun sur iOS (le bac à sable de l'app n'est le dossier de personne).
    public static var localHome: String? {
        #if os(macOS)
        NSHomeDirectory()
        #else
        nil
        #endif
    }

    /// Un chemin pour l'œil : relatif à `root` s'il est dessous, sinon sous « ~ »
    /// relativement à `home`. Sans `home` (ou vide), le chemin reste absolu.
    public static func path(_ path: String, relativeTo root: String? = nil, home: String?) -> String {
        if let root, !root.isEmpty {
            let base = root.hasSuffix("/") ? root : root + "/"
            if path.hasPrefix(base) { return String(path.dropFirst(base.count)) }
            if path == root { return (root as NSString).lastPathComponent }
        }
        guard var home, !home.isEmpty else { return path }
        while home.count > 1, home.hasSuffix("/") { home.removeLast() }
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }

    /// La forme historique, abrégée sous le dossier personnel LOCAL. Interdite
    /// sur iOS : le dossier local y est le bac à sable, jamais celui du Mac.
    @available(iOS, unavailable)
    public static func path(_ path: String, relativeTo root: String? = nil) -> String {
        self.path(path, relativeTo: root, home: NSHomeDirectory())
    }

    /// « 1,2 k », « 2,5 M ».
    public static func tokens(_ n: Int) -> String {
        n.formatted(.number.notation(.compactName).locale(locale))
    }

    /// « il y a 4 minutes », « hier » — relatif à `nowMs`, jamais à l'horloge du
    /// process (Doc-10).
    public static func relative(ms: Double, nowMs: Double) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .full
        formatter.dateTimeStyle = .named
        return formatter.localizedString(
            for: Date(timeIntervalSince1970: ms / 1000),
            relativeTo: Date(timeIntervalSince1970: nowMs / 1000)
        )
    }

    /// L'heure seule, « 14:05 ».
    public static func time(ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000)
            .formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    }

    /// La date et l'heure en entier, à la minute, « 10 oct. 2026 à 21:54 » : jour,
    /// mois abrégé, année et heure, dans le fuseau donné (celui du process par défaut).
    public static func dateTime(ms: Double, timeZone: TimeZone = .current) -> String {
        var style = Date.FormatStyle(date: .abbreviated, time: .shortened).locale(locale)
        style.timeZone = timeZone
        return Date(timeIntervalSince1970: ms / 1000).formatted(style)
    }
}
