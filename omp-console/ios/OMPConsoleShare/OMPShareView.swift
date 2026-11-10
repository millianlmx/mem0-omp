import ConsoleClient
import ConsoleCore
import SwiftUI

// L'extension de partage « Demander à l'OS » : ce qui est partagé (une page, un texte)
// devient une Demande, avec son contexte. L'écran est minimal : le contenu partagé, un
// champ de consigne facultatif, Envoyer et Annuler. La Demande part par ConsoleClient
// (`HarnessIntakes.submit`), sur le serveur que l'app a relié — son adresse et son jeton
// viennent du groupe d'apps (`HarnessModel.shared`). Un échec se lit ici, sans quitter
// la feuille ; la demande reste à renvoyer.

/// L'état de la feuille de partage.
@MainActor
final class OMPShareModel: ObservableObject {
    enum Phase: Equatable {
        /// Le contenu partagé est en cours de lecture.
        case reading
        case ready
        case sending
        case sent
    }

    @Published private(set) var draft = HarnessShareDraft()
    @Published private(set) var phase: Phase = .reading
    /// Ce qui a empêché l'envoi, en une phrase ; effacé par l'envoi suivant.
    @Published private(set) var failure: String?
    /// La consigne saisie, facultative.
    @Published var instruction = ""

    /// Le contenu partagé est lu : sans page ni texte, il n'y a rien à demander.
    func received(_ draft: HarnessShareDraft) {
        self.draft = draft
        phase = .ready
        failure = draft.isEmpty ? OSRemoteText.shareNothing : nil
    }

    var canSend: Bool { phase == .ready && !draft.isEmpty }

    /// Pose la Demande ; `true` : elle est partie.
    func send() async -> Bool {
        guard canSend, let text = draft.request(instruction: instruction, pageRequest: OSRemoteText.sharePage) else { return false }
        phase = .sending
        failure = nil
        failure = await submit(text)
        phase = failure == nil ? .sent : .ready
        return failure == nil
    }

    /// L'envoi au serveur relié par le groupe d'apps ; rend la phrase de l'échec, ou `nil`.
    private func submit(_ text: String) async -> String? {
        guard let server = await HarnessModel.shared() else { return OSRemoteText.shareNotLinked }
        do {
            try await server.intakes.submit(text: text, source: HarnessRemote.shareSource, context: draft.context(instruction: instruction))
            return nil
        } catch let failure as HarnessIntakeFailure {
            return failure.message
        } catch {
            return HarnessFailure.unreachable.message
        }
    }
}

/// La feuille : le contenu partagé, la consigne, Envoyer et Annuler.
struct OMPShareView: View {
    @ObservedObject var model: OMPShareModel
    /// Ferme la feuille ; `true` : la Demande est partie.
    let close: (Bool) -> Void

    var body: some View {
        NavigationStack {
            Form {
                if !model.draft.isEmpty {
                    Section { shared }
                    Section {
                        TextField(OSRemoteText.sharePrompt, text: $model.instruction, axis: .vertical)
                            .disabled(model.phase != .ready)
                    }
                }
                if let failure = model.failure {
                    Section {
                        Label(failure, systemImage: IntakeText.failedSymbol)
                            .foregroundStyle(.red)
                    }
                }
                if model.phase == .sent {
                    Section {
                        Label(OSRemoteText.shareSent, systemImage: OSRemoteText.shareSentSymbol)
                            .foregroundStyle(.green)
                    }
                }
            }
            .navigationTitle(OSRemoteText.shareTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(OSRemoteText.shareCancel) { close(false) }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(model.phase == .sending ? OSRemoteText.shareSending : OSRemoteText.shareSend) { send() }
                        .disabled(!model.canSend)
                }
            }
        }
    }

    /// Ce qui est partagé : le titre de la page (ou le texte), puis son adresse.
    private var shared: some View {
        Label {
            VStack(alignment: .leading, spacing: 2) {
                Text(model.draft.headline)
                    .lineLimit(4)
                if let detail = model.draft.detail {
                    Text(detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        } icon: {
            Image(systemName: model.draft.url == nil ? OSRemoteText.shareTextSymbol : OSRemoteText.sharePageSymbol)
                .accessibilityHidden(true)
        }
    }

    /// Envoie, laisse lire la confirmation, puis rend la main à l'app d'origine.
    private func send() {
        Task {
            guard await model.send() else { return }
            try? await Task.sleep(for: .milliseconds(700))
            close(true)
        }
    }
}
