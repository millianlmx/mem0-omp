// Les valeurs du canal côté app (S-1, S-2, S-4) : une livraison (réponse à une
// question ou texte libre) et une commande du canal de commande.
//
// Ce fichier ne porte AUCUNE E/S : ce sont des valeurs pures et l'encodage de
// leur objet JSON, en parité EXACTE avec `asDelivery`/`asCommand` du dépôt
// (`omp-mem0-req/store.ts:439-465`, `commands.ts:110-131`). L'ordre des clés et
// l'indentation sont libres (les deux lecteurs ne lisent que l'objet) : l'app
// écrit compact, clés triées.

import Foundation

// --- livraisons (S-1, S-2) ---------------------------------------------------

/// La réponse retenue d'une question `ask` : exactement l'un des deux
/// (`PanelDeliveryAnswer` parité). `selected` porte le LIBELLÉ de l'option
/// choisie (`inbox.ts` : le run apparie par libellé, jamais par index).
enum AskAnswer: Sendable, Equatable {
    case selected(String)
    case custom(String)
}

/// Une livraison déposée dans la boîte d'un run (`PanelDelivery`, store.ts:337).
enum OutgoingDelivery: Sendable, Equatable {
    case ask(toolCallId: String, answer: AskAnswer)
    case text(text: String)
}

// --- commandes (S-4) ---------------------------------------------------------

/// Le verdict d'un jalon : `v` (specs) ou `y` (revue) — les mots du canal.
enum MilestoneVerdict: String, Sendable, Equatable {
    case specs = "v"
    case review = "y"
}

/// Une commande du canal. L'app n'émet QUE ces six formes : launch, verdict,
/// reply, stop, models, relaunch — ni `add`, ni `remove`, ni `answer` (une question en vol
/// passe par une livraison dans la boîte du run). `reply` répond à une question en
/// TEXTE d'un maillon terminé (feature `waiting` + `waitKind: "answer"`, S-9/S-10
/// de omp-console-redesign). `models` remplace les deux modèles d'une feature
/// (S-5) : les deux clés sont TOUJOURS présentes, `null` pour un groupe laissé sur
/// le défaut OMP. `relaunch` relance une feature `failed`/`blocked`/`cancelled`
/// (`commands.ts`, action `relaunch` de `lotController.ts`) : l'app ne l'envoie
/// que pour `failed` et `blocked` (S-3 de accueil-en-cours-melange-pause-et-compte).
enum OutgoingCommand: Sendable, Equatable {
    case launch(
        id: String, repo: String, title: String, description: String,
        modelReqSpecs: String?, modelImplReview: String?
    )
    case verdict(id: String, repo: String, slug: String, verdict: MilestoneVerdict)
    case reply(id: String, repo: String, slug: String, text: String)
    case stop(id: String, repo: String)
    case models(id: String, repo: String, slug: String, modelReqSpecs: String?, modelImplReview: String?)
    case relaunch(id: String, repo: String, slug: String)
}

/// L'état d'un accusé : `taken` (l'effet suit) ou `refused` (le motif est dans
/// `reason`).
enum CommandAckState: String, Sendable, Equatable {
    case taken
    case refused
}

/// L'accusé d'une commande, tel que le pilote l'écrit (`PipelineCommandAck`,
/// commands.ts:131) : lecture seule, jamais reconstruit.
struct PipelineCommandAck: Sendable, Equatable {
    let id: String
    let state: CommandAckState
    let reason: String?
    let at: Double
}

// --- identifiants et motifs --------------------------------------------------

/// Le motif d'un identifiant de commande (`COMMAND_ID`, commands.ts:57) : il NOMME
/// un fichier d'accusé, donc aucun séparateur de chemin.
enum PipelineId {
    static func isValid(_ id: String) -> Bool {
        guard let first = id.first, first.isASCII, first.isLetter || first.isNumber else { return false }
        guard id.count >= 1, id.count <= 64 else { return false }
        for character in id.dropFirst() {
            guard character.isASCII else { return false }
            guard character.isLetter || character.isNumber || character == "_" || character == "-" else {
                return false
            }
        }
        return true
    }

    /// `id = "console-<sentAt entier>-<salt>"` (S-4) : conforme à `COMMAND_ID`,
    /// unique par construction, et c'est lui qui nomme l'accusé. Le `<sentAt>` est
    /// l'entier BRUT — seule la TÊTE d'un nom de fichier est complétée à 16
    /// chiffres (`stamp`).
    static func console(sentAt: Double, salt: String) -> String {
        "console-\(sentAtMillis(sentAt))-\(salt)"
    }
}

/// `<sentAt sur 16 chiffres>` : la tête du nom de fichier d'une livraison COMME
/// d'une commande (`Math.trunc`, jamais négatif — parité `writeCommand`).
func stamp(_ sentAt: Double) -> String {
    let truncated = sentAt.isFinite ? Int64(max(0, sentAt.rounded(.towardZero))) : 0
    var text = String(truncated)
    if text.count < 16 { text = String(repeating: "0", count: 16 - text.count) + text }
    return text
}

/// L'instant de dépôt porté par un JSON : un entier de millisecondes epoch.
func sentAtMillis(_ sentAt: Double) -> Int64 {
    sentAt.isFinite ? Int64(max(0, sentAt.rounded(.towardZero))) : 0
}

// --- encodage des objets -----------------------------------------------------

extension OutgoingDelivery {
    /// L'objet JSON EXACT de la livraison, sans clé de plus (S-1, S-2).
    func object(sentAt: Double) -> [String: Any] {
        let at = sentAtMillis(sentAt)
        switch self {
        case .ask(let toolCallId, let answer):
            var object: [String: Any] = [
                "version": 1,
                "kind": "ask",
                "toolCallId": toolCallId,
                "sentAt": at,
            ]
            switch answer {
            case .selected(let label): object["selected"] = label
            case .custom(let text): object["custom"] = text
            }
            return object
        case .text(let text):
            return ["version": 1, "kind": "text", "text": text, "sentAt": at]
        }
    }
}

extension OutgoingCommand {
    /// L'identifiant porté par la commande — c'est lui qui nomme l'accusé.
    var id: String {
        switch self {
        case .launch(let id, _, _, _, _, _): id
        case .verdict(let id, _, _, _): id
        case .reply(let id, _, _, _): id
        case .stop(let id, _): id
        case .models(let id, _, _, _, _): id
        case .relaunch(let id, _, _): id
        }
    }

    /// L'objet JSON EXACT de la commande : les schémas de `commands.ts:110-131`,
    /// avec `deps` JAMAIS écrit (hors périmètre). `launch` n'écrit une clé de
    /// modèle que quand elle est présente ; `models` écrit TOUJOURS les deux,
    /// `NSNull` pour un groupe laissé sur le défaut OMP (S-5).
    func object(sentAt: Double) -> [String: Any] {
        let at = sentAtMillis(sentAt)
        switch self {
        case .launch(let id, let repo, let title, let description, let modelReqSpecs, let modelImplReview):
            var object: [String: Any] = [
                "version": 1, "id": id, "sentAt": at, "repo": repo,
                "kind": "launch", "title": title, "description": description,
            ]
            if let modelReqSpecs { object["modelReqSpecs"] = modelReqSpecs }
            if let modelImplReview { object["modelImplReview"] = modelImplReview }
            return object
        case .verdict(let id, let repo, let slug, let verdict):
            return [
                "version": 1, "id": id, "sentAt": at, "repo": repo,
                "kind": "verdict", "slug": slug, "verdict": verdict.rawValue,
            ]
        case .reply(let id, let repo, let slug, let text):
            return [
                "version": 1, "id": id, "sentAt": at, "repo": repo,
                "kind": "reply", "slug": slug, "text": text,
            ]
        case .stop(let id, let repo):
            return ["version": 1, "id": id, "sentAt": at, "repo": repo, "kind": "stop"]
        case .models(let id, let repo, let slug, let modelReqSpecs, let modelImplReview):
            return [
                "version": 1, "id": id, "sentAt": at, "repo": repo,
                "kind": "models", "slug": slug,
                "modelReqSpecs": modelReqSpecs ?? NSNull(),
                "modelImplReview": modelImplReview ?? NSNull(),
            ]
        case .relaunch(let id, let repo, let slug):
            return [
                "version": 1, "id": id, "sentAt": at, "repo": repo,
                "kind": "relaunch", "slug": slug,
            ]
        }
    }
}
