// L'AUTONOMIE PAR PALIERS, écrite une fois pour le Mac et l'iPhone/iPad : la page
// Système › Autonomie (règles par dépôt, décisions prises seules avec leur règle et leurs
// preuves, propositions de palier avec la modification de configuration suggérée) et le
// bloc « porte franchie, règle, preuves » que la carte « décision prise seule » d'À
// traiter montre aussi.
//
// Tout est en LECTURE : aucun geste ne modifie une règle (le serveur ne le fait jamais
// seul, l'app non plus). Les gestes d'une décision prise seule (accepter, renverser) sont
// ceux de la carte d'À traiter ; revert, annulation et relance sont ceux de la page de la
// feature.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Une ligne « libellé, valeur » : le libellé en légende, la valeur dessous, lisible en entier.
struct AutonomyFactRow: View {
    let label: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.callout)
                .consoleReadable()
        }
        .accessibilityElement(children: .combine)
    }
}

/// La porte franchie seule, la règle retenue (rang, `match`, exigences, portes) et chaque preuve avec sa valeur.
public struct AutonomyProofView: View {
    let proof: HarnessAutonomyProof

    public init(proof: HarnessAutonomyProof) {
        self.proof = proof
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(proof.facts) { fact in
                AutonomyFactRow(label: fact.label, value: fact.value)
            }
        }
        .consoleID("autonomy.proof")
    }
}

/// La page Système › Autonomie.
public struct AutonomySections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var autonomy: HarnessAutonomy

    public init(server: HarnessModel) {
        self.server = server
        self.autonomy = server.autonomy
    }

    public var body: some View {
        if let failure = autonomy.failure {
            ConsoleFailureBanner(failure: failure)
        }
        ControlAvailabilityNotice(availability: autonomy.availability)
        if autonomy.availability == .available, let view = autonomy.view {
            Section {
                Text(AutonomyText.readOnlyHint)
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            rulesSection(view)
            validationsSection(view)
            proposalsSection(view)
        }
    }

    // MARK: - Règles par dépôt

    private func rulesSection(_ view: HarnessAutonomyView) -> some View {
        Section {
            ForEach(view.repos) { repo in
                VStack(alignment: .leading, spacing: 10) {
                    Text(repo.repo)
                        .font(.headline)
                    if repo.rules.isEmpty {
                        Text(AutonomyText.noRules)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(repo.rules.enumerated()), id: \.offset) { index, rule in
                        ruleRow(rank: index + 1, rule: rule)
                    }
                }
                .padding(.vertical, 4)
                .consoleID("autonomy.repo")
            }
            if view.repos.isEmpty {
                Text(AutonomyText.noRules)
                    .foregroundStyle(.secondary)
            }
        } header: {
            Text(AutonomyText.rulesTitle)
        } footer: {
            Text(AutonomyText.rulesFooter)
        }
    }

    private func ruleRow(rank: Int, rule: HarnessAutonomyRule) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(AutonomyText.ruleTitle(rank: rank, kind: rule.match.kind))
                .font(.body.weight(.medium))
            AutonomyFactRow(label: AutonomyText.factRuleHeader, value: rule.match.summary)
            AutonomyFactRow(label: AutonomyText.factRequire, value: rule.require.summary)
            AutonomyFactRow(label: AutonomyText.factRuleGates, value: rule.gates.summary)
        }
        .consoleID("autonomy.rule")
    }

    // MARK: - Décisions prises seules

    private func validationsSection(_ view: HarnessAutonomyView) -> some View {
        Section {
            if view.validations.isEmpty {
                Text(AutonomyText.noValidations)
                    .foregroundStyle(.secondary)
            }
            ForEach(view.validations) { decision in
                validationRow(decision)
            }
        } header: {
            Text(AutonomyText.validationsTitle)
        } footer: {
            Text(AutonomyText.validationsFooter)
        }
    }

    @ViewBuilder
    private func validationRow(_ decision: HarnessDecision) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(decision.autonomy.map { AutonomyText.gateCrossed($0.gate) } ?? decision.question)
                    .font(.headline)
                Spacer(minLength: 8)
                Text(AutonomyText.validationStatus(decision.status))
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text([server.inbox?.run(decision.runId)?.title ?? decision.runId, ConsoleFormat.dateTime(ms: decision.createdAt)].joined(separator: " · "))
                .font(.caption)
                .foregroundStyle(.secondary)
            if let proof = decision.autonomy {
                AutonomyProofView(proof: proof)
            }
        }
        .padding(.vertical, 4)
        .consoleID("autonomy.validation")
    }

    // MARK: - Propositions de palier

    private func proposalsSection(_ view: HarnessAutonomyView) -> some View {
        Section {
            if view.proposals.isEmpty {
                Text(AutonomyText.noProposals)
                    .foregroundStyle(.secondary)
            }
            ForEach(view.proposals) { proposal in
                proposalRow(proposal)
            }
        } header: {
            Text(AutonomyText.proposalsTitle)
        } footer: {
            Text(AutonomyText.proposalsFooter)
        }
    }

    private func proposalRow(_ proposal: HarnessAutonomyProposal) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(AutonomyText.proposalTitle(raise: proposal.isRaise, kind: proposal.kind, gate: proposal.gate))
                .font(.headline)
            Text(proposal.repo)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(AutonomyText.proposalToday(current: proposal.current, rule: proposal.rule))
                .font(.callout)
            Text(AutonomyText.proposalFigures(runs: proposal.runs, passages: proposal.passages, corrections: proposal.corrections, rate: proposal.rate))
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(AutonomyText.changesTitle)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(proposal.changes) { change in
                VStack(alignment: .leading, spacing: 1) {
                    Text(change.path)
                        .font(.caption.monospaced())
                    Text(change.valueText)
                        .font(.callout.monospaced())
                        .foregroundStyle(.secondary)
                }
                .consoleReadable()
            }
        }
        .padding(.vertical, 4)
        .consoleID("autonomy.proposal")
    }
}
