// Les sections du Mac servies par le serveur de pipelines du VPS (omp-harness) — le
// seul moteur : « À traiter » (la file unique de ce qui attend l'humain) et Features
// (une ligne par feature à gauche, sa page à droite ; projets, audits et issues en
// portées). Le Poste passe par le même cadre (`WorkstationViews.swift`), Système aussi
// (`SystemPages.swift`).
//
// Le contenu partagé avec l'app iOS vient de la cible ConsoleUI ; ce fichier n'en garde
// que le cadre du Mac. Un seul `HarnessModel` et un seul `HarnessDrafts` pour toute la
// fenêtre (posés par `OMPConsoleApp`) : le flux d'événements tient chaque section à
// jour. Sans serveur relié, chaque section montre le même appel à le relier. Le titre
// de la fenêtre est posé par la racine, jamais ici.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// MARK: - Actualiser (⌘R)

/// L'actualisation de la section à l'écran : le menu Présentation ▸ « Actualiser » (⌘R)
/// l'appelle. Le cadre la publie pour la scène ; aucun bouton ne la répète à l'écran.
struct HarnessRefreshAction {
    let isEnabled: Bool
    let perform: @MainActor () async -> Void
}

private struct HarnessRefreshKey: FocusedValueKey {
    typealias Value = HarnessRefreshAction
}

extension FocusedValues {
    var harnessRefresh: HarnessRefreshAction? {
        get { self[HarnessRefreshKey.self] }
        set { self[HarnessRefreshKey.self] = newValue }
    }
}

// MARK: - Cadre

/// Le cadre commun : relier le serveur s'il ne l'est pas, sinon le contenu — dans un
/// formulaire groupé (`form`), l'échec du dernier échange en tête — et les feuilles des
/// gestes. Aucun bouton de barre d'outils : chaque écran déclare sa seule action
/// principale. `reload` relit, à ⌘R, ce qui n'est pas dans la boîte (le poste, la vigie…).
struct HarnessSection<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let catalog: Bool
    let form: Bool
    let reload: (@MainActor () async -> Void)?
    @ViewBuilder let content: () -> Content

    init(
        server: HarnessModel,
        drafts: HarnessDrafts,
        catalog: Bool,
        form: Bool = true,
        reload: (@MainActor () async -> Void)? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.server = server
        self.drafts = drafts
        self.catalog = catalog
        self.form = form
        self.reload = reload
        self.content = content
    }

    var body: some View {
        Group {
            if !server.isLoaded {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !server.isConfigured {
                notConfigured
            } else if form {
                HarnessForm(server: server, drafts: drafts) { content() }
            } else {
                VStack(spacing: 0) {
                    if let failure = server.failure {
                        ConsoleFailureBanner(failure: failure)
                            .padding([.horizontal, .top])
                    }
                    content()
                }
            }
        }
        .focusedSceneValue(\.harnessRefresh, HarnessRefreshAction(isEnabled: server.isConfigured && !server.isLoading) {
            await server.refresh()
            if catalog { await server.refreshCatalog() }
            await reload?()
        })
        .task {
            if catalog { await server.refreshCatalog() }
        }
        .harnessGestures(server: server, drafts: drafts)
        .workstationGestures(workstation: server.workstation, drafts: drafts)
    }

    private var notConfigured: some View {
        VStack(spacing: 16) {
            Image(systemName: "server.rack")
                .font(.largeTitle)
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(PipelineServerText.notConfigured)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
                .frame(maxWidth: 420)
            Button(PipelineServerText.configure) { drafts.serverSheetShown = true }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("server.configure")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Un formulaire groupé du serveur : l'échec du dernier échange en tête, seulement s'il
/// y en a un. Une demande de la palette ou d'une notification (`homeAnchor`) y fait
/// défiler jusqu'à l'élément de la file qu'elle désigne, puis est oubliée.
struct HarnessForm<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                if let failure = server.failure {
                    Section {
                        ConsoleFailureBanner(failure: failure)
                    }
                }
                content()
            }
            .formStyle(.grouped)
            .onAppear { scroll(to: drafts.homeAnchor, proxy) }
            .onChange(of: drafts.homeAnchor) { _, anchor in scroll(to: anchor, proxy) }
        }
    }

    private func scroll(to anchor: HarnessHomeAnchor?, _ proxy: ScrollViewProxy) {
        guard let anchor else { return }
        withAnimation { proxy.scrollTo(anchor.rawValue, anchor: .top) }
        drafts.homeAnchor = nil
    }
}

// MARK: - À traiter

/// « À traiter » : la ligne de pouls, les envois du poste à approuver, puis la file
/// unique de ce qui attend l'humain. Une seule action en barre d'outils : « + ».
struct HarnessInboxView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, reload: {
            await server.workstation.refresh()
            await server.signals.refresh()
            await server.atlassian.refresh()
            await server.intakes.refresh()
            await server.vigie.refresh()
        }) {
            InboxFeed(server: server, drafts: drafts, inbox: server.inbox ?? HarnessInbox())
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    drafts.launchSheetShown = true
                } label: {
                    Label(PipelineServerText.newFeature, systemImage: PipelineServerText.newFeatureSymbol)
                }
                .help(PipelineServerText.newFeature)
                .disabled(!server.isConfigured || !server.canAct)
                .accessibilityIdentifier("inbox.new")
            }
        }
        .accessibilityIdentifier("inbox.harness")
    }
}

// MARK: - Features

/// Features : la portée choisie en tête de la barre d'outils. Pour les features, la
/// liste dense à gauche et la page de la feature choisie à droite ; projets, audits et
/// issues en formulaire pleine largeur.
struct HarnessRunsView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var history: HarnessRunsHistory

    init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
        self.history = server.history
    }

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: true, form: false, reload: { await history.refresh() }) {
            switch drafts.runsScope {
            case .features:
                features
            case .projects:
                HarnessForm(server: server, drafts: drafts) { ProjectsListSections(server: server, drafts: drafts) }
            case .audits:
                HarnessForm(server: server, drafts: drafts) { AuditsListSections(server: server, drafts: drafts) }
            case .issues:
                HarnessForm(server: server, drafts: drafts) { IssuesSections(server: server, drafts: drafts) }
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker(ShellText.scope, selection: $drafts.runsScope) {
                    ForEach(RunsScope.allCases) { scope in
                        Text(scope.title).tag(scope)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("runs.scope")
            }
            if drafts.runsScope == .features {
                ToolbarItem(placement: .primaryAction) {
                    RunsFilterMenu(server: server)
                }
            }
            ToolbarItem(placement: .primaryAction) {
                NewWorkMenu(server: server, drafts: drafts)
            }
        }
        .task { await history.refresh() }
        .accessibilityIdentifier("runs.harness")
    }

    private var features: some View {
        HSplitView {
            List(selection: $drafts.openedRun) {
                RunsListSections(server: server, drafts: drafts, selectable: true)
            }
            .listStyle(.inset)
            .frame(minWidth: 260, idealWidth: 340, maxWidth: 520)
            Group {
                if let runId = drafts.openedRun {
                    RunPageView(server: server, drafts: drafts, runId: runId)
                        .id(runId)
                } else {
                    ContentUnavailableView {
                        Label(ShellText.pickRun, systemImage: ConsoleSection.runs.systemImage)
                    } description: {
                        Text(ShellText.pickRunHint)
                    }
                }
            }
            .frame(minWidth: 420, maxWidth: .infinity, maxHeight: .infinity)
        }
        .searchable(text: $history.query)
    }
}
