// La surface de l'action depuis le Kanban (S-9) : le bandeau de lancement, le
// formulaire, la zone d'action du détail et le journal des gestes.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`) n'est employé : sous les
// Command Line Tools seuls, ces macros n'existent pas (D3). L'état mutable vit
// dans `ActionsModel`, et les liaisons sont des `Binding(get:set:)` construites à
// la main — la convention de la coque (`ConsoleRootView.swift:20-26`).

import SwiftUI

/// Le bandeau haut de la section Kanban : le bouton de dépliage et, déplié, le
/// formulaire de lancement.
struct KanbanActionBar: View {
    @ObservedObject var model: ActionsModel
    let board: KanbanBoard
    let selectedCard: KanbanCard?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button(ActionsText.launchToggle) { model.launchFormShown.toggle() }
                .accessibilityIdentifier("kanban.launch.toggle")
            if model.launchFormShown {
                KanbanLaunchForm(model: model, board: board, selectedCard: selectedCard)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Le bandeau est un CONTENEUR d'accessibilité : sans lui, son identifiant
        // écraserait celui de ses enfants (« Lancer une feature… »).
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.actions.bar")
    }
}

/// Le formulaire de lancement : titre, description, dépôt CHOISI parmi les dépôts
/// connus, puis « Lancer » — inactif tant que le titre ou la description est blanc,
/// ou qu'aucun dépôt n'est connu.
struct KanbanLaunchForm: View {
    @ObservedObject var model: ActionsModel
    let board: KanbanBoard
    let selectedCard: KanbanCard?

    var body: some View {
        let projectRoot = ProjectRoot.resolve(defaults: .standard, fileManager: .default)?.path
        let options = KanbanLaunchRepos.options(cards: board.cards, projectRoot: projectRoot)
        let fallback = KanbanLaunchRepos.defaultSelection(
            options: options,
            selectedRepoRoot: selectedCard?.action?.repoRoot,
            projectRoot: projectRoot
        )
        let selection = Binding<String>(
            get: { model.launchRepoRoot ?? fallback ?? "" },
            set: { model.launchRepoRoot = $0.isEmpty ? nil : $0 }
        )
        let ready = !model.launchTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.launchDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !options.isEmpty

        VStack(alignment: .leading, spacing: 6) {
            TextField(ActionsText.titleLabel, text: $model.launchTitle)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("kanban.launch.title")
            TextField(ActionsText.descriptionLabel, text: $model.launchDescription)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier("kanban.launch.description")
            if options.isEmpty {
                Text(ActionsText.noRepos())
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("kanban.actions.motif")
            } else {
                Picker(ActionsText.repoLabel, selection: selection) {
                    ForEach(options, id: \.self) { root in Text(root).tag(root) }
                }
                .accessibilityIdentifier("kanban.launch.repo")
            }
            HStack(spacing: 8) {
                Button(ActionsText.submit) {
                    model.launch(
                        title: model.launchTitle,
                        description: model.launchDescription,
                        repoRoot: selection.wrappedValue
                    )
                }
                .disabled(!ready)
                .accessibilityIdentifier("kanban.launch.submit")
                Button(ActionsText.cancel) { model.launchFormShown = false }
                    .accessibilityIdentifier("kanban.launch.cancel")
            }
        }
    }
}

/// La zone d'action du détail : une vue par zone de
/// `KanbanActionPresentation.zones(for:)`, ou le motif quand la carte n'offre rien.
struct KanbanActionPane: View {
    @ObservedObject var model: ActionsModel
    let card: KanbanCard

    var body: some View {
        let zones = KanbanActionPresentation.zones(for: card)
        VStack(alignment: .leading, spacing: 10) {
            if let motif = KanbanActionPresentation.motif(for: card) {
                Text(motif)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("kanban.actions.motif")
            }
            if let action = card.action {
                ForEach(Array(zones.enumerated()), id: \.offset) { _, zone in
                    zoneView(zone, action: action)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Conteneur : les identifiants des contrôles (boutons, champs, options)
        // restent lisibles individuellement par la sonde AX.
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.actions")
    }

    @ViewBuilder
    private func zoneView(_ zone: KanbanActionZone, action: KanbanCardAction) -> some View {
        switch zone {
        case .pendingQuestion(_, let question, let options):
            questionZone(question: question, options: options, action: action)
        case .steer:
            steerZone(action: action)
        case .milestone(let slug, let kind):
            Button(kind == .specs ? ActionsText.validate : ActionsText.accept) {
                if kind == .specs { model.validate(action) } else { model.accept(action) }
            }
            .accessibilityIdentifier(kind == .specs ? "kanban.actions.validate" : "kanban.actions.accept")
            .accessibilityLabel("\(kind == .specs ? ActionsText.validate : ActionsText.accept) \(slug)")
        case .stopLot:
            Button(ActionsText.stop) { model.stopLot(action) }
                .accessibilityIdentifier("kanban.actions.stop")
        }
    }

    /// La question en vol : ses options ET le champ libre, toujours offerts tous les
    /// deux (B-1) — sélectionner une option vide le champ, saisir le désélectionne.
    private func questionZone(
        question: String,
        options: [PanelAskOption],
        action: KanbanCardAction
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ActionsText.questionTitle)
                .font(.headline)
            Text(question)
                .font(.callout)
                .textSelection(.enabled)
            ForEach(Array(options.enumerated()), id: \.offset) { index, option in
                Button {
                    model.selectAnswerOption(option.label)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Image(systemName: model.answerSelectedLabel == option.label
                            ? "largecircle.fill.circle" : "circle")
                        VStack(alignment: .leading, spacing: 0) {
                            Text(option.label)
                            if let description = option.description {
                                Text(description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("kanban.actions.option.\(index)")
            }
            TextField(
                ActionsText.answerFieldPlaceholder,
                text: Binding(
                    get: { model.answerCustomText },
                    set: { model.setAnswerCustomText($0) }
                )
            )
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("kanban.actions.answerField")
            Button(ActionsText.answer) { model.submitAnswer(action) }
                .disabled(!model.answerReady)
                .accessibilityIdentifier("kanban.actions.answer")
        }
    }

    /// Un run vivant SANS question en vol : le seul geste offert est un texte.
    private func steerZone(action: KanbanCardAction) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(ActionsText.steerTitle)
                .font(.headline)
            TextField(
                ActionsText.steerFieldLabel,
                text: Binding(get: { model.steerText }, set: { model.steerText = $0 })
            )
            .textFieldStyle(.roundedBorder)
            .accessibilityIdentifier("kanban.actions.steerField")
            Button(ActionsText.send) { model.submitSteer(action) }
                .disabled(model.steerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityIdentifier("kanban.actions.send")
        }
    }
}

/// Le journal des gestes : une ligne par entrée, la plus récente en tête, police
/// monospacée, hauteur bornée avec défilement.
struct KanbanJournalView: View {
    @ObservedObject var model: ActionsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(ActionsText.journalTitle)
                .font(.headline)
            if model.journal.isEmpty {
                Text(ActionsText.journalEmpty)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("kanban.journal.empty")
            } else {
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(model.journal) { entry in
                            Text(ActionsText.journalLine(for: entry))
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 120)
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("kanban.journal")
    }
}
