// Le PONT entre la charge utile d'une session (le contrat d'API) et le modèle de
// conversation PARTAGÉ de `ConsoleCore` (S-3).
//
// C'est ce pont qui rend la parité vérifiable : l'app iOS ne relit jamais un
// `.jsonl` (aucun accès disque), elle reconstruit le MÊME `ConversationEntry` que le
// lecteur macOS, puis le MÊME `SessionRowBuilder` en dérive les mêmes lignes.
//
// Deux replis, documentés et voulus :
//   — `offset` absent (Mac d'avant la feature) ⇒ `wire.index` : les identités de
//     lignes restent uniques, elles ne sont simplement plus stables au-delà d'une
//     même session ;
//   — `kind` hors des cinq valeurs connues ⇒ l'entrée est OMISE, jamais un
//     plantage : ce n'est pas un fait de lecture, donc jamais une entrée ignorée.

import ConsoleCore
import Foundation

extension ConversationEntry {
    /// La reconstruction d'une entrée de conversation depuis sa forme de transport.
    /// `nil` quand le `kind` est hors des cinq valeurs du contrat : l'appelant OMET
    /// l'entrée.
    public init?(_ wire: RemoteConversationEntry) {
        let kind: ConversationEntry.Kind
        switch wire.kind {
        case "user":
            kind = .user(UserTurn(text: wire.text ?? ""))
        case "assistant":
            kind = .assistant(
                AssistantTurn(
                    text: wire.text ?? "",
                    thinking: wire.thinking,
                    model: wire.model,
                    usage: wire.usage.map {
                        TokenUsage(
                            input: $0.input,
                            output: $0.output,
                            cacheRead: $0.cacheRead,
                            cacheWrite: $0.cacheWrite,
                            totalTokens: $0.totalTokens,
                            cost: $0.cost
                        )
                    },
                    toolCalls: (wire.toolCalls ?? []).map {
                        ToolCall(id: $0.id, name: $0.name, arguments: $0.arguments)
                    }
                )
            )
        case "toolResult":
            kind = .toolResult(
                ToolResultTurn(
                    callId: wire.callId,
                    name: wire.name,
                    text: wire.text ?? "",
                    diff: wire.diff,
                    isError: wire.isError ?? false
                )
            )
        case "compaction":
            kind = .compaction(
                CompactionMarker(summary: wire.text ?? "", tokensBefore: wire.tokensBefore)
            )
        case "branchSummary":
            kind = .branchSummary(
                BranchSummaryMarker(summary: wire.text ?? "", fromId: wire.fromId ?? "")
            )
        default:
            return nil
        }

        self.init(
            index: wire.index,
            offset: wire.offset ?? wire.index,
            kind: kind,
            timestampMs: wire.timestampMs
        )
    }
}

/// Les entrées d'une charge utile de session, dans l'ordre du fichier.
public enum SessionWire {
    /// Les entrées converties de `payload.entries`. Une entrée dont le `kind` est
    /// inconnu est OMISE (jamais un plantage, jamais une entrée ignorée comptée).
    /// L'anti-doublon par `offset` n'est PAS fait ici : il vit dans le
    /// `SessionRowBuilder` partagé, seul à connaître les entrées déjà consommées —
    /// c'est ce qui rend inoffensive une entrée délivrée deux fois.
    public static func entries(_ payload: RemoteSessionPayload) -> [ConversationEntry] {
        payload.entries.compactMap(ConversationEntry.init)
    }
}
