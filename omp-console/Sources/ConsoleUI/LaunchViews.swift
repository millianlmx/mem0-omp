// Le LANCEMENT d'une feature, écrit une fois pour le Mac et l'iPhone/iPad : le dépôt
// (parmi ceux que le serveur déclare), le titre, la demande, puis les options que
// `POST /v1/runs` accepte — priorité, voie, modules touchés, cadrage `/req` déjà écrit
// et budget propre (contrat C3, envoyé seulement s'il est renseigné). Posé dans
// l'écran Pipelines et dans la feuille « Nouvelle feature » (⌘N).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Le choix du dépôt des lancements, parmi ceux que le serveur déclare.
public struct RepoPicker: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
    }

    public var body: some View {
        if server.repos.isEmpty {
            Text(PipelineServerText.noRepo)
                .foregroundStyle(.secondary)
        } else {
            Picker(PipelineServerText.repoLabel, selection: Binding(
                get: { drafts.launchRepo(in: server.repos) ?? "" },
                set: { drafts.repo = $0 }
            )) {
                ForEach(server.repos) { repo in
                    Text(repo.name).tag(repo.name)
                }
            }
        }
    }
}

/// Le formulaire d'une nouvelle feature : la demande, puis ses options repliées.
public struct LaunchFeatureSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    /// Appelé après un lancement accepté (la feuille ⌘N se referme).
    let launched: @MainActor () -> Void

    public init(server: HarnessModel, drafts: HarnessDrafts, launched: @escaping @MainActor () -> Void = {}) {
        self.server = server
        self.drafts = drafts
        self.launched = launched
    }

    public var body: some View {
        Section {
            RepoPicker(server: server, drafts: drafts)
            TextField(PipelineServerText.titleLabel, text: $drafts.runTitle)
                .consoleID("pipelines.launch.title")
            TextField(PipelineServerText.requestLabel, text: $drafts.runRequest, axis: .vertical)
                .lineLimit(3...10)
                .consoleID("pipelines.launch.request")
        } header: {
            Text(PipelineServerText.launchRunTitle)
        } footer: {
            Text(PipelineServerText.launchRunHint)
        }

        Section {
            TextField(PipelineServerText.priorityLabel, text: $drafts.runOptions.priority, prompt: Text(PipelineServerText.priorityPrompt))
                .consoleNumberInput()
                .consoleID("pipelines.launch.priority")
            if drafts.runOptions.problem == .priority {
                problem(PipelineServerText.priorityInvalid)
            }
            Picker(PipelineServerText.laneLabel, selection: $drafts.runOptions.lane) {
                ForEach(HarnessLane.allCases) { lane in
                    Text(PipelineServerText.lane(lane.rawValue)).tag(lane)
                }
            }
            .consoleSegmented()
            .consoleID("pipelines.launch.lane")
            TextField(PipelineServerText.modulesLabel, text: $drafts.runOptions.modules)
                .consolePlainInput()
                .consoleID("pipelines.launch.modules")
            TextField(PipelineServerText.reqLabel, text: $drafts.runOptions.req, axis: .vertical)
                .lineLimit(2...8)
                .consoleID("pipelines.launch.req")
            TextField(PipelineServerText.budgetLabel, text: $drafts.runOptions.budget, prompt: Text(PipelineServerText.budgetPrompt))
                .consoleDecimalInput()
                .consoleID("pipelines.launch.budget")
            if drafts.runOptions.problem == .budget {
                problem(PipelineServerText.budgetInvalid)
            }
            Picker(AutonomyText.launchKindLabel, selection: $drafts.runOptions.kind) {
                Text(AutonomyText.launchKindNone).tag(HarnessWorkKind?.none)
                ForEach(HarnessWorkKind.allCases) { kind in
                    Text(AutonomyText.kindName(kind.rawValue)).tag(HarnessWorkKind?.some(kind))
                }
            }
            .consoleID("pipelines.launch.kind")
            TextField(AutonomyText.launchLabelsLabel, text: $drafts.runOptions.labels, prompt: Text(AutonomyText.launchLabelsPrompt))
                .consolePlainInput()
                .consoleID("pipelines.launch.labels")
            if drafts.runOptions.problem == .labels {
                problem(AutonomyText.launchLabelsInvalid)
            }
        } header: {
            Text(PipelineServerText.launchOptionsTitle)
        } footer: {
            VStack(alignment: .leading, spacing: 4) {
                Text(PipelineServerText.laneHint)
                Text(PipelineServerText.reqHint)
                Text(AutonomyText.launchKindHint)
            }
        }

        Section {
            Button(PipelineServerText.launch) {
                guard let repo = drafts.launchRepo(in: server.repos), let options = drafts.runOptions.options else { return }
                let title = drafts.runTitle
                let request = drafts.runRequest
                Task {
                    if await server.launchRun(repo: repo, title: title, request: request, options: options) != nil {
                        drafts.clearRun()
                        launched()
                    }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!server.canAct || !drafts.canLaunchRun || server.isLaunching || server.repos.isEmpty)
            .consoleID("pipelines.launch.commit")
        }
    }

    private func problem(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
    }
}

/// La feuille « Nouvelle feature » (⌘N), ouverte de partout.
public struct LaunchFeatureSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.drafts = drafts
    }

    public var body: some View {
        NavigationStack {
            Form {
                if let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                LaunchFeatureSections(server: server, drafts: drafts) { drafts.launchSheetShown = false }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.launchRunTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.launchSheetShown = false }
                }
            }
        }
        .consoleSheetSize(minWidth: 520, minHeight: 560)
        .task { await server.refreshCatalog() }
    }
}

extension View {
    /// Un entier signé : le pavé numérique et ponctuation sur iOS.
    @ViewBuilder
    func consoleNumberInput() -> some View {
        #if os(iOS)
        keyboardType(.numbersAndPunctuation)
        #else
        self
        #endif
    }

    /// Un montant : le pavé décimal sur iOS.
    @ViewBuilder
    func consoleDecimalInput() -> some View {
        #if os(iOS)
        keyboardType(.decimalPad)
        #else
        self
        #endif
    }
}
