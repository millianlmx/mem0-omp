// La zone d'action d'une carte (S-9, puis S-10 de omp-console-redesign) et le
// journal des gestes : la zone vit dans la feuille de détail de Pipelines, le
// journal dans la bulle « Activité » de sa barre d'outils, et les options d'une question sont partagées avec
// l'Accueil. Le lancement d'une feature vit dans la feuille « Nouvelle feature »
// (Launch/NewFeatureSheet.swift), plus dans un formulaire du tableau.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) n'est employé : sous les
// Command Line Tools seuls, ces macros n'existent pas (D3). L'état mutable vit
// dans `ActionsModel` (ou dans un petit `ObservableObject` tenu par
// `@StateObject`), et les liaisons sont des `Binding(get:set:)` construites à la
// main — la convention de la coque (`ConsoleRootView.swift`).
//
// Styles (HIG Materials et Buttons) : boutons standard du système, pas de verre
// dans le contenu ; UN SEUL bouton proéminent par zone d'action — celui du
// premier geste principal (« Répondre », jalon, « Reprendre »). Les boutons de
// validation d'une saisie sont alignés à droite, sous leur champ. « Arrêter… »
// demande toujours confirmation.

import ConsoleCore
import SwiftUI

/// La zone d'action du détail : une vue par zone de
/// `KanbanActionPresentation.zones(for:)`, ou le motif quand la carte n'offre rien.
struct KanbanActionPane: View {
    @ObservedObject var model: ActionsModel
    /// Le tableau (S-6) : depuis la feuille de détail — elle-même une feuille —
    /// « Lire le contrat » ferme d'abord le détail, la feuille Contrat s'ouvrant à
    /// sa fermeture effective.
    @ObservedObject var kanban: KanbanModel
    let card: KanbanCard
    /// « Arrêter… » dans la zone ; la feuille de détail le rend elle-même, à
    /// gauche de sa rangée de boutons, loin des gestes de réponse.
    var showsStop = true
    @StateObject private var stopPrompt = KanbanStopPrompt()

    var body: some View {
        let zones = KanbanActionPresentation.zones(for: card).filter { zone in
            if case .stopLot = zone { return showsStop }
            return true
        }
        // Le geste le plus probable porte le seul bouton proéminent de la zone.
        let primary = zones.firstIndex(where: \.isPrimary)
        VStack(alignment: .leading, spacing: 12) {
            if let motif = KanbanActionPresentation.motif(for: card) {
                Text(motif)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("kanban.actions.motif")
            }
            if let action = card.action {
                ForEach(Array(zones.enumerated()), id: \.offset) { index, zone in
                    zoneView(zone, action: action, prominent: index == primary)
                }
            }
            // Le geste de lecture du contrat (S-6), sous les zones de geste —
            // seulement quand la carte porte un moment de validation.
            if ContractDocument.moment(for: card) != nil {
                Button(ContractText.open) { kanban.requestContract(card) }
                    .accessibilityIdentifier("kanban.actions.contract")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Conteneur : les identifiants des contrôles (boutons, champs, options)
        // restent lisibles individuellement par la sonde AX.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.actions")
    }

    @ViewBuilder
    private func zoneView(_ zone: KanbanActionZone, action: KanbanCardAction, prominent: Bool) -> some View {
        switch zone {
        case .pendingQuestion(_, let question, let options):
            questionZone(question: question, options: options, action: action, prominent: prominent)
        case .steer:
            steerZone(action: action)
        case .textQuestion(_, let prompt):
            replyZone(prompt: prompt, action: action, prominent: prominent)
        case .milestone(let slug, let kind):
            Button(kind == .specs ? ActionsText.validate : ActionsText.accept) {
                if kind == .specs { model.validate(action) } else { model.accept(action) }
            }
            .consoleButtonProminence(prominent)
            .accessibilityIdentifier(kind == .specs ? "kanban.actions.validate" : "kanban.actions.accept")
            .accessibilityLabel("\(kind == .specs ? ActionsText.validate : ActionsText.accept) \(slug)")
        case .resume:
            VStack(alignment: .leading, spacing: 6) {
                Text(ActionsText.resumeNote)
                    .font(.callout)
                Button(ActionsText.resume) { model.resume(action) }
                    .consoleButtonProminence(prominent)
                    .accessibilityIdentifier("kanban.actions.resume")
            }
        case .stopLot:
            Button(ActionsText.stop, role: .destructive) { stopPrompt.shown = true }
                .accessibilityIdentifier("kanban.actions.stop")
                .kanbanStopConfirmation(
                    repo: card.repo,
                    isPresented: Binding(get: { stopPrompt.shown }, set: { stopPrompt.shown = $0 })
                ) {
                    model.stopLot(action)
                }
        }
    }

    /// Une question en TEXTE d'un maillon terminé (feature qui attend une réponse,
    /// aucune question `ask` en vol) : la question, un champ, « Répondre » — la
    /// réponse part en commande `reply` du canal.
    private func replyZone(prompt: String?, action: KanbanCardAction, prominent: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ActionsText.replyTitle)
                .font(.headline)
            ScrollView(.vertical) {
                Text(prompt ?? HomeText.questionWithoutText)
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 160)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier("kanban.actions.reply.prompt")
            fullWidthField(
                ActionsText.replyFieldPlaceholder,
                text: Binding(get: { model.replyText }, set: { model.replyText = $0 }),
                onSubmit: { model.submitReply(action) }
            )
            .accessibilityIdentifier("kanban.actions.reply.text")
            HStack {
                Spacer()
                Button(ActionsText.answer) { model.submitReply(action) }
                    .consoleButtonProminence(prominent)
                    .disabled(model.replyText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("kanban.actions.reply.submit")
            }
        }
    }

    /// La question de l'agent : ses options ET le champ libre, toujours offerts
    /// tous les deux (B-1) — sélectionner une option vide le champ, saisir le
    /// désélectionne.
    private func questionZone(
        question: String,
        options: [PanelAskOption],
        action: KanbanCardAction,
        prominent: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ActionsText.questionTitle)
                .font(.headline)
            Text(question)
                .font(.callout)
                .textSelection(.enabled)
            QuestionOptionsView(model: model, options: options)
            fullWidthField(
                ActionsText.answerFieldPlaceholder,
                text: Binding(
                    get: { model.answerCustomText },
                    set: { model.setAnswerCustomText($0) }
                ),
                onSubmit: { if model.answerReady { model.submitAnswer(action) } }
            )
            .accessibilityIdentifier("kanban.actions.answerField")
            HStack {
                Spacer()
                Button(ActionsText.answer) { model.submitAnswer(action) }
                    .consoleButtonProminence(prominent)
                    .disabled(!model.answerReady)
                    .accessibilityIdentifier("kanban.actions.answer")
            }
        }
    }

    /// Une exécution vivante SANS question en cours : le seul geste offert est un
    /// message à l'agent.
    private func steerZone(action: KanbanCardAction) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ActionsText.steerTitle)
                .font(.headline)
            fullWidthField(
                ActionsText.steerFieldLabel,
                text: Binding(get: { model.steerText }, set: { model.steerText = $0 }),
                onSubmit: { model.submitSteer(action) }
            )
            .accessibilityIdentifier("kanban.actions.steerField")
            Button(ActionsText.send) { model.submitSteer(action) }
                .disabled(model.steerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("kanban.actions.send")
        }
    }

    /// Un champ sur TOUTE la largeur : dans un `Form` groupé, le titre d'un
    /// `TextField` deviendrait une étiquette à gauche qui écrase le champ — il est
    /// donc masqué et repris comme invite (et comme libellé d'accessibilité).
    private func fullWidthField(
        _ title: String,
        text: Binding<String>,
        onSubmit: @escaping () -> Void
    ) -> some View {
        TextField(title, text: text, prompt: Text(title))
            .labelsHidden()
            .textFieldStyle(.roundedBorder)
            .frame(maxWidth: .infinity)
            .onSubmit(onSubmit)
    }
}

/// L'état de la confirmation « Arrêter… » d'une zone d'action (`@State` interdit
/// sous CLT) : tenu par `@StateObject`, il vit autant que la zone.
final class KanbanStopPrompt: ObservableObject {
    @Published var shown = false
}

extension View {
    /// La confirmation d'arrêt, partagée par la zone d'action et par le menu
    /// contextuel d'une carte : l'arrêt vise le DÉPÔT entier (le canal n'a pas
    /// d'arrêt par exécution), d'où le nom du dépôt dans le titre.
    func kanbanStopConfirmation(
        repo: String,
        isPresented: Binding<Bool>,
        onConfirm: @escaping () -> Void
    ) -> some View {
        confirmationDialog(
            ActionsText.stopConfirmTitle(repo: repo),
            isPresented: isPresented,
            titleVisibility: .visible
        ) {
            Button(ActionsText.stopConfirm, role: .destructive, action: onConfirm)
            Button(ActionsText.cancel, role: .cancel) {}
        } message: {
            Text(ActionsText.stopConfirmMessage)
        }
    }
}

private extension KanbanActionZone {
    /// Un geste PRINCIPAL : il peut porter le bouton proéminent de la zone.
    var isPrimary: Bool {
        switch self {
        case .pendingQuestion, .textQuestion, .milestone, .resume: true
        case .steer, .stopLot: false
        }
    }
}

/// Les options d'une question en vol : un VRAI groupe de boutons radio
/// (`Picker(.radioGroup)`), chaque option avec son libellé et, dessous, sa
/// description secondaire. Aucune option choisie tant que l'utilisateur n'a rien
/// coché ou qu'il saisit une réponse libre (`answerSelectedLabel` nil).
/// Partagées par la zone d'action de Pipelines et par la feuille « Répondre » de
/// l'Accueil (S-5 de omp-console-redesign).
struct QuestionOptionsView: View {
    @ObservedObject var model: ActionsModel
    let options: [PanelAskOption]

    var body: some View {
        Picker(
            ActionsText.questionTitle,
            selection: Binding<String?>(
                get: { model.answerSelectedLabel },
                set: { label in if let label { model.selectAnswerOption(label) } }
            )
        ) {
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                VStack(alignment: .leading, spacing: 1) {
                    Text(option.label)
                    if let description = option.description {
                        Text(description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .tag(Optional(option.label))
                .accessibilityIdentifier("kanban.actions.option.\(index)")
            }
        }
        .pickerStyle(.radioGroup)
        .labelsHidden()
        .accessibilityIdentifier("kanban.actions.options")
    }
}

/// L'activité récente (journal des gestes) : une ligne par entrée, la plus récente
/// en tête — symbole de l'état, ligne exacte, heure —, hauteur bornée avec
/// défilement. Le titre est porté par la bulle « Activité » de Pipelines.
struct KanbanJournalView: View {
    @ObservedObject var model: ActionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if model.journal.isEmpty {
                Text(ActionsText.journalEmpty)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("kanban.journal.empty")
            } else {
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(model.journal) { entry in
                            HStack(spacing: 8) {
                                stateSymbol(entry.state)
                                Text(ActionsText.journalLine(for: entry))
                                    .font(.callout)
                                Spacer()
                                Text(ConsoleFormat.time(ms: entry.at))
                                    .font(.caption.monospacedDigit())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 120)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.journal")
    }

    /// Le symbole d'un état de journal : le texte de la ligne dit l'état, le
    /// symbole le double.
    @ViewBuilder
    private func stateSymbol(_ state: ActionJournalState) -> some View {
        switch state {
        case .awaitingAck:
            Image(systemName: "clock").foregroundStyle(.secondary)
        case .taken, .delivered:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .unacknowledged:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .refused, .failed:
            Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.red)
        }
    }
}
