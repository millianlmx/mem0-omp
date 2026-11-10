// L'« OS agentique » : les ESPACES (un client : ses dépôts, son budget, son autonomie),
// partagés par le Mac et l'iPhone/iPad. La section du Savoir les liste — un administrateur
// les crée, les modifie et les supprime dans une feuille (nom, dépôts, poste, projets
// Jira, budget journalier, autonomie par défaut). La PAGE d'un espace montre sa semaine
// en chiffres, son budget du jour et son rapport hebdomadaire (Markdown rendu), à copier
// ou à partager. Un serveur sans espaces ne montre rien.

import ConsoleClient
import ConsoleCore
import SwiftUI

// MARK: - Section du Savoir

struct OSSpacesSection: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var spaces: HarnessSpacesModel

    @State private var editing: OSSpaceEditing?
    @State private var deleting: HarnessSpace?

    init(server: HarnessModel, workspace: OSWorkspace) {
        self.server = server
        self.workspace = workspace
        _spaces = ObservedObject(wrappedValue: server.spaces)
    }

    var body: some View {
        if spaces.availability == .available {
            Section {
                if let failure = spaces.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                if spaces.spaces.isEmpty {
                    Text(OSWatchText.noSpace).foregroundStyle(.secondary)
                }
                ForEach(spaces.spaces) { space in
                    row(space)
                }
            } header: {
                HStack {
                    Text(OSWatchText.spaces)
                    Spacer()
                    if server.osManagesSpaces {
                        Button(OSWatchText.add, systemImage: "plus") { editing = OSSpaceEditing(space: nil) }
                            .osBorderless()
                    }
                }
                .sheet(item: $editing) { editing in
                    OSSpaceSheet(server: server, space: editing.space)
                }
                .confirmationDialog(OSWatchText.deleteSpace, isPresented: confirmingDelete, titleVisibility: .visible, presenting: deleting) { space in
                    Button(OSWatchText.delete, role: .destructive) {
                        Task { await spaces.delete(space) }
                    }
                } message: { space in
                    Text(space.name)
                }
            }
        }
    }

    private var confirmingDelete: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { shown in if !shown { deleting = nil } })
    }

    /// Ce que l'espace réunit tient sur une ligne sur le Mac, sur deux sur l'iPhone et l'iPad.
    #if os(macOS)
    private static let summaryLines = 1
    #else
    private static let summaryLines = 2
    #endif

    /// Un espace : son nom, ce qu'il réunit ; un clic ouvre sa page.
    private func row(_ space: HarnessSpace) -> some View {
        let busy = spaces.busy.contains(space.id)
        return HStack(spacing: 10) {
            Button {
                workspace.selection = OSWorkspace.space(space.id)
            } label: {
                HStack(spacing: 10) {
                    Image(systemName: "building.2")
                        .foregroundStyle(Color.accentColor)
                        .frame(width: 22)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(space.name).fontWeight(.semibold).lineLimit(1)
                        Text(space.osSummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(Self.summaryLines)
                            .multilineTextAlignment(.leading)
                    }
                    Spacer(minLength: 8)
                }
                .frame(minHeight: ConsolePlatform.minimumTarget)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            if busy { ProgressView().controlSize(.small) }
            if server.osManagesSpaces {
                Menu {
                    Button(OSWatchText.edit, systemImage: "pencil") { editing = OSSpaceEditing(space: space) }
                    Button(OSWatchText.delete, systemImage: "trash", role: .destructive) { deleting = space }
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .frame(minWidth: ConsolePlatform.minimumTarget, minHeight: ConsolePlatform.minimumTarget)
                        .accessibilityLabel(OSDecideText.more)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(busy)
            }
            Image(systemName: "chevron.right")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
        .padding(.vertical, 2)
    }
}

/// La feuille ouverte : un espace à créer (`nil`) ou à modifier.
struct OSSpaceEditing: Identifiable {
    let space: HarnessSpace?

    var id: String { space?.id ?? "" }
}

extension HarnessSpace {
    /// « 2 dépôts · 20,00 $ par jour · Tout me demander » : ce que l'espace réunit.
    var osSummary: String {
        var parts = [OSWatchText.repos(repos.count)]
        if poste { parts.append(OSText.poste) }
        if let dailyBudgetUsd { parts.append(OSWatchText.perDay(dailyBudgetUsd)) }
        parts.append(OSWatchText.autonomy(autonomy?.rawValue))
        return parts.joined(separator: " · ")
    }
}

extension HarnessModel {
    /// Le jeton voit tous les dépôts : le serveur lui dit le budget d'un espace. Un client
    /// borné à des dépôts n'en reçoit ni le plafond ni le reste : rien ne s'affiche.
    var osSeesBudgets: Bool { client?.repos == nil }

    /// Créer, modifier, supprimer un espace : l'administrateur non borné (une saisie sans le
    /// budget réel l'effacerait).
    var osManagesSpaces: Bool { isAdmin && osSeesBudgets }
}

// MARK: - Feuille d'un espace

/// La saisie du budget : vide (aucun plafond), un montant, ou un texte qui n'en est pas un.
enum OSSpaceBudget: Equatable {
    case none
    case amount(Double)
    case invalid

    /// Lit un montant saisi, virgule ou point ; seul un montant positif est un plafond.
    static func parse(_ text: String) -> OSSpaceBudget {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return .none }
        guard let value = Double(trimmed.replacingOccurrences(of: ",", with: ".")), value.isFinite, value > 0 else { return .invalid }
        return .amount(value)
    }
}

/// Créer ou modifier un espace (administrateur).
struct OSSpaceSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var spaces: HarnessSpacesModel
    let space: HarnessSpace?
    @State private var draft: HarnessSpaceDraft
    @State private var budget: String
    @State private var jira: String
    @Environment(\.dismiss) private var dismiss

    init(server: HarnessModel, space: HarnessSpace?) {
        self.server = server
        _spaces = ObservedObject(wrappedValue: server.spaces)
        self.space = space
        _draft = State(initialValue: space.map(HarnessSpaceDraft.init) ?? HarnessSpaceDraft())
        _budget = State(initialValue: space?.dailyBudgetUsd.map { String(format: "%g", $0) } ?? "")
        _jira = State(initialValue: space?.jiraProjects.joined(separator: ", ") ?? "")
    }

    /// La saisie telle qu'elle partira, ou `nil` tant qu'elle ne peut pas partir.
    private var sendable: HarnessSpaceDraft? {
        var sent = draft
        switch OSSpaceBudget.parse(budget) {
        case .none: sent.dailyBudgetUsd = nil
        case let .amount(value): sent.dailyBudgetUsd = value
        case .invalid: return nil
        }
        sent.jiraProjects = jira.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        return sent.problem == nil ? sent : nil
    }

    var body: some View {
        NavigationStack {
            Form {
                if let failure = spaces.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                Section {
                    TextField(OSWatchText.spaceName, text: $draft.name)
                }
                Section(OSWatchText.spaceRepos) {
                    ForEach(server.repos) { repo in
                        repoToggle(repo.name)
                    }
                    Toggle(OSText.poste, isOn: $draft.poste)
                }
                Section {
                    TextField(OSWatchText.spaceJira, text: $jira, prompt: Text(OSWatchText.spaceJiraPrompt))
                    TextField(OSWatchText.spaceBudget, text: $budget, prompt: Text(OSWatchText.spaceBudgetPrompt))
                    Picker(OSWatchText.spaceAutonomy, selection: $draft.autonomy) {
                        Text(OSWatchText.autonomyRules).tag(HarnessRunAutonomy?.none)
                        Text(OSWatchText.autonomyAsk).tag(HarnessRunAutonomy?.some(.ask))
                        Text(OSWatchText.autonomyDeliver).tag(HarnessRunAutonomy?.some(.deliver))
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(space == nil ? OSWatchText.newSpace : OSWatchText.editSpace)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(OSText.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(OSWatchText.save) { save() }
                        .disabled(sendable == nil || spaces.isSaving || space.map { spaces.busy.contains($0.id) } == true)
                }
            }
        }
        .osSheetSize(width: 480, minHeight: 460)
        .task {
            if server.repos.isEmpty { await server.refreshCatalog() }
        }
    }

    /// Un dépôt de l'espace ; celui qu'un autre espace tient déjà ne se coche pas (un dépôt
    /// n'a qu'un espace), et dit lequel.
    private func repoToggle(_ name: String) -> some View {
        let owner = spaces.spaces.first { $0.repos.contains(name) && $0.id != space?.id }
        return Toggle(isOn: Binding(
            get: { draft.repos.contains(name) },
            set: { on in
                if on { draft.repos.append(name) } else { draft.repos.removeAll { $0 == name } }
            }
        )) {
            HStack(spacing: 6) {
                Text(name)
                if let owner {
                    Text(OSWatchText.inSpace(owner.name))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .disabled(owner != nil)
    }

    private func save() {
        guard let sendable else { return }
        Task {
            let saved: Bool
            if let space {
                saved = await spaces.update(space, sendable)
            } else {
                saved = await spaces.create(sendable) != nil
            }
            if saved { dismiss() }
        }
    }
}

// MARK: - Page d'un espace

public struct OSSpacePage: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var spaces: HarnessSpacesModel
    let spaceId: String
    let copy: ((String) -> Void)?

    @State private var report: HarnessSpaceReport?
    @State private var loading = false
    @State private var copied = false
    @State private var editing: OSSpaceEditing?

    /// `copy` : le presse-papiers de la plateforme, posé par la coque ; sans lui, « Copier »
    /// n'existe pas (le partage natif reste).
    public init(server: HarnessModel, spaceId: String, copy: ((String) -> Void)? = nil) {
        self.server = server
        _spaces = ObservedObject(wrappedValue: server.spaces)
        self.spaceId = spaceId
        self.copy = copy
    }

    public var body: some View {
        // Un vrai conteneur : sa tâche relit les espaces même quand la page n'a encore rien à montrer.
        ZStack {
            if let space = spaces.spaces.first(where: { $0.id == spaceId }) {
                ScrollView {
                    VStack(alignment: .leading, spacing: 22) {
                        header(space)
                        week(space.stats)
                        if server.osSeesBudgets { budget(space) }
                        weekly
                    }
                    .frame(maxWidth: 760, alignment: .leading)
                    .osPagePadding(28)
                    .frame(maxWidth: .infinity)
                }
                .navigationTitle(space.name)
                // Le rapport se relit quand l'espace change (ses dépôts font le rapport).
                .task(id: "\(space.id)/\(space.rev)") {
                    loading = true
                    report = await spaces.report(space)
                    loading = false
                }
                .sheet(item: $editing) { editing in
                    OSSpaceSheet(server: server, space: editing.space)
                }
            } else if spaces.availability == .available {
                ContentUnavailableView(OSWatchText.noSpace, systemImage: "building.2")
            }
        }
        .task(id: server.address) { await spaces.refresh() }
    }

    /// Le nom, ce que l'espace réunit en étiquettes, ce qui y vit maintenant.
    private func header(_ space: HarnessSpace) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            // Sur l'iPhone et l'iPad, le nom de l'espace est le titre de la barre.
            #if os(macOS)
            HStack(alignment: .firstTextBaseline) {
                Text(space.name).font(.largeTitle.weight(.bold))
                Spacer(minLength: 0)
                if server.osManagesSpaces {
                    Button(OSWatchText.edit, systemImage: "pencil") { editing = OSSpaceEditing(space: space) }
                }
            }
            #else
            if server.osManagesSpaces {
                Button(OSWatchText.edit, systemImage: "pencil") { editing = OSSpaceEditing(space: space) }
                    .osRowButton()
            }
            #endif
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(space.repos, id: \.self) { repo in
                        OSTag(text: repo, symbol: "shippingbox", tint: .accentColor)
                    }
                    if space.poste { OSTag(text: OSText.poste, symbol: "globe") }
                    ForEach(space.jiraProjects, id: \.self) { project in
                        OSTag(text: project, symbol: "list.bullet.clipboard")
                    }
                    OSTag(text: OSWatchText.autonomy(space.autonomy?.rawValue), symbol: "dial.medium")
                }
            }
            OSLine(spacing: 6, gestures: false) {
                if space.stats.yours > 0 { OSTag(text: "\(space.stats.yours) " + OSText.phaseYours, symbol: OSPhase.yours.symbol, tint: .orange) }
                if space.stats.working > 0 { OSTag(text: "\(space.stats.working) " + OSText.phaseWorking, symbol: OSPhase.working.symbol, tint: .accentColor) }
                if space.stats.queued > 0 { OSTag(text: "\(space.stats.queued) " + OSText.phaseQueued, symbol: OSPhase.queued.symbol) }
            }
        }
    }

    /// Les chiffres de la semaine : livrées, échecs, arrêtées, coût.
    private func week(_ stats: HarnessSpaceStats) -> some View {
        section(OSText.sectionWeek) {
            HStack(spacing: 10) {
                OSTile(value: "\(stats.mergedWeek)", label: OSWatchText.weekDelivered, tint: stats.mergedWeek > 0 ? .green : .secondary)
                OSTile(value: "\(stats.failedWeek)", label: OSWatchText.weekFailed, tint: stats.failedWeek > 0 ? .red : .secondary)
                OSTile(value: "\(stats.cancelledWeek)", label: OSWatchText.weekStopped, tint: .secondary)
                OSTile(value: MonitoringText.cost(stats.costWeek), label: OSWatchText.weekCost)
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// Le budget du jour : la dépense sur le plafond et ce qu'il en reste ; sans plafond, la dépense seule.
    private func budget(_ space: HarnessSpace) -> some View {
        section(OSWatchText.budgetToday) {
            if let ceiling = space.dailyBudgetUsd {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: min(max(space.stats.costToday, 0), ceiling), total: ceiling)
                        .tint(space.stats.costToday >= ceiling ? .red : .accentColor)
                    HStack {
                        Text(OSWatchText.budgetUse(spent: space.stats.costToday, ceiling: ceiling))
                        Spacer()
                        if let left = space.stats.budgetLeftToday {
                            Text(OSWatchText.budgetLeft(left)).foregroundStyle(.secondary)
                        }
                    }
                    .font(.callout.monospacedDigit())
                }
            } else {
                Text(OSText.today(space.stats.costToday) + " · " + OSWatchText.spaceBudgetPrompt)
                    .font(.callout.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Le rapport hebdomadaire, rendu ; « Copier » et le partage natif portent son texte.
    private var weekly: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Text(OSWatchText.weeklyReport.uppercased())
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
                Spacer()
                if let text = report?.text, !text.isEmpty {
                    if let copy {
                        Button(copied ? OSWatchText.copied : OSWatchText.copy, systemImage: copied ? "checkmark" : "doc.on.doc") {
                            copy(text)
                            copied = true
                        }
                    }
                    ShareLink(item: text) {
                        Label(OSWatchText.share, systemImage: "square.and.arrow.up")
                    }
                }
            }
            .osBorderless()
            if let text = report?.text, !text.isEmpty {
                OSCard {
                    ConsoleMarkdown(markdown: text)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            } else if loading {
                ProgressView().controlSize(.small)
            } else {
                Text(OSWatchText.noReport).foregroundStyle(.secondary)
            }
        }
        .onChange(of: report?.text) { copied = false }
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            content()
        }
    }
}
