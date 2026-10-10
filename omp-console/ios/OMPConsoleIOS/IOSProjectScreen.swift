// L'écran Projet de l'app iOS (BR-4) : le contenu réel de la section — en-tête du
// projet conduit, bandeau d'attente, choix segmenté Plan | Document, volet
// « PR et CI » en lecture seule, document PROJECT.md rendu, et les gestes
// « Piloter un projet… » / « Arrêter le pilotage ».
//
// Chaque état (dégradé, vide, démarrage, erreur, succès) est couvert ; aucun
// `onTapGesture`, uniquement des contrôles système atteignables au clavier.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSProjectScreen: View {
    @ObservedObject var client: ConsoleClientModel
    @StateObject private var model: IOSProjectModel

    @State private var pane: Pane = .plan
    @State private var showingLaunch = false
    @State private var showingRefusal = false
    @State private var showingStop = false

    private enum Pane: Hashable {
        case plan
        case document
    }

    init(client: ConsoleClientModel) {
        self.client = client
        _model = StateObject(wrappedValue: IOSProjectModel(client: client))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch model.surface {
            case .degraded(let message):
                Text(message)
                    .font(.callout)
                    .iosBanner(tone: .attention)
            case .empty:
                emptyState
                actions
            case .starting:
                startingState
                actions
            case .live:
                liveState
            }
        }
        .onAppear {
            model.appeared()
            model.reloadDocumentIfNeeded()
            model.reloadPRsIfNeeded()
        }
        .onChange(of: client.conduite) {
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
            IOSProjectLaunchSheet(client: client) { repoKey, name in
                await model.start(repoKey: repoKey, name: name)
            }
        }
        .sheet(item: pendingDialogBinding) { dialog in
            IOSProjectDialogSheet(dialog: dialog) { request in
                await model.send(request)
            }
        }
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
        .iosCard()
        .accessibilityIdentifier(ProjectAccessibility.emptyCard)
    }

    private var startingState: some View {
        HStack(spacing: 8) {
            ProgressView()
            Text(ProjectViewText.sessionStarting)
                .font(.callout)
        }
    }

    private var liveState: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            waitingBanner
            if let banner = model.banner {
                Text(banner)
                    .font(.callout)
                    .iosBanner(tone: .danger)
                    .accessibilityIdentifier(ProjectAccessibility.banner)
            }
            picker
            paneContent
            prPane
            actions
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(headerName)
                    .font(.headline)
                Spacer(minLength: 8)
                if let status = client.conduite?.status {
                    IOSStatusChip(status: status)
                }
            }
            if let root = client.conduite?.repoRoot {
                Text(ConsoleFormat.path(root))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .iosCard()
        .accessibilityIdentifier(ProjectAccessibility.header)
    }

    @ViewBuilder private var waitingBanner: some View {
        if model.waitingCount > 1 {
            Text(ProjectViewText.waitingCount(model.waitingCount))
                .font(.callout)
                .iosBanner(tone: .attention)
        } else if model.waitingCount == 1 {
            Text(ProjectViewText.waitingBanner)
                .font(.callout)
                .iosBanner(tone: .attention)
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
                .accessibilityIdentifier(ProjectAccessibility.plan)
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
            HStack(spacing: 8) {
                ProgressView()
                Text(ProjectViewText.docLoading)
                    .font(.callout)
            }
        case .blocks(let blocks):
            IOSMarkdownView(blocks: blocks)
                .accessibilityIdentifier(ProjectAccessibility.document)
        case .message(let text):
            message(text)
        }
    }

    private var prPane: some View {
        IOSProjectPRView(
            rows: model.prRows,
            failure: model.prFailure,
            stale: model.prStale,
            isLoading: model.isRefreshingPRs,
            onRefresh: { model.reloadPRs() }
        )
    }

    private var actions: some View {
        HStack(spacing: 12) {
            Button(ProjectViewText.startConduite, action: startTapped)
                .disabled(!IOSProjectModel.gesturesEnabled(client.state))
                .accessibilityIdentifier(ProjectAccessibility.start)
            if model.isConduiteLive {
                Button(ProjectViewText.closeConduite) { showingStop = true }
                    .disabled(!model.canStop)
                    .accessibilityIdentifier(ProjectAccessibility.stop)
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .iosCard()
    }

    // MARK: - Faits dérivés

    private var headerName: String {
        client.conduite?.name ?? model.draft?.name ?? ProjectViewText.windowTitle
    }

    private var refusalMessage: String {
        let name = client.conduite?.name ?? model.draft?.name ?? ""
        let root = ConsoleFormat.path(client.conduite?.repoRoot ?? "")
        return ProjectViewText.refusal(name: name, path: root)
    }

    private var pendingDialogBinding: Binding<RpcDialogRequest?> {
        Binding(get: { model.pendingDialog }, set: { _ in })
    }

    private func startTapped() {
        if model.isConduiteLive {
            showingRefusal = true
        } else {
            showingLaunch = true
        }
    }
}
