// La feuille « Session en direct » d'une feature : ce que l'agent du serveur écrit, son
// raisonnement et chaque outil qu'il lance, avec son résultat, en temps réel.
//
// Le modèle suit une session à la fois (`HarnessModel.followSession`) : la feuille
// l'ouvre à son apparition et l'arrête à sa fermeture. Les entrées sont groupées par
// étape ; « Suivre la fin » garde la dernière entrée à l'écran tant qu'il est coché.

import ConsoleClient
import ConsoleCore
import SwiftUI

struct HarnessSessionSheet: View {
    @ObservedObject var server: HarnessModel
    let run: HarnessRun
    @Environment(\.dismiss) private var dismiss
    @State private var followsEnd = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                statusBar
                Divider()
                log
            }
            .navigationTitle(run.title)
            .navigationSubtitle(PipelineServerText.sessionTitle)
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Toggle(isOn: $followsEnd) {
                        Label(PipelineServerText.sessionFollowEnd, systemImage: PipelineServerText.sessionFollowEndSymbol)
                    }
                    .accessibilityIdentifier("session.followEnd")
                }
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("session.close")
                }
            }
        }
        .frame(minWidth: 620, idealWidth: 760, minHeight: 520, idealHeight: 680)
        .onAppear { server.followSession(runId: run.id) }
        .onDisappear { server.stopSession() }
        .accessibilityIdentifier("session.sheet")
    }

    private var feed: HarnessSessionFeed? {
        server.session?.target == .run(run.id) ? server.session : nil
    }

    /// L'état du direct : l'agent au travail (et son outil du moment), ou au repos ;
    /// l'échec qui a arrêté le direct, ou la reconnexion en cours.
    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let failure = server.sessionFailure {
                HarnessFailureLabel(failure: failure)
            } else if let feed, feed.isLoaded {
                Label(
                    feed.isRunning ? PipelineServerText.sessionWorking : PipelineServerText.sessionIdle,
                    systemImage: feed.isRunning ? PipelineServerText.liveSymbol : PipelineServerText.sessionSymbol
                )
                .foregroundStyle(feed.isRunning ? Color.primary : Color.secondary)
                if let current = feed.current {
                    Text(PipelineServerText.sessionNow(current.tool ?? current.text))
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                }
                if !server.isSessionLive {
                    Text(PipelineServerText.sessionReconnecting)
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            } else {
                Label(PipelineServerText.sessionConnecting, systemImage: PipelineServerText.offlineSymbol)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal)
        .padding(.vertical, 10)
    }

    private var log: some View {
        let entries = feed?.entries ?? []
        return ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if entries.isEmpty, feed?.isLoaded == true {
                        Text(PipelineServerText.sessionEmpty)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(Array(entries.enumerated()), id: \.element.seq) { index, entry in
                        if let step = entry.step, index == 0 || entries[index - 1].step != step {
                            Text(PipelineServerText.sessionStep(HarnessRun.label(forStep: step)))
                                .font(.headline)
                                .padding(.top, index == 0 ? 0 : 8)
                                .accessibilityAddTraits(.isHeader)
                        }
                        HarnessSessionEntryRow(entry: entry)
                            .id(entry.seq)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .onChange(of: entries.last) { _, last in
                guard followsEnd, let last else { return }
                proxy.scrollTo(last.seq, anchor: .bottom)
            }
            .onChange(of: followsEnd) { _, follows in
                guard follows, let last = entries.last else { return }
                proxy.scrollTo(last.seq, anchor: .bottom)
            }
        }
    }
}

/// Une entrée du direct : un paragraphe, un raisonnement replié, un outil (son état,
/// son intention, son résultat replié) ou un signal.
struct HarnessSessionEntryRow: View {
    let entry: HarnessSessionEntry

    var body: some View {
        switch entry.sort {
        case .tool:
            tool
        case .thinking:
            DisclosureGroup {
                Text(entry.text)
                    .italic()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } label: {
                Label(PipelineServerText.sessionThinking, systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        case .notice:
            Label(PipelineServerText.sessionNotice(entry.text), systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
                .font(.caption)
                .foregroundStyle(.secondary)
        case .text:
            Text(Self.markdown(entry.text))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var tool: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Group {
                if entry.isRunning {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: entry.status))
                        .foregroundStyle(entry.isFailure ? Color.red : Color.green)
                }
            }
            .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.tool ?? "")
                    .font(.caption.monospaced().weight(.semibold))
                    .foregroundStyle(.secondary)
                if !entry.text.isEmpty {
                    Text(entry.text)
                        .font(.callout.monospaced())
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
                if let detail = entry.detail {
                    DisclosureGroup(PipelineServerText.sessionResult) {
                        Text(detail)
                            .font(.caption.monospaced())
                            .foregroundStyle(entry.isFailure ? Color.red : Color.secondary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .font(.caption)
                }
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(PipelineServerText.toolLine(tool: entry.tool ?? "", status: entry.status, text: entry.text))
    }

    /// Le texte de l'agent en Markdown en ligne (gras, code, liens), sauts de ligne gardés.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}
