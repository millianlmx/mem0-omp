// L'« OS agentique » : MAINTENANT, l'accueil, partagé par le Mac et l'iPhone/iPad. Cinq
// chiffres (ce qui vous attend, les agents au travail, et les dernières 24 h du rapport
// du matin), les agents au travail avec ce qu'ils font, puis ce qui a été livré
// aujourd'hui. Chaque ligne ouvre son fil.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSHomeView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var pulse: OSPulse
    @ObservedObject var workspace: OSWorkspace
    let threads: [OSThread]
    let decisions: Int

    /// `decisions` : le nombre de décisions qui attendent (`OSDecision.all`).
    public init(server: HarnessModel, pulse: OSPulse, workspace: OSWorkspace, threads: [OSThread], decisions: Int) {
        self.server = server
        self.pulse = pulse
        self.workspace = workspace
        self.threads = threads
        self.decisions = decisions
    }

    public var body: some View {
        let working = threads.filter { $0.phase == .working }
        let today = Calendar.current.startOfDay(for: Date()).timeIntervalSince1970 * 1000
        let delivered = threads.filter { $0.phase == .done && $0.updatedAt >= today }
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(OSText.now).font(.largeTitle.weight(.bold))
                    Text(Date().formatted(Date.FormatStyle(date: .complete, time: .omitted).locale(ConsoleFormat.locale))).foregroundStyle(.secondary)
                }
                HStack(spacing: 10) {
                    tile(decisions, OSText.yours, tint: decisions > 0 ? .orange : .secondary) { workspace.triage = decisions > 0 }
                    tile(working.count, OSText.atWork, tint: .accentColor, action: nil)
                    if let counts = server.digest?.counts {
                        tile(counts.merged, OSText.mergedTile, tint: .green, action: nil)
                        tile(counts.decisions, OSText.aloneTile, tint: .purple, action: nil)
                        tile(counts.failed, OSText.failedTile, tint: counts.failed > 0 ? .red : .secondary, action: nil)
                    }
                }
                section(OSText.atWork) {
                    if working.isEmpty {
                        Text(OSText.calm).foregroundStyle(.secondary)
                    }
                    TimelineView(.periodic(from: .now, by: 5)) { context in
                        VStack(spacing: 8) {
                            ForEach(working) { thread in
                                workingRow(thread, now: context.date)
                            }
                        }
                    }
                }
                if !delivered.isEmpty {
                    section(OSText.delivered) {
                        ForEach(delivered) { thread in
                            Button {
                                workspace.open(thread.id)
                            } label: {
                                HStack(spacing: 8) {
                                    OSPhaseMark(phase: .done, size: 12)
                                    Text(thread.title).lineLimit(1)
                                    Spacer()
                                    Text(ConsoleFormat.time(ms: thread.updatedAt))
                                        .font(.caption.monospacedDigit())
                                        .foregroundStyle(.secondary)
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(28)
            .frame(maxWidth: .infinity)
        }
        .task { await server.refreshServices() }
    }

    private func tile(_ value: Int, _ label: String, tint: Color, action: (() -> Void)?) -> some View {
        Button {
            action?()
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text("\(value)")
                    .font(.system(size: 30, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(value > 0 ? tint : .secondary)
                Text(label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
        }
        .buttonStyle(.plain)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased())
                .font(.caption.weight(.bold))
                .foregroundStyle(.secondary)
            content()
        }
    }

    private func workingRow(_ thread: OSThread, now: Date) -> some View {
        let run = thread.runs.last { $0.phase == .running || $0.phase == .merging || $0.phase == .queued } ?? thread.focusRun
        let line = run.flatMap { pulse.current(.run($0.id), now: now)?.line } ?? run?.osState ?? ""
        return Button {
            workspace.open(thread.id)
        } label: {
            OSCard(tint: .accentColor, emphasized: true) {
                HStack(spacing: 10) {
                    OSPhaseMark(phase: .working, size: 16)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(thread.title).font(.headline).lineLimit(1)
                        Text("↳ " + line).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    if let run { OSStepDots(run: run) }
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}
