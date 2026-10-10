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
//
// Hors connexion (etats-non-connecte-heterogenes-ios, S-4) : sans relevé reçu, le
// composant d'état de connexion partagé SEUL, hors du panneau ; avec un relevé
// conservé, le tableau reste sous le bandeau du composant, et la section relit au
// retour du Mac.

import ConsoleClient
import ConsoleCore
import Foundation
import SwiftUI

struct IOSStatsScreen: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSStatsModel
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool

    init(client: ConsoleClientModel, showConnection: Binding<Bool>) {
        self.client = client
        _showConnection = showConnection
        _model = StateObject(wrappedValue: IOSStatsModel(client: client))
    }

    var body: some View {
        Group {
            switch surface {
            case .unavailable(let status):
                // Rien de reçu, Mac non connecté : le composant partagé SEUL, hors
                // du panneau (S-4).
                IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
            default:
                panel
            }
        }
        .navigationTitle(ConsoleSection.stats.title)
        .onAppear { model.reload(trigger: .appeared) }
        // Un nouvel état du magasin (trame `store` dérivée en ardoise) ou une mise
        // à jour de session relancent le relevé, sans geste de l'utilisateur (S-5).
        .onChange(of: client.board) { model.reload(trigger: .boardChanged) }
        .onChange(of: client.sessionUpdates) { model.reload(trigger: .sessionsChanged) }
        // Retour du Mac : le relevé conservé est relu (etats-non-connecte-heterogenes-ios, S-4).
        .onMacReconnected(client) { model.reload(trigger: .appeared) }
    }

    /// Le statut de connexion présenté.
    private var connection: IOSConnectionStatus { IOSConnectionStatus.of(client) }

    private var surface: IOSStatsSurface { model.surface(connection: connection) }

    /// Le cadre de la section : le panneau, son titre, le bandeau de connexion
    /// quand un relevé conservé est affiché hors connexion (S-4), puis la liste.
    private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(ConsoleSection.stats.title)
                .font(.title2)
            if connection != .connected {
                IOSConnectionStateView(status: connection, layout: .banner, onConnect: { showConnection = true })
            }
            // La liste défile verticalement quand elle dépasse la hauteur (S-4) ;
            // l'horloge de rendu reste À L'INTÉRIEUR pour que la position de
            // défilement ne soit jamais reconstruite par un tic (Doc-1).
            ScrollView(.vertical) {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    content(nowMs: context.date.timeIntervalSince1970 * 1000)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .accessibilityIdentifier(StatsAccessibility.screen)
        }
        .iosPanel()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.screen." + ConsoleSection.stats.rawValue)
    }

    @ViewBuilder
    private func content(nowMs: Double) -> some View {
        switch surface {
        case .unavailable:
            // Rendu par `body`, hors du panneau.
            EmptyView()
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
            .disabled(!connection.gesturesEnabled)
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
            .disabled(!connection.gesturesEnabled)
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
