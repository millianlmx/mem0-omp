// Les métriques d'UNE session, réduites par des fonctions PURES (S-2) : aucune
// E/S, aucune horloge implicite — l'instant de rendu est un paramètre.
//
// Le domaine `Stats` ne touche JAMAIS `TokenUsage.cost` : aucun montant en
// dollars n'est lu ni rendu (AC-2). La durée est un temps MURAL, bornes
// comprises, donc l'attente d'une réponse utilisateur est incluse.

import ConsoleCore
import Foundation

/// Ce que la session d'un run porte : deux sommes de tokens, un compte de tours,
/// le modèle de la dernière réponse, les bornes temporelles.
struct SessionMetrics: Equatable, Sendable {
    /// Σ `usage.input` des entrées assistant qui portent un usage.
    var input: Int
    /// Σ `usage.output`.
    var output: Int
    /// Nombre d'entrées `user` : un tour = un prompt, JAMAIS une « réponse
    /// finale » (un run `-p` n'en porte aucune, Doc-1).
    var turns: Int
    /// `model` de la DERNIÈRE entrée assistant qui en porte un (non vide).
    var model: String?
    /// min des `timestampMs` des entrées de conversation.
    var firstMs: Double?
    /// max des `timestampMs` des entrées de conversation.
    var lastMs: Double?

    static let empty = SessionMetrics(
        input: 0, output: 0, turns: 0, model: nil, firstMs: nil, lastMs: nil
    )
}

/// Réduit une conversation lue en ses métriques. Les compteurs ne dépendent
/// JAMAIS du temps : une entrée à l'horodatage absent compte pour `turns`/
/// `input`/`output`, jamais pour `firstMs`/`lastMs`.
func sessionMetrics(_ conversation: SessionConversation) -> SessionMetrics {
    var metrics = SessionMetrics.empty
    for entry in conversation.entries {
        if let timestamp = entry.timestampMs {
            metrics.firstMs = metrics.firstMs.map { min($0, timestamp) } ?? timestamp
            metrics.lastMs = metrics.lastMs.map { max($0, timestamp) } ?? timestamp
        }
        switch entry.kind {
        case .user:
            metrics.turns += 1
        case .assistant(let turn):
            if let usage = turn.usage {
                metrics.input += usage.input
                metrics.output += usage.output
            }
            if let model = turn.model, !model.isEmpty { metrics.model = model }
        case .toolResult, .compaction, .branchSummary:
            break
        }
    }
    return metrics
}

/// Durée murale d'un run, ou `nil` quand la session ne porte aucun horodatage
/// (affiché `—`). Un run VIVANT court jusqu'à `nowMs` : sa durée avance sans
/// qu'un octet soit écrit (AC-2, AC-3). Un run clos va de sa première à sa
/// dernière entrée horodatée.
func durationMs(_ metrics: SessionMetrics, isLive: Bool, nowMs: Double) -> Double? {
    guard let first = metrics.firstMs else { return nil }
    let end = isLive ? nowMs : (metrics.lastMs ?? first)
    return max(0, end - first)
}
