// Le LANCEMENT d'un fil, écrit une fois pour le Mac et l'iPhone/iPad : la feuille
// « Nouveau fil… » (⌘N) tient en trois gestes — le dépôt (parmi ceux de l'espace
// choisi), la phrase, « Lancer » à côté d'« Annuler ». « Plus d'options » replie ce que
// `POST /v1/runs` accepte en plus : le type de travail, le budget et l'autonomie ; puis,
// pour l'expert, la voie, le cadrage `/req` déjà écrit, les modules touchés, la priorité
// et les labels. Le titre du fil est la première ligne de la phrase, sauf s'il est déjà
// écrit (« Refaire » le préremplit).

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les dépôts qu'un lancement propose : ceux de l'espace choisi (`repos` ; `nil` : tous
/// ceux du serveur) et celui qu'il présélectionne (`preferred`).
public struct LaunchScope: Equatable, Sendable {
    public var repos: [String]?
    public var preferred: String?

    public init(repos: [String]? = nil, preferred: String? = nil) {
        self.repos = repos
        self.preferred = preferred
    }

    /// Les dépôts proposés, dans l'ordre du serveur.
    public func permitted(_ declared: [HarnessRepo]) -> [HarnessRepo] {
        guard let repos else { return declared }
        return declared.filter { repos.contains($0.name) }
    }

    /// Le dépôt du lancement : celui déjà choisi s'il est proposé, sinon le préféré, sinon le premier.
    public func repo(chosen: String, among declared: [HarnessRepo]) -> String? {
        let names = permitted(declared).map(\.name)
        if names.contains(chosen) { return chosen }
        if let preferred, names.contains(preferred) { return preferred }
        return names.first
    }
}

/// Le titre d'un fil lancé d'une phrase : sa première ligne, coupée sur un mot.
public enum LaunchPhrase {
    /// La longueur au-delà de laquelle le titre est coupé.
    public static let titleLimit = 80

    public static func title(of phrase: String) -> String {
        let line = phrase
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty } ?? ""
        guard line.count > titleLimit else { return line }
        let cut = line.prefix(titleLimit)
        let kept = cut.lastIndex(of: " ").map { cut[..<$0] } ?? cut
        return kept.trimmingCharacters(in: .whitespaces) + "…"
    }
}

/// Le choix du dépôt des lancements, parmi ceux que le serveur déclare (et que `scope` permet).
public struct RepoPicker: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let scope: LaunchScope

    public init(server: HarnessModel, drafts: HarnessDrafts, scope: LaunchScope = LaunchScope()) {
        self.server = server
        self.drafts = drafts
        self.scope = scope
    }

    public var body: some View {
        let repos = scope.permitted(server.repos)
        if repos.isEmpty {
            Text(PipelineServerText.noRepo)
                .foregroundStyle(.secondary)
        } else {
            Picker(PipelineServerText.repoLabel, selection: Binding(
                get: { scope.repo(chosen: drafts.repo, among: server.repos) ?? "" },
                set: { drafts.repo = $0 }
            )) {
                ForEach(repos) { repo in
                    Text(repo.name).tag(repo.name)
                }
            }
        }
    }
}

/// Le formulaire d'un nouveau fil : le dépôt et la phrase, puis ses options repliées.
public struct LaunchFeatureSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let scope: LaunchScope
    @State private var showsOptions: Bool
    @State private var showsExpert: Bool

    public init(server: HarnessModel, drafts: HarnessDrafts, scope: LaunchScope = LaunchScope()) {
        self.server = server
        self.drafts = drafts
        self.scope = scope
        // Des options déjà renseignées (« Refaire », une saisie gardée) s'ouvrent dépliées.
        let options = drafts.runOptions
        let expert = options.lane != .auto || !options.req.isEmpty || !options.modules.isEmpty || !options.priority.isEmpty || !options.labels.isEmpty
        let p2 = ProcessInfo.processInfo.environment["OMP_P2_OPTIONS"] != nil // TEMPORAIRE P2Coque
        _showsOptions = State(initialValue: options.isCustomized || p2)
        _showsExpert = State(initialValue: expert || p2)
    }

    public var body: some View {
        Section {
            RepoPicker(server: server, drafts: drafts, scope: scope)
            TextField(OSShellText.phrase, text: $drafts.runRequest, axis: .vertical)
                .lineLimit(3...10)
                .consoleID("pipelines.launch.request")
        }

        Section {
            DisclosureGroup(OSShellText.moreOptions, isExpanded: $showsOptions) {
                Picker(AutonomyText.kindLabel, selection: $drafts.runOptions.kind) {
                    Text(AutonomyText.kindUnset).tag(HarnessWorkKind?.none)
                    ForEach(HarnessWorkKind.allCases) { kind in
                        Text(AutonomyText.kind(kind.rawValue)).tag(Optional(kind))
                    }
                }
                .consoleID("pipelines.launch.kind")
                TextField(PipelineServerText.budgetLabel, text: $drafts.runOptions.budget, prompt: Text(PipelineServerText.budgetPrompt))
                    .consoleDecimalInput()
                    .consoleID("pipelines.launch.budget")
                if drafts.runOptions.problem == .budget {
                    problem(PipelineServerText.budgetInvalid)
                }
                Picker(OSDecideText.autonomy, selection: $drafts.runOptions.autonomy) {
                    Text(OSWatchText.autonomyAsk).tag(HarnessRunAutonomy?.some(.ask))
                    Text(OSWatchText.autonomyRules).tag(HarnessRunAutonomy?.none)
                    Text(OSWatchText.autonomyDeliver).tag(HarnessRunAutonomy?.some(.deliver))
                }
                .consoleID("pipelines.launch.autonomy")
                DisclosureGroup(OSShellText.expert, isExpanded: $showsExpert) {
                    expert
                }
            }
        }
    }

    /// Ce que seul l'expert règle : la voie, le cadrage déjà écrit, les modules, la priorité, les labels.
    @ViewBuilder
    private var expert: some View {
        Picker(PipelineServerText.laneLabel, selection: $drafts.runOptions.lane) {
            ForEach(HarnessLane.allCases) { lane in
                Text(PipelineServerText.lane(lane.rawValue)).tag(lane)
            }
        }
        .consoleSegmented()
        .consoleID("pipelines.launch.lane")
        TextField(PipelineServerText.reqLabel, text: $drafts.runOptions.req, axis: .vertical)
            .lineLimit(2...8)
            .consoleID("pipelines.launch.req")
        TextField(PipelineServerText.modulesLabel, text: $drafts.runOptions.modules)
            .consolePlainInput()
            .consoleID("pipelines.launch.modules")
        TextField(PipelineServerText.priorityLabel, text: $drafts.runOptions.priority, prompt: Text(PipelineServerText.priorityPrompt))
            .consoleNumberInput()
            .consoleID("pipelines.launch.priority")
        if drafts.runOptions.problem == .priority {
            problem(PipelineServerText.priorityInvalid)
        }
        TextField(AutonomyText.labelsLabel, text: $drafts.runOptions.labels, prompt: Text(AutonomyText.labelsPrompt))
            .consolePlainInput()
            .consoleID("pipelines.launch.labels")
        if drafts.runOptions.problem == .labels {
            problem(AutonomyText.labelsInvalid)
        }
    }

    private func problem(_ text: String) -> some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
    }
}

/// La feuille « Nouveau fil… » (⌘N), ouverte de partout.
public struct LaunchFeatureSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let scope: LaunchScope

    public init(server: HarnessModel, drafts: HarnessDrafts, scope: LaunchScope = LaunchScope()) {
        self.server = server
        self.drafts = drafts
        self.scope = scope
    }

    /// Le dépôt, la phrase et des options lisibles : le fil peut partir.
    private var canLaunch: Bool {
        server.canAct && !server.isLaunching
            && scope.repo(chosen: drafts.repo, among: server.repos) != nil
            && !drafts.runRequest.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && drafts.runOptions.problem == nil
    }

    public var body: some View {
        NavigationStack {
            Form {
                if let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                LaunchFeatureSections(server: server, drafts: drafts, scope: scope)
            }
            .formStyle(.grouped)
            .navigationTitle(OSShellText.newThreadTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.launchSheetShown = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.launch) { launch() }
                        .disabled(!canLaunch)
                        .consoleID("pipelines.launch.commit")
                }
            }
        }
        .consoleSheetSize(minWidth: 520, minHeight: 360)
        .task { await server.refreshCatalog() }
    }

    private func launch() {
        guard let repo = scope.repo(chosen: drafts.repo, among: server.repos), let options = drafts.runOptions.options else { return }
        let request = drafts.runRequest
        // Un titre déjà écrit (« Refaire ») est gardé ; sinon la première ligne de la phrase.
        let written = drafts.runTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        let title = written.isEmpty ? LaunchPhrase.title(of: request) : written
        Task {
            if await server.launchRun(repo: repo, title: title, request: request, options: options) != nil {
                drafts.clearRun()
                drafts.launchSheetShown = false
            }
        }
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
