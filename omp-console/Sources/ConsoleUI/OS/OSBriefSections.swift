// L'« OS agentique » : les SECTIONS DU BRIEF, sur « Maintenant » — ce qui vous attend, ce
// qui a été livré (avec la pastille « seul » quand aucun geste humain n'a été fait), ce
// qui est bloqué en file et pourquoi, les échecs, les décisions prises seules (« Garder »,
// « Revoir ») et les arrêts avec leur motif. Chaque section se replie et ne se montre que
// si elle a quelque chose ; chaque ligne est un élément, et ouvre son fil.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSBriefSections: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workspace: OSWorkspace
    @ObservedObject var pause: HarnessPauseModel
    let brief: HarnessBrief
    let threads: [OSThread]

    private enum Fold: Hashable {
        case waiting, delivered, blocked, failed, decided, stopped
    }

    /// Les arrêts sont repliés d'office : ils se lisent en dernier.
    @State private var folded: Set<Fold> = [.stopped]

    public init(server: HarnessModel, workspace: OSWorkspace, brief: HarnessBrief, threads: [OSThread]) {
        self.server = server
        self.workspace = workspace
        _pause = ObservedObject(wrappedValue: server.pause)
        self.brief = brief
        self.threads = threads
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if brief.proposals > 0 {
                Button {
                    workspace.selection = OSWorkspace.proposals
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "lightbulb.fill").foregroundStyle(Color.accentColor)
                        Text(AutonomyText.proposalsCount(brief.proposals))
                        Spacer()
                        Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            section(.waiting, OSWatchText.sectionWaiting, brief.waiting.count) {
                ForEach(brief.waiting) { item in
                    row(.yours, item.runId, item.title, detail: [item.repo, OSWatchText.wait(item.wait), item.since.osRelative])
                }
            }
            section(.delivered, OSWatchText.sectionDelivered, brief.delivered.count) {
                ForEach(brief.delivered) { item in
                    row(
                        .done, item.runId, item.title,
                        detail: [item.repo, item.cost.map(MonitoringText.cost), ConsoleFormat.time(ms: item.at)],
                        tag: item.alone ? OSWatchText.alone : nil
                    )
                }
            }
            section(.blocked, OSWatchText.sectionBlocked, brief.blocked.count) {
                ForEach(brief.blocked) { item in
                    row(.queued, item.runId, item.title, detail: [item.repo, item.text.isEmpty ? ControlText.waitCause(item.cause) : item.text]) {
                        if item.cause == "paused", pause.isPaused {
                            Button(OSWatchText.resume) { Task { await pause.setPause(paused: false) } }
                                .disabled(!server.canAct || pause.isSaving)
                        }
                    }
                }
            }
            section(.failed, OSWatchText.sectionFailed, brief.failed.count) {
                ForEach(brief.failed) { item in
                    row(.failed, item.runId, item.title, detail: [item.repo, item.reason.map(OSThreads.firstLine)])
                }
            }
            section(.decided, OSWatchText.sectionDecided, brief.decided.count) {
                ForEach(brief.decided) { item in
                    row(.done, item.runId, OSThreads.firstLine(item.question), detail: [item.repo, item.chosen], symbol: "checkmark.seal") {
                        Button(OSText.keep) { Task { await server.accept(runId: item.runId, seq: item.seq) } }
                            .disabled(!server.canAct)
                        Button(OSText.revisit) { workspace.open(runId: item.runId, in: threads) }
                    }
                }
            }
            section(.stopped, OSText.sectionStopped, brief.stopped.count) {
                ForEach(brief.stopped) { item in
                    row(.stopped, item.runId, item.title, detail: [item.repo, OSWatchText.cancelCause(item.cause)])
                }
            }
        }
    }

    /// Une section repliable ; rien quand elle est vide.
    @ViewBuilder
    private func section<Content: View>(_ fold: Fold, _ title: String, _ count: Int, @ViewBuilder content: () -> Content) -> some View {
        if count > 0 {
            let open = !folded.contains(fold)
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    if open { folded.insert(fold) } else { folded.remove(fold) }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.caption2.weight(.bold))
                            .rotationEffect(.degrees(open ? 90 : 0))
                        Text(title.uppercased() + " · \(count)")
                            .font(.caption.weight(.bold))
                        Spacer()
                    }
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(.isHeader)
                if open { content() }
            }
        }
    }

    private func row(_ phase: OSPhase, _ runId: String, _ title: String, detail: [String?], tag: String? = nil, symbol: String? = nil) -> some View {
        row(phase, runId, title, detail: detail, tag: tag, symbol: symbol) { EmptyView() }
    }

    /// Une ligne : l'état, le titre, où et quoi en gris, puis ses gestes. Elle ouvre le fil.
    private func row<Gestures: View>(
        _ phase: OSPhase, _ runId: String, _ title: String, detail: [String?], tag: String? = nil, symbol: String? = nil,
        @ViewBuilder gestures: () -> Gestures
    ) -> some View {
        HStack(spacing: 8) {
            Button {
                workspace.open(runId: runId, in: threads)
            } label: {
                HStack(spacing: 8) {
                    if let symbol {
                        Image(systemName: symbol)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(.purple)
                            .frame(width: 18, height: 18)
                    } else {
                        Image(systemName: phase.symbol)
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(phase.color)
                            .frame(width: 18, height: 18)
                            .accessibilityLabel(phase.label)
                    }
                    Text(title)
                        .lineLimit(1)
                        .layoutPriority(1)
                    if let tag { OSTag(text: tag, symbol: "sparkle", tint: .green) }
                    Text(detail.compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            gestures()
                .buttonStyle(.borderless)
                .controlSize(.small)
        }
    }
}
