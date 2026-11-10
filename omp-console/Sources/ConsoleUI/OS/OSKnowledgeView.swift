// L'« OS agentique » : le SAVOIR, partagé par le Mac et l'iPhone/iPad — ce que l'OS sait
// et applique sans qu'on le lui redise. Les consignes permanentes (liste, interrupteur,
// modifier, supprimer, ajouter), les paliers d'autonomie par dépôt (règles en phrases,
// confiance, propositions à appliquer), les espaces (créer, modifier, supprimer ; chacun
// ouvre sa page), puis la mémoire et l'interface classique, que la coque ouvre. Chaque
// partie que le serveur ne sert pas est absente, sans rien dire.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSKnowledgeView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workspace: OSWorkspace
    let openMemory: (() -> Void)?
    let openClassic: (() -> Void)?

    /// `openMemory`, `openClassic` : ce que la coque sait ouvrir (l'écran de la mémoire,
    /// l'interface classique) ; sans geste, la ligne n'existe pas.
    public init(
        server: HarnessModel, workspace: OSWorkspace, openMemory: (() -> Void)? = nil, openClassic: (() -> Void)? = nil
    ) {
        self.server = server
        self.workspace = workspace
        self.openMemory = openMemory
        self.openClassic = openClassic
    }

    public var body: some View {
        Form {
            OSKnowledgeRules(server: server)
            OSKnowledgeTiers(server: server)
            OSSpacesSection(server: server, workspace: workspace)
            if openMemory != nil || openClassic != nil {
                Section {
                    if let openMemory {
                        link(OSWatchText.memory, symbol: "brain", action: openMemory)
                    }
                    if let openClassic {
                        link(OSText.classic, symbol: "sidebar.left", action: openClassic)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .navigationTitle(OSWatchText.knowledge)
        .task(id: server.address) {
            await server.rules.refresh()
            await server.autonomy.refresh()
            // La confiance d'un dépôt se lit sur la semaine, quelle que soit la dernière fenêtre lue.
            await server.scoreboard.refresh(days: HarnessScoreboardModel.defaultDays)
            await server.spaces.refresh()
            if server.repos.isEmpty { await server.refreshCatalog() }
        }
    }

    private func link(_ title: String, symbol: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .foregroundStyle(Color.accentColor)
                    .frame(width: 22)
                Text(title)
                Spacer()
                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Consignes permanentes

/// Les consignes permanentes : ce que chaque agent lit à chaque étape.
struct OSKnowledgeRules: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var rules: HarnessStandingRulesModel

    /// La feuille ouverte : une consigne à écrire (`nil`) ou à modifier.
    private struct Editing: Identifiable {
        let rule: HarnessStandingRule?

        var id: String { rule?.id ?? "" }
    }

    @State private var editing: Editing?
    @State private var deleting: HarnessStandingRule?

    init(server: HarnessModel) {
        self.server = server
        _rules = ObservedObject(wrappedValue: server.rules)
    }

    var body: some View {
        if rules.availability == .available {
            Section {
                if let failure = rules.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                if rules.rules.isEmpty {
                    Text(OSWatchText.noRule).foregroundStyle(.secondary)
                }
                ForEach(rules.rules) { rule in
                    row(rule)
                }
            } header: {
                HStack {
                    Text(OSWatchText.standingRules)
                    Spacer()
                    Button(OSWatchText.add, systemImage: "plus") { editing = Editing(rule: nil) }
                        .buttonStyle(.borderless)
                        .disabled(!server.canAct)
                }
                .sheet(item: $editing) { editing in
                    OSRuleSheet(server: server, rule: editing.rule)
                }
                .confirmationDialog(OSWatchText.deleteRule, isPresented: confirmingDelete, titleVisibility: .visible, presenting: deleting) { rule in
                    Button(OSWatchText.delete, role: .destructive) {
                        Task { await rules.remove(rule) }
                    }
                } message: { rule in
                    Text(rule.text)
                }
            }
        }
    }

    private var confirmingDelete: Binding<Bool> {
        Binding(get: { deleting != nil }, set: { shown in if !shown { deleting = nil } })
    }

    /// Une consigne : son texte, où elle vaut et d'où elle vient, ses gestes, son interrupteur.
    private func row(_ rule: HarnessStandingRule) -> some View {
        let busy = rules.busy.contains(rule.id)
        return HStack(alignment: .center, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(rule.text)
                    .foregroundStyle(rule.enabled ? .primary : .secondary)
                    .lineLimit(4)
                    .osSelectable()
                Text((rule.repo ?? OSWatchText.ruleEverywhere) + " · " + OSWatchText.ruleOrigin(rule.source))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            if busy { ProgressView().controlSize(.small) }
            Menu {
                Button(OSWatchText.edit, systemImage: "pencil") { editing = Editing(rule: rule) }
                Button(OSWatchText.delete, systemImage: "trash", role: .destructive) { deleting = rule }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(busy || !server.canAct)
            Toggle(rule.text, isOn: Binding(
                get: { rule.enabled },
                set: { enabled in Task { await rules.update(rule, enabled: enabled) } }
            ))
            .labelsHidden()
            .toggleStyle(.switch)
            .controlSize(.small)
            .disabled(busy || !server.canAct)
        }
        .padding(.vertical, 2)
    }
}

/// La feuille d'une consigne : son texte, et à l'écriture le dépôt où elle vaut (ou partout).
struct OSRuleSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var rules: HarnessStandingRulesModel
    let rule: HarnessStandingRule?
    @State private var text: String
    @State private var repo: String?
    @Environment(\.dismiss) private var dismiss

    init(server: HarnessModel, rule: HarnessStandingRule?) {
        self.server = server
        _rules = ObservedObject(wrappedValue: server.rules)
        self.rule = rule
        _text = State(initialValue: rule?.text ?? "")
        _repo = State(initialValue: rule?.repo)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private var canSave: Bool {
        !trimmed.isEmpty && trimmed.count <= HarnessStandingRulesModel.maxTextLength && trimmed != rule?.text
    }

    var body: some View {
        NavigationStack {
            Form {
                if let failure = rules.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                TextField(OSWatchText.rulePrompt, text: $text, axis: .vertical)
                    .lineLimit(3...8)
                // Le dépôt d'une consigne ne change plus une fois écrite.
                if rule == nil {
                    Picker(OSWatchText.ruleRepo, selection: $repo) {
                        Text(OSText.everywhere).tag(String?.none)
                        ForEach(server.repos) { repo in
                            Text(repo.name).tag(String?.some(repo.name))
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(rule == nil ? OSWatchText.newRule : OSWatchText.editRule)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(OSText.cancel) { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(OSWatchText.save) { save() }
                        .disabled(!canSave || rules.isSaving)
                }
            }
        }
        .osSheetSize(width: 460, minHeight: 260)
    }

    private func save() {
        Task {
            let saved: Bool
            if let rule {
                saved = await rules.update(rule, text: trimmed)
            } else {
                saved = await rules.create(text: trimmed, repo: repo) != nil
            }
            if saved { dismiss() }
        }
    }
}

// MARK: - Paliers d'autonomie

/// Ce qu'une règle de palier laisse valider seul, en une phrase, et ses conditions.
public struct OSTierPhrase: Identifiable, Equatable, Sendable {
    /// Le rang de la règle dans son dépôt, à partir de 0.
    public var id: Int
    /// « Bogue : specs validées seules ».
    public var text: String
    /// « 50 lignes de différences au plus · Exige : suite complète verte », ou `nil`.
    public var conditions: String?
}

public enum OSTiers {
    /// Les règles d'un dépôt en phrases, dans leur ordre.
    public static func phrases(_ rules: [HarnessAutonomyRule]) -> [OSTierPhrase] {
        rules.enumerated().map { index, rule in
            var conditions: [String] = []
            if let lines = rule.match.maxDiffLines { conditions.append(AutonomyText.maxDiffLines(lines)) }
            if let paths = rule.match.paths, !paths.isEmpty { conditions.append(AutonomyText.paths(paths.joined(separator: ", "))) }
            if let labels = rule.match.labels, !labels.isEmpty { conditions.append(AutonomyText.labels(labels.joined(separator: ", "))) }
            if let required = rule.require.summary { conditions.append(required) }
            return OSTierPhrase(
                id: index,
                text: OSWatchText.tier(
                    kind: AutonomyText.kind(rule.match.kind),
                    specsAlone: rule.gates.specs == HarnessAutonomyMode.auto.rawValue,
                    reviewAlone: rule.gates.review == HarnessAutonomyMode.auto.rawValue
                ),
                conditions: conditions.isEmpty ? nil : conditions.joined(separator: " · ")
            )
        }
    }

    /// Ce qu'« Appliquer » écrit pour une proposition de palier : le type, la porte et le
    /// mode (monter : le serveur valide seul ; rendre : l'humain valide). `nil` quand un
    /// code est inconnu de cette version de l'app.
    public static func change(of proposal: HarnessAutonomyProposal) -> (kind: HarnessWorkKind, gate: HarnessAutonomyGate, mode: HarnessAutonomyMode)? {
        guard let kind = HarnessWorkKind(rawValue: proposal.kind), let gate = HarnessAutonomyGate(rawValue: proposal.gate) else { return nil }
        switch proposal.direction {
        case "raise": return (kind, gate, .auto)
        case "lower": return (kind, gate, .human)
        default: return nil
        }
    }
}

/// Les paliers d'autonomie, dépôt par dépôt : ses règles en phrases, sa confiance (le taux
/// de réussite des chiffres), et les propositions du serveur, qu'un administrateur applique.
struct OSKnowledgeTiers: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var autonomy: HarnessAutonomy
    @ObservedObject var scores: HarnessScoreboardModel

    init(server: HarnessModel) {
        self.server = server
        _autonomy = ObservedObject(wrappedValue: server.autonomy)
        _scores = ObservedObject(wrappedValue: server.scoreboard)
    }

    var body: some View {
        if autonomy.availability == .available, let view = autonomy.view, !view.repos.isEmpty {
            Section(OSWatchText.tiers) {
                if let failure = autonomy.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                ForEach(view.repos) { repo in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Text(repo.repo).font(.headline)
                            confidence(of: repo.repo)
                            Spacer(minLength: 0)
                        }
                        let phrases = OSTiers.phrases(repo.rules)
                        if phrases.isEmpty {
                            Text(OSWatchText.tierNone).foregroundStyle(.secondary)
                        }
                        ForEach(phrases) { phrase in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(phrase.text)
                                if let conditions = phrase.conditions {
                                    Text(conditions)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                        ForEach(view.proposals.filter { $0.repo == repo.repo }) { proposal in
                            proposalRow(proposal)
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    /// La confiance d'un dépôt : son taux de réussite, et ce que le serveur suggère.
    @ViewBuilder
    private func confidence(of repo: String) -> some View {
        if let score = scores.scoreboard?.repos.first(where: { $0.repo == repo }) {
            if let rate = score.successRate {
                // Vert quand le dépôt livre presque tout ; sinon le chiffre seul, sans couleur.
                OSTag(text: OSWatchText.confidence(rate), symbol: "gauge.with.dots.needle.67percent", tint: rate >= 0.8 ? .green : .secondary)
            }
            switch score.suggestion {
            case "raise": OSTag(text: OSWatchText.suggestionRaise, symbol: "arrow.up", tint: .accentColor)
            case "lower": OSTag(text: OSWatchText.suggestionLower, symbol: "arrow.down")
            default: EmptyView()
            }
        }
    }

    /// Une proposition du serveur : ce qu'elle change, sur quoi elle s'appuie, et
    /// « Appliquer » pour un administrateur.
    private func proposalRow(_ proposal: HarnessAutonomyProposal) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: proposal.direction == "raise" ? "arrow.up.circle.fill" : "arrow.down.circle.fill")
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(proposal.title)
                Text(proposal.stats)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            if server.isAdmin, let change = OSTiers.change(of: proposal) {
                Button(OSWatchText.apply) {
                    Task { await autonomy.setRule(repo: proposal.repo, kind: change.kind, gate: change.gate, mode: change.mode) }
                }
                .disabled(autonomy.isSaving)
            }
        }
        .padding(.top, 2)
    }
}
