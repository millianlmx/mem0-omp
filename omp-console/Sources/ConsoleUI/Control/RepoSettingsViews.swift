// L'écran « Dépôts », écrit une fois pour le Mac et l'iPhone/iPad : la liste des dépôts
// déclarés (forge, branche, fusion, juge des tests, confidentialité, espace, en symboles),
// l'ajout par adresse avec la clé de déploiement à poser quand la forge refuse, et les
// réglages d'un dépôt dans un formulaire natif. Chaque réglage s'écrit dès qu'il change
// (un champ de texte à sa validation, un compteur après une courte pause) ; un refus du
// serveur remet la valeur d'avant et vient en bandeau.
//
// L'écran n'a pas de pile de navigation à lui : sur iPhone/iPad il est poussé dans celle de
// l'app et un dépôt s'ouvre par-dessus ; sur Mac il occupe le centre de la fenêtre, liste et
// réglages côte à côte. Admin seulement ; un serveur sans `repo-settings` montre la liste et
// accepte un ajout, sans réglages.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les dépôts du serveur : liste, ajout, réglages et retrait.
public struct RepoSettingsList: View {
    @ObservedObject private var server: HarnessModel
    @ObservedObject private var admin: HarnessAdmin
    @State private var adding = false
    @State private var selection: String?

    public init(server: HarnessModel) {
        self.server = server
        admin = server.admin
    }

    public var body: some View {
        content
            .navigationTitle(RepoText.title)
            .toolbar {
                if server.isAdmin {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            adding = true
                        } label: {
                            Label(RepoText.add, systemImage: RepoText.addSymbol)
                        }
                        .disabled(admin.isSaving)
                        .consoleID("repos.add")
                    }
                }
            }
            .sheet(isPresented: $adding) {
                RepoAddSheet(admin: admin)
            }
            .task(id: "\(server.address ?? "")|\(server.isAdmin)") {
                await admin.loadRepos()
            }
    }

    @ViewBuilder
    private var content: some View {
        if !server.isAdmin {
            ContentUnavailableView(RepoText.adminOnly, systemImage: RepoText.lockedSymbol)
        } else {
            #if os(macOS)
            HSplitView {
                List(selection: $selection) { rows }
                    .overlay { placeholder }
                    .frame(minWidth: 240, idealWidth: 280, maxWidth: 360)
                detail
                    .frame(minWidth: 440, maxWidth: .infinity, maxHeight: .infinity)
            }
            .onChange(of: admin.repos.map(\.name), initial: true) { _, names in
                if let selection, names.contains(selection) { return }
                selection = names.first
            }
            #else
            List { rows }
                .overlay { placeholder }
                .refreshable { await admin.loadRepos() }
            #endif
        }
    }

    @ViewBuilder
    private var rows: some View {
        if let failure = admin.failure {
            ConsoleFailureBanner(failure: failure)
        }
        if let removed = admin.removed, removed.kept {
            Label(RepoText.kept(removed.repo), systemImage: RepoText.timeoutSymbol)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        ForEach(admin.repos) { repo in
            row(repo)
        }
    }

    @ViewBuilder
    private func row(_ repo: HarnessServedRepo) -> some View {
        let label = RepoRow(repo: repo)
        #if os(macOS)
        label.tag(repo.name)
        #else
        if admin.editsRepos {
            NavigationLink {
                RepoSettingsDetail(admin: admin, name: repo.name)
            } label: {
                label
            }
        } else {
            label
        }
        #endif
    }

    @ViewBuilder
    private var placeholder: some View {
        if admin.repos.isEmpty {
            if admin.isLoading {
                ProgressView()
            } else if admin.failure == nil {
                ContentUnavailableView {
                    Label(RepoText.empty, systemImage: RepoText.repoSymbol)
                } description: {
                    Text(RepoText.emptyHint)
                } actions: {
                    Button(RepoText.add) { adding = true }
                        .buttonStyle(.borderedProminent)
                }
            }
        }
    }

    #if os(macOS)
    @ViewBuilder
    private var detail: some View {
        if let selection {
            if admin.editsRepos {
                RepoSettingsDetail(admin: admin, name: selection) { self.selection = nil }
                    .id(selection)
            } else {
                ContentUnavailableView(selection, systemImage: RepoText.repoSymbol, description: Text(RepoText.readOnly))
            }
        } else {
            ContentUnavailableView(RepoText.pick, systemImage: RepoText.repoSymbol)
        }
    }
    #endif
}

// MARK: - Ligne

/// Les repères d'un dépôt, sans phrase : branche, fusion, juge des tests, modèles locaux.
struct RepoBadges: View {
    let branch: String?
    let merge: String?
    let judge: String?
    let localOnly: Bool

    var body: some View {
        HStack(spacing: 10) {
            if let branch {
                Label(branch, systemImage: RepoText.branchSymbol)
                    .lineLimit(1)
                    .labelStyle(.titleAndIcon)
            }
            if let merge {
                glyph(merge == "gh" ? RepoText.pullRequestSymbol : RepoText.localMergeSymbol, RepoText.mergeName(merge))
            }
            if let judge {
                glyph(judge == "ci" ? RepoText.ciSymbol : RepoText.serverJudgeSymbol, RepoText.tests + " · " + RepoText.judgeName(judge))
            }
            if localOnly {
                glyph(RepoText.localOnlySymbol, RepoText.localOnly)
            }
        }
    }

    private func glyph(_ symbol: String, _ meaning: String) -> some View {
        Image(systemName: symbol)
            .help(meaning)
            .accessibilityLabel(meaning)
    }
}

/// Une ligne de la liste : la forge, le nom et ses repères ; dessous, la branche et l'espace. Tout vient de
/// `GET /v1/repos` : la liste ne lit pas chaque dépôt.
struct RepoRow: View {
    let repo: HarnessServedRepo

    var body: some View {
        HStack(spacing: 12) {
            forgeGlyph
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(repo.name)
                        .font(.headline)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    RepoBadges(
                        branch: nil, merge: repo.merge, judge: repo.judge,
                        localOnly: repo.policy?.privacy == "local-only"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                HStack(spacing: 10) {
                    if let branch = repo.mainBranch {
                        Label(branch, systemImage: RepoText.branchSymbol)
                            .foregroundStyle(.secondary)
                    }
                    if let space = repo.space {
                        Label(space, systemImage: RepoText.spaceSymbol)
                            .foregroundStyle(.tint)
                    }
                }
                .font(.caption)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
        .contentShape(.rect)
        .accessibilityElement(children: .combine)
        .consoleID("repos.row")
    }

    @ViewBuilder
    private var forgeGlyph: some View {
        let forge = repo.forge
        Image(systemName: forge.map(RepoText.forgeSymbol) ?? RepoText.repoSymbol)
            .font(.title3)
            .foregroundStyle(.secondary)
            .frame(width: 28)
            .help(forge.map(RepoText.forgeName) ?? "")
            .accessibilityLabel(forge.map(RepoText.forgeName) ?? "")
            .accessibilityHidden(forge == nil)
    }
}

// MARK: - Clé de déploiement

/// La clé PUBLIQUE à poser sur la forge : lisible, copiable, partageable, avec la page de la forge.
struct RepoDeployKeyRows: View {
    let key: HarnessDeployKey
    @State private var copied = false

    var body: some View {
        Text(key.publicKey)
            .font(.caption.monospaced())
            .textSelection(.enabled)
            .lineLimit(4)
            .truncationMode(.middle)
            .consoleID("repos.deployKey")
        Button {
            OSLocalSessionClipboard.copy(key.publicKey)
            copied = true
        } label: {
            Label(RepoText.copy, systemImage: copied ? RepoText.copiedSymbol : RepoText.copySymbol)
                .contentTransition(.symbolEffect(.replace))
        }
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: .seconds(2))
            copied = false
        }
        ShareLink(item: key.publicKey)
        if let page = key.url.flatMap(URL.init(string:)) {
            Link(destination: page) {
                Label(RepoText.openForge, systemImage: RepoText.openSymbol)
            }
        }
    }
}

// MARK: - Ajout

/// La feuille d'ajout : l'adresse, un nom court facultatif ; la clé à poser si la forge refuse.
struct RepoAddSheet: View {
    @ObservedObject var admin: HarnessAdmin
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var name = ""
    @State private var reply: HarnessRepoDeclared?
    @State private var attempted = false
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Form {
                if attempted, let failure = admin.failure {
                    Section { ConsoleFailureBanner(failure: failure) }
                }
                Section {
                    TextField(RepoText.address, text: $url, prompt: Text(ControlText.repoURLPrompt))
                        .consolePlainInput()
                        #if os(iOS)
                        .keyboardType(.URL)
                        #endif
                        .focused($focused)
                        .onSubmit(declare)
                        .consoleID("repos.add.url")
                    TextField(RepoText.shortName, text: $name, prompt: Text(RepoText.optional))
                        .consolePlainInput()
                        .onSubmit(declare)
                        .consoleID("repos.add.name")
                }
                if let reply, !reply.added {
                    if let key = reply.deployKey {
                        Section {
                            RepoDeployKeyRows(key: key)
                        } header: {
                            Label(RepoText.deployKey, systemImage: RepoText.deployKeySymbol)
                        } footer: {
                            Text(RepoText.deployKeyHint)
                        }
                    } else if !reply.message.isEmpty {
                        Section {
                            Label(reply.message, systemImage: RepoText.repoSymbol)
                                .consoleReadable()
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(RepoText.addTitle)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(RepoText.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if admin.isSaving {
                        ProgressView()
                    } else if let reply, !reply.added, reply.deployKey == nil {
                        Button(RepoText.done) { dismiss() }
                    } else {
                        Button(reply?.deployKey == nil ? RepoText.declare : RepoText.retry, action: declare)
                            .disabled(url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            .consoleID("repos.add.confirm")
                    }
                }
            }
            .onAppear { focused = true }
        }
        #if os(macOS)
        .frame(minWidth: 480, minHeight: 280)
        #endif
    }

    private func declare() {
        guard !admin.isSaving, !url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        attempted = true
        Task {
            guard let declared = await admin.declareRepo(url: url, name: name) else { return }
            if declared.added {
                dismiss()
            } else {
                reply = declared
            }
        }
    }
}

// MARK: - Réglages d'un dépôt

/// Les réglages d'un dépôt, écrits dès qu'ils changent.
struct RepoSettingsDetail: View {
    @ObservedObject var admin: HarnessAdmin
    let name: String
    /// Le dépôt vient d'être retiré (Mac : la liste choisit le suivant).
    var onRemoved: () -> Void = {}

    #if os(iOS)
    @Environment(\.dismiss) private var dismiss
    #endif
    @State private var branch = ""
    @State private var scope = ""
    @State private var gitName = ""
    @State private var gitEmail = ""
    /// 0 : sans limite.
    @State private var parallel = 0
    @State private var timeoutMinutes = 60
    @State private var showsCommands = false
    @State private var confirmsRemoval = false
    @FocusState private var focus: Field?

    private enum Field { case branch, scope, gitName, gitEmail }

    /// Les niveaux de modèles, du plus rapide au plus approfondi.
    private static let tiers = ["fast", "standard", "heavy"]

    private var reply: HarnessRepoSettingsReply? { admin.repoSettings[name] }
    private var isSaving: Bool { admin.savingRepos.contains(name) }

    var body: some View {
        Group {
            if let reply {
                form(reply.repo, spaces: reply.spaces)
            } else if let failure = admin.failure {
                ContentUnavailableView {
                    Label(name, systemImage: RepoText.repoSymbol)
                } description: {
                    Text(failure.message)
                } actions: {
                    Button(RepoText.retry, systemImage: RepoText.retrySymbol) {
                        Task { await admin.loadRepo(name) }
                    }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        #if os(iOS)
        .navigationTitle(name)
        .navigationBarTitleDisplayMode(.inline)
        #endif
        .task(id: name) { await admin.loadRepo(name) }
        .onChange(of: reply?.repo, initial: true) { sync() }
        .onChange(of: focus) { old, _ in commitField(old) }
        .task(id: parallel) {
            guard await settle(), let repo = reply?.repo, (repo.maxParallel ?? 0) != parallel else { return }
            commit(HarnessRepoSettingsPatch(maxParallel: parallel == 0 ? .reset : .value(parallel)))
        }
        .task(id: timeoutMinutes) {
            guard await settle(), let repo = reply?.repo, Self.minutes(repo) != timeoutMinutes else { return }
            commit(HarnessRepoSettingsPatch(ciTimeoutSec: .value(timeoutMinutes * 60)))
        }
        .confirmationDialog(RepoText.removeConfirm(name), isPresented: $confirmsRemoval, titleVisibility: .visible) {
            Button(RepoText.removeAction, role: .destructive) { remove() }
        } message: {
            Text(RepoText.removeMessage)
        }
    }

    private func form(_ repo: HarnessRepoSettings, spaces: [String]) -> some View {
        Form {
            if let failure = admin.failure {
                Section { ConsoleFailureBanner(failure: failure) }
            }
            Section { hero(repo) }
            generalSection(repo, spaces: spaces)
            forgeSection(repo)
            testsSection(repo)
            privacySection(repo)
            issuesSection(repo)
            gitSection
            accessSection(repo)
            Section {
                Button(role: .destructive) {
                    confirmsRemoval = true
                } label: {
                    Label(RepoText.remove, systemImage: RepoText.removeSymbol)
                }
                .disabled(!spaces.isEmpty || isSaving)
                .consoleID("repos.remove")
            } footer: {
                if let space = spaces.first { Text(RepoText.removeHeld(space)) }
            }
        }
        .formStyle(.grouped)
    }

    private func hero(_ repo: HarnessRepoSettings) -> some View {
        HStack(spacing: 14) {
            Image(systemName: RepoText.forgeSymbol(repo.forgeInUse))
                .font(.largeTitle)
                .foregroundStyle(.tint)
                .frame(width: 48)
                .accessibilityLabel(RepoText.forgeName(repo.forgeInUse))
            VStack(alignment: .leading, spacing: 4) {
                Text(repo.name)
                    .font(.title2.bold())
                    .lineLimit(1)
                RepoBadges(
                    branch: repo.mainBranch, merge: repo.merge, judge: repo.tests.judge,
                    localOnly: repo.privacy == "local-only"
                )
                .font(.callout)
                .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if isSaving {
                ProgressView()
                    .controlSize(.small)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: Sections

    private func generalSection(_ repo: HarnessRepoSettings, spaces: [String]) -> some View {
        Section(RepoText.general) {
            LabeledContent {
                TextField(RepoText.branch, text: $branch, prompt: Text(repo.mainBranch))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .consolePlainInput()
                    .focused($focus, equals: .branch)
                    .onSubmit { commitField(.branch) }
                    .consoleID("repos.branch")
            } label: {
                Label(RepoText.branch, systemImage: RepoText.branchSymbol)
            }
            LabeledContent {
                TextField(RepoText.memory, text: $scope, prompt: Text(repo.name))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .consolePlainInput()
                    .focused($focus, equals: .scope)
                    .onSubmit { commitField(.scope) }
                    .consoleID("repos.scope")
            } label: {
                Label(RepoText.memory, systemImage: RepoText.memorySymbol)
            }
            LabeledContent {
                Stepper(value: $parallel, in: 0...32) {
                    if parallel == 0 {
                        Text(RepoText.unlimited)
                    } else {
                        Text(parallel, format: .number).monospacedDigit()
                    }
                }
                .fixedSize()
                .consoleID("repos.parallel")
            } label: {
                Label(RepoText.parallel, systemImage: RepoText.parallelSymbol)
            }
            if !spaces.isEmpty {
                LabeledContent {
                    Text(spaces.joined(separator: ", "))
                } label: {
                    Label(RepoText.space, systemImage: RepoText.spaceSymbol)
                }
            }
        }
    }

    private func forgeSection(_ repo: HarnessRepoSettings) -> some View {
        let noForge = repo.forgeInUse == "none"
        let needsForge = repo.merge == "gh" || repo.tests.judge == "ci"
        return Section(RepoText.forgeSection) {
            Picker(selection: binding(repo.forge ?? "auto") { HarnessRepoSettingsPatch(forge: $0 == "auto" ? .reset : .value($0)) }) {
                Text(repo.forge == nil ? RepoText.forgeAuto(repo.forgeInUse) : RepoText.auto).tag("auto")
                ForEach(["github", "gitlab", "none"], id: \.self) { forge in
                    Label(RepoText.forgeName(forge), systemImage: RepoText.forgeSymbol(forge))
                        .tag(forge)
                        .disabled(forge == "none" && needsForge)
                }
            } label: {
                Label(RepoText.forge, systemImage: RepoText.forgeSymbol(repo.forgeInUse))
            }
            .consoleID("repos.forge")
            Picker(selection: binding(repo.merge) { HarnessRepoSettingsPatch(merge: .value($0)) }) {
                Label(RepoText.mergeRequest, systemImage: RepoText.pullRequestSymbol)
                    .tag("gh")
                    .disabled(noForge)
                Label(RepoText.mergeLocal, systemImage: RepoText.localMergeSymbol)
                    .tag("local")
            } label: {
                Label(RepoText.merge, systemImage: repo.merge == "gh" ? RepoText.pullRequestSymbol : RepoText.localMergeSymbol)
            }
            .consoleSegmented()
            .consoleID("repos.merge")
        }
    }

    private func testsSection(_ repo: HarnessRepoSettings) -> some View {
        Section(RepoText.tests) {
            Picker(selection: binding(repo.tests.judge) { HarnessRepoSettingsPatch(judge: .value($0)) }) {
                Label(RepoText.judgeServer, systemImage: RepoText.serverJudgeSymbol)
                    .tag("local")
                Label(RepoText.judgeCI, systemImage: RepoText.ciSymbol)
                    .tag("ci")
                    .disabled(repo.forgeInUse == "none")
            } label: {
                Label(RepoText.judge, systemImage: RepoText.testsSymbol)
            }
            .consoleSegmented()
            .consoleID("repos.judge")
            if repo.tests.judge == "ci" {
                LabeledContent {
                    Stepper(value: $timeoutMinutes, in: 5...240, step: 5) {
                        Text(RepoText.minutes(timeoutMinutes)).monospacedDigit()
                    }
                    .fixedSize()
                    .consoleID("repos.ciTimeout")
                } label: {
                    Label(RepoText.ciTimeout, systemImage: RepoText.timeoutSymbol)
                }
            }
            DisclosureGroup(isExpanded: $showsCommands) {
                command(RepoText.touched, RepoText.commandSymbol, repo.tests.touched)
                command(RepoText.fullSuite, RepoText.commandSymbol, repo.tests.full)
                if let pattern = repo.tests.pattern {
                    command(RepoText.pattern, RepoText.patternSymbol, pattern)
                }
                ForEach(repo.checks.keys.sorted(), id: \.self) { check in
                    command(check, RepoText.checkSymbol, repo.checks[check] ?? "")
                }
                if let image = repo.testImage {
                    command(RepoText.testImage, RepoText.testImageSymbol, image)
                }
                if repo.preview {
                    Label(RepoText.preview, systemImage: RepoText.previewSymbol)
                }
            } label: {
                Label(RepoText.commands, systemImage: RepoText.commandsSymbol)
            }
            .consoleID("repos.commands")
        }
    }

    private func command(_ title: String, _ symbol: String, _ line: String) -> some View {
        LabeledContent {
            Text(line)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .lineLimit(3)
                .multilineTextAlignment(.trailing)
        } label: {
            Label(title, systemImage: symbol)
        }
    }

    private func privacySection(_ repo: HarnessRepoSettings) -> some View {
        Section(RepoText.privacySection) {
            Toggle(isOn: binding(repo.privacy == "local-only") { HarnessRepoSettingsPatch(privacy: $0 ? .value("local-only") : .reset) }) {
                Label(RepoText.localOnly, systemImage: RepoText.localOnlySymbol)
            }
            .consoleID("repos.localOnly")
            LabeledContent {
                Text(repo.providers.map { $0.joined(separator: ", ") } ?? RepoText.serverDefault)
            } label: {
                Label(RepoText.providers, systemImage: RepoText.providersSymbol)
            }
            if let models = repo.models {
                ForEach(Self.tiers.filter { models[$0] != nil }, id: \.self) { tier in
                    command(PipelineServerText.tier(tier), RepoText.modelsSymbol, (models[tier] ?? []).joined(separator: " › "))
                }
            } else {
                LabeledContent {
                    Text(RepoText.serverDefault)
                } label: {
                    Label(RepoText.models, systemImage: RepoText.modelsSymbol)
                }
            }
            if repo.providers != nil || repo.models != nil {
                Button(RepoText.useServerDefault, systemImage: RepoText.retrySymbol) {
                    commit(HarnessRepoSettingsPatch(providers: .reset, models: .reset))
                }
                .disabled(isSaving)
            }
        }
    }

    private func issuesSection(_ repo: HarnessRepoSettings) -> some View {
        Section(RepoText.issues) {
            Picker(selection: binding(repo.corporate) { HarnessRepoSettingsPatch(corporate: .value($0)) }) {
                ForEach(["forbid", "redacted", "full"], id: \.self) { policy in
                    Label(RepoText.corporateName(policy), systemImage: RepoText.corporateSymbol(policy))
                        .tag(policy)
                }
            } label: {
                Label(RepoText.corporate, systemImage: RepoText.corporateSectionSymbol)
            }
            .consoleID("repos.corporate")
            Toggle(isOn: binding(repo.atlassian) { HarnessRepoSettingsPatch(atlassian: $0 ? .value(true) : .reset) }) {
                Label(RepoText.atlassian, systemImage: RepoText.atlassianSymbol)
            }
            .consoleID("repos.atlassian")
        }
    }

    private var gitSection: some View {
        Section(RepoText.gitSection) {
            LabeledContent {
                TextField(RepoText.gitName, text: $gitName, prompt: Text(RepoText.gitDefault))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .focused($focus, equals: .gitName)
                    .onSubmit { commitField(.gitName) }
                    .consoleID("repos.gitName")
            } label: {
                Label(RepoText.gitName, systemImage: RepoText.gitNameSymbol)
            }
            LabeledContent {
                TextField(RepoText.gitEmail, text: $gitEmail, prompt: Text(RepoText.gitDefault))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .consolePlainInput()
                    #if os(iOS)
                    .keyboardType(.emailAddress)
                    #endif
                    .focused($focus, equals: .gitEmail)
                    .onSubmit { commitField(.gitEmail) }
                    .consoleID("repos.gitEmail")
            } label: {
                Label(RepoText.gitEmail, systemImage: RepoText.gitEmailSymbol)
            }
        }
    }

    @ViewBuilder
    private func accessSection(_ repo: HarnessRepoSettings) -> some View {
        if repo.remoteUrl != nil || repo.deployKey != nil {
            Section(RepoText.access) {
                if let remote = repo.remoteUrl {
                    command(RepoText.remote, RepoText.remoteSymbol, remote)
                }
                if let key = repo.deployKey {
                    Label(RepoText.deployKey, systemImage: RepoText.deployKeySymbol)
                    RepoDeployKeyRows(key: key)
                }
            }
        }
    }

    // MARK: Écriture

    /// Un contrôle lié au réglage en vigueur : le changer écrit son patch.
    private func binding<Value: Equatable>(_ current: Value, _ patch: @escaping (Value) -> HarnessRepoSettingsPatch) -> Binding<Value> {
        Binding(
            get: { current },
            set: { value in if value != current { commit(patch(value)) } }
        )
    }

    private func commit(_ patch: HarnessRepoSettingsPatch) {
        Task { await admin.updateRepo(name, patch) }
    }

    /// Un champ de texte quitté ou validé : il s'écrit s'il a changé.
    private func commitField(_ field: Field?) {
        guard let field, let repo = reply?.repo else { return }
        switch field {
        case .branch:
            let value = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            if value.isEmpty { branch = repo.mainBranch } else if value != repo.mainBranch { commit(HarnessRepoSettingsPatch(mainBranch: value)) }
        case .scope:
            let value = scope.trimmingCharacters(in: .whitespacesAndNewlines)
            if value != repo.scope { commit(HarnessRepoSettingsPatch(scope: value.isEmpty ? .reset : .value(value))) }
        case .gitName, .gitEmail:
            let identity = HarnessGitIdentity(
                name: gitName.trimmingCharacters(in: .whitespacesAndNewlines),
                email: gitEmail.trimmingCharacters(in: .whitespacesAndNewlines)
            )
            if identity.name.isEmpty, identity.email.isEmpty {
                if repo.git != nil { commit(HarnessRepoSettingsPatch(git: .reset)) }
            } else if !identity.name.isEmpty, !identity.email.isEmpty, identity != repo.git {
                commit(HarnessRepoSettingsPatch(git: .value(identity)))
            }
        }
    }

    /// Une courte pause pour qu'un compteur cliqué plusieurs fois n'écrive qu'une fois ; faux si
    /// la valeur a encore changé entre-temps.
    private func settle() async -> Bool {
        do {
            try await Task.sleep(for: .milliseconds(700))
            return true
        } catch {
            return false
        }
    }

    /// Les champs suivent les réglages en vigueur, sauf celui en cours de saisie.
    private func sync() {
        guard let repo = reply?.repo else { return }
        if focus != .branch { branch = repo.mainBranch }
        if focus != .scope { scope = repo.scope }
        if focus != .gitName { gitName = repo.git?.name ?? "" }
        if focus != .gitEmail { gitEmail = repo.git?.email ?? "" }
        parallel = repo.maxParallel ?? 0
        timeoutMinutes = Self.minutes(repo)
    }

    /// L'attente de la CI en minutes, une au moins.
    private static func minutes(_ repo: HarnessRepoSettings) -> Int {
        max(1, repo.tests.ciTimeoutSec / 60)
    }

    private func remove() {
        Task {
            guard await admin.removeRepo(name) != nil else { return }
            #if os(iOS)
            dismiss()
            #else
            onRemoved()
            #endif
        }
    }
}
