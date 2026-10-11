// L'écran Statistiques de l'app iOS (S-3 … S-6) : le contenu réel de la section —
// sélecteur de projet, les graphiques « Durée par feature » et « Tokens par
// feature » (`IOSStatsChartSections`, ios-statistiques-et-graphe-accessibles), une
// section par feature (slug, modèle, durée, tours, tokens envoyés et reçus), la
// section « Total du projet » et la mention des features masquées. LECTURE SEULE :
// aucun geste de pilotage d'un run, aucun montant.
//
// Le sélecteur est l'en-tête de projet : il nomme le projet CHOISI et se tient en
// tête du tableau, de l'état vide et de la bascule vers un autre projet
// (`IOSStatsSurface.showsProjectHeader`, S-1 de
// statistiques-etat-vide-et-non-defilables) — un projet sans données ne piège
// donc jamais l'utilisateur.
//
// La durée et les totaux se recalculent à l'instant de RENDU (`TimelineView`,
// Doc-1) : seules les VALEURS sont réévaluées à chaque tic, jamais la liste, et un
// run vivant fait avancer son temps sans un octet de trafic — le relevé n'est
// relancé que sur ses quatre déclencheurs (S-5).
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
    /// Le crochet de recette `-stats.recipe`, quand il est donné (S-6).
    let recipe: IOSStatsRecipe?
    @StateObject private var model: IOSStatsModel
    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool

    init(client: ConsoleClientModel, recipe: IOSStatsRecipe? = nil, showConnection: Binding<Bool>) {
        self.client = client
        self.recipe = recipe
        _showConnection = showConnection
        _model = StateObject(wrappedValue: recipe?.model() ?? IOSStatsModel(client: client))
    }

    var body: some View {
        Group {
            switch surface {
            case .unavailable(let status):
                // Rien de reçu, Mac non connecté : le composant partagé SEUL, hors
                // du panneau (S-4).
                IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
            default:
                list
            }
        }
        .navigationTitle(ConsoleSection.stats.title)
        .onAppear { model.reload(trigger: .appeared) }
        // Un nouvel état du magasin (trame `store` dérivée en ardoise) ou une mise
        // à jour de session relancent le relevé, sans geste de l'utilisateur (S-5).
        .onChange(of: client.board) { model.reload(trigger: .boardChanged) }
        .onChange(of: client.sessionUpdates) { model.reload(trigger: .sessionsChanged) }
        // La recette `-stats.recipe` fait son pas suivant à chaque relevé reçu
        // (S-6) ; sans recette, rien.
        .onChange(of: model.payload?.projectKey) { recipe?.advance(model) }
        // Retour du Mac : le relevé conservé est relu (etats-non-connecte-heterogenes-ios, S-4).
        .onMacReconnected(client) { model.reload(trigger: .appeared) }
        // ⌘R : le même relevé que le bouton Réessayer, actif client connecté.
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(
            owner: .stats,
            isEnabled: IOSStatsModel.reloads(.appeared, state: client.state)
        ) { model.reload(trigger: .appeared) })
    }

    /// Le statut de connexion présenté. Sous le crochet `-stats.recipe`, la
    /// lecture en mémoire tient lieu de Mac : l'écran est connecté.
    private var connection: IOSConnectionStatus {
        if recipe != nil { return .connected }
        return IOSConnectionStatus.of(client)
    }

    private var surface: IOSStatsSurface { model.surface(connection: connection) }

    /// La liste groupée de la section, son seul défilement
    /// (ios-listes-groupees-natives, S-3) : le bandeau de connexion en rangée nue
    /// quand un relevé conservé est affiché hors connexion (S-4), le sélecteur de
    /// projet dans une section sans en-tête, puis les rangées de l'état ; le titre
    /// est celui de la barre de navigation.
    private var list: some View {
        List {
            if connection != .connected {
                IOSConnectionStateView(status: connection, layout: .banner, onConnect: { showConnection = true })
                    .iosBareListRow()
            }
            if surface.showsProjectHeader {
                Section {
                    projectPicker
                }
            }
            content
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.screen." + ConsoleSection.stats.rawValue)
        .iosGroupedList()
    }

    @ViewBuilder
    private var content: some View {
        switch surface {
        case .unavailable:
            // Rendu par `body`, hors de la liste.
            EmptyView()
        case .loading:
            loadingRow
        case .error(let message):
            errorState(message)
        case .noProject:
            noProjectState
        case .switching:
            // L'en-tête nomme déjà le projet choisi ; sa lecture est en cours.
            loadingRow
        case .empty:
            emptyState
        case .board:
            boardState
        }
    }

    // MARK: - États

    /// Le chargement : celui du premier relevé, et celui du projet choisi pendant
    /// une bascule (sous l'en-tête).
    private var loadingRow: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(StatsPresentation.loading)
                .font(.callout)
        }
        .accessibilityIdentifier(StatsAccessibility.loading)
    }

    /// L'échec : le bandeau en rangée nue, puis Réessayer dans sa rangée.
    @ViewBuilder
    private func errorState(_ message: String) -> some View {
        Text(message)
            .font(.callout)
            .iosBanner(tone: .danger)
            .accessibilityIdentifier(StatsAccessibility.error)
            .iosBareListRow()
        Button(ConnectionText.retry, systemImage: "arrow.clockwise") {
            model.reload(trigger: .appeared)
        }
        .frame(minHeight: IOSMetrics.minimumTarget)
        .disabled(!connection.gesturesEnabled)
        .accessibilityIdentifier(StatsAccessibility.retry)
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
        .accessibilityIdentifier(StatsAccessibility.empty)
    }

    /// Le tableau : les graphiques de durée et de tokens quand leurs valeurs ne
    /// sont pas toutes nulles (ios-statistiques-et-graphe-accessibles, S-2), une
    /// section par feature listée, la section du total, puis la mention des
    /// features masquées.
    @ViewBuilder
    private var boardState: some View {
        if let payload = model.payload {
            IOSStatsChartSections(payload: payload, elapsedMs: model.elapsedMs(at:))
            ForEach(payload.features, id: \.slug) { feature in
                cardSection(identifier: StatsAccessibility.feature(feature.slug)) { elapsed in
                    IOSStatsContent.featureCard(feature, elapsedMs: elapsed)
                }
            }
            cardSection(identifier: StatsAccessibility.total) { elapsed in
                IOSStatsContent.totalCard(payload, elapsedMs: elapsed)
            }
        }
        hiddenMention
    }

    // MARK: - Contenu

    /// Le sélecteur de projet, en-tête des états tableau, vide et bascule : les
    /// options sont EXACTEMENT celles servies (S-3), aucune clé n'est calculée ni
    /// inventée ; il nomme le projet CHOISI, y compris pendant sa lecture ; aucun
    /// sélecteur n'est dessiné quand le Mac n'annonce aucun projet.
    @ViewBuilder
    private var projectPicker: some View {
        if !model.projects.isEmpty {
            Picker(
                ConsoleSection.project.title,
                selection: Binding(
                    get: { model.selectedKey ?? "" },
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

    /// Une section de statistiques : le titre en en-tête natif, puis une rangée
    /// libellé/valeur par grandeur. Seule la valeur est réévaluée à chaque tic
    /// (`TimelineView`, Doc-1) : `card` rend la carte `elapsedMs` après la
    /// réception du relevé, ses titres et libellés ne dépendent pas de l'heure.
    private func cardSection(identifier: String, card: @escaping (Double) -> IOSStatsCard) -> some View {
        let shown = card(model.elapsedMs(at: Date.now.timeIntervalSince1970 * 1000))
        return Section {
            ForEach(Array(shown.lines.enumerated()), id: \.element.label) { index, line in
                LabeledContent {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text(card(model.elapsedMs(at: context.date.timeIntervalSince1970 * 1000)).lines[index].value)
                    }
                } label: {
                    Text(line.label)
                }
            }
        } header: {
            // L'identifiant est sur l'en-tête : posé sur la `Section`, il
            // remplacerait celui de chaque rangée (MESURÉ).
            Text(shown.title)
                .textCase(nil)
                .accessibilityIdentifier(identifier)
        }
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
