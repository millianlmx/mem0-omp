// Le rendu d'un appel d'outil sur Mac, tel que le serveur le décrit (`HarnessToolView`) :
// une commande se lit comme une commande, des différences en vert et rouge, la prose
// de l'agent en Markdown, le JSON des outils du service en champs et en listes, et
// chaque sous-agent en fiche — sa mission, ce qu'il fait, ses derniers outils, ce
// qu'il a rendu. Le JSON brut se déplie à part (`HarnessSessionDetailSheet`).
//
// Les mots viennent du noyau (`PipelineServerText`) : un rôle de bloc inconnu de cette
// version de l'app garde le titre tiré des données.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les blocs d'un rendu, dans l'ordre.
struct HarnessToolBlocksView: View {
    let blocks: [HarnessToolBlock]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                HarnessToolBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Un bloc du rendu : son titre, puis son texte, ses champs, sa liste ou ses fiches.
struct HarnessToolBlockView: View {
    let block: HarnessToolBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let title {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(block.isError ? Color.red : Color.primary)
                    .accessibilityAddTraits(.isHeader)
            }
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var title: String? {
        block.role.flatMap(PipelineServerText.toolBlockRole) ?? block.title
    }

    /// La puce d'un élément de liste.
    static let bullet = "•"

    @ViewBuilder
    private var content: some View {
        switch block.sort {
        case .text:
            HarnessToolText(block: block)
        case .fields:
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 4) {
                ForEach(Array((block.fields ?? []).enumerated()), id: \.offset) { _, field in
                    GridRow {
                        Text(field.key)
                            .font(.callout.monospaced())
                            .foregroundStyle(.secondary)
                        Text(field.value)
                            .textSelection(.enabled)
                    }
                }
            }
        case .list:
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array((block.items ?? []).enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(Self.bullet)
                            .foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        Text(item)
                            .textSelection(.enabled)
                    }
                }
            }
        case .agents:
            VStack(alignment: .leading, spacing: 10) {
                ForEach(block.agents ?? []) { agent in
                    HarnessAgentCard(agent: agent)
                }
            }
        }
    }
}

/// Un texte d'outil selon sa forme : Markdown, code, différences ou commande.
struct HarnessToolText: View {
    let block: HarnessToolBlock

    var body: some View {
        switch block.textFormat {
        case .markdown:
            MarkdownBlocksView(markdown: block.displayText)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .diff:
            framed {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(block.diffLines) { line in
                        Text(line.text)
                            .font(.callout.monospaced())
                            .foregroundStyle(line.kind == .hunk ? Color.secondary : Color.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Self.tint(line.kind))
                    }
                }
            }
        case .command:
            framed {
                Text(block.displayText)
                    .font(.callout.monospaced().weight(.medium))
            }
        case .code, .plain:
            framed {
                Text(block.displayText)
                    .font(.callout.monospaced())
                    .foregroundStyle(block.isError ? Color.red : Color.primary)
            }
        }
    }

    /// Un texte en chasse fixe : une ligne longue défile, sans élargir la feuille.
    private func framed<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView(.horizontal) {
            content()
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .padding(8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }

    static func tint(_ kind: HarnessDiffLine.Kind) -> Color {
        switch kind {
        case .added: Color.green.opacity(0.18)
        case .removed: Color.red.opacity(0.18)
        case .hunk, .context: Color.clear
        }
    }
}

/// Un sous-agent en une ligne, dans la rangée du direct : son état, son nom, ce qu'il fait.
struct HarnessAgentLineView: View {
    let agent: HarnessAgentLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            HarnessAgentStatusIcon(status: agent.state, raw: agent.status)
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(agent.label)
                        .font(.callout.weight(.semibold))
                    Text(PipelineServerText.agentHeader(agent: agent.agent, status: agent.status))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Text(agent.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// L'icône de l'état d'un sous-agent ; un agent au travail tourne.
struct HarnessAgentStatusIcon: View {
    let status: HarnessAgentStatus
    /// L'état tel que le serveur l'écrit (son symbole).
    let raw: String

    var body: some View {
        Group {
            if status == .running {
                ProgressView()
                    .controlSize(.mini)
            } else {
                Image(systemName: PipelineServerText.agentStatusSymbol(raw))
                    .foregroundStyle(Self.color(status))
            }
        }
        .accessibilityHidden(true)
    }

    static func color(_ status: HarnessAgentStatus) -> Color {
        switch status {
        case .completed: .green
        case .failed: .red
        case .aborted: .orange
        case .pending, .running, .unknown: .secondary
        }
    }
}

/// La fiche d'un sous-agent : qui il est et où il en est, sa mission (repliée une fois
/// qu'il a rendu), ce qu'il fait à l'instant, ses derniers outils, ce qu'il a rendu.
struct HarnessAgentCard: View {
    let agent: HarnessAgentView
    @State private var showsTask: Bool

    init(agent: HarnessAgentView) {
        self.agent = agent
        _showsTask = State(initialValue: agent.output == nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                HarnessAgentStatusIcon(status: agent.state, raw: agent.status)
                Text(agent.label)
                    .font(.headline)
                Text(PipelineServerText.agentHeader(agent: agent.agent, status: agent.status))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                if let metrics = PipelineServerText.agentMetrics(durationMs: agent.durationMs, tokens: agent.tokens, cost: agent.cost) {
                    Text(metrics)
                        .font(.caption)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            if let model = agent.model {
                Text(model)
                    .font(.caption.monospaced())
                    .foregroundStyle(.tertiary)
            }
            if !agent.task.isEmpty {
                DisclosureGroup(PipelineServerText.sessionAgentTask, isExpanded: $showsTask) {
                    MarkdownBlocksView(markdown: agent.task)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 4)
                }
            }
            if let activity = agent.currentActivity {
                LabeledContent(PipelineServerText.sessionAgentNow) {
                    Text(activity)
                        .font(.callout.monospaced())
                        .textSelection(.enabled)
                }
            }
            if !agent.recent.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(PipelineServerText.sessionAgentRecent)
                        .font(.subheadline.weight(.semibold))
                    ForEach(Array(agent.recent.enumerated()), id: \.offset) { _, call in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(call.tool)
                                .font(.caption.monospaced().weight(.semibold))
                                .foregroundStyle(call.error ? Color.red : Color.secondary)
                            Text(call.text)
                                .font(.caption.monospaced())
                                .foregroundStyle(call.error ? Color.red : Color.primary)
                                .lineLimit(2)
                        }
                    }
                }
            }
            if let error = agent.error {
                Text(error)
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if let output = agent.output {
                VStack(alignment: .leading, spacing: 4) {
                    Text(PipelineServerText.sessionAgentOutput)
                        .font(.subheadline.weight(.semibold))
                    MarkdownBlocksView(markdown: output)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.secondary.opacity(0.2)))
    }
}
