import ConsoleClient
import ConsoleCore
import SwiftUI

// Le rendu d'un appel d'outil sur iPhone et iPad, tel que le serveur le décrit
// (`HarnessToolView`) : une section par bloc — une commande, des différences en vert et
// rouge, la prose de l'agent en Markdown, des champs, une liste —, et chaque sous-agent
// en fiche : sa mission, ce qu'il fait, ses derniers outils, ce qu'il a rendu. Le JSON
// brut se déplie à part (`IOSSessionDetailScreen`).
//
// Le texte se sélectionne par la pose de la feuille du direct. Les mots viennent du
// noyau (`PipelineServerText`) : aucun libellé en dur ici (`design-ios/AC-5`).

/// Les blocs d'un rendu, une section chacun.
struct IOSToolBlockSections: View {
    let blocks: [HarnessToolBlock]

    var body: some View {
        ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
            Section {
                content(block)
            } header: {
                if let title = block.role.flatMap(PipelineServerText.toolBlockRole) ?? block.title {
                    Text(title)
                        .foregroundStyle(block.isError ? Color.red : Color.secondary)
                }
            }
        }
    }

    @ViewBuilder
    private func content(_ block: HarnessToolBlock) -> some View {
        switch block.sort {
        case .text:
            IOSToolText(block: block)
        case .fields:
            ForEach(Array((block.fields ?? []).enumerated()), id: \.offset) { _, field in
                LabeledContent {
                    Text(field.value)
                } label: {
                    Text(field.key)
                        .font(.footnote.monospaced())
                }
            }
        case .list:
            ForEach(Array((block.items ?? []).enumerated()), id: \.offset) { _, item in
                Text(item)
                    .font(.callout)
            }
        case .agents:
            ForEach(block.agents ?? []) { agent in
                IOSAgentCard(agent: agent)
            }
        }
    }
}

/// Un texte d'outil selon sa forme : Markdown, code, différences ou commande.
struct IOSToolText: View {
    let block: HarnessToolBlock

    var body: some View {
        switch block.textFormat {
        case .markdown:
            IOSMarkdownView(blocks: MarkdownDocument.blocks(block.displayText))
        case .diff:
            VStack(alignment: .leading, spacing: 0) {
                ForEach(block.diffLines) { line in
                    Text(line.text)
                        .font(.footnote.monospaced())
                        .foregroundStyle(line.kind == .hunk ? Color.secondary : Color.primary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 4)
                        .background(IOSDiffScreen.tint(line.kind))
                }
            }
        case .command:
            Text(block.displayText)
                .font(.footnote.monospaced().weight(.medium))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .code, .plain:
            Text(block.displayText)
                .font(.footnote.monospaced())
                .foregroundStyle(block.isError ? Color.red : Color.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// L'icône de l'état d'un sous-agent ; un agent au travail tourne.
struct IOSAgentStatusIcon: View {
    let status: HarnessAgentStatus
    /// L'état tel que le serveur l'écrit (son symbole).
    let raw: String

    var body: some View {
        Group {
            if status == .running {
                ProgressView()
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

/// Un sous-agent en une ligne, dans la rangée du direct : son état, son nom, ce qu'il fait.
struct IOSAgentLineView: View {
    let agent: HarnessAgentLine

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            IOSAgentStatusIcon(status: agent.state, raw: agent.status)
            VStack(alignment: .leading, spacing: 1) {
                Text(agent.label)
                    .font(.footnote.weight(.semibold))
                Text(PipelineServerText.agentHeader(agent: agent.agent, status: agent.status))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(agent.summary)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// La fiche d'un sous-agent : qui il est et où il en est, sa mission (repliée une fois
/// qu'il a rendu), ce qu'il fait à l'instant, ses derniers outils, ce qu'il a rendu.
struct IOSAgentCard: View {
    let agent: HarnessAgentView
    @State private var showsTask: Bool

    init(agent: HarnessAgentView) {
        self.agent = agent
        _showsTask = State(initialValue: agent.output == nil)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                IOSAgentStatusIcon(status: agent.state, raw: agent.status)
                Text(agent.label)
                    .font(.headline)
            }
            Text(PipelineServerText.agentHeader(agent: agent.agent, status: agent.status))
                .font(.subheadline)
                .foregroundStyle(.secondary)
            if let metrics = PipelineServerText.agentMetrics(durationMs: agent.durationMs, tokens: agent.tokens, cost: agent.cost) {
                Text(metrics)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
            }
            if let model = agent.model {
                Text(model)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            if !agent.task.isEmpty {
                DisclosureGroup(PipelineServerText.sessionAgentTask, isExpanded: $showsTask) {
                    IOSMarkdownView(blocks: MarkdownDocument.blocks(agent.task))
                }
            }
            if let activity = agent.currentActivity {
                VStack(alignment: .leading, spacing: 2) {
                    Text(PipelineServerText.sessionAgentNow)
                        .font(.subheadline.weight(.semibold))
                    Text(activity)
                        .font(.footnote.monospaced())
                }
            }
            if !agent.recent.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text(PipelineServerText.sessionAgentRecent)
                        .font(.subheadline.weight(.semibold))
                    ForEach(Array(agent.recent.enumerated()), id: \.offset) { _, call in
                        Text(call.tool)
                            .font(.caption.monospaced().weight(.semibold))
                            .foregroundStyle(call.error ? Color.red : Color.secondary)
                        Text(call.text)
                            .font(.caption.monospaced())
                            .foregroundStyle(call.error ? Color.red : Color.primary)
                    }
                }
            }
            if let error = agent.error {
                Text(error)
                    .foregroundStyle(.red)
            }
            if let output = agent.output {
                VStack(alignment: .leading, spacing: 4) {
                    Text(PipelineServerText.sessionAgentOutput)
                        .font(.subheadline.weight(.semibold))
                    IOSMarkdownView(blocks: MarkdownDocument.blocks(output))
                }
            }
        }
        .padding(.vertical, 4)
    }
}
