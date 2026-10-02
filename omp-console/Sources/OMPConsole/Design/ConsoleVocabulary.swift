// Le vocabulaire commun des écrans (S-11 de omp-console-redesign) : l'état d'une
// carte ou d'un run se dit en UN MOT doublé d'un ton, une étape se nomme en
// français, durées, tokens et dates passent par les formateurs de Foundation.
//
// Fonctions PURES : les écrans (Accueil, Pipelines, Sessions, Statistiques,
// conversation) les appellent, aucun ne compose son propre libellé d'état.

import Foundation

/// Le ton d'un état : la couleur du badge le double, le mot le porte.
enum ConsoleTone: Equatable, Sendable {
    case neutral, info, attention, success, danger, paused
}

/// L'état affiché d'une carte, d'un run ou d'un fil : un mot et un ton.
struct ConsoleStatus: Equatable, Sendable {
    var text: String
    var tone: ConsoleTone

    /// L'état d'une carte de l'ardoise. Une carte que « Reprendre » peut relancer
    /// est « En pause » quelle que soit sa colonne (le pilote est mort, la feature
    /// vit encore).
    static func of(card: KanbanCard) -> ConsoleStatus {
        if KanbanActionPresentation.resumable(card) {
            return ConsoleStatus(text: "En pause", tone: .paused)
        }
        switch card.column {
        case .enAttente: return ConsoleStatus(text: "Pas commencée", tone: .neutral)
        case .enCours: return ConsoleStatus(text: "En cours", tone: .info)
        case .questionEnVol: return ConsoleStatus(text: "À vous", tone: .attention)
        case .prOuverte: return ConsoleStatus(text: "PR ouverte", tone: .success)
        case .fusionne: return ConsoleStatus(text: "Fusionnée", tone: .success)
        case .echec: return ConsoleStatus(text: "Échec", tone: .danger)
        case .jalonSpecs: return ConsoleStatus(text: "Specs à valider", tone: .attention)
        case .jalonReview: return ConsoleStatus(text: "Revue à accepter", tone: .attention)
        case .bloquee: return ConsoleStatus(text: "Bloquée", tone: .danger)
        case .termineeSansPr: return ConsoleStatus(text: "Terminée", tone: .neutral)
        case .annuleeRetiree: return ConsoleStatus(text: "Annulée", tone: .neutral)
        }
    }

    /// L'état d'un run de la liste des sessions : un run vivant au propriétaire
    /// périmé est « Interrompu ».
    static func of(run: RunChoice) -> ConsoleStatus {
        switch run.state {
        case .live where run.isStale:
            return ConsoleStatus(text: "Interrompu", tone: .neutral)
        case .live(.running):
            return ConsoleStatus(text: "En cours", tone: .info)
        case .live(.waiting):
            return ConsoleStatus(text: "À vous", tone: .attention)
        case .ended(.done):
            return ConsoleStatus(text: "Terminé", tone: .success)
        case .ended(.failed):
            return ConsoleStatus(text: "Échec", tone: .danger)
        }
    }

    /// L'état d'une session OMP hébergée (Session OMP, Projet) : le mot de
    /// `SessionConsoleText.stateTitle` et son ton.
    static func of(session state: SessionHost.State, hasProject: Bool) -> ConsoleStatus {
        let text = SessionConsoleText.stateTitle(state, hasProject: hasProject)
        let tone: ConsoleTone = switch state {
        case .running: .success
        case .launching: .info
        case .stopping, .idle, .stopped: .neutral
        case .dead, .failed: .danger
        }
        return ConsoleStatus(text: text, tone: tone)
    }
}

/// Le nom et le symbole d'une étape de pipeline.
enum PhaseText {
    static func title(_ phase: PipelinePhase) -> String {
        switch phase {
        case .req: return "Clarification"
        case .specs: return "Spécification"
        case .impl: return "Implémentation"
        case .review: return "Revue"
        case .release: return "Publication"
        }
    }

    static func symbol(_ phase: PipelinePhase?) -> String {
        switch phase {
        case .req: return "text.bubble"
        case .specs: return "doc.text"
        case .impl: return "hammer"
        case .review: return "checkmark.seal"
        case .release: return "shippingbox"
        case nil: return "circle.dashed"
        }
    }
}

/// Durées, tokens et dates des écrans, en français (Doc-10). Les chaînes rendues
/// par Foundation ne sont jamais figées en test.
enum ConsoleFormat {
    static let locale = Locale(identifier: "fr_FR")

    /// « 14 min », « 3 h et 32 min », « 45 s » : à la minute dès qu'un écart
    /// dépasse la minute (une durée qui défile à la seconde est du bruit, audit
    /// HIG 2026-10-01) ; un écart négatif ou non fini vaut zéro.
    static func duration(ms: Double) -> String {
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
    static func count(_ n: Int, _ singular: String, _ plural: String) -> String {
        "\(n.formatted(.number.locale(locale))) \(abs(n) <= 1 ? singular : plural)"
    }

    /// Un chemin pour l'œil : le dossier personnel devient « ~ ». Un chemin
    /// relatif à `root` (s'il est dessous) est rendu relatif.
    static func path(_ path: String, relativeTo root: String? = nil) -> String {
        if let root, !root.isEmpty {
            let base = root.hasSuffix("/") ? root : root + "/"
            if path.hasPrefix(base) { return String(path.dropFirst(base.count)) }
            if path == root { return (root as NSString).lastPathComponent }
        }
        let home = NSHomeDirectory()
        if path == home { return "~" }
        if path.hasPrefix(home + "/") { return "~" + path.dropFirst(home.count) }
        return path
    }

    /// « 1,2 k », « 2,5 M ».
    static func tokens(_ n: Int) -> String {
        n.formatted(.number.notation(.compactName).locale(locale))
    }

    /// « il y a 4 minutes », « hier » — relatif à `nowMs`, jamais à l'horloge du
    /// process (Doc-10).
    static func relative(ms: Double, nowMs: Double) -> String {
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
    static func time(ms: Double) -> String {
        Date(timeIntervalSince1970: ms / 1000)
            .formatted(Date.FormatStyle(date: .omitted, time: .shortened).locale(locale))
    }
}
