// L'écran Statistiques de l'app iOS (S-3 … S-6) : le contenu réel de la section —
// sélecteur de projet, une carte par feature (slug, modèle, durée, tours, tokens
// envoyés et reçus), la ligne « Total du projet » et la mention des features
// masquées. LECTURE SEULE : aucun geste de pilotage d'un run, aucun montant.
//
// La durée et les totaux se recalculent à l'instant de RENDU (`TimelineView`,
// Doc-1), donc un run vivant fait avancer son temps sans un octet de trafic — le
// relevé n'est relancé que sur ses quatre déclencheurs (S-5).
//
// Chaque état est un état à part entière ; aucun `onTapGesture`, uniquement des
// contrôles système atteignables au clavier.

import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI

struct IOSStatsScreen: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSStatsModel

    init(client: ConsoleClientModel) {
        self.client = client
        _model = StateObject(wrappedValue: IOSStatsModel(client: client))
    }

    var body: some View {
        // La liste défile verticalement quand elle dépasse la hauteur (S-4) ;
        // l'horloge de rendu reste À L'INTÉRIEUR pour que la position de
        // défilement ne soit jamais reconstruite par un tic (Doc-1).
        ScrollView(.vertical) {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                content(nowMs: context.date.timeIntervalSince1970 * 1000)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .onAppear { model.reload(trigger: .appeared) }
        // Un nouvel état du magasin (trame `store` dérivée en ardoise) ou une mise
        // à jour de session relancent le relevé, sans geste de l'utilisateur (S-5).
        .onChange(of: client.board) { model.reload(trigger: .boardChanged) }
        .onChange(of: client.sessionUpdates) { model.reload(trigger: .sessionsChanged) }
        // ⌘R : le même relevé que le bouton Réessayer, actif client connecté.
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(
            owner: .stats,
            isEnabled: IOSStatsModel.reloads(.appeared, state: client.state)
        ) { model.reload(trigger: .appeared) })
        .accessibilityIdentifier(StatsAccessibility.screen)
    }

    @ViewBuilder
    private func content(nowMs: Double) -> some View {
        switch model.surface {
        case .degraded(let message):
            Text(message)
                .font(.callout)
                .iosBanner(tone: .attention)
                .accessibilityIdentifier(StatsAccessibility.banner)
        case .loading:
            HStack(spacing: 8) {
                ProgressView()
                Text(KanbanBoardState.loadingText)
                    .font(.callout)
            }
            .accessibilityIdentifier(StatsAccessibility.loading)
        case .error(let message):
            errorState(message)
        case .noProject:
            noProjectState
        case .empty:
            emptyState
        case .board:
            boardState(nowMs: nowMs)
        }
    }

    // MARK: - États

    private func errorState(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(message)
                .font(.callout)
                .iosBanner(tone: .danger)
            Button(ConnectionText.retry, systemImage: "arrow.clockwise") {
                model.reload(trigger: .appeared)
            }
            .frame(minHeight: IOSMetrics.minimumTarget)
            .accessibilityIdentifier(StatsAccessibility.retry)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(StatsAccessibility.error)
    }

    private var noProjectState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(StatsPresentation.noProjectTitle)
                .font(.headline)
            Text(StatsPresentation.noProject)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(StatsAccessibility.noProject)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let message = model.payload.flatMap(IOSStatsContent.emptyMessage) {
                Text(message)
                    .font(.headline)
            }
            hiddenMention
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(StatsAccessibility.empty)
    }

    private func boardState(nowMs: Double) -> some View {
        let elapsed = model.elapsedMs(at: nowMs)
        return VStack(alignment: .leading, spacing: 12) {
            projectPicker
            if let payload = model.payload {
                ForEach(IOSStatsContent.cards(payload, elapsedMs: elapsed), id: \.title) { card in
                    cardView(card, identifier: StatsAccessibility.feature(card.title))
                }
                cardView(
                    IOSStatsContent.totalCard(payload, elapsedMs: elapsed),
                    identifier: StatsAccessibility.total
                )
            }
            hiddenMention
        }
    }

    // MARK: - Contenu

    /// Le sélecteur de projet : les options sont EXACTEMENT celles servies (S-3),
    /// aucune clé n'est calculée ni inventée ; aucun sélecteur n'est dessiné quand
    /// le Mac n'annonce aucun projet.
    @ViewBuilder
    private var projectPicker: some View {
        if !model.projects.isEmpty {
            Picker(
                ConsoleSection.project.title,
                selection: Binding(
                    get: { model.shownProjectKey ?? "" },
                    set: { model.select(project: $0) }
                )
            ) {
                ForEach(model.projects, id: \.key) { project in
                    Text(project.label).tag(project.key)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(minHeight: IOSMetrics.minimumTarget)
            .accessibilityIdentifier(StatsAccessibility.project)
        }
    }

    /// Une carte de statistiques : le titre, puis une ligne par grandeur. VoiceOver
    /// annonce la carte en une phrase combinée (S-4).
    private func cardView(_ card: IOSStatsCard, identifier: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(card.title)
                .font(.headline)
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                ForEach(card.lines, id: \.label) { line in
                    GridRow {
                        Text(line.label)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                        Text(line.value)
                            .font(.callout)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }

    /// La mention des features du plan sans run lisible : dessinée dès qu'il y en a,
    /// y compris quand aucune feature n'est listée (S-4).
    @ViewBuilder
    private var hiddenMention: some View {
        if let payload = model.payload, let mention = IOSStatsContent.hiddenMention(payload) {
            Text(mention)
                .font(.caption)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(StatsAccessibility.hidden)
        }
    }
}
