// L'écran Projet de l'app iOS (BR-4) : le contenu réel de la section — en-tête du
// projet conduit, bandeau d'attente, choix segmenté Plan | Document, volet
// « PR et CI » en lecture seule, document PROJECT.md rendu, et les gestes
// « Piloter un projet… » / « Arrêter le pilotage ».
//
// Une liste groupée native, seul défilement de l'écran (ios-listes-groupees-natives,
// S-6) : les bandeaux en rangées nues, puis l'en-tête, le sélecteur, une section
// par segment du plan (ou le document), la section « PR et CI » et une rangée par
// geste. Un plan plus haut que l'écran se lit jusqu'à sa dernière étape.
//
// Chaque état (non connecté, vide, démarrage, erreur, succès) est couvert ; aucun
// `onTapGesture`, uniquement des contrôles système atteignables au clavier.
//
// Hors connexion (etats-non-connecte-heterogenes-ios, S-4) : sans conduite reçue,
// le composant d'état de connexion partagé SEUL, hors de la liste ; avec une
// conduite conservée, la liste garde son contenu sous le bandeau du composant.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSProjectScreen: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSProjectModel

    /// La feuille Connexion de la racine, ouverte par « Se connecter ».
    @Binding var showConnection: Bool

    @State private var pane: Pane = .plan
    @State private var showingLaunch = false
    @State private var showingRefusal = false
    @State private var showingStop = false
    /// Le dialogue de la recette `-projet.recipe <dialogue|saisie>`, tant qu'il est ouvert.
    @State private var recipeDialog: RpcDialogRequest?

    /// Le crochet de recette `-projet.recipe <lancement|dialogue|saisie|plan>`, quand il est donné.
    private let recipe: IOSProjectRecipe?

    private enum Pane: Hashable {
        case plan
        case document
    }

    init(client: ConsoleClientModel, recipe: IOSProjectRecipe? = nil, showConnection: Binding<Bool>) {
        self.client = client
        self.recipe = recipe
        _showConnection = showConnection
        _model = StateObject(wrappedValue: IOSProjectModel(
            client: client,
            fixture: recipe == .plan ? IOSProjectPlanRecipe.fixture : nil
        ))
    }

    var body: some View {
        Group {
            switch model.surface {
            case .unavailable(let status):
                // Rien de reçu, Mac non connecté : le composant partagé SEUL, hors
                // de la liste (S-4).
                IOSConnectionStateView(status: status, layout: .screen, onConnect: { showConnection = true })
            case .empty:
                list {
                    emptyState
                    Section { actions }
                }
            case .starting:
                list {
                    startingState
                    Section { actions }
                }
            case .live:
                list { liveState }
            }
        }
        .navigationTitle(ConsoleSection.project.title)
        .onAppear {
            model.appeared()
            model.reloadDocumentIfNeeded()
            model.reloadPRsIfNeeded()
        }
        .onChange(of: model.conduite) {
            model.appeared()
            model.reloadDocumentIfNeeded()
            model.reloadPRsIfNeeded()
        }
        .onChange(of: model.project) {
            model.reloadDocumentIfNeeded()
            model.reloadPRsIfNeeded()
        }
        .onChange(of: pane) {
            if pane == .document { model.reloadDocumentIfNeeded() }
        }
        .sheet(isPresented: $showingLaunch) {
            IOSProjectLaunchSheet(client: client, recipe: recipe == .lancement ? IOSLaunchRecipe.fixture : nil) { repoKey, name in
                await model.start(repoKey: repoKey, name: name)
            }
        }
        .sheet(item: pendingDialogBinding) { dialog in
            IOSProjectDialogSheet(dialog: dialog) { request in
                // Le dialogue de recette se ferme sans réseau.
                if recipeDialog != nil {
                    recipeDialog = nil
                    return nil
                }
                return await model.send(request)
            }
        }
        .task { applyRecipe() }
        .alert(ProjectViewText.refusalTitle, isPresented: $showingRefusal) {
            Button(SessionConsoleText.cancel, role: .cancel) {}
        } message: {
            Text(refusalMessage)
        }
        .confirmationDialog(
            ProjectViewText.closeConfirmTitle,
            isPresented: $showingStop,
            titleVisibility: .visible
        ) {
            Button(ProjectViewText.closeConduite, role: .destructive) {
                guard model.connection.gesturesEnabled else { return }
                Task { await model.stop() }
            }
            Button(SessionConsoleText.cancel, role: .cancel) {}
        } message: {
            Text(ProjectViewText.closeConfirmMessage)
        }
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(
            owner: .project,
            isEnabled: IOSProjectModel.gesturesEnabled(client.state)
        ) {
            model.reloadDocument()
            model.reloadPRs()
        })
    }

    // MARK: - Liste

    /// La liste groupée de l'écran, son seul défilement (S-6) : le bandeau de
    /// connexion en première rangée nue quand la conduite conservée est affichée
    /// hors connexion (S-4), puis l'état. Le titre est celui de la barre de
    /// navigation.
    private func list<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        List {
            if model.connection != .connected {
                IOSConnectionStateView(status: model.connection, layout: .banner, onConnect: { showConnection = true })
                    .iosBareListRow()
            }
            content()
        }
        .iosGroupedList()
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(ProjectAccessibility.screen)
    }

    // MARK: - États

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(ProjectViewText.emptyTitle)
                .font(.headline)
            Text(ProjectViewText.emptyHelp)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(ProjectAccessibility.emptyCard)
    }

    private var startingState: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(ProjectViewText.sessionStarting)
                .font(.callout)
        }
    }

    @ViewBuilder private var liveState: some View {
        waitingBanner
        if let banner = IOSProjectModel.shownFailure(model.banner, connection: model.connection) {
            Text(banner)
                .font(.callout)
                .iosBanner(tone: .danger)
                .accessibilityIdentifier(ProjectAccessibility.banner)
                .iosBareListRow()
        }
        Section { header }
        Section { picker }
        paneContent
        prPane
        Section { actions }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                if let headerName {
                    Text(headerName)
                        .font(.headline)
                }
                Spacer(minLength: 8)
                if let status = model.conduite?.status {
                    IOSStatusChip(status: status)
                }
            }
            if let root = model.conduite?.repoRoot {
                Text(ConsoleFormat.path(root, home: client.macHomeDirectory))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(ProjectAccessibility.header)
    }

    @ViewBuilder private var waitingBanner: some View {
        if model.waitingCount > 1 {
            Text(ProjectViewText.waitingCount(model.waitingCount))
                .font(.callout)
                .iosBanner(tone: .attention)
                .iosBareListRow()
        } else if model.waitingCount == 1 {
            Text(ProjectViewText.waitingBanner)
                .font(.callout)
                .iosBanner(tone: .attention)
                .iosBareListRow()
        }
    }

    private var picker: some View {
        Picker(selection: $pane) {
            Text(ProjectViewText.planTitle).tag(Pane.plan)
            Text(ProjectViewText.docTitle).tag(Pane.document)
        } label: {
            Text(ProjectViewText.windowTitle)
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier(ProjectAccessibility.picker)
    }

    /// Le volet choisi : une section par segment du plan, ou une section pour le
    /// document ; un message tient dans une rangée.
    @ViewBuilder private var paneContent: some View {
        switch pane {
        case .plan:
            if model.project == nil {
                message(ProjectViewText.projectMissing)
            } else if model.planSections.isEmpty {
                message(ProjectViewText.emptyPlan)
            } else {
                IOSProjectPlanView(
                    sections: model.planSections,
                    expanded: model.expanded,
                    onToggle: model.toggle
                )
            }
        case .document:
            documentPane
        }
    }

    @ViewBuilder private var documentPane: some View {
        switch model.docState {
        case .idle:
            EmptyView()
        case .loading:
            Section {
                HStack(spacing: 8) {
                    ProgressView()
                    Text(ProjectViewText.docLoading)
                        .font(.callout)
                }
            }
        case .blocks(let blocks):
            Section {
                IOSMarkdownView(blocks: blocks)
                    .accessibilityIdentifier(ProjectAccessibility.document)
            }
        case .message(let text):
            message(text)
        }
    }

    private var prPane: some View {
        IOSProjectPRView(
            rows: model.prRows,
            failure: IOSProjectModel.shownFailure(model.prFailure, connection: model.connection),
            stale: model.prStale,
            isLoading: model.isRefreshingPRs,
            gesturesEnabled: model.connection.gesturesEnabled,
            onRefresh: { model.reloadPRs() }
        )
    }

    /// Les gestes, une rangée chacun (un seul geste par rangée, T-5) :
    /// « Piloter un projet… », puis « Arrêter le pilotage » quand la conduite
    /// est vive.
    private var actions: some View {
        Group {
            Button(action: startTapped) {
                Text(ProjectViewText.startConduite)
                    .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.borderedProminent)
            .disabled(!model.connection.gesturesEnabled)
            .accessibilityIdentifier(ProjectAccessibility.start)
            if model.isConduiteLive {
                Button(ProjectViewText.closeConduite) { showingStop = true }
                    .disabled(!model.connection.gesturesEnabled || !model.canStop)
                    .accessibilityIdentifier(ProjectAccessibility.stop)
            }
        }
    }

    /// Un message du volet, seul dans sa section.
    private func message(_ text: String) -> some View {
        Section {
            Text(text)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: - Faits dérivés

    /// Le nom de la conduite, ou celui du brouillon soumis ; sans nom, aucune ligne
    /// (le titre de l'écran est celui de la barre de navigation).
    private var headerName: String? {
        model.conduite?.name ?? model.draft?.name
    }

    private var refusalMessage: String {
        let name = model.conduite?.name ?? model.draft?.name ?? ""
        let root = ConsoleFormat.path(model.conduite?.repoRoot ?? "", home: client.macHomeDirectory)
        return ProjectViewText.refusal(name: name, path: root)
    }

    /// Le dialogue n'est présenté que connecté ; encore en attente, il se rouvre à
    /// la reconnexion (etats-non-connecte-heterogenes-ios, S-5).
    private var pendingDialogBinding: Binding<RpcDialogRequest?> {
        Binding(get: { recipeDialog ?? (model.connection == .connected ? model.pendingDialog : nil) }, set: { _ in })
    }

    /// Le crochet de recette ouvre sa feuille d'elle-même, sur la fixture.
    private func applyRecipe() {
        switch recipe {
        case .lancement: showingLaunch = true
        case .dialogue: recipeDialog = IOSLaunchRecipe.dialog
        case .saisie: recipeDialog = IOSLaunchRecipe.editorDialog
        case .plan, nil: break
        }
    }

    private func startTapped() {
        if model.isConduiteLive {
            showingRefusal = true
        } else {
            showingLaunch = true
        }
    }
}
