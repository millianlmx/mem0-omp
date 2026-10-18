import ConsoleClient
import ConsoleCore
import SwiftUI

/// La feuille d'une carte (S-5 … S-12) : ce que la carte montre et les gestes
/// qu'elle offre. La carte est RELUE par son identifiant à chaque rendu — la
/// trame `store` met la feuille à jour sans la refermer —, sauf la question en
/// vol, FIGÉE dans `answer` (reponse-ios-sans-identifiant-de-question, S-4) : la
/// réponse part avec son identifiant, et seul un refus du Mac la remplace.
///
/// Rendu en formulaire groupé natif (ios-listes-groupees-natives, S-7) : une
/// section d'erreur, une section d'information, la section de la question
/// affichée (en-tête natif « Question »), puis une section de gestes — une rangée
/// par geste, aucun panneau ni carte imbriqués.
struct PipelinesCardSheet: View {
    @ObservedObject var client: ConsoleClientModel
    let cardId: String
    /// Le crochet de recette `-pipelines.recipe` : la carte de fixture et son
    /// catalogue remplacent l'instantané du Mac, et l'état forcé est appliqué puis annoncé.
    var recipe: PipelinesCardRecipe?
    /// Appelée quand le Mac dit que la question n'attend plus de réponse, juste
    /// avant la fermeture : l'écran Pipelines présente alors son alerte (S-5).
    let onQuestionGone: () -> Void

    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var modelNames: [String: String]?
    @State private var busy = false
    @State private var error: String?
    @State private var mergeFailed = false
    /// Le texte d'une question en TEXTE (`client.reply`) ; la question en vol a le sien dans `answer`.
    @State private var freeText = ""
    /// La question en vol AFFICHÉE, figée, et sa saisie (S-4) : posée depuis la carte
    /// vivante seulement quand aucune n'est affichée, puis changée par `adopt` ou par une livraison.
    @State private var answer = IOSAnswerDraft(question: nil)
    /// La question à laquelle la fiche vient de répondre : sa section reste masquée
    /// tant que la carte vivante la porte encore.
    @State private var deliveredToolCallId: String?
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
                .onChange(of: IOSAnswerQuestion(card: card), initial: true) { _, live in
                    adoptLiveQuestion(live)
                }
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
            if let motive = KanbanCardPresentation.arbiterMotive(card) {
                Text(motive)
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
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

    /// La question affichée (une section, en-tête natif, rendue depuis `answer`
    /// même si la carte vivante n'a plus de question), puis la section des autres
    /// gestes, une rangée par geste. La première rangée rendue porte l'ancre
    /// `PipelinesText.recipeActionsAnchor`, vers laquelle la recette fait défiler
    /// (`applyRecipe`).
    @ViewBuilder
    private func gestureSections(_ card: KanbanCard) -> some View {
        let actions = Array(PipelinesGesture.gestures(of: card).filter { !Self.isQuestion($0) }.enumerated())
        let question = answer.question
        if let question {
            questionSection(question, anchored: true)
        }
        if let motif = PipelinesGesture.motif(of: card) {
            Section {
                Text(motif)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier(PipelinesAccessibility.sheetMotif)
                    .recipeAnchor(question == nil)
            }
        } else if !actions.isEmpty {
            Section {
                ForEach(actions, id: \.offset) { item in
                    gestureRows(item.element, card: card, anchored: question == nil && item.offset == 0)
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
            textRows(card, prompt: prompt, placeholder: KanbanText.replyPlaceholder, anchored: anchored)
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
        case .arbiter(let state):
            // Un libellé, pas un bouton : l'arbitre décide, rien n'est à faire.
            TimelineView(.periodic(from: .now, by: 1)) { context in
                VStack(alignment: .leading, spacing: 4) {
                    Label(state.label(nowMs: context.date.timeIntervalSince1970 * 1000) ?? "", systemImage: KanbanLane.arbitre.symbol)
                        .font(.headline)
                    Text(KanbanText.arbiterHandles)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier(PipelinesAccessibility.gesture(KanbanText.arbiterLane, card.id))
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

    /// La question affichée : en-tête natif « Question », le bandeau « la question
    /// a changé » s'il y a lieu, la question, une rangée par option (envoi direct),
    /// puis le champ libre et « Envoyer ».
    @ViewBuilder
    private func questionSection(_ question: IOSAnswerQuestion, anchored: Bool) -> some View {
        Section {
            // Le bandeau se lit AVANT la question (S-4).
            if let notice = answer.notice {
                Text(notice)
                    .font(.callout)
                    .iosBanner(tone: .attention)
                    .iosBareListRow()
                    .accessibilityIdentifier(PipelinesAccessibility.answerNotice)
            }
            Text(question.question)
                .font(.callout)
                .multilineTextAlignment(.leading)
                .accessibilityIdentifier(PipelinesAccessibility.sheetQuestion)
                .recipeAnchor(anchored)
            ForEach(Array(question.options.enumerated()), id: \.offset) { item in
                Button {
                    submitAnswer(.option(item.element.label))
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
                .disabled(!connection.gesturesEnabled || busy)
                .accessibilityIdentifier(PipelinesAccessibility.option(item.offset))
            }
            TextField(KanbanText.answerPlaceholder, text: $answer.text, axis: .vertical)
                .disabled(!connection.gesturesEnabled)
                .accessibilityIdentifier(PipelinesAccessibility.answerField)
            Button(KanbanText.send) {
                submitAnswer(.custom(answer.text))
            }
            .frame(minHeight: IOSMetrics.minimumTarget)
            .disabled(!connection.gesturesEnabled || busy || isBlank(answer.text))
            .accessibilityIdentifier(PipelinesAccessibility.answerSend)
        } header: {
            Text(KanbanText.questionTitle)
                .textCase(nil)
                .accessibilityIdentifier(PipelinesAccessibility.sheetQuestionTitle)
        }
    }

    /// La question en TEXTE : l'invite éventuelle, le champ, puis « Envoyer » — une rangée chacun.
    @ViewBuilder
    private func textRows(
        _ card: KanbanCard,
        prompt: String?,
        placeholder: String,
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
                _ = try await client.reply(cardId: card.id, text: text)
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

    /// Pose la question vivante dans `answer` quand aucune n'est affichée et que ce
    /// n'est pas celle à laquelle la fiche vient de répondre (S-4). Ensuite, aucune
    /// trame `store` ne change la question sous les yeux de l'utilisateur.
    private func adoptLiveQuestion(_ live: IOSAnswerQuestion?) {
        guard answer.question == nil, let live, live.toolCallId != deliveredToolCallId else { return }
        answer = IOSAnswerDraft(question: live)
    }

    /// Répond à la question AFFICHÉE avec son identifiant (S-3), puis suit l'issue :
    /// livrée, la section se masque jusqu'à la question suivante ; changée, la fiche
    /// adopte la nouvelle question et garde le texte (S-4) ; partie, l'écran est
    /// prévenu et la fiche se ferme (S-5) ; autre échec, bandeau d'erreur.
    private func submitAnswer(_ choice: IOSAnswerChoice) {
        guard !busy, let question = answer.question else { return }
        busy = true
        error = nil
        mergeFailed = false
        Task { @MainActor in
            let outcome = await IOSAnswerFlow.submit(
                question: question,
                choice: choice,
                send: { toolCallId, choice in
                    switch choice {
                    case .option(let label):
                        _ = try await client.answer(
                            cardId: cardId,
                            kind: PipelinesAnswerKind.selected.rawValue,
                            label: label,
                            text: nil,
                            toolCallId: toolCallId
                        )
                    case .custom(let text):
                        _ = try await client.answer(
                            cardId: cardId,
                            kind: PipelinesAnswerKind.custom.rawValue,
                            label: nil,
                            text: text,
                            toolCallId: toolCallId
                        )
                    }
                },
                reread: {
                    _ = try await client.store()
                    return PipelinesModel.boardState(of: client, nowMs: Self.nowMs)?.card(cardId)
                }
            )
            switch outcome {
            case .delivered:
                deliveredToolCallId = question.toolCallId
                answer = IOSAnswerDraft(question: nil)
                adoptLiveQuestion(IOSAnswerQuestion(card: card))
            case .questionChanged(let next):
                answer.adopt(next)
            case .questionGone:
                onQuestionGone()
                dismiss()
            case .failed(let failure):
                error = IOSMacErrorText.message(for: failure)
            }
            busy = false
        }
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
