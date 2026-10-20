// La feuille « Répondre » de l'Accueil iOS (S-13) : elle répond à la zone que
// `MainSheetPolicy.answerZone(for:)` désigne — une question en vol (question
// entière, options à choisir, champ libre) ou une question en texte (invite et
// champ). Une option sélectionnée PRIME : le champ n'est alors pas envoyé.
//
// La question en vol est FIGÉE à l'ouverture (`IOSAnswerDraft`) et la réponse
// part avec SON identifiant (reponse-ios-sans-identifiant-de-question, S-3/S-4) :
// si le Mac répond qu'elle a changé, la feuille reste ouverte sur la nouvelle
// question, bandeau en tête, texte conservé ; si elle n'attend plus de réponse,
// la feuille le signale à l'Accueil (`onQuestionGone`) puis se ferme (S-5).
//
// Aucune phrase n'est composée ici : les mots viennent de `HomeText`,
// `ActionsText` et `IOSHomeText`. Un échec montre le message EXACT de l'API,
// garde la feuille ouverte et la saisie conservée.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HomeAnswerSheet: View {
    let card: KanbanCard
    /// Les deux clients : la réponse part vers la machine de la carte, avec l'identifiant
    /// de carte de CETTE machine (`MachineClients.target(forCardId:)`).
    @ObservedObject var clients: MachineClients
    /// Le statut présenté par l'Accueil (`HomeView.connection`, recette comprise) :
    /// hors `.connected`, options, champ et « Répondre » sont grisés
    /// (etats-non-connecte-heterogenes-ios, S-5).
    let connection: IOSConnectionStatus
    /// Appelée quand le Mac dit que la question n'attend plus de réponse, juste
    /// avant la fermeture : l'Accueil présente alors son alerte (S-5).
    let onQuestionGone: () -> Void

    @Environment(\.dismiss) private var dismiss

    /// La question affichée, figée à l'ouverture, la sélection, le texte et le
    /// bandeau « la question a changé » (S-4).
    @State private var draft: IOSAnswerDraft
    @State private var failure: String?
    @State private var sending = false

    init(
        card: KanbanCard,
        clients: MachineClients,
        connection: IOSConnectionStatus,
        onQuestionGone: @escaping () -> Void
    ) {
        self.card = card
        self.clients = clients
        self.connection = connection
        self.onQuestionGone = onQuestionGone
        _draft = State(initialValue: IOSAnswerDraft(question: IOSAnswerQuestion(card: card)))
    }

    /// La machine de la carte et l'identifiant de carte qu'elle connaît.
    private var target: (client: ConsoleClientModel, cardId: String, machine: RepoMachine) {
        clients.target(forCardId: card.id)
    }

    private var selectedOption: String? { draft.selectedOption }

    private var zone: KanbanActionZone? {
        IOSHomeContent.answerZone(card)
    }

    private var options: [PanelAskOption] {
        draft.question?.options ?? []
    }

    private var hasOptions: Bool { !options.isEmpty }

    private var canSubmit: Bool {
        !sending && draft.choice != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                // Le titre de la carte, entier, en tête du formulaire : la barre ne
                // porte que le titre court et statique de la feuille.
                Section {
                    Text(verbatim: card.title)
                        .font(.headline)
                        .accessibilityAddTraits(.isHeader)
                        .accessibilityIdentifier(IOSHomeAccessibility.answerTitle)
                }
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
            .navigationTitle(IOSHomeText.answerNavigationTitle)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    IOSSheetIconButton(role: .cancel, label: KanbanText.cancel) { dismiss() }
                        .accessibilityIdentifier(IOSHomeAccessibility.answerCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    IOSSheetIconButton(role: .confirm, label: ActionsText.answer) { submit() }
                        .disabled(!connection.gesturesEnabled || !canSubmit)
                        .accessibilityIdentifier(IOSHomeAccessibility.answerSubmit)
                }
            }
            .accessibilityIdentifier(IOSHomeAccessibility.answerSheet)
        }
    }

    @ViewBuilder
    private var zoneSection: some View {
        if let question = draft.question {
            Section {
                // Le bandeau se lit AVANT la question (S-4).
                if let notice = draft.notice {
                    Text(notice)
                        .font(.callout)
                        .iosBanner(tone: .attention)
                        .accessibilityIdentifier(IOSHomeAccessibility.answerNotice)
                }
                Text(question.question)
                    .font(.body)
                    .accessibilityIdentifier(IOSHomeAccessibility.answerQuestion)
                ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                    Button {
                        draft.selectedOption = option.label
                    } label: {
                        optionRow(option)
                    }
                    .disabled(!connection.gesturesEnabled || sending)
                    // La coche est cachée : l'option choisie s'annonce par le trait (S-9).
                    .accessibilityAddTraits(selectedOption == option.label ? .isSelected : [])
                    .accessibilityIdentifier(IOSHomeAccessibility.answerOption(index))
                }
            }
        } else if case .textQuestion(_, let prompt) = zone {
            Section {
                Text(prompt ?? HomeText.questionWithoutText)
                    .font(.body)
                    .accessibilityIdentifier(IOSHomeAccessibility.answerQuestion)
            }
        }
    }

    private var textSection: some View {
        Section {
            TextField(hasOptions ? HomeText.answerOtherPlaceholder : HomeText.answerPlaceholder, text: $draft.text)
                .disabled(!connection.gesturesEnabled)
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
                    .accessibilityHidden(true)
            }
        }
    }

    /// Envoie le geste : une option sélectionnée prime sur le champ. La réponse à
    /// une question en vol part avec l'identifiant de la question AFFICHÉE ; un
    /// échec laisse la feuille ouverte et la saisie en place.
    private func submit() {
        guard !sending, let choice = draft.choice else { return }
        sending = true
        failure = nil
        Task {
            if let question = draft.question {
                let outcome = await IOSAnswerFlow.submit(
                    question: question,
                    choice: choice,
                    send: { toolCallId, choice in
                        switch choice {
                        case .option(let label):
                            _ = try await target.client.answer(
                                cardId: card.id,
                                kind: IOSHomeText.kindSelected,
                                label: label,
                                text: nil,
                                toolCallId: toolCallId
                            )
                        case .custom(let text):
                            _ = try await target.client.answer(
                                cardId: card.id,
                                kind: IOSHomeText.kindCustom,
                                label: nil,
                                text: text,
                                toolCallId: toolCallId
                            )
                        }
                    },
                    reread: {
                        _ = try await target.client.store()
                        return clients.board.state.card(card.id)
                    }
                )
                switch outcome {
                case .delivered:
                    dismiss()
                case .questionChanged(let next):
                    draft.adopt(next)
                    failure = nil
                case .questionGone:
                    onQuestionGone()
                    dismiss()
                case .failed(let error):
                    failure = IOSHomeContent.failure(error)
                }
            } else {
                do {
                    if case .textQuestion = zone {
                        _ = try await target.client.reply(cardId: target.cardId, text: draft.text)
                    }
                    dismiss()
                } catch {
                    failure = IOSHomeContent.failure(error)
                }
            }
            sending = false
        }
    }
}
