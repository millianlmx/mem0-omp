// « Comprendre », la logique pure : où il se présente (inspecteur ou feuille, selon la
// largeur de la fenêtre — c'est le correctif du plantage des fenêtres étroites), les
// largeurs des colonnes de la coque Mac, le résumé en trois blocs écrits par l'app (ce
// qui a été fait, pourquoi on vous demande, ce qui reste douteux) et la PORTE lue dans
// la raison du serveur. Le serveur ne donne pas de code à ses attentes : il écrit une
// raison au gabarit fixe (`omp-harness/machine.ts` `WAIT_REASON`, `verdict.ts`,
// `steps.ts` `gateReasons`), que `humanWaitOf` relit lui-même par son début. `OSGate`
// fait la même lecture, et en tire les chiffres.

import ConsoleClient
import ConsoleCore
import Foundation

// MARK: - Colonnes et présentation

/// Où « Comprendre » se présente.
public enum OSUnderstandPlacement: Equatable, Sendable {
    case inspector, sheet
}

/// Les largeurs de la coque Mac. L'inspecteur natif (une colonne de plus dans la vue
/// scindée de la fenêtre) plantait l'app dès que la barre latérale, le détail et lui ne
/// tenaient pas ensemble : AppKit levait une exception de contraintes pendant le calcul de
/// la fenêtre. « Comprendre » est donc un PANNEAU du détail, d'une largeur que la coque
/// fixe d'après la fenêtre, et n'existe qu'au-delà d'`inspectorThreshold` ; en deçà, c'est
/// une feuille. Aucune colonne n'impose plus de largeur que la fenêtre ne peut donner.
public struct OSShellLayout: Equatable, Sendable {
    public static let sidebarMin: CGFloat = 260
    public static let sidebarIdeal: CGFloat = 300
    public static let sidebarMax: CGFloat = 320
    /// Ce qu'il faut au détail (« Maintenant », un fil, un outil) pour se lire.
    public static let detailMin: CGFloat = 500
    public static let inspectorNarrowest: CGFloat = 400
    public static let inspectorWidest: CGFloat = 520
    /// La fenêtre la plus étroite : la barre latérale et le détail, à leur minimum.
    public static let windowMin = sidebarMin + detailMin
    /// En deçà, « Comprendre » est une feuille.
    public static let inspectorThreshold: CGFloat = 1250
    /// La largeur du panneau varie par pas : la coque ne se recalcule pas à chaque point.
    private static let step: CGFloat = 20

    public var placement: OSUnderstandPlacement
    /// La largeur du panneau « Comprendre » dans cette fenêtre.
    public var inspectorWidth: CGFloat

    public init(width: CGFloat) {
        placement = Self.placement(width: width)
        inspectorWidth = Self.inspectorWidth(width: width)
    }

    public static func placement(width: CGFloat) -> OSUnderstandPlacement {
        width >= inspectorThreshold ? .inspector : .sheet
    }

    /// Ce qu'il reste au panneau quand la barre latérale est à son plus large et le détail
    /// à son plus étroit, entre `inspectorNarrowest` et `inspectorWidest`.
    public static func inspectorWidth(width: CGFloat) -> CGFloat {
        let room = ((width - sidebarMax - detailMin) / step).rounded(.down) * step
        return min(inspectorWidest, max(inspectorNarrowest, room))
    }
}

// MARK: - Les vues

extension OSLevel {
    /// Recette : `OMP_CONSOLE_OS_LEVEL` nomme une vue par son code ou par son mot français,
    /// quelle que soit la langue de l'app ; les noms des quatre anciens niveaux restent lus
    /// (« Récit » et « Brut » sont devenus le Journal).
    public init?(recipe name: String) {
        switch name.lowercased() {
        case "summary", "résumé": self = .summary
        case "proofs", "preuves": self = .proofs
        case "journal", "story", "récit", "raw", "brut": self = .journal
        default: return nil
        }
    }

    /// Alias de fusion : la page d'un fil (hors de cette tranche) nomme encore les anciens
    /// niveaux. À retirer dès qu'elle écrit `.journal`.
    public static var story: OSLevel { .journal }
    public static var raw: OSLevel { .journal }
}

// MARK: - La porte

/// Une raison pour laquelle une tâche attend l'humain.
public enum OSGateCause: Equatable, Sendable {
    /// L'agent pose une question.
    case question
    case irreversibleDecisions(Int)
    /// Le changement dépasse le plafond de lignes (`limit` inconnu d'une raison illisible).
    case diff(lines: Int, limit: Int?)
    case blockers(Int)
    /// Le risque du verdict, tel que le serveur le nomme (`medium`, `high`).
    case risk(String)
    case testsRed, testsNotRun
    /// Le curseur du fil est sur « Tout me demander ».
    case askLevel
    case openQuestions
    case criteriaMissing, criteriaUnproven, criteriaChanged, criteriaUnverified
    case unreadFiles
    case weakVerdict
    /// Le dépôt fait valider chaque revue.
    case reviewRequired
    case split, noModules
    /// Un geste irréversible, et ses catégories du serveur (`schema`, `public_api`, `deletion`).
    case irreversible([String])
    case firstOfProject
    /// Le dépôt fait valider les specs.
    case specsAlways
    case overturned
    case fixCap(fixes: Int?, blockers: Int?)
    case contest
    case budget(spent: Double?, ceiling: Double?)
    /// Une panne que l'agent n'a pas su lever : la raison du serveur, telle quelle.
    case failure(String)
    /// Un motif que l'app ne connaît pas : le texte du serveur, tel quel.
    case other(String)
}

public enum OSGate {
    private static let specsPrefix = "specs à valider avant /impl"
    private static let verdictPrefix = "validation humaine"
    private static let fixCapPrefix = "plafond de corrections atteint"
    private static let contestPrefix = "le correcteur conteste les bloquants"
    private static let budgetPrefix = "budget dépassé"
    private static let askReason = "autonomie « tout me demander »"

    /// Pourquoi cette tâche attend l'humain ; vide si elle n'attend personne.
    public static func causes(of run: HarnessRun) -> [OSGateCause] {
        causes(state: run.state, step: run.step, reason: run.reason)
    }

    public static func causes(state: String, step: String?, reason: String?) -> [OSGateCause] {
        let text = (reason ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        switch HarnessRunState(rawValue: state) {
        case .escalated:
            if text.contains("irréversible"), let count = numbers(in: text).first { return [.irreversibleDecisions(count)] }
            return [.question]
        case .awaitingHuman:
            return unique(awaiting(step: step, reason: text))
        default:
            return []
        }
    }

    private static func awaiting(step: String?, reason: String) -> [OSGateCause] {
        if reason.hasPrefix(budgetPrefix) {
            let amounts = Self.amounts(in: reason)
            return [.budget(spent: amounts.first, ceiling: amounts.count > 1 ? amounts[1] : nil)]
        }
        if step == "specs", reason.hasPrefix(specsPrefix) {
            let parts = Self.parts(of: reason, after: specsPrefix)
            return parts.isEmpty ? [.specsAlways] : parts.compactMap { specs($0) }
        }
        if reason.hasPrefix(verdictPrefix) {
            let parts = Self.parts(of: reason, after: verdictPrefix)
            if parts.isEmpty { return [.reviewRequired] }
            var kept: [OSGateCause] = []
            for part in parts {
                if let cause = verdict(part) {
                    kept.append(cause)
                } else if let last = kept.last, carriesList(last) {
                    // La suite d'une liste (« critère(s) non vérifié(s) : a ; b ») : pas un motif de plus.
                    continue
                } else {
                    kept.append(.other(part))
                }
            }
            return kept
        }
        if reason.hasPrefix(fixCapPrefix) {
            let found = numbers(in: reason)
            return [.fixCap(fixes: found.first, blockers: found.count > 1 ? found[1] : nil)]
        }
        if reason.hasPrefix(contestPrefix) { return [.contest] }
        return [.failure(reason)]
    }

    /// Une raison de porte des specs (`steps.ts` `gateReasons`, plus le curseur et le renversement).
    private static func specs(_ part: String) -> OSGateCause? {
        if part == "découpage proposé" { return .split }
        if part == "modules vides" { return .noModules }
        if part.hasPrefix("geste irréversible") { return .irreversible(categories(in: part)) }
        if part.hasPrefix("première feature d'un projet") { return .firstOfProject }
        if part == askReason { return .askLevel }
        if part.contains("renversée par l'humain") { return .overturned }
        return .other(part)
    }

    /// Une raison du refus de fusionner seul (`verdict.ts`), ou `nil` si elle n'est pas connue.
    private static func verdict(_ part: String) -> OSGateCause? {
        if part == "requise" { return .reviewRequired }
        if part == askReason { return .askLevel }
        if part.hasPrefix("diff de ") {
            let found = numbers(in: part)
            guard let lines = found.first else { return nil }
            return .diff(lines: lines, limit: found.count > 1 ? found[1] : nil)
        }
        if part.hasPrefix("risque ") { return .risk(String(part.dropFirst("risque ".count))) }
        if part == "suite complète rouge" { return .testsRed }
        if part.hasPrefix("suite complète non lancée") { return .testsNotRun }
        if part == "verdict faible" { return .weakVerdict }
        if part.hasPrefix("critère(s) absent(s)") { return .criteriaMissing }
        if part.hasPrefix("critère(s) non prouvé(s)") { return .criteriaUnproven }
        if part.hasPrefix("critère(s) validé(s) modifié(s)") { return .criteriaChanged }
        if part.hasPrefix("critère(s) non vérifié(s)") { return .criteriaUnverified }
        if part.hasPrefix("fichier(s) touchés non relus") { return .unreadFiles }
        if part.contains("bloquant"), let count = numbers(in: part).first { return .blockers(count) }
        if part.contains("escalade"), numbers(in: part).first != nil { return .openQuestions }
        return nil
    }

    /// Le motif porte une liste, que le serveur sépare comme ses motifs (« ; »).
    private static func carriesList(_ cause: OSGateCause) -> Bool {
        switch cause {
        case .criteriaMissing, .criteriaUnproven, .criteriaChanged, .criteriaUnverified, .unreadFiles: true
        default: false
        }
    }

    /// Les motifs d'une raison, après son début : « <début> : a ; b » → [a, b] ; « <début> requise » → [requise].
    private static func parts(of reason: String, after prefix: String) -> [String] {
        var rest = reason.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
        if rest.hasPrefix(":") { rest = rest.dropFirst().trimmingCharacters(in: .whitespaces) }
        return rest.components(separatedBy: " ; ").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Les entiers d'un texte, dans l'ordre (« diff de 412 lignes (> 300) » → [412, 300]).
    private static func numbers(in text: String) -> [Int] {
        text.split(whereSeparator: { !$0.isNumber }).compactMap { Int($0) }
    }

    /// Les montants d'un texte (« 5.21 $ pour un plafond de 5.00 $ » → [5.21, 5.0]).
    private static func amounts(in text: String) -> [Double] {
        text.components(separatedBy: " $").dropLast().compactMap { chunk in
            chunk.split(whereSeparator: { !($0.isNumber || $0 == ".") }).last.flatMap { Double($0) }
        }
    }

    /// Les catégories d'un geste irréversible : « geste irréversible (schema, deletion) » → [schema, deletion].
    private static func categories(in part: String) -> [String] {
        guard let open = part.firstIndex(of: "("), let close = part.lastIndex(of: ")"), open < close else { return [] }
        return part[part.index(after: open)..<close]
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
    }

    private static func unique(_ causes: [OSGateCause]) -> [OSGateCause] {
        var kept: [OSGateCause] = []
        for cause in causes where !kept.contains(cause) { kept.append(cause) }
        return kept
    }
}

extension OSGateCause {
    /// La porte en clair, écrite par l'app.
    public var text: String {
        switch self {
        case .question: return OSText.gateQuestion
        case let .irreversibleDecisions(count): return OSText.gateIrreversibleDecisions(count)
        case let .diff(lines, limit):
            if let limit { return OSText.gateDiff(lines: lines, limit: limit) }
            return OSText.gateDiff(lines: lines)
        case let .blockers(count): return OSText.gateBlockers(count)
        case let .risk(raw): return OSText.gateRisk(PipelineServerText.risk(raw))
        case .testsRed: return OSText.gateTestsRed
        case .testsNotRun: return OSText.gateTestsNotRun
        case .askLevel: return OSText.gateAskLevel
        case .openQuestions: return OSText.gateOpenQuestions
        case .criteriaMissing: return OSText.gateCriteriaMissing
        case .criteriaUnproven: return OSText.gateCriteriaUnproven
        case .criteriaChanged: return OSText.gateCriteriaChanged
        case .criteriaUnverified: return OSText.gateCriteriaUnverified
        case .unreadFiles: return OSText.gateUnreadFiles
        case .weakVerdict: return OSText.gateWeakVerdict
        case .reviewRequired: return OSText.gateReviewRequired
        case .split: return OSText.gateSplit
        case .noModules: return OSText.gateNoModules
        case let .irreversible(categories):
            return OSText.gateIrreversible(categories.map { Self.word(ofCategory: $0) }.joined(separator: ", "))
        case .firstOfProject: return OSText.gateFirstOfProject
        case .specsAlways: return OSText.gateSpecsAlways
        case .overturned: return OSText.gateOverturned
        case let .fixCap(fixes, blockers):
            if let fixes, let blockers { return OSText.gateFixCap(fixes: fixes, blockers: blockers) }
            return OSText.gateFixCapUnknown
        case .contest: return OSText.gateContest
        case let .budget(spent, ceiling):
            if let spent, let ceiling { return OSText.gateBudget(spent: spent, ceiling: ceiling) }
            return OSText.gateBudgetUnknown
        case .failure: return OSText.gateFailure
        case let .other(raw): return OSSummary.sentence(raw)
        }
    }

    /// Le texte du serveur à montrer sous la phrase : celui d'une panne, que l'app ne sait pas dire mieux.
    public var detail: String? {
        if case let .failure(raw) = self, !raw.isEmpty { return raw }
        return nil
    }

    /// Ce que touche un geste irréversible, en clair ; une catégorie inconnue reste telle quelle.
    private static func word(ofCategory category: String) -> String {
        switch category {
        case "schema": OSText.irreversibleSchema
        case "public_api": OSText.irreversiblePublicApi
        case "deletion": OSText.irreversibleDeletion
        default: category
        }
    }
}

// MARK: - Le résumé

/// Un doute laissé par la revue.
public struct OSDoubt: Equatable, Identifiable, Sendable {
    public enum Kind: Equatable, Sendable { case blocker, risk, unverified }

    public var kind: Kind
    public var text: String

    public var id: String { "\(kind)|\(text)" }
}

/// Le résumé d'une tâche, en trois blocs écrits par l'app.
public struct OSSummary: Equatable, Sendable {
    /// Ce qui a été fait, en une phrase.
    public var done: String
    /// Pourquoi on vous demande ; vide si la tâche n'attend personne.
    public var why: [OSGateCause]
    /// Ce qui reste douteux ; `nil` tant qu'aucune revue n'a été rendue.
    public var doubts: [OSDoubt]?

    /// La longueur au-delà de laquelle la première phrase d'un verdict est coupée.
    static let sentenceLimit = 220

    public init(run: HarnessRun) {
        done = Self.done(run)
        why = OSGate.causes(of: run)
        doubts = run.verdict.map { verdict in
            verdict.blockers.map { OSDoubt(kind: .blocker, text: $0) }
                + verdict.risks.map { OSDoubt(kind: .risk, text: $0) }
                + verdict.unverified.map { OSDoubt(kind: .unverified, text: $0) }
        }
    }

    static func done(_ run: HarnessRun) -> String {
        if let verdict = run.verdict {
            let sentence = firstSentence(verdict.summary)
            if !sentence.isEmpty { return sentence }
        }
        if run.awaitsSpecs { return OSText.doneSpecs }
        switch run.phase {
        case .escalated: return OSText.doneQuestion
        case .queued, .running, .merging, nil: return OSText.doneWorking
        case .awaitingHuman, .merged, .failed, .cancelled: return OSText.doneNothing
        }
    }

    /// La première phrase d'un texte d'agent : après ses titres, sans puce ni mise en forme
    /// Markdown, coupée à `sentenceLimit` caractères sur un mot. Un texte qui n'est qu'un
    /// titre rend ce titre.
    public static func firstSentence(_ text: String) -> String {
        let lines = text.split(whereSeparator: \.isNewline).map { String($0).trimmingCharacters(in: .whitespaces) }
        let body = lines.filter { !$0.hasPrefix("#") }.map { plain($0) }.first { !$0.isEmpty }
        let line = body ?? lines.map { plain($0) }.first { !$0.isEmpty } ?? ""
        var sentence = line
        var index = line.startIndex
        while index < line.endIndex {
            let next = line.index(after: index)
            // Une fin de phrase : un point final suivi d'une espace puis d'une majuscule (« v1.2 » n'en est pas une).
            if ".!?…".contains(line[index]), next < line.endIndex, line[next] == " " {
                let after = line.index(after: next)
                if after < line.endIndex, line[after].isUppercase || line[after] == "«" {
                    sentence = String(line[...index])
                    break
                }
            }
            index = next
        }
        guard sentence.count > sentenceLimit else { return sentence }
        let cut = sentence.prefix(sentenceLimit)
        let kept = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return kept.trimmingCharacters(in: .whitespaces) + "…"
    }

    /// Un motif du serveur rendu en phrase : une majuscule, un point.
    static func sentence(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return trimmed }
        let body = first.uppercased() + trimmed.dropFirst()
        return ".!?…".contains(body.last ?? ".") ? body : body + "."
    }

    /// Une ligne sans sa mise en forme Markdown (titre, puce, citation, gras, code).
    private static func plain(_ line: String) -> String {
        var text = line.trimmingCharacters(in: .whitespaces)
        while let first = text.first, "#>-*•".contains(first) { text = String(text.dropFirst()).trimmingCharacters(in: .whitespaces) }
        for mark in ["**", "__", "`"] { text = text.replacingOccurrences(of: mark, with: "") }
        return text
    }
}
