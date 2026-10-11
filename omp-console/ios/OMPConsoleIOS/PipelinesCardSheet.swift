import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille d'une carte (S-5 … S-12) : ce que la carte montre et les gestes
/// qu'elle offre. La carte est RELUE par son identifiant à chaque rendu — la
/// trame `store` met la feuille à jour sans la refermer.
///
/// Rendu en formulaire groupé natif (ios-listes-groupees-natives, S-7) : une
/// section d'erreur, une section d'information, une section par question en
/// attente (en-tête natif « Question »), puis une section de gestes — une rangée
/// par geste, aucun panneau ni carte imbriqués.
struct PipelinesCardSheet: View {
    @ObservedObject var client: ConsoleClientModel
    let cardId: String
    /// Le crochet de recette `-pipelines.recipe` : la carte de fixture et son
    /// catalogue remplacent l'instantané du Mac, et l'état forcé est appliqué puis annoncé.
    var recipe: PipelinesCardRecipe?

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var modelNames: [String: String]?
    @State private var busy = false
    @State private var error: String?
    @State private var mergeFailed = false
    @State private var freeText = ""
    @State private var stopShown = false
    @State private var mergeShown = false
    @State private var mergeRow: ProjectPRRow?

    private func loadModelNames() async {
        if let recipe, recipe.card?.id == cardId {
            modelNames = recipe.modelNames
            return
        }
        guard card?.models != nil else {
            modelNames = nil
            return
        }
        do {
            let payload = try await client.models()
            modelNames = payload.failure == nil ? payload.names : nil
        } catch {
            if !Task.isCancelled { modelNames = nil }
        }
    }

    /// L'état forcé de la recette : défilement jusqu'aux gestes, puis (état `arret`) la
    /// confirmation d'arrêt ; le signal de prêt n'est écrit qu'une fois l'état demandé.
    private func applyRecipe(_ proxy: ScrollViewProxy) async {
        guard let recipe, recipe.card?.id == cardId else { return }
        await Task.yield()
        if recipe.scrollsToActions {
            proxy.scrollTo(PipelinesText.recipeActionsAnchor, anchor: .top)
        }
        if recipe == .arret { stopShown = true }
        recipe.announce()
    }

    private static var nowMs: Double { Date().timeIntervalSince1970 * 1000 }

    private var card: KanbanCard? {
        if let recipeCard = recipe?.card, recipeCard.id == cardId { return recipeCard }
        return PipelinesModel.boardState(of: client, nowMs: Self.nowMs)?.card(cardId)
    }

    /// Le statut présenté (etats-non-connecte-heterogenes-ios, S-5) : sous la recette,
    /// la fixture tient lieu de Mac et la feuille est connectée (S-4) ; sinon celui du
    /// client. Les gestes vers le Mac ne sont actifs qu'à `.connected`.
    private var connection: IOSConnectionStatus {
        if recipe != nil { return .connected }
        return IOSConnectionStatus.of(client)
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                Form {
                    if let error {
                        Section {
                            Text(error)
                                .font(.callout)
                                .iosBanner(tone: .danger)
                                .iosBareListRow()
                                .accessibilityIdentifier(PipelinesAccessibility.error)
                            if mergeFailed, let card {
                                Button {
                                    loadMerge(card)
                                } label: {
                                    Label(ConnectionText.retry, systemImage: "arrow.clockwise")
                                        .frame(minHeight: IOSMetrics.minimumTarget)
                                        .contentShape(Rectangle())
                                }
                                .disabled(busy)
                                .accessibilityIdentifier(PipelinesAccessibility.retry)
                            }
                        }
                    }
                    if let card {
                        Section {
                            information(card)
                        }
                        gestureSections(card)
                    } else {
                        Section {
                            Text(PipelinesText.sheetNoCard)
                                .font(.headline)
                                .accessibilityIdentifier(PipelinesAccessibility.sheetEmpty)
                        }
                    }
                }
                .formStyle(.grouped)
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier(PipelinesAccessibility.sheet)
                .navigationTitle(ConsoleSection.kanban.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        // Cadre 44 pt : le bouton de barre stylé retombe à 36 pt sans ce label.
                        Button {
                            dismiss()
                        } label: {
                            Text(KanbanText.close)
                                .padding(.horizontal, 8)
                                .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier(PipelinesAccessibility.sheetClose)
                    }
                }
                .task(id: card?.models) { await loadModelNames() }
                .task { await applyRecipe(proxy) }
            }
        }
        .confirmationDialog(
            KanbanText.stopConfirmTitle(repo: card?.repo ?? ""),
            isPresented: $stopShown,
            titleVisibility: .visible,
            presenting: card
        ) { card in
            Button(KanbanText.stopConfirm, role: .destructive) {
                // Confirmation ouverte avant la coupure : rien ne part hors connexion (S-5).
                guard connection.gesturesEnabled else { return }
                perform { _ = try await client.stop(cardId: card.id) }
            }
            Button(KanbanText.cancel, role: .cancel) {}
        } message: { _ in
            Text(KanbanText.stopConfirmMessage)
        }
        .confirmationDialog(
            ProjectViewText.prMergeConfirmTitle(number: mergeRow?.number),
            isPresented: $mergeShown,
            titleVisibility: .visible,
            presenting: mergeRow
        ) { row in
            Button(ProjectViewText.prMergeConfirmButton, role: .destructive) { confirmMerge(row) }
            Button(ProjectViewText.prMergeCancelButton, role: .cancel) {}
        } message: { row in
            Text(ProjectViewText.prMergeConfirmMessage(title: row.title ?? row.url))
        }
    }

    // MARK: - Information

    /// Une rangée : le titre complet (une seule fois), le dépôt, l'état, la durée,
    /// les modèles et la PR.
    @ViewBuilder
    private func information(_ card: KanbanCard) -> some View {
        let lines = KanbanCardPresentation.modelLines(card, names: modelNames)
        VStack(alignment: .leading, spacing: 6) {
            Text(KanbanCardPresentation.title(card))
                .font(.title3)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier(PipelinesAccessibility.sheetTitle)
            Text(card.repo)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(PipelinesAccessibility.sheetRepo)
            IOSAdaptiveRow(spacing: 8, pinsControlsTrailing: false) {
                IOSStatusChip(status: ConsoleStatus.of(card: card))
                if let phase = card.phase {
                    Text(PhaseText.title(phase))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier(PipelinesAccessibility.sheetPhase)
                }
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                Text(ConsoleFormat.duration(ms:
                    card.elapsedMs(nowMs: context.date.timeIntervalSince1970 * 1000)
                ))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(PipelinesAccessibility.sheetDuration)
            }
            if let lines {
                Text(lines.reqSpecs)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(PipelinesAccessibility.sheetModelReqSpecs)
                Text(lines.implReview)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(PipelinesAccessibility.sheetModelImplReview)
            }
            if let prUrl = card.prUrl, !prUrl.isEmpty {
                Text(prUrl)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(PipelinesAccessibility.sheetPR)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PipelinesAccessibility.sheetInfo)
    }

    // MARK: - Gestes

    private static func isQuestion(_ gesture: PipelinesGesture) -> Bool {
        switch gesture {
        case .answerQuestion: return true
        default: return false
        }
    }

    /// Les questions en attente (une section chacune, en-tête natif), puis la
    /// section des autres gestes, une rangée par geste. La première rangée rendue
    /// porte l'ancre `PipelinesText.recipeActionsAnchor`, vers laquelle la recette
    /// fait défiler (`applyRecipe`).
    @ViewBuilder
    private func gestureSections(_ card: KanbanCard) -> some View {
        let gestures = Array(PipelinesGesture.gestures(of: card).enumerated())
        let questions = gestures.filter { Self.isQuestion($0.element) }
        let actions = gestures.filter { !Self.isQuestion($0.element) }
        let anchor = (questions.first ?? actions.first)?.offset
        if let motif = PipelinesGesture.motif(of: card) {
            Section {
                Text(motif)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(PipelinesAccessibility.sheetMotif)
                    .id(PipelinesText.recipeActionsAnchor)
            }
        } else {
            ForEach(questions, id: \.offset) { item in
                if case let .answerQuestion(toolCallId, question, options) = item.element {
                    questionSection(card, toolCallId: toolCallId, question: question, options: options, anchored: item.offset == anchor)
                }
            }
            if !actions.isEmpty {
                Section {
                    ForEach(actions, id: \.offset) { item in
                        gestureRows(item.element, card: card, anchored: item.offset == anchor)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func gestureRows(_ gesture: PipelinesGesture, card: KanbanCard, anchored: Bool) -> some View {
        switch gesture {
        case .answerQuestion:
            EmptyView()
        case .answerText(let prompt):
            textRows(card, prompt: prompt, placeholder: KanbanText.replyPlaceholder, customKind: false, anchored: anchored)
        case .validateMilestone(let kind):
            actionButton(
                label: kind == .specs ? KanbanText.validateSpecs : KanbanText.acceptReview,
                id: KanbanText.acceptReview,
                card: card
            ) {
                let verdict = kind.verdict ?? PipelinesVerdict.specs.rawValue
                _ = try await client.verdict(cardId: card.id, verdict: verdict)
            }
            .recipeAnchor(anchored)
        case .resume:
            actionButton(label: KanbanText.resume, id: KanbanText.resume, card: card) {
                _ = try await client.resume(cardId: card.id)
            }
            .recipeAnchor(anchored)
        case .stop:
            Button(role: .destructive) {
                stopShown = true
            } label: {
                Text(KanbanText.stop)
                    .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget, alignment: .leading)
            }
            .disabled(!connection.gesturesEnabled || busy)
            .accessibilityIdentifier(PipelinesAccessibility.gesture(KanbanText.stop, card.id))
            .recipeAnchor(anchored)
        case .launch:
            actionButton(label: KanbanText.launch, id: KanbanText.launch, card: card) {
                _ = try await client.resume(cardId: card.id)
            }
            .recipeAnchor(anchored)
        case .openPR:
            Button {
                if let url = httpURL(card.prUrl ?? "") { openURL(url) }
            } label: {
                Text(HomeText.openPR)
                    .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                    .contentShape(Rectangle())
            }
            .accessibilityIdentifier(PipelinesAccessibility.gesture(HomeText.openPR, card.id))
            .recipeAnchor(anchored)
        case .merge:
            Button(ProjectViewText.prMerge) { loadMerge(card) }
                .frame(minHeight: IOSMetrics.minimumTarget)
                .disabled(!connection.gesturesEnabled || busy)
                .accessibilityIdentifier(PipelinesAccessibility.gesture(ProjectViewText.prMerge, card.id))
                .recipeAnchor(anchored)
        }
    }

    /// La question en attente : en-tête natif « Question », la question, une rangée
    /// par option, puis le champ libre et « Envoyer ».
    @ViewBuilder
    private func questionSection(
        _ card: KanbanCard,
        toolCallId: String,
        question: String,
        options: [PanelAskOption],
        anchored: Bool
    ) -> some View {
        Section {
            Text(question)
                .font(.callout)
                .multilineTextAlignment(.leading)
                .accessibilityIdentifier(PipelinesAccessibility.sheetQuestion)
                .recipeAnchor(anchored)
            ForEach(Array(options.enumerated()), id: \.offset) { item in
                Button {
                    let label = item.element.label
                    perform {
                        _ = try await client.answer(
                            cardId: card.id,
                            kind: PipelinesAnswerKind.selected.rawValue,
                            label: label,
                            text: nil,
                            toolCallId: toolCallId
                        )
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(item.element.label)
                        if let description = item.element.description, !description.isEmpty {
                            Text(description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(minHeight: IOSMetrics.minimumTarget, alignment: .leading)
                }
                .disabled(!connection.gesturesEnabled)
                .accessibilityIdentifier(PipelinesAccessibility.option(item.offset))
            }
            textRows(card, prompt: nil, placeholder: KanbanText.answerPlaceholder, customKind: true, toolCallId: toolCallId, anchored: false)
        } header: {
            Text(KanbanText.questionTitle)
                .textCase(nil)
                .accessibilityIdentifier(PipelinesAccessibility.sheetQuestionTitle)
        }
    }

    /// Le texte libre : l'invite éventuelle, le champ, puis « Envoyer » — une rangée chacun.
    @ViewBuilder
    private func textRows(
        _ card: KanbanCard,
        prompt: String?,
        placeholder: String,
        customKind: Bool,
        toolCallId: String? = nil,
        anchored: Bool
    ) -> some View {
        let prompted = prompt.map { !$0.isEmpty } ?? false
        if let prompt, prompted {
            Text(prompt)
                .font(.callout)
                .multilineTextAlignment(.leading)
                .accessibilityIdentifier(PipelinesAccessibility.sheetPrompt)
                .recipeAnchor(anchored)
        }
        TextField(placeholder, text: $freeText, axis: .vertical)
            .disabled(!connection.gesturesEnabled)
            .accessibilityIdentifier(PipelinesAccessibility.answerField)
            .recipeAnchor(anchored && !prompted)
        Button(KanbanText.send) {
            let text = freeText
            freeText = ""
            perform {
                if customKind {
                    _ = try await client.answer(
                        cardId: card.id,
                        kind: PipelinesAnswerKind.custom.rawValue,
                        label: nil,
                        text: text,
                        toolCallId: toolCallId
                    )
                } else {
                    _ = try await client.reply(cardId: card.id, text: text)
                }
            }
        }
        .frame(minHeight: IOSMetrics.minimumTarget)
        .disabled(!connection.gesturesEnabled || busy || isBlank(freeText))
        .accessibilityIdentifier(PipelinesAccessibility.answerSend)
    }

    /// Une rangée de bouton système ; pendant l'envoi, l'indicateur d'activité.
    private func actionButton(
        label: String,
        id: String,
        card: KanbanCard,
        action: @escaping () async throws -> Void
    ) -> some View {
        Button {
            perform(action)
        } label: {
            if busy {
                ProgressView()
                    .frame(minHeight: IOSMetrics.minimumTarget)
            } else {
                Text(label)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(minHeight: IOSMetrics.minimumTarget)
            }
        }
        .disabled(!connection.gesturesEnabled || busy)
        .accessibilityIdentifier(PipelinesAccessibility.gesture(id, card.id))
    }

    // MARK: - Effets

    private func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func perform(_ action: @escaping () async throws -> Void) {
        Task { @MainActor in
            busy = true
            error = nil
            mergeFailed = false
            do {
                try await action()
            } catch {
                self.error = IOSMacErrorText.message(for: error)
            }
            busy = false
        }
    }

    /// Fusionner : lire les PR du dépôt, trouver la ligne du slug, puis demander
    /// confirmation AVANT tout effet (S-12). Un échec de LECTURE des PR est un
    /// chargement : il offre Réessayer (`mergeFailed`) ; un échec de geste, non.
    private func loadMerge(_ card: KanbanCard) {
        guard let slug = card.action?.slug, let repoKey = card.action?.repoKey else { return }
        Task { @MainActor in
            busy = true
            error = nil
            mergeFailed = false
            do {
                let payload = try await client.pullRequests(repoKey: repoKey)
                guard let row = payload.rows.first(where: { $0.slug == slug }) else {
                    error = PipelinesText.noPullRequestRow
                    busy = false
                    return
                }
                mergeRow = row
                mergeShown = true
            } catch {
                self.error = IOSMacErrorText.message(for: error)
                mergeFailed = self.error != nil
            }
            busy = false
        }
    }

    private func confirmMerge(_ row: ProjectPRRow) {
        // Confirmation ouverte avant la coupure : rien ne part hors connexion (S-5).
        guard connection.gesturesEnabled else { return }
        guard let slug = card?.action?.slug, let repoKey = card?.action?.repoKey, let headOid = row.headOid else {
            return
        }
        perform {
            _ = try await client.merge(repoKey: repoKey, slug: slug, headOid: headOid)
        }
    }
}

private extension View {
    /// L'ancre de défilement de la recette, posée sur la seule première rangée de geste.
    @ViewBuilder
    func recipeAnchor(_ anchored: Bool) -> some View {
        if anchored {
            id(PipelinesText.recipeActionsAnchor)
        } else {
            self
        }
    }
}
