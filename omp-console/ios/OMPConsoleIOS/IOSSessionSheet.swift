import ConsoleClient
import ConsoleCore
import SwiftUI

// La feuille « Session en direct » d'une feature, sur iPhone et iPad : ce que l'agent
// du serveur écrit, son raisonnement et chaque outil qu'il lance, avec son résultat,
// en temps réel. Ouverte depuis le menu contextuel d'une feature (`IOSHarnessRunRow`).
//
// Le modèle suit une session à la fois (`HarnessModel.followSession`) : la feuille
// l'ouvre à son apparition et l'arrête à sa fermeture. Les entrées sont groupées par
// étape, dans une liste groupée native ; « Suivre la fin » garde la dernière entrée à
// l'écran, d'un saut sous « Réduire les animations » (`IOSMotion`). Les mots viennent
// du noyau (`PipelineServerText`) : aucun libellé en dur ici (`design-ios/AC-5`).

struct IOSSessionSheet: View {
    @ObservedObject var server: HarnessModel
    let run: HarnessRun
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var followsEnd = true

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                List {
                    statusSection
                    ForEach(groups, id: \.first?.seq) { group in
                        Section {
                            ForEach(group) { entry in
                                IOSSessionEntryRow(entry: entry)
                                    .id(entry.seq)
                            }
                        } header: {
                            if let step = group.first?.step {
                                Text(PipelineServerText.sessionStep(HarnessRun.label(forStep: step)))
                            }
                        }
                    }
                }
                .iosGroupedList()
                // Une pose pour toute la feuille : le texte de l'agent, ses commandes et leurs résultats se copient.
                .textSelection(.enabled)
                .onChange(of: entries.last) { _, last in
                    scroll(proxy, to: last)
                }
                .onChange(of: followsEnd) { _, _ in
                    scroll(proxy, to: entries.last)
                }
            }
            .navigationTitle(run.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    // Forme 44 pt, comme la fiche d'un souvenir : le bouton de barre par défaut n'a que 36 pt.
                    Button {
                        dismiss()
                    } label: {
                        Text(PipelineServerText.close)
                            .padding(.horizontal, 8)
                            .frame(minWidth: IOSMetrics.minimumTarget, minHeight: IOSMetrics.minimumTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("ios.session.close")
                }
                ToolbarItem(placement: .topBarLeading) {
                    Toggle(isOn: $followsEnd) {
                        Label(PipelineServerText.sessionFollowEnd, systemImage: PipelineServerText.sessionFollowEndSymbol)
                    }
                    .toggleStyle(.button)
                    .accessibilityIdentifier("ios.session.followEnd")
                }
            }
        }
        .iosPageSheet()
        .onAppear { server.followSession(runId: run.id) }
        .onDisappear { server.stopSession() }
    }

    private var feed: HarnessSessionFeed? {
        server.session?.runId == run.id ? server.session : nil
    }

    private var entries: [HarnessSessionEntry] { feed?.entries ?? [] }

    /// Les entrées, en groupes consécutifs de même étape.
    private var groups: [[HarnessSessionEntry]] {
        var groups: [[HarnessSessionEntry]] = []
        for entry in entries {
            if let last = groups.last?.last, last.step == entry.step {
                groups[groups.count - 1].append(entry)
            } else {
                groups.append([entry])
            }
        }
        return groups
    }

    /// L'état du direct, en tête : l'agent au travail (et son outil du moment), ou au
    /// repos ; l'échec qui a arrêté le direct, ou la reconnexion en cours.
    @ViewBuilder
    private var statusSection: some View {
        Section {
            if let failure = server.sessionFailure {
                Text(failure.message)
                    .font(.callout)
                    .iosBanner(tone: .attention)
            } else if let feed, feed.isLoaded {
                IOSStatusChip(status: ConsoleStatus(
                    text: feed.isRunning ? PipelineServerText.sessionWorking : PipelineServerText.sessionIdle,
                    tone: feed.isRunning ? .info : .neutral
                ))
                if let current = feed.current {
                    Text(PipelineServerText.sessionNow(current.tool ?? current.text))
                        .font(.footnote.monospaced())
                        .foregroundStyle(.secondary)
                }
                if !server.isSessionLive {
                    Text(PipelineServerText.sessionReconnecting)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if feed.entries.isEmpty {
                    Text(PipelineServerText.sessionEmpty)
                        .foregroundStyle(.secondary)
                }
            } else {
                HStack {
                    ProgressView()
                    Text(PipelineServerText.sessionConnecting)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func scroll(_ proxy: ScrollViewProxy, to last: HarnessSessionEntry?) {
        guard followsEnd, let last else { return }
        withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
            proxy.scrollTo(last.seq, anchor: .bottom)
        }
    }
}

/// Une entrée du direct : un paragraphe, un raisonnement replié, un outil (son état,
/// son intention, son résultat replié) ou un signal.
struct IOSSessionEntryRow: View {
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
            } label: {
                Label(PipelineServerText.sessionThinking, systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        case .notice:
            Label(PipelineServerText.sessionNotice(entry.text), systemImage: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: nil))
                .font(.footnote)
                .foregroundStyle(.secondary)
        case .text:
            Text(Self.markdown(entry.text))
        }
    }

    private var tool: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Group {
                    if entry.isRunning {
                        ProgressView()
                    } else {
                        Image(systemName: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: entry.status))
                            .foregroundStyle(entry.isFailure ? Color.red : Color.green)
                    }
                }
                .accessibilityHidden(true)
                Text(entry.tool ?? "")
                    .font(.subheadline.monospaced().weight(.semibold))
            }
            if !entry.text.isEmpty {
                Text(entry.text)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
            if let detail = entry.detail {
                DisclosureGroup(PipelineServerText.sessionResult) {
                    Text(detail)
                        .font(.caption.monospaced())
                        .foregroundStyle(entry.isFailure ? Color.red : Color.secondary)
                }
                .font(.footnote)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(PipelineServerText.toolLine(tool: entry.tool ?? "", status: entry.status, text: entry.text))
    }

    /// Le texte de l'agent en Markdown en ligne (gras, code, liens), sauts de ligne gardés.
    static func markdown(_ text: String) -> AttributedString {
        (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(text)
    }
}
