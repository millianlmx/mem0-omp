import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille d'une carte (S-5 … S-12) : ce que la carte montre et les gestes
/// qu'elle offre. La carte est RELUE par son identifiant à chaque rendu — la
/// trame `store` met la feuille à jour sans la refermer.
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

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 12) {
                        if let error {
                            Text(error)
                                .font(.callout)
                                .iosBanner(tone: .danger)
                                .accessibilityIdentifier(PipelinesAccessibility.error)
                        }
                        if let card {
                            information(card)
                            Divider()
                            gestureList(card)
                                .id(PipelinesText.recipeActionsAnchor)
                        } else {
                            Text(PipelinesText.noSnapshot)
                                .font(.headline)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .iosCard()
                                .accessibilityIdentifier(PipelinesAccessibility.sheetEmpty)
                        }
                    }
                    .padding()
                    .accessibilityElement(children: .contain)
                    .accessibilityIdentifier(PipelinesAccessibility.sheet)
                }
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

    @ViewBuilder
    private func information(_ card: KanbanCard) -> some View {
        let lines = PipelinesModel.modelLines(card, names: modelNames)
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
            HStack(spacing: 8) {
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
        .iosCard()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(PipelinesAccessibility.sheetInfo)
    }

    // MARK: - Gestes

    @ViewBuilder
    private func gestureList(_ card: KanbanCard) -> some View {
        let gestures = PipelinesGesture.gestures(of: card)
        VStack(alignment: .leading, spacing: 10) {
            if let motif = PipelinesGesture.motif(of: card) {
                Text(motif)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(PipelinesAccessibility.sheetMotif)
            } else {
                ForEach(Array(gestures.enumerated()), id: \.offset) { item in
                    gestureButton(item.element, card: card)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .confirmationDialog(
            KanbanText.stopConfirmTitle(repo: card.repo),
            isPresented: $stopShown,
            titleVisibility: .visible
        ) {
            Button(KanbanText.stopConfirm, role: .destructive) {
                perform { _ = try await client.stop(cardId: card.id) }
            }
            Button(KanbanText.cancel, role: .cancel) {}
        } message: {
            Text(KanbanText.stopConfirmMessage)
        }
    }

    @ViewBuilder
    private func gestureButton(_ gesture: PipelinesGesture, card: KanbanCard) -> some View {
        switch gesture {
        case .answerQuestion(let toolCallId, let question, let options):
            questionZone(card, toolCallId: toolCallId, question: question, options: options)
        case .answerText(let prompt):
            textZone(card, prompt: prompt, placeholder: KanbanText.replyPlaceholder, customKind: false)
        case .validateMilestone(let kind):
            actionButton(
                label: kind == .specs ? KanbanText.validateSpecs : KanbanText.acceptReview,
                id: KanbanText.acceptReview,
                card: card
            ) {
                let verdict = kind.verdict ?? PipelinesVerdict.specs.rawValue
                _ = try await client.verdict(cardId: card.id, verdict: verdict)
            }
        case .resume:
            actionButton(label: KanbanText.resume, id: KanbanText.resume, card: card, prominent: true) {
                _ = try await client.resume(cardId: card.id)
            }
        case .stop:
            Button(role: .destructive) {
                stopShown = true
            } label: {
                Text(KanbanText.stop)
                    .frame(maxWidth: .infinity, minHeight: IOSMetrics.minimumTarget)
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .tint(ConsoleTone.danger.tint)
            .overlay(Capsule().strokeBorder(ConsoleTone.danger.tint, lineWidth: 1))
            .disabled(busy)
            .accessibilityIdentifier(PipelinesAccessibility.gesture(KanbanText.stop, card.id))
        case .launch:
            actionButton(label: KanbanText.launch, id: KanbanText.launch, card: card) {
                _ = try await client.resume(cardId: card.id)
            }
        case .openPR:
            Button(HomeText.openPR) {
                if let url = httpURL(card.prUrl ?? "") { openURL(url) }
            }
            .frame(minHeight: IOSMetrics.minimumTarget)
            .accessibilityIdentifier(PipelinesAccessibility.gesture(HomeText.openPR, card.id))
        case .merge:
            Button(ProjectViewText.prMerge) { loadMerge(card) }
                .frame(minHeight: IOSMetrics.minimumTarget)
                .disabled(busy)
                .accessibilityIdentifier(PipelinesAccessibility.gesture(ProjectViewText.prMerge, card.id))
        }
    }

    @ViewBuilder
    private func questionZone(
        _ card: KanbanCard,
        toolCallId: String,
        question: String,
        options: [PanelAskOption]
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(KanbanText.questionTitle)
                .font(.headline)
                .accessibilityIdentifier(PipelinesAccessibility.sheetQuestionTitle)
            Text(question)
                .font(.callout)
                .multilineTextAlignment(.leading)
                .accessibilityIdentifier(PipelinesAccessibility.sheetQuestion)
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
                .buttonStyle(.plain)
                .iosCard()
                .accessibilityIdentifier(PipelinesAccessibility.option(item.offset))
            }
            textZone(card, prompt: nil, placeholder: KanbanText.answerPlaceholder, customKind: true, toolCallId: toolCallId)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func textZone(
        _ card: KanbanCard,
        prompt: String?,
        placeholder: String,
        customKind: Bool,
        toolCallId: String? = nil
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if let prompt, !prompt.isEmpty {
                Text(prompt)
                    .font(.callout)
                    .multilineTextAlignment(.leading)
                    .accessibilityIdentifier(PipelinesAccessibility.sheetPrompt)
            }
            TextField(placeholder, text: $freeText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .accessibilityIdentifier(PipelinesAccessibility.answerField)
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
            .disabled(busy || isBlank(freeText))
            .accessibilityIdentifier(PipelinesAccessibility.answerSend)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func actionButton(
        label: String,
        id: String,
        card: KanbanCard,
        prominent: Bool = false,
        action: @escaping () async throws -> Void
    ) -> some View {
        let button = Button {
            perform(action)
        } label: {
            if busy {
                ProgressView()
                    .frame(maxWidth: prominent ? .infinity : nil, minHeight: IOSMetrics.minimumTarget)
            } else {
                Text(label)
                    .frame(maxWidth: .infinity, alignment: prominent ? .center : .leading)
                    .frame(minHeight: IOSMetrics.minimumTarget)
            }
        }
        if prominent {
            button
                .buttonStyle(.borderedProminent)
                .disabled(busy)
                .accessibilityIdentifier(PipelinesAccessibility.gesture(id, card.id))
        } else {
            button
                .buttonStyle(.plain)
                .iosCard()
                .disabled(busy)
                .accessibilityIdentifier(PipelinesAccessibility.gesture(id, card.id))
        }
    }

    // MARK: - Effets

    private func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func perform(_ action: @escaping () async throws -> Void) {
        Task { @MainActor in
            busy = true
            error = nil
            do {
                try await action()
            } catch {
                self.error = PipelinesText.gestureError(error)
            }
            busy = false
        }
    }

    /// Fusionner : lire les PR du dépôt, trouver la ligne du slug, puis demander
    /// confirmation AVANT tout effet (S-12).
    private func loadMerge(_ card: KanbanCard) {
        guard let slug = card.action?.slug, let repoKey = card.action?.repoKey else { return }
        Task { @MainActor in
            busy = true
            error = nil
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
                self.error = PipelinesText.gestureError(error)
            }
            busy = false
        }
    }

    private func confirmMerge(_ row: ProjectPRRow) {
        guard let slug = card?.action?.slug, let repoKey = card?.action?.repoKey, let headOid = row.headOid else {
            return
        }
        perform {
            _ = try await client.merge(repoKey: repoKey, slug: slug, headOid: headOid)
        }
    }
}
