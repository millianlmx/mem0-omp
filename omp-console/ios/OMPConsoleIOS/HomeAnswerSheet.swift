// La feuille « Répondre » de l'Accueil iOS (S-13) : elle répond à la zone que
// `MainSheetPolicy.answerZone(for:)` désigne — une question en vol (question
// entière, options à choisir, champ libre) ou une question en texte (invite et
// champ). Une option sélectionnée PRIME : le champ n'est alors pas envoyé.
//
// Aucune phrase n'est composée ici : les mots viennent de `HomeText`,
// `ActionsText` et `IOSHomeText`. Un échec montre le message EXACT de l'API,
// garde la feuille ouverte et la saisie conservée.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HomeAnswerSheet: View {
    let card: KanbanCard
    @ObservedObject var client: ConsoleClientModel

    @Environment(\.dismiss) private var dismiss

    @State private var selectedOption: String?
    @State private var text = ""
    @State private var failure: String?
    @State private var sending = false

    private var zone: KanbanActionZone? {
        IOSHomeContent.answerZone(card)
    }

    private var options: [PanelAskOption] {
        if case .pendingQuestion(_, _, let options) = zone { return options }
        return []
    }

    private var hasOptions: Bool { !options.isEmpty }

    private var canSubmit: Bool {
        !sending && (selectedOption != nil || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                if let failure {
                    Section {
                        Text(failure)
                            .font(.callout)
                            .iosBanner(tone: .danger)
                    }
                }
                zoneSection
                textSection
            }
            .navigationTitle(card.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(KanbanText.cancel) { dismiss() }
                        .accessibilityIdentifier(IOSHomeAccessibility.answerCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(ActionsText.answer) { submit() }
                        .disabled(!canSubmit)
                        .accessibilityIdentifier(IOSHomeAccessibility.answerSubmit)
                }
            }
            .accessibilityIdentifier(IOSHomeAccessibility.answerSheet)
        }
    }

    @ViewBuilder
    private var zoneSection: some View {
        switch zone {
        case .pendingQuestion(_, let question, let options):
            Section {
                Text(question)
                    .font(.body)
                    .accessibilityIdentifier(IOSHomeAccessibility.answerQuestion)
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    Button {
                        selectedOption = option.label
                    } label: {
                        optionRow(option)
                    }
                    .accessibilityIdentifier(IOSHomeAccessibility.answerOption(index))
                }
            }
        case .textQuestion(_, let prompt):
            Section {
                Text(prompt ?? HomeText.questionWithoutText)
                    .font(.body)
                    .accessibilityIdentifier(IOSHomeAccessibility.answerQuestion)
            }
        default:
            EmptyView()
        }
    }

    private var textSection: some View {
        Section {
            TextField(hasOptions ? HomeText.answerOtherPlaceholder : HomeText.answerPlaceholder, text: $text)
                .accessibilityIdentifier(IOSHomeAccessibility.answerText)
        }
    }

    /// La ligne d'une option : son libellé, sa description quand elle en porte,
    /// et une marque quand elle est choisie.
    private func optionRow(_ option: PanelAskOption) -> some View {
        HStack(spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(option.label)
                if let description = option.description, !description.isEmpty {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
            if selectedOption == option.label {
                Image(systemName: IOSHomeText.selectedSymbol)
                    .foregroundStyle(Color.accentColor)
            }
        }
    }

    /// Envoie le geste : une option sélectionnée prime sur le champ. Un échec
    /// laisse la feuille ouverte et la saisie en place.
    private func submit() {
        guard !sending else { return }
        sending = true
        failure = nil
        Task {
            do {
                switch zone {
                case .pendingQuestion:
                    if let selectedOption {
                        _ = try await client.answer(
                            cardId: card.id,
                            kind: IOSHomeText.kindSelected,
                            label: selectedOption,
                            text: nil
                        )
                    } else {
                        _ = try await client.answer(
                            cardId: card.id,
                            kind: IOSHomeText.kindCustom,
                            label: nil,
                            text: text
                        )
                    }
                case .textQuestion:
                    _ = try await client.reply(cardId: card.id, text: text)
                default:
                    break
                }
                dismiss()
            } catch {
                failure = IOSHomeContent.failure(error)
            }
            sending = false
        }
    }
}
