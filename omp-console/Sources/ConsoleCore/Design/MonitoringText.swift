// Le vocabulaire du MONITORING des features, partagé par la coque Mac et l'app iOS :
// le direct et ses onglets, le coût, les alertes de la veille, la frise, les fichiers
// touchés, les tests en direct et instables, la santé du serveur, la comparaison des
// modèles, et la Live Activity d'une feature sur iPhone.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?, « » avec espaces insécables) et glossaire GLOSSAIRE.md.

public enum MonitoringText {
    // MARK: - Onglets du direct

    public static let tabLive = "Direct"
    public static let tabFiles = "Fichiers"
    public static let tabTests = "Tests"
    public static let tabTimeline = "Frise"
    public static let loadEarlier = "Afficher les entrées précédentes"
    public static let auditSessionTitle = "Analyse en direct"
    public static let refreshSymbol = "arrow.clockwise"
    public static let refresh = "Actualiser"

    // MARK: - Coût

    public static let costLabel = "Coût"
    public static let costSymbol = "dollarsign.circle"
    public static let usageTitle = "Consommation des agents"
    public static let usageHint = "Le coût que les fournisseurs annoncent à omp, message par message ; un fournisseur qui ne dit rien de son prix compte pour zéro."
    public static let usageTotal = "Depuis le début"
    public static let usageWeek = "7 derniers jours"
    public static let usageByDay = "Par jour"
    public static let usageNone = "Aucune consommation relevée."
    public static let usageDayAxis = "Jour"

    /// « 0,42 $ »
    public static func cost(_ value: Double) -> String {
        let cents = Int((value * 100).rounded())
        let units = cents / 100
        let rest = abs(cents % 100)
        return "\(units),\(rest < 10 ? "0" : "")\(rest) $"
    }

    /// « 12 345 jetons »
    public static func tokens(_ count: Int) -> String {
        "\(grouped(count)) \(count == 1 ? "jeton" : "jetons")"
    }

    /// « 0,42 $ sur 1,00 $ »
    public static func budgetLine(cost value: Double, threshold: Double) -> String {
        "\(cost(value)) sur \(cost(threshold))"
    }

    /// « 1,20 $ · 45 000 jetons »
    public static func usageLine(cost value: Double, tokens count: Int) -> String {
        "\(cost(value)) · \(tokens(count))"
    }

    /// Un nombre en groupes de trois chiffres séparés d'une espace insécable.
    public static func grouped(_ value: Int) -> String {
        let digits = String(abs(value))
        var out = ""
        for (index, character) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { out.append(" ") }
            out.append(character)
        }
        return value < 0 ? "-\(out)" : out
    }

    // MARK: - Alertes

    public static let alertsTitle = "Alertes"
    public static let alertsHint = "La veille du serveur : un agent muet, une étape anormalement longue, une boucle de corrections ou un budget dépassé."

    /// « Agent muet depuis 20 min (outil run_tests) »
    public static func alertStalled(minutes: Int?, tool: String?) -> String {
        let base = "Agent muet depuis \(minutes.map { "\($0) min" } ?? "longtemps")"
        guard let tool, !tool.isEmpty else { return base }
        return "\(base) (outil \(tool))"
    }

    /// « Étape /impl lente : 25 min (médiane 10 min) »
    public static func alertSlow(step: String, minutes: Int?, medianMin: Int?) -> String {
        var line = "Étape \(step) lente"
        if let minutes { line += " : \(minutes) min" }
        if let medianMin { line += " (médiane \(medianMin) min)" }
        return line
    }

    /// « 3 corrections : la revue ne passe pas »
    public static func alertFixLoop(fixes: Int?) -> String {
        "\(fixes.map { $0 == 1 ? "1 correction" : "\($0) corrections" } ?? "Plusieurs corrections") : la revue ne passe pas"
    }

    /// « Budget dépassé : 1,50 $ (plafond 1,00 $) — la feature attend votre relance »
    public static func alertBudget(cost value: Double?, threshold: Double?, paused: Bool) -> String {
        var line = "Budget dépassé"
        if let value { line += " : \(cost(value))" }
        if let threshold { line += " (plafond \(cost(threshold)))" }
        if paused { line += " — la feature attend votre relance" }
        return line
    }

    public static let alertUnknown = "Alerte du serveur"

    /// Le symbole SF d'une alerte, d'après son code serveur.
    public static func alertSymbol(_ kind: String) -> String {
        switch kind {
        case MonitoringCodes.stalled: "hourglass"
        case MonitoringCodes.stepSlow: "tortoise"
        case MonitoringCodes.fixLoop: "arrow.triangle.2.circlepath"
        case MonitoringCodes.budgetExceeded: "dollarsign.circle"
        default: "exclamationmark.triangle"
        }
    }

    // MARK: - Frise

    public static let timelineTitle = "Frise"
    public static let timelineSteps = "Étapes"
    public static let timelineEvents = "Événements marquants"
    public static let timelineTests = "Tests"
    public static let timelineDecisions = "Décisions de l’agent"
    public static let timelineEmpty = "Aucune étape pour l’instant."
    public static let timelineUnavailable = "La frise n’est pas lisible : le serveur est peut-être trop ancien."
    public static let timelineTimeAxis = "Heure"
    public static let timelineStepAxis = "Étape"

    /// « /impl · terminée · 4 min · claude-sonnet »
    public static func stepLine(label: String, status: String, duration: String, model: String?) -> String {
        [label, stepStatus(status), duration, model].compactMap { $0 }.joined(separator: " · ")
    }

    public static func stepStatus(_ raw: String) -> String {
        switch raw {
        case "running": "en cours"
        case "done": "terminée"
        case "failed": "en échec"
        case "escalated": "escaladée"
        case "interrupted": "interrompue"
        default: "état inconnu"
        }
    }

    /// Le libellé d'un événement de la frise, d'après son type serveur.
    public static func event(_ type: String) -> String {
        switch type {
        case MonitoringCodes.created: "Feature créée"
        case MonitoringCodes.stepTimeout: "Délai d’étape dépassé"
        case MonitoringCodes.retried: "Relancée"
        case MonitoringCodes.rateLimited: "Limite de débit"
        case MonitoringCodes.modelFailover: "Bascule de modèle"
        case MonitoringCodes.providerRetry: "Nouvel essai du fournisseur"
        case MonitoringCodes.providerError: "Erreur du fournisseur"
        case MonitoringCodes.escalations: "Questions posées"
        case MonitoringCodes.escalationAnswered: "Question répondue"
        case MonitoringCodes.specsReady: "Specs prêtes"
        case MonitoringCodes.verdict: "Verdict rendu"
        case MonitoringCodes.decisionAutoTimeout: "Tranchée à l’échéance"
        case MonitoringCodes.heavyOomRetry: "Tests relancés (mémoire)"
        case MonitoringCodes.heavyFailRetry: "Tests relancés après un rouge"
        case MonitoringCodes.heavyFlaky: "Tests instables"
        case MonitoringCodes.rebased: "Remise à jour sur la branche principale"
        case MonitoringCodes.rebaseConflict: "Conflit avec la branche principale"
        case MonitoringCodes.mergeQueued: "Fusion demandée"
        case MonitoringCodes.mergeRetry: "Fusion relancée"
        case MonitoringCodes.merged: "Fusionnée"
        case MonitoringCodes.pushFailed: "Envoi au dépôt distant refusé"
        case MonitoringCodes.reverted: "Annulée"
        case MonitoringCodes.stalled: "Agent muet"
        case MonitoringCodes.stepSlow: "Étape lente"
        case MonitoringCodes.fixLoop: "Boucle de corrections"
        case MonitoringCodes.budgetExceeded: "Budget dépassé"
        case MonitoringCodes.failed: "Échec"
        case MonitoringCodes.recovered: "Reprise après un redémarrage"
        default: "Événement"
        }
    }

    /// Le symbole SF d'un événement de la frise.
    public static func eventSymbol(_ type: String) -> String {
        switch type {
        case MonitoringCodes.merged: "checkmark.seal"
        case MonitoringCodes.failed, MonitoringCodes.pushFailed, MonitoringCodes.rebaseConflict: "xmark.octagon"
        case MonitoringCodes.rateLimited, MonitoringCodes.providerRetry, MonitoringCodes.providerError, MonitoringCodes.modelFailover: "bolt.horizontal"
        case MonitoringCodes.escalations, MonitoringCodes.escalationAnswered, MonitoringCodes.specsReady, MonitoringCodes.verdict, MonitoringCodes.decisionAutoTimeout: "person.crop.circle.badge.questionmark"
        case MonitoringCodes.stalled, MonitoringCodes.stepSlow, MonitoringCodes.fixLoop, MonitoringCodes.budgetExceeded: alertSymbol(type)
        default: "circle.fill"
        }
    }

    /// « n° 3 · Séparateur → virgule »
    public static func decisionLine(seq: Int, question: String, chosen: String) -> String {
        "n° \(seq) · \(question) → \(chosen)"
    }

    /// « 2. /specs » : une étape sur l'axe de la frise (une étape refaite a sa propre ligne).
    public static func chartStep(position: Int, label: String) -> String { "\(position). \(label)" }

    /// « Coût · 1,20 $ »
    public static func costFooter(_ value: Double) -> String { "\(costLabel) · \(cost(value))" }

    // MARK: - Fichiers touchés

    public static let changesTitle = "Fichiers touchés"
    public static let changesEmpty = "Aucun fichier touché pour l’instant."
    public static let changesUnavailable = "Les fichiers ne sont pas lisibles : le serveur est peut-être trop ancien."
    public static let fileBinary = "binaire"
    public static let diffTruncated = "Différences coupées : le fichier est trop long."
    public static let diffUnavailable = "Les différences de ce fichier ne sont pas lisibles."
    public static let diffChoose = "Choisissez un fichier pour lire ses différences."

    /// D'où viennent les fichiers : le dossier de la feature, ou la version fusionnée.
    public static func changesSource(_ raw: String?) -> String {
        switch raw {
        case MonitoringCodes.sourceWorkingCopy: "Dossier de la feature, depuis sa base"
        case MonitoringCodes.sourceMerge: "Version fusionnée dans la branche principale"
        default: "Rien à lire"
        }
    }

    /// « +12 −3 »
    public static func lines(added: Int?, removed: Int?) -> String {
        guard added != nil || removed != nil else { return fileBinary }
        return "+\(added ?? 0) −\(removed ?? 0)"
    }

    /// « 4 fichiers · +120 −8 »
    public static func changesSummary(count: Int, added: Int, removed: Int) -> String {
        "\(count == 1 ? "1 fichier" : "\(count) fichiers") · +\(added) −\(removed)"
    }

    /// « modifié · +12 −3 »
    public static func fileLine(status: String, added: Int?, removed: Int?) -> String {
        "\(fileStatus(status)) · \(lines(added: added, removed: removed))"
    }

    public static func fileStatus(_ code: String) -> String {
        switch code {
        case "A": "ajouté"
        case "D": "supprimé"
        case "R": "renommé"
        default: "modifié"
        }
    }

    // MARK: - Tests

    public static let testsTitle = "Tests en direct"
    public static let testsEmpty = "Aucun test lancé pour l’instant."
    public static let testRunning = "En cours…"
    public static let flakyTitle = "Tests instables"
    public static let flakyHint = "Verts après un rouge sur le même arbre : un échec qui ne dit rien du code."
    public static let flakyNone = "Aucun test instable relevé."

    public static func testScope(_ raw: String) -> String {
        switch raw {
        case "touched": "Tests touchés"
        case "full": "Suite complète"
        case "check": "Vérification"
        default: "Tests"
        }
    }

    public static func testOutcome(_ raw: String?) -> String {
        switch raw {
        case nil: testRunning
        case "pass": "Vert"
        case "fail": "Rouge"
        case "oom": "Mémoire dépassée"
        case "timeout": "Délai dépassé"
        case "error": "Lancement impossible"
        case "aborted": "Arrêté"
        default: "Issue inconnue"
        }
    }

    /// « Suite complète · essai 2 · Vert »
    public static func testLine(scope: String, attempt: Int, outcome: String?) -> String {
        "\(testScope(scope)) · essai \(attempt) · \(testOutcome(outcome))"
    }

    /// « 3 fois, dernière le 24/10 »
    public static func flakyLine(count: Int, last: String) -> String {
        "\(count == 1 ? "1 fois" : "\(count) fois"), dernière le \(last)"
    }

    /// « demo · Suite complète · 3 fois, dernière le 24/10/2026 »
    public static func flakyRow(repo: String, scope: String, count: Int, last: String) -> String {
        "\(repo) · \(testScope(scope)) · \(flakyLine(count: count, last: last))"
    }

    /// Le symbole SF de l'issue d'un job.
    public static func testSymbol(_ outcome: String?) -> String {
        switch outcome {
        case nil: "hourglass"
        case "pass": "checkmark.circle"
        default: "xmark.octagon"
        }
    }

    // MARK: - Santé du serveur

    public static let healthTitle = "Santé du serveur"
    public static let healthAgents = "Agents occupés"
    public static let healthTests = "Tests occupés"
    public static let healthWaiting = "En attente"
    public static let healthMemory = "Mémoire libre"
    public static let healthQueue = "Features en file"
    public static let healthIncidents = "Limites de débit et bascules"
    public static let healthTimeAxis = "Heure"
    public static let healthValueAxis = "Nombre"

    /// « Pas encore de relevé : le serveur en prend un toutes les 15 s. »
    public static func healthEmpty(sampleSec: Int) -> String {
        "Pas encore de relevé : le serveur en prend un toutes les \(sampleSec) s."
    }

    /// « 2 sur 5 · 1 en attente »
    public static func slotsLine(used: Int, capacity: Int, waiting: Int) -> String {
        waiting > 0 ? "\(used) sur \(capacity) · \(waiting) en attente" : "\(used) sur \(capacity)"
    }

    // MARK: - Modèles

    public static let modelsTitle = "Modèles"
    public static let modelsHint = "Chaque modèle sur ses étapes : échecs, durée médiane, implémentations renvoyées en correction, features fusionnées et coût."
    public static let modelsNone = "Aucune étape conduite par un modèle connu."

    /// « 12 étapes · 1 en échec · médiane 4 min »
    public static func modelSteps(steps: Int, failed: Int, median: String?) -> String {
        var parts = [steps == 1 ? "1 étape" : "\(steps) étapes"]
        if failed > 0 { parts.append("\(failed) en échec") }
        if let median { parts.append("médiane \(median)") }
        return parts.joined(separator: " · ")
    }

    /// « 25 % corrigées · 3 fusionnées · 1,20 $ »
    public static func modelOutcome(corrected: String?, merged: Int, cost value: Double) -> String {
        var parts: [String] = []
        if let corrected { parts.append("\(corrected) corrigées") }
        parts.append(merged == 1 ? "1 fusionnée" : "\(merged) fusionnées")
        parts.append(cost(value))
        return parts.joined(separator: " · ")
    }

    // MARK: - Live Activity (iPhone)

    public static let activityStart = "Suivre sur l’écran verrouillé"
    public static let activityStop = "Ne plus suivre sur l’écran verrouillé"
    public static let activitySymbol = "lock.iphone"
}
