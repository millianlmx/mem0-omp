// L'AUTONOMIE PAR PALIERS, écrite une fois pour le Mac et l'iPhone/iPad : la preuve
// d'une validation prise seule (porte franchie, règle, preuves constatées), posée sur la
// carte des décisions d'À traiter, et la page Système › Autonomie, en lecture seule —
// les règles par dépôt, les validations prises seules et les propositions de palier
// avec la modification de configuration suggérée. Aucune section vide n'est montrée.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Ce qu'une validation prise seule a franchi, selon quelle règle, sur quelles preuves.
struct AutonomyProofView: View {
    let proof: HarnessAutonomyProof

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(proof.gateLine)
                .font(.callout.weight(.semibold))
            AutonomyRuleLines(title: proof.ruleLine, require: proof.rule.require, gates: proof.rule.gates)
            Text(AutonomyText.proofsTitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .padding(.top, 2)
            ForEach(proof.proofLines, id: \.self) { line in
                Label(line, systemImage: "checkmark")
                    .font(.callout)
                    .consoleReadable()
            }
        }
        .consoleID("decision.autonomy")
    }
}

/// Une règle : son rang et ce qu'elle exige, ses preuves requises, le mode de ses portes.
struct AutonomyRuleLines: View {
    let title: String
    let require: HarnessAutonomyRequire
    let gates: HarnessAutonomyGates

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.callout)
                .consoleReadable()
            if let required = require.summary {
                Text(required)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(gates.summary)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }
}

/// La page Système › Autonomie : lecture seule, rien d'autre à faire que lire et ouvrir.
public struct AutonomySections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var autonomy: HarnessAutonomy
    @ObservedObject var drafts: HarnessDrafts
    @Environment(\.consoleShell) private var shell

    public init(server: HarnessModel, drafts: HarnessDrafts) {
        self.server = server
        self.autonomy = server.autonomy
        self.drafts = drafts
    }

    public var body: some View {
        if let failure = autonomy.failure {
            ConsoleFailureBanner(failure: failure)
        }
        ControlAvailabilityNotice(availability: autonomy.availability)
        if autonomy.availability == .available, let view = autonomy.view {
            if !view.proposals.isEmpty {
                proposalsSection(view.proposals)
            }
            rulesSection(view.repos)
            if !view.validations.isEmpty {
                validationsSection(view.validations)
            }
        }
    }

    private func rulesSection(_ repos: [HarnessAutonomyRepo]) -> some View {
        let ruled = repos.filter { !$0.rules.isEmpty }
        let bare = repos.filter(\.rules.isEmpty).map(\.repo)
        return Section {
            if ruled.isEmpty {
                Text(AutonomyText.noRule).foregroundStyle(.secondary)
            }
            ForEach(ruled) { repo in
                VStack(alignment: .leading, spacing: 8) {
                    Text(repo.repo)
                        .font(.headline)
                    ForEach(Array(repo.rules.enumerated()), id: \.offset) { index, rule in
                        AutonomyRuleLines(title: AutonomyText.rule(index + 1, rule.match.summary), require: rule.require, gates: rule.gates)
                    }
                }
                .padding(.vertical, 2)
                .consoleID("autonomy.repo")
            }
            if !ruled.isEmpty, !bare.isEmpty {
                Text(AutonomyText.withoutRule(bare.joined(separator: ", ")))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(AutonomyText.rulesTitle)
        } footer: {
            Text(AutonomyText.readOnlyHint)
        }
    }

    private func validationsSection(_ validations: [HarnessDecision]) -> some View {
        Section {
            ForEach(validations) { decision in
                VStack(alignment: .leading, spacing: 8) {
                    HStack(alignment: .firstTextBaseline) {
                        Text(ConsoleFormat.relative(ms: decision.createdAt, nowMs: Date().timeIntervalSince1970 * 1000))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        if let status = PipelineServerText.decisionStatus(decision.status) {
                            Text(status)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }
                    }
                    Text(MarkdownDocument.inline(decision.question))
                        .font(.headline)
                        .consoleReadable()
                    if let proof = decision.autonomy {
                        AutonomyProofView(proof: proof)
                    }
                    Button(ShellText.openRun) {
                        ConsoleNavigation.openRun(decision.runId, drafts: drafts, select: shell.select)
                    }
                    .buttonStyle(.bordered)
                    .consoleID("autonomy.validation.run")
                }
                .padding(.vertical, 2)
            }
        } header: {
            Text(AutonomyText.validationsTitle)
        } footer: {
            Text(AutonomyText.validationsHint)
        }
    }

    private func proposalsSection(_ proposals: [HarnessAutonomyProposal]) -> some View {
        Section {
            ForEach(proposals) { proposal in
                VStack(alignment: .leading, spacing: 6) {
                    Text(proposal.repo)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(proposal.title)
                        .font(.headline)
                    Text(AutonomyText.currentRule(proposal.rule))
                        .font(.callout)
                    Text(proposal.stats)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                    Text(AutonomyText.changesTitle)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .padding(.top, 2)
                    ForEach(proposal.changes, id: \.path) { change in
                        Text(verbatim: "\(change.path) = \(change.valueText)")
                            .font(.caption.monospaced())
                            .consoleReadable()
                    }
                }
                .padding(.vertical, 2)
                .consoleID("autonomy.proposal")
            }
        } header: {
            Text(AutonomyText.proposalsTitle)
        } footer: {
            Text(AutonomyText.proposalsHint)
        }
    }
}
