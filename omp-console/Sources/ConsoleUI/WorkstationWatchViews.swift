// La VEILLE PROACTIVE du poste dans « À traiter », écrite une fois pour le Mac et
// l'iPhone/iPad : chaque élément (réponse proposée, relance, préparation de réunion, brief
// du matin) avec sa sorte, son canal, son sujet et son texte ; une réponse « prête » le dit.
// Rien de vide ne s'affiche : sans élément, ou pour un jeton qui n'est pas celui du
// propriétaire, la section n'existe pas.
//
// Une réponse ou une relance proposée (ou dont l'envoi n'a pas abouti) se décide ici :
// « Valider » (texte proposé tel quel), « Modifier » (l'éditeur, puis « Valider ce texte »)
// ou « Écarter ». Ces gestes n'apparaissent que sur l'appareil approbateur ; ailleurs, le
// pied de section dit où obtenir son code. Une réponse validée attend son envoi (« Validée,
// en attente d'envoi », avec la raison d'attente de la demande du poste) ; un envoi non
// abouti montre la raison du serveur et se revalide. Le refus d'un geste revient sous la
// réponse ; la liste est relue après chaque geste.

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
                    WorkstationWatchRow(watch: watch, item: item)
                }
            } header: {
                Label(WatchText.sectionTitle, systemImage: WatchText.sectionSymbol)
                    .foregroundStyle(.teal)
            } footer: {
                Text(!watch.isApprover && watch.items.contains(where: \.isDecidable) ? WatchText.approverOnly : WatchText.sectionHint)
            }
        }
    }
}

struct WorkstationWatchRow: View {
    @ObservedObject var watch: WorkstationWatchModel
    let item: WorkstationWatchItem
    /// Le texte en cours de modification ; `nil` hors de l'éditeur.
    @State private var editedText: String?
    @State private var failure: HarnessFailure?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(WatchText.kind(item.kind))
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.teal)
                if item.isReply {
                    status
                }
            }
            if let subject = item.subject, !subject.isEmpty {
                Text(subject)
                    .font(.headline)
                    .consoleReadable()
            }
            if let editedText {
                TextField(WatchText.editorLabel, text: Binding(get: { editedText }, set: { self.editedText = $0 }), axis: .vertical)
                    .lineLimit(3...12)
                    .accessibilityLabel(Text(WatchText.editorLabel))
                    .consoleID("watch.editor.\(item.id)")
            } else if item.isReply {
                // Une réponse se lit EN ENTIER avant d'être validée : jamais tronquée.
                Text(item.text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .consoleReadable()
            } else {
                Text(item.text)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
            }
            if item.state == "validated", let reason = item.request?.reason, !reason.isEmpty {
                Text(reason)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if item.state == "failed", let sendError = item.sendError, !sendError.isEmpty {
                Text(sendError)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleBanner(tone: .attention)
            }
            Text(origin)
                .font(.caption)
                .foregroundStyle(.secondary)
            if item.isDecidable, watch.isApprover {
                ViewThatFits(in: .horizontal) {
                    HStack { buttons }
                    VStack(alignment: .leading, spacing: 8) { buttons }
                }
                .disabled(watch.busy.contains(item.id))
            }
            if let failure {
                Text(message(failure))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                    .consoleBanner(tone: .attention)
                    .consoleID("watch.failure.\(item.id)")
            }
        }
        .padding(.vertical, 4)
        .consoleID("watch.item.\(item.id)")
    }

    /// Prête ou à relire (proposée), validée en attente d'envoi, ou envoi non abouti.
    @ViewBuilder
    private var status: some View {
        switch item.state {
        case "validated":
            Label(WatchText.validated, systemImage: WatchText.validatedSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.blue)
        case "failed":
            Label(WatchText.failed, systemImage: WatchText.failedSymbol)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
        default:
            Text(item.ready ? WatchText.ready : WatchText.toReview)
                .font(.caption.weight(.semibold))
                .foregroundStyle(item.ready ? .green : .secondary)
        }
    }

    @ViewBuilder
    private var buttons: some View {
        if let editedText {
            Button(WatchText.validateEdited) {
                act { try await watch.validate(item, text: editedText) ; self.editedText = nil }
            }
            .buttonStyle(.borderedProminent)
            .disabled(editedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .consoleID("watch.validateEdited.\(item.id)")
            Button(WatchText.cancelEdit) { self.editedText = nil }
                .buttonStyle(.bordered)
                .consoleID("watch.cancelEdit.\(item.id)")
        } else {
            Button(WatchText.validate) {
                act { try await watch.validate(item, text: nil) }
            }
            .buttonStyle(.borderedProminent)
            .consoleID("watch.validate.\(item.id)")
            Button(WatchText.edit) {
                failure = nil
                editedText = item.text
            }
            .buttonStyle(.bordered)
            .consoleID("watch.edit.\(item.id)")
            Button(WatchText.dismiss, role: .destructive) {
                act { try await watch.dismiss(item) }
            }
            .buttonStyle(.bordered)
            .consoleID("watch.dismiss.\(item.id)")
        }
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

    /// Le texte d'un refus : la réponse changée (412) et l'appareil non approbateur ont le leur.
    private func message(_ failure: HarnessFailure) -> String {
        switch failure {
        case .stale: WatchText.changed
        case .approverOnly: WatchText.approverOnly
        default: failure.message
        }
    }

    private func act(_ gesture: @escaping @MainActor () async throws -> Void) {
        failure = nil
        Task {
            do {
                try await gesture()
            } catch let refused as HarnessFailure {
                failure = refused
            } catch {}
        }
    }
}
