// La VEILLE PROACTIVE du poste dans « À traiter », écrite une fois pour le Mac et
// l'iPhone/iPad : chaque élément (réponse proposée, relance, préparation de réunion, brief
// du matin) avec sa sorte, son canal, son sujet et son texte ; une réponse « prête » le dit.
// Rien de vide ne s'affiche : sans élément, ou pour un jeton qui n'est pas celui du
// propriétaire, la section n'existe pas. Valider, modifier ou écarter viendra avec la
// validation des réponses proposées.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct WorkstationWatchSection: View {
    @ObservedObject var watch: WorkstationWatchModel

    public init(watch: WorkstationWatchModel) {
        self.watch = watch
    }

    public var body: some View {
        if watch.availability == .available, !watch.items.isEmpty {
            Section {
                ForEach(watch.items) { item in
                    WorkstationWatchRow(item: item)
                }
            } header: {
                Label(WatchText.sectionTitle, systemImage: WatchText.sectionSymbol)
                    .foregroundStyle(.teal)
            } footer: {
                Text(WatchText.sectionHint)
            }
        }
    }
}

struct WorkstationWatchRow: View {
    let item: WorkstationWatchItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(WatchText.kind(item.kind))
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.teal)
                if item.kind == "reply" || item.kind == "followup" {
                    Text(item.ready ? WatchText.ready : WatchText.toReview)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(item.ready ? .green : .secondary)
                }
            }
            if let subject = item.subject, !subject.isEmpty {
                Text(subject)
                    .font(.headline)
                    .consoleReadable()
            }
            Text(item.text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(6)
            Text(origin)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
        .consoleID("watch.item.\(item.id)")
    }

    /// « Gmail · Brouillon Gmail créé · 9 nov. 2026 à 10:05 ».
    private var origin: String {
        var parts: [String] = []
        if let channel = item.channel { parts.append(ChannelText.channel(channel)) }
        if let draft = item.draft {
            parts.append(draft.kind == "gmail" ? (draft.id == nil ? WatchText.gmailDraftPending : WatchText.gmailDraft) : WatchText.internalDraft)
        }
        parts.append(ConsoleFormat.dateTime(ms: item.createdAt))
        return parts.joined(separator: " · ")
    }
}
