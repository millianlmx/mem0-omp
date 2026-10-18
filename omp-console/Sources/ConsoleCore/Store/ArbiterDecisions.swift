// Le fil des décisions de TOUS les lots : les lignes de `journal/<repoKey>.jsonl`
// (une par décision, écrites par le service OMP) relues pour chaque dépôt, pas
// seulement pour les audits lancés depuis l'app. C'est ce qui rend visible ce que
// l'arbitre a tranché en arrière-plan, et pourquoi.
//
// Mêmes champs que `JournalEntry` (omp-mem0-req/context.ts). Fonctions PURES :
// le Mac lit les octets (`StoreReader`), l'iPhone reçoit le fil dans la trame
// `store` (enveloppe `audits`).
//
// VIT DANS `ConsoleCore`.

import Foundation

/// D'où vient une décision : déjà tranchée par le contexte, tranchée par
/// l'arbitre, ou par l'utilisateur.
public enum ArbiterDecisionSource: String, Sendable, Codable {
    case contexte, arbitrage, utilisateur
}

/// La sorte d'une entrée de journal (`JournalKind`, context.ts:14).
public enum ArbiterDecisionKind: String, Sendable, Codable {
    case question, jalon, quota, contexte, plafond, echec, arbitrage, avance
}

/// Une décision du journal d'un dépôt.
public struct ArbiterDecision: Sendable, Equatable, Codable, Identifiable {
    public var repoKey: String
    /// L'offset (octets) de la ligne dans son journal : l'identité STABLE d'une
    /// décision, le journal n'étant écrit qu'en ajout.
    public var offset: Int
    public var slug: String
    /// Un maillon, ou `project`/`audit` (`JournalPhase`).
    public var phase: String
    public var kind: ArbiterDecisionKind
    public var question: String
    public var answer: String
    public var source: ArbiterDecisionSource
    /// `justification.reason` quand l'arbitre en a donné une.
    public var reason: String?
    public var at: Double

    public var id: String { "\(repoKey):\(offset)" }

    public init(repoKey: String, offset: Int, slug: String, phase: String, kind: ArbiterDecisionKind, question: String, answer: String, source: ArbiterDecisionSource, reason: String?, at: Double) {
        self.repoKey = repoKey
        self.offset = offset
        self.slug = slug
        self.phase = phase
        self.kind = kind
        self.question = question
        self.answer = answer
        self.source = source
        self.reason = reason
        self.at = at
    }

    /// Une ligne de journal (`asEntry`, context.ts) : `nil` pour une ligne
    /// invalide ou d'une sorte hors vocabulaire. Une justification mal formée est
    /// lue absente, jamais la ligne rejetée.
    public init?(journalLine json: JSONValue, repoKey: String, offset: Int) {
        guard let r = asObject(json), isVersion1(r["version"]) else { return nil }
        guard let at = asNumber(r["at"]), let slug = asString(r["slug"]), let phase = asString(r["phase"]) else { return nil }
        guard let kind = ArbiterDecisionKind(rawValue: asString(r["kind"]) ?? "") else { return nil }
        guard let question = asString(r["question"]), let answer = asString(r["answer"]) else { return nil }
        guard let source = ArbiterDecisionSource(rawValue: asString(r["source"]) ?? "") else { return nil }
        let reason = asObject(r["justification"]).flatMap { asString($0["reason"]) }
            .flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        self.init(repoKey: repoKey, offset: offset, slug: slug, phase: phase, kind: kind, question: question, answer: answer, source: source, reason: reason, at: at)
    }

    /// Une DÉCISION, pas une note : la sorte `contexte` (un dépassement de
    /// contexte consigné) n'a rien tranché.
    public var isDecision: Bool { kind != .contexte }
}

public enum ArbiterDecisionFeed {
    /// La borne du fil : les décisions les plus récentes, tous dépôts confondus.
    public static let limit = 50

    /// Les décisions d'UN journal, lues depuis la FIN (les plus récentes
    /// d'abord), au plus `limit`. `firstByte` : l'offset de `data` dans le
    /// fichier (une lecture de la queue ne commence pas à 0).
    /// `parse` : le lecteur JSON de la coque ; une ligne illisible est ignorée
    /// (parité `journalFor`).
    public static func decisions(
        journal data: Data,
        repoKey: String,
        firstByte: Int = 0,
        limit: Int = ArbiterDecisionFeed.limit,
        parse: (Data) -> JSONValue?
    ) -> [ArbiterDecision] {
        let lines = data.split(separator: UInt8(ascii: "\n"))
        var out: [ArbiterDecision] = []
        for line in lines.reversed() {
            guard out.count < limit else { break }
            let offset = firstByte + (line.startIndex - data.startIndex)
            guard let json = parse(Data(line)),
                  let decision = ArbiterDecision(journalLine: json, repoKey: repoKey, offset: offset),
                  decision.isDecision else { continue }
            out.append(decision)
        }
        return out
    }

    /// Les décisions de plusieurs journaux en UN fil : la plus récente d'abord,
    /// à égalité par identité, borné à `limit`.
    public static func merge(_ journals: [[ArbiterDecision]], limit: Int = ArbiterDecisionFeed.limit) -> [ArbiterDecision] {
        let all = journals.flatMap { $0 }.sorted { left, right in
            left.at != right.at ? left.at > right.at : left.id.utf8.lexicographicallyPrecedes(right.id.utf8)
        }
        return Array(all.prefix(limit))
    }

    /// Le nom du dépôt d'une décision : le dernier segment du `repoRoot` du lot
    /// dont la clé est `repoKey`, `nil` quand aucun lot lu ne la porte.
    public static func repoNames(lots: [Lot]) -> [String: String] {
        var names: [String: String] = [:]
        for lot in lots {
            let key = KanbanRepoKey.key(forRoot: lot.repoRoot)
            if names[key] == nil {
                names[key] = (realpathOr(lot.repoRoot) as NSString).lastPathComponent
            }
        }
        return names
    }
}
