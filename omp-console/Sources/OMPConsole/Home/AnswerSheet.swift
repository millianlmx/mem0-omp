// La feuille « Répondre » (S-5 de omp-console-redesign) : la question entière d'une
// carte d'attente, ses options (groupe radio) et/ou un champ, puis « Annuler »
// (Échap) et « Répondre » (↩, bouton par défaut). La zone est celle de
// `MainSheetPolicy.answerZone(for:)` : une question en vol part par
// `submitAnswer`, une question en texte par `submitReply`. La politique ferme la
// feuille d'elle-même si la carte n'attend plus de réponse.
//
// Quand la question offre des options, le champ « Autre réponse… » ne prend PAS
// le focus à l'ouverture : le choix d'une option est le geste attendu.
//
// La question est un CONTENU : bloc opaque, jamais de verre (S-11).

import AppKit
import ConsoleCore
import SwiftUI

struct AnswerSheet: View {
    let card: KanbanCard
    @ObservedObject var home: HomeModel
    @ObservedObject var actions: ActionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.title)
                    .font(.title2.bold())
                if let subtitle = HomeText.cardSubtitle(card, noPhase: nil, showsRepo: true) {
                    Text(subtitle)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            if let zone = MainSheetPolicy.answerZone(for: card), let action = card.action {
                zoneView(zone, action: action)
            } else {
                buttons(submit: nil)
            }
        }
        .padding(20)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("answer.sheet")
    }

    @ViewBuilder
    private func zoneView(_ zone: KanbanActionZone, action: KanbanCardAction) -> some View {
        switch zone {
        case .pendingQuestion(_, let question, let options):
            questionBlock(question)
            if !options.isEmpty {
                QuestionOptionsView(model: actions, options: options)
            }
            TextField(
                options.isEmpty ? HomeText.answerPlaceholder : HomeText.answerOtherPlaceholder,
                text: Binding(get: { actions.answerCustomText }, set: { actions.setAnswerCustomText($0) })
            )
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("answer.text")
            .onAppear { if !options.isEmpty { Self.releaseInitialFocus() } }
            buttons(submit: (enabled: actions.answerReady, perform: {
                actions.submitAnswer(action)
                home.answerCardID = nil
            }))
        case .textQuestion(_, let prompt):
            questionBlock(prompt ?? HomeText.questionWithoutText)
            TextField(
                HomeText.answerPlaceholder,
                text: Binding(get: { actions.replyText }, set: { actions.replyText = $0 })
            )
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("answer.text")
            buttons(submit: (
                enabled: !actions.replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                perform: {
                    actions.submitReply(action)
                    home.answerCardID = nil
                }
            ))
        default:
            buttons(submit: nil)
        }
    }

    /// AppKit donne le focus au premier champ de la feuille ; on le rend à la
    /// fenêtre (aucun premier répondant) au tour suivant, une fois la feuille
    /// installée.
    private static func releaseInitialFocus() {
        DispatchQueue.main.async {
            NSApp.keyWindow?.makeFirstResponder(nil)
        }
    }

    /// La question entière, sélectionnable, dans un bloc opaque borné à 200 pt.
    private func questionBlock(_ text: String) -> some View {
        ScrollView(.vertical) {
            Text(text)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxHeight: 200)
        .fixedSize(horizontal: false, vertical: true)
        .padding(10)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityIdentifier("answer.question")
    }

    /// « Annuler » puis le bouton par défaut « Répondre », en rangée à droite
    /// (HIG Alerts).
    private func buttons(submit: (enabled: Bool, perform: () -> Void)?) -> some View {
        HStack(spacing: 8) {
            Spacer()
            Button(NewFeatureText.cancel) { home.dismissAnswer(actions: actions) }
                .keyboardShortcut(.cancelAction)
                .accessibilityIdentifier("answer.cancel")
            if let submit {
                Button(ActionsText.answer, action: submit.perform)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!submit.enabled)
                    .accessibilityIdentifier("answer.submit")
            }
        }
    }
}
