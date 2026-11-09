// Le vocabulaire du MONITORING des features, partagé par la coque Mac et l'app iOS :
// le direct et ses onglets, le coût, les alertes de la veille, la frise, les fichiers
// touchés, les tests en direct et instables, la santé du serveur, la comparaison des
// modèles, et la Live Activity d'une feature sur iPhone.
//
// Fichier de VOCABULAIRE (`*Text.swift`) : typographie française (’, espace
// insécable avant ; : ! ?, « » avec espaces insécables) et glossaire GLOSSAIRE.md.
// Chaque phrase passe par `L10n` : sa clé est le texte français, sa traduction
// anglaise vit dans `Resources/en.lproj/Localizable.strings` (localisation-apps).

import Foundation

public enum MonitoringText {
    // MARK: - Onglets du direct

    public static let tabLive = L10n.text("Direct")
    public static let tabFiles = L10n.text("Fichiers")
    public static let tabTests = L10n.text("Tests")
    public static let tabTimeline = L10n.text("Frise")
    public static let loadEarlier = L10n.text("Afficher les entrées précédentes")
    public static let auditSessionTitle = L10n.text("Analyse en direct")
    public static let refreshSymbol = "arrow.clockwise"
    public static let refresh = L10n.text("Actualiser")

    // MARK: - Coût

    public static let costLabel = L10n.text("Coût")
    public static let costSymbol = "dollarsign.circle"
    public static let usageTitle = L10n.text("Consommation des agents")
    public static let usageHint = L10n.text("Le coût que les fournisseurs annoncent à omp, message par message ; un fournisseur qui ne dit rien de son prix compte pour zéro.")
    public static let usageTotal = L10n.text("Depuis le début")
    public static let usageWeek = L10n.text("7 derniers jours")
    public static let usageByDay = L10n.text("Par jour")
    public static let usageNone = L10n.text("Aucune consommation relevée.")
    public static let usageDayAxis = L10n.text("Jour")

    /// « 0,42 $ »
    public static func cost(_ value: Double) -> String {
        let cents = Int((value * 100).rounded())
        let units = cents / 100
        let rest = abs(cents % 100)
        let separator = ConsoleFormat.locale.decimalSeparator ?? ","
        return L10n.format("%@ $", "\(units)\(separator)\(rest < 10 ? "0" : "")\(rest)")
    }

    /// « 12 345 jetons »
    public static func tokens(_ count: Int) -> String {
        "\(grouped(count)) \(count == 1 ? L10n.text("jeton") : L10n.text("jetons"))"
    }

    /// « 0,42 $ sur 1,00 $ »
    public static func budgetLine(cost value: Double, threshold: Double) -> String {
        L10n.format("%@ sur %@", cost(value), cost(threshold))
    }

    /// « 1,20 $ · 45 000 jetons »
    public static func usageLine(cost value: Double, tokens count: Int) -> String {
        "\(cost(value)) · \(tokens(count))"
    }

    /// Un nombre en groupes de trois chiffres séparés d'une espace insécable.
    public static func grouped(_ value: Int) -> String {
        let digits = String(abs(value))
        let separator = ConsoleFormat.locale.groupingSeparator == "," ? "," : " "
        var out = ""
        for (index, character) in digits.enumerated() {
            if index > 0, (digits.count - index) % 3 == 0 { out.append(separator) }
            out.append(character)
        }
        return value < 0 ? "-\(out)" : out
    }

    // MARK: - Alertes

    public static let alertsTitle = L10n.text("Alertes")
    public static let alertsHint = L10n.text("La veille du serveur : un agent muet, une étape anormalement longue, une boucle de corrections ou un budget dépassé.")

    /// « Agent muet depuis 20 min (outil run_tests) »
    public static func alertStalled(minutes: Int?, tool: String?) -> String {
        let base = minutes.map { L10n.format("Agent muet depuis %lld min", $0) } ?? L10n.text("Agent muet depuis longtemps")
        guard let tool, !tool.isEmpty else { return base }
        return L10n.format("%@ (outil %@)", base, tool)
    }

    /// « Étape /review lente : en cours depuis 31 min (médiane 36 s) » — la durée mesurée à `now` depuis `startedAt` (ms) ;
    /// un serveur ancien, sans `startedAt`/`medianMs`, garde « : 25 min (médiane 10 min) », figés au déclenchement.
    public static func alertSlow(step: String, startedAt: Double?, medianMs: Double?, minutes: Int?, medianMin: Int?, now: Date) -> String {
        var line = L10n.format("Étape %@ lente", step)
        if let startedAt {
            line += L10n.format(" : en cours depuis %lld min", max(0, Int((now.timeIntervalSince1970 * 1000 - startedAt) / 60_000)))
        } else if let minutes {
            line += L10n.format(" : %lld min", minutes)
        }
        if let medianMs {
            let seconds = Int((medianMs / 1000).rounded())
            line += seconds < 60 ? L10n.format(" (médiane %lld s)", seconds) : L10n.format(" (médiane %lld min)", Int((Double(seconds) / 60).rounded()))
        } else if let medianMin {
            line += L10n.format(" (médiane %lld min)", medianMin)
        }
        return line
    }

    /// « 3 corrections : la revue ne passe pas »
    public static func alertFixLoop(fixes: Int?) -> String {
        let fixLine = fixes.map { $0 == 1 ? L10n.text("1 correction") : L10n.format("%lld corrections", $0) }
        return L10n.format("%@ : la revue ne passe pas", fixLine ?? L10n.text("Plusieurs corrections"))
    }

    /// « Budget dépassé : 1,50 $ (plafond 1,00 $) — la feature attend votre relance »
    public static func alertBudget(cost value: Double?, threshold: Double?, paused: Bool) -> String {
        var line = L10n.text("Budget dépassé")
        if let value { line += L10n.format(" : %@", cost(value)) }
        if let threshold { line += L10n.format(" (plafond %@)", cost(threshold)) }
        if paused { line += L10n.text(" — la feature attend votre relance") }
        return line
    }

    public static let alertUnknown = L10n.text("Alerte du serveur")

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

    public static let timelineTitle = L10n.text("Frise")
    public static let timelineSteps = L10n.text("Étapes")
    public static let timelineEvents = L10n.text("Événements marquants")
    public static let timelineTests = L10n.text("Tests")
    public static let timelineDecisions = L10n.text("Décisions de l’agent")
    public static let timelineEmpty = L10n.text("Aucune étape pour l’instant.")
    public static let timelineUnavailable = L10n.text("La frise n’est pas lisible : le serveur est peut-être trop ancien.")
    public static let timelineTimeAxis = L10n.text("Heure")
    public static let timelineStepAxis = L10n.text("Étape")

    /// « /impl · terminée · 4 min · claude-sonnet »
    public static func stepLine(label: String, status: String, duration: String, model: String?) -> String {
        [label, stepStatus(status), duration, model].compactMap { $0 }.joined(separator: " · ")
    }

    public static func stepStatus(_ raw: String) -> String {
        switch raw {
        case "running": L10n.text("en cours")
        case "done": L10n.text("terminée")
        case "failed": L10n.text("en échec")
        case "escalated": L10n.text("escaladée")
        case "interrupted": L10n.text("interrompue")
        default: L10n.text("état inconnu")
        }
    }

    /// Le libellé d'un événement de la frise, d'après son type serveur.
    public static func event(_ type: String) -> String {
        switch type {
        case MonitoringCodes.created: L10n.text("Feature créée")
        case MonitoringCodes.stepTimeout: L10n.text("Délai d’étape dépassé")
        case MonitoringCodes.retried: L10n.text("Relancée")
        case MonitoringCodes.rateLimited: L10n.text("Limite de débit")
        case MonitoringCodes.modelFailover: L10n.text("Bascule de modèle")
        case MonitoringCodes.providerRetry: L10n.text("Nouvel essai du fournisseur")
        case MonitoringCodes.providerError: L10n.text("Erreur du fournisseur")
        case MonitoringCodes.escalations: L10n.text("Questions posées")
        case MonitoringCodes.escalationAnswered: L10n.text("Question répondue")
        case MonitoringCodes.specsReady: L10n.text("Specs prêtes")
        case MonitoringCodes.verdict: L10n.text("Verdict rendu")
        case MonitoringCodes.decisionAutoTimeout: L10n.text("Tranchée à l’échéance")
        case MonitoringCodes.heavyOomRetry: L10n.text("Tests relancés (mémoire)")
        case MonitoringCodes.heavyFailRetry: L10n.text("Tests relancés après un rouge")
        case MonitoringCodes.heavyFlaky: L10n.text("Tests instables")
        case MonitoringCodes.rebased: L10n.text("Remise à jour sur la branche principale")
        case MonitoringCodes.rebaseConflict: L10n.text("Conflit avec la branche principale")
        case MonitoringCodes.mergeQueued: L10n.text("Fusion demandée")
        case MonitoringCodes.mergeRetry: L10n.text("Fusion relancée")
        case MonitoringCodes.merged: L10n.text("Fusionnée")
        case MonitoringCodes.pushFailed: L10n.text("Envoi au dépôt distant refusé")
        case MonitoringCodes.reverted: L10n.text("Annulée")
        case MonitoringCodes.stalled: L10n.text("Agent muet")
        case MonitoringCodes.stepSlow: L10n.text("Étape lente")
        case MonitoringCodes.fixLoop: L10n.text("Boucle de corrections")
        case MonitoringCodes.budgetExceeded: L10n.text("Budget dépassé")
        case MonitoringCodes.failed: L10n.text("Échec")
        case MonitoringCodes.recovered: L10n.text("Reprise après un redémarrage")
        case MonitoringCodes.pilot: L10n.text("Pilote de l’audit")
        default: L10n.text("Événement")
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
        case MonitoringCodes.pilot: "steeringwheel"
        default: "circle.fill"
        }
    }

    /// « n° 3 · Séparateur → virgule »
    public static func decisionLine(seq: Int, question: String, chosen: String) -> String {
        L10n.format("n° %lld · %@ → %@", seq, question, chosen)
    }

    /// « 2. /specs » : une étape sur l'axe de la frise (une étape refaite a sa propre ligne).
    public static func chartStep(position: Int, label: String) -> String { "\(position). \(label)" }

    /// « Coût · 1,20 $ »
    public static func costFooter(_ value: Double) -> String { "\(costLabel) · \(cost(value))" }

    // MARK: - Fichiers touchés

    public static let changesTitle = L10n.text("Fichiers touchés")
    public static let changesEmpty = L10n.text("Aucun fichier touché pour l’instant.")
    public static let changesUnavailable = L10n.text("Les fichiers ne sont pas lisibles : le serveur est peut-être trop ancien.")
    public static let fileBinary = L10n.text("binaire")
    public static let diffTruncated = L10n.text("Différences coupées : le fichier est trop long.")
    public static let diffUnavailable = L10n.text("Les différences de ce fichier ne sont pas lisibles.")
    public static let diffChoose = L10n.text("Choisissez un fichier pour lire ses différences.")

    /// D'où viennent les fichiers : le dossier de la feature, ou la version fusionnée.
    public static func changesSource(_ raw: String?) -> String {
        switch raw {
        case MonitoringCodes.sourceWorkingCopy: L10n.text("Dossier de la feature, depuis sa base")
        case MonitoringCodes.sourceMerge: L10n.text("Version fusionnée dans la branche principale")
        default: L10n.text("Rien à lire")
        }
    }

    /// « +12 −3 »
    public static func lines(added: Int?, removed: Int?) -> String {
        guard added != nil || removed != nil else { return fileBinary }
        return "+\(added ?? 0) −\(removed ?? 0)"
    }

    /// « 4 fichiers · +120 −8 »
    public static func changesSummary(count: Int, added: Int, removed: Int) -> String {
        let files = count == 1 ? L10n.text("1 fichier") : L10n.format("%lld fichiers", count)
        return "\(files) · +\(added) −\(removed)"
    }

    /// « modifié · +12 −3 »
    public static func fileLine(status: String, added: Int?, removed: Int?) -> String {
        "\(fileStatus(status)) · \(lines(added: added, removed: removed))"
    }

    public static func fileStatus(_ code: String) -> String {
        switch code {
        case "A": L10n.text("ajouté")
        case "D": L10n.text("supprimé")
        case "R": L10n.text("renommé")
        default: L10n.text("modifié")
        }
    }

    // MARK: - Tests

    public static let testsTitle = L10n.text("Tests en direct")
    public static let testsEmpty = L10n.text("Aucun test lancé pour l’instant.")
    public static let testRunning = L10n.text("En cours…")
    public static let flakyTitle = L10n.text("Tests instables")
    public static let flakyHint = L10n.text("Verts après un rouge sur le même arbre : un échec qui ne dit rien du code.")
    public static let flakyNone = L10n.text("Aucun test instable relevé.")

    public static func testScope(_ raw: String) -> String {
        switch raw {
        case "touched": L10n.text("Tests touchés")
        case "full": L10n.text("Suite complète")
        case "check": L10n.text("Vérification")
        default: L10n.text("Tests")
        }
    }

    public static func testOutcome(_ raw: String?) -> String {
        switch raw {
        case nil: testRunning
        case "pass": L10n.text("Vert")
        case "fail": L10n.text("Rouge")
        case "oom": L10n.text("Mémoire dépassée")
        case "timeout": L10n.text("Délai dépassé")
        case "error": L10n.text("Lancement impossible")
        case "aborted": L10n.text("Arrêté")
        default: L10n.text("Issue inconnue")
        }
    }

    /// « Suite complète · essai 2 · Vert »
    public static func testLine(scope: String, attempt: Int, outcome: String?) -> String {
        L10n.format("%@ · essai %lld · %@", testScope(scope), attempt, testOutcome(outcome))
    }

    /// « 3 fois, dernière le 24/10 »
    public static func flakyLine(count: Int, last: String) -> String {
        let times = count == 1 ? L10n.text("1 fois") : L10n.format("%lld fois", count)
        return L10n.format("%@, dernière le %@", times, last)
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

    public static let healthTitle = L10n.text("Santé du serveur")
    public static let healthAgents = L10n.text("Agents occupés")
    public static let healthTests = L10n.text("Tests occupés")
    public static let healthWaiting = L10n.text("En attente")
    public static let healthMemory = L10n.text("Mémoire libre")
    public static let healthQueue = L10n.text("Features en file")
    public static let healthIncidents = L10n.text("Limites de débit et bascules")
    public static let healthTimeAxis = L10n.text("Heure")
    public static let healthValueAxis = L10n.text("Nombre")

    /// « Pas encore de relevé : le serveur en prend un toutes les 15 s. »
    public static func healthEmpty(sampleSec: Int) -> String {
        L10n.format("Pas encore de relevé : le serveur en prend un toutes les %lld s.", sampleSec)
    }

    /// « 2 sur 5 · 1 en attente »
    public static func slotsLine(used: Int, capacity: Int, waiting: Int) -> String {
        waiting > 0
            ? L10n.format("%lld sur %lld · %lld en attente", used, capacity, waiting)
            : L10n.format("%lld sur %lld", used, capacity)
    }

    // MARK: - Modèles

    public static let modelsTitle = L10n.text("Modèles")
    public static let modelsHint = L10n.text("Chaque modèle sur ses étapes : échecs, durée médiane, implémentations renvoyées en correction, features fusionnées et coût.")
    public static let modelsNone = L10n.text("Aucune étape conduite par un modèle connu.")

    /// « 12 étapes · 1 en échec · médiane 4 min »
    public static func modelSteps(steps: Int, failed: Int, median: String?) -> String {
        var parts = [steps == 1 ? L10n.text("1 étape") : L10n.format("%lld étapes", steps)]
        if failed > 0 { parts.append(L10n.format("%lld en échec", failed)) }
        if let median { parts.append(L10n.format("médiane %@", median)) }
        return parts.joined(separator: " · ")
    }

    /// « 25 % corrigées · 3 fusionnées · 1,20 $ »
    public static func modelOutcome(corrected: String?, merged: Int, cost value: Double) -> String {
        var parts: [String] = []
        if let corrected { parts.append(L10n.format("%@ corrigées", corrected)) }
        parts.append(merged == 1 ? L10n.text("1 fusionnée") : L10n.format("%lld fusionnées", merged))
        parts.append(cost(value))
        return parts.joined(separator: " · ")
    }

    // MARK: - Live Activity (iPhone)

    public static let activityStart = L10n.text("Suivre sur l’écran verrouillé")
    public static let activityStop = L10n.text("Ne plus suivre sur l’écran verrouillé")
    public static let activitySymbol = "lock.iphone"

    // MARK: - Widget d'écran d'accueil

    public static let widgetName = L10n.text("Boîte du serveur")
    public static let widgetDescription = L10n.text("Ce qui attend votre décision et les features que le serveur conduit, avec leur étape.")
    public static let widgetNotConfigured = L10n.text("Ouvrez OMP Console pour relier le serveur.")
    public static let widgetNothingPending = L10n.text("Rien n’attend votre décision.")
    public static let widgetNoActive = L10n.text("Aucune feature en cours.")
    public static let widgetPendingSymbol = "tray.full"

    /// « 2 décisions attendent »
    public static func widgetPending(_ count: Int) -> String {
        count == 0 ? widgetNothingPending : (count == 1 ? L10n.text("1 décision attend") : L10n.format("%lld décisions attendent", count))
    }

    /// « 3 features en cours »
    public static func widgetActive(_ count: Int) -> String {
        count == 1 ? L10n.text("1 feature en cours") : L10n.format("%lld features en cours", count)
    }

    /// « 2 alertes »
    public static func widgetAlerts(_ count: Int) -> String {
        count == 1 ? L10n.text("1 alerte") : L10n.format("%lld alertes", count)
    }

    /// « Lu à 14 h 05 »
    public static func widgetUpdated(_ time: String) -> String { L10n.format("Lu à %@", time) }

    // MARK: - Services

    public static let servicesTitle = L10n.text("Services")
    public static let servicesHint = L10n.text("La santé du serveur, de sa mémoire, de ses sauvegardes et de l’extension Chrome.")
    public static let servicesUnreachable = L10n.text("Le serveur ne répond pas à la sonde de santé.")
    public static let servicesAllGood = L10n.text("Tous les services sont en ordre.")
    public static let servicesSymbol = "stethoscope"
    public static let serviceNotConfigured = L10n.text("Non configuré")

    /// Le nom d'un service (`HarnessServiceLine.Kind`).
    public static func service(_ raw: String) -> String {
        switch raw {
        case "server": L10n.text("Serveur de pipelines")
        case "database": L10n.text("Base de données")
        case "scheduler": L10n.text("Ordonnancement")
        case "disk": L10n.text("Disque")
        case "oracle": L10n.text("Mémoire du projet")
        case "memory": L10n.text("Service mem0")
        case "backups": L10n.text("Sauvegardes")
        default: L10n.text("Extension Chrome")
        }
    }

    /// Le niveau d'un service (`HarnessServiceLine.Level`).
    public static func serviceLevel(_ raw: Int) -> String {
        switch raw {
        case 0: L10n.text("En ordre")
        case 2: L10n.text("À surveiller")
        case 3: L10n.text("En panne")
        default: L10n.text("Inconnu")
        }
    }

    /// Le symbole d'un niveau de service.
    public static func serviceSymbol(_ raw: Int) -> String {
        switch raw {
        case 0: "checkmark.circle.fill"
        case 2: "exclamationmark.triangle.fill"
        case 3: "xmark.octagon.fill"
        default: "questionmark.circle"
        }
    }

    /// Le résumé de l'Accueil : combien de services demandent un regard.
    public static func servicesProblems(_ count: Int) -> String {
        count == 1 ? L10n.text("1 service demande votre attention.") : L10n.format("%lld services demandent votre attention.", count)
    }

    public static func serviceVersion(_ version: String) -> String { L10n.format("Version %@", version) }
    public static func lastTick(_ duration: String) -> String { L10n.format("Dernier tour il y a %@", duration) }
    public static func freeSpace(_ size: String) -> String { L10n.format("%@ libres", size) }
    public static func lostWrites(_ count: Int) -> String {
        count == 1 ? L10n.text("1 écriture perdue") : L10n.format("%lld écritures perdues", count)
    }
    public static func memories(_ count: Int) -> String {
        count == 1 ? L10n.text("1 souvenir") : L10n.format("%lld souvenirs", count)
    }
    public static func lastBackup(_ date: String) -> String { L10n.format("Dernière sauvegarde : %@", date) }
    public static func lastError(_ error: String) -> String { L10n.format("Dernière erreur : %@", error) }

    // MARK: - Rapport du matin

    public static let digestTitle = L10n.text("Rapport du matin")
    public static let digestSymbol = "sun.max"
    public static func digestWindow(_ since: String) -> String { L10n.format("Depuis le %@", since) }
}

/// Les NOTIFICATIONS des deux apps : les gestes qu'offre une notification (catégories
/// `omp.validate`, `omp.approve`, `omp.open` d'omp-harness/push-alerts.ts) et, sur Mac,
/// le texte des notifications locales tirées du flux du serveur — les mêmes mots que
/// les alertes push que le serveur envoie à l'iPhone.
public enum NotificationText {
    // MARK: - Gestes

    public static let validate = L10n.text("Valider")
    public static let refuse = L10n.text("Refuser")
    public static let approve = L10n.text("Approuver")
    public static let open = L10n.text("Ouvrir")
    public static let refusePlaceholder = L10n.text("La raison du refus")

    // MARK: - Alertes

    public static let specs = L10n.text("Specs à valider")
    public static let verdict = L10n.text("Verdict à valider")
    public static func questions(_ count: Int) -> String {
        count == 1 ? L10n.text("Une question attend votre réponse") : L10n.format("%lld questions attendent votre réponse", count)
    }
    /// Les autres questions d’un lot, après le `stake` de la première : « +2 autres questions ».
    public static func otherQuestions(_ count: Int) -> String {
        count == 1 ? L10n.text("+1 autre question") : L10n.format("+%lld autres questions", count)
    }
    public static let approval = L10n.text("Poste — envoi à approuver")
    public static let approvalBody = L10n.text("Rien ne part sans votre accord.")
    public static let failed = L10n.text("Feature en échec")
    public static let stalled = L10n.text("Agent muet")
    public static let budget = L10n.text("Budget dépassé")
    public static let dailyBudget = L10n.text("Plafond journalier atteint")
    public static let dailyBudgetBody = L10n.text("Plus aucune étape ne démarre avant minuit UTC ou un plafond relevé.")
    public static let vigieSilent = L10n.text("Vigie muette")
    public static let vigieSilentBody = L10n.text("La vigie ne donne plus signe de vie.")
    public static let backupFailed = L10n.text("Sauvegarde échouée")
    public static let backupFailedBody = L10n.text("Une sauvegarde de la base a échoué.")
    public static let atlassianComment = L10n.text("Commentaire Jira à valider")
    public static let atlassianCommentBody = L10n.text("Rien n’est publié sans votre accord.")
    public static let plan = L10n.text("Plan du jour prêt")
    public static let planBody = L10n.text("Le plan du jour vous attend dans le Poste.")
    /// Un geste fait depuis une notification que le serveur a refusé (révision périmée, droits).
    public static let gestureFailed = L10n.text("Geste non abouti")
    public static let gestureFailedBody = L10n.text("Ouvrez l’app pour voir où en est la demande.")

    /// « demo · Panier » : le dépôt d'abord, l'humain suit plusieurs projets.
    public static func runLine(repo: String, title: String) -> String { "\(repo) · \(title)" }

    /// « aucune preuve », « 1 preuve », « 3 preuves » : les mots du serveur
    /// (`proofCountText` d'omp-harness/proofs.ts), en fin du corps d'un verdict.
    public static func proofs(_ count: Int) -> String {
        switch count {
        case ...0: L10n.text("aucune preuve")
        case 1: L10n.text("1 preuve")
        default: L10n.format("%lld preuves", count)
        }
    }
}
