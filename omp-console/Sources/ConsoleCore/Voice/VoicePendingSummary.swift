// La liste des attentes formulée à voix haute (noyau-vocal-partage, S-4) : le
// total, puis les 3 attentes les plus récentes, de la plus récente à la plus
// ancienne. Fonction PURE sur la sortie de `PendingRequests.list(_:)`.
//
// VIT DANS `ConsoleCore`.

import Foundation

public enum VoicePendingSummary {
    /// La phrase de `pending`, dont l'ordre d'entrée est ignoré. `paused`,
    /// `detail`, `options` et `reply` ne sont pas prononcés.
    public static func phrase(for pending: [PendingRequest]) -> String {
        guard !pending.isEmpty else { return VoiceSpeechText.noPending }
        let recent = pending.sorted { a, b in
            if a.at != b.at { return a.at > b.at }
            return a.id.utf8.lexicographicallyPrecedes(b.id.utf8)
        }
        .prefix(3)
        return VoiceSpeechText.pendingPhrase(
            count: pending.count,
            items: recent.map(item),
            more: max(pending.count - 3, 0)
        )
    }

    private static func item(_ request: PendingRequest) -> String {
        let subject = request.subject?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return VoiceSpeechText.pendingItem(
            source: subject.isEmpty ? VoiceSpeechText.pendingSource(request.nature) : subject,
            nature: VoiceSpeechText.pendingNature(request.nature),
            question: VoiceSpeech.collapsingBlanks(request.question)
        )
    }
}
