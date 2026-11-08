// Le DIRECT d'une session : ce que l'agent du serveur écrit, son raisonnement et chaque
// outil qu'il lance, avec son résultat, en temps réel — et, pour une feature, les
// fichiers qu'elle touche, la sortie de ses tests et sa frise.
//
// `HarnessSessionContent` est posé tel quel par la page d'une feature (onglets Direct,
// Fichiers, Tests, Frise) et par la feuille `HarnessSessionSheet`, qui ne sert plus
// qu'à l'analyse d'un audit et aux jobs du poste. Le modèle suit un direct à la fois
// (`HarnessModel.followSession`) : celui qui pose le contenu l'ouvre et l'arrête. Une
// session finie se rejoue : « Afficher les entrées précédentes » remonte page par page.
// « Suivre la fin » garde la dernière entrée à l'écran tant qu'il est coché.
//
// Chaque outil montre sa commande (son appel), même quand l'agent a donné son
// intention, et un appel de sous-agents montre chacun d'eux en une ligne, en direct.
// « Détails » ouvre le rendu lisible de l'outil (`HarnessToolBlocksView`) — relu tant
// qu'il tourne —, son JSON brut replié dessous. Un paragraphe trop long pour le direct
// s'ouvre en entier.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

/// Ce que montre le contenu d'une session : le direct, ou un panneau d'une feature.
enum HarnessSessionPane: Hashable {
    case live, files, tests, timeline
}

/// L'état du direct puis le journal (ou le panneau choisi) d'une session.
struct HarnessSessionContent: View {
    @ObservedObject var server: HarnessModel
    let target: HarnessSessionTarget
    let pane: HarnessSessionPane
    @Binding var followsEnd: Bool
    @State private var opened: HarnessSessionDetailRequest?

    var body: some View {
        VStack(spacing: 0) {
            statusBar
            Divider()
            switch pane {
            case .live:
                log
            case .files:
                if let runId { HarnessChangesPane(server: server, runId: runId, refreshKey: toolsDone) }
            case .tests:
                HarnessTestsPane(jobs: feed?.tests ?? [], followsEnd: followsEnd)
            case .timeline:
                if let runId { HarnessTimelinePane(server: server, runId: runId, refreshKey: feed?.entries.count ?? 0) }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .sheet(item: $opened) { item in
            HarnessSessionDetailSheet(server: server, target: target, seq: item.seq)
        }
    }

    private var runId: String? {
        if case let .run(id) = target { return id }
        return nil
    }

    private var feed: HarnessSessionFeed? {
        server.session?.target == target ? server.session : nil
    }

    /// Les outils terminés : leur nombre relit les fichiers touchés (une écriture en est peut-être une).
    private var toolsDone: Int {
        feed?.entries.filter { $0.isTool && !$0.isRunning }.count ?? 0
    }

    /// L'état du direct : l'agent au travail (et son outil du moment, ou le job de tests
    /// en cours), ou au repos ; l'échec qui a arrêté le direct, ou la reconnexion en cours.
    private var statusBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let failure = server.sessionFailure {
                ConsoleFailureBanner(failure: failure)
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
                if let test = feed.runningTest {
                    Label(MonitoringText.testLine(scope: test.scope, attempt: test.attempt, outcome: nil), systemImage: MonitoringText.testSymbol(nil))
                        .font(.caption)
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
                    if feed?.hasEarlier == true {
                        Button(MonitoringText.loadEarlier) {
                            followsEnd = false
                            Task { await server.loadEarlierSession() }
                        }
                        .buttonStyle(.link)
                        .frame(maxWidth: .infinity)
                        .accessibilityIdentifier("session.earlier")
                    }
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
                        HarnessSessionEntryRow(entry: entry) { opened = HarnessSessionDetailRequest(seq: entry.seq) }
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

/// « Suivre la fin » : garder la dernière entrée du direct à l'écran.
struct HarnessFollowEndToggle: View {
    @Binding var followsEnd: Bool

    var body: some View {
        Toggle(isOn: $followsEnd) {
            Label(PipelineServerText.sessionFollowEnd, systemImage: PipelineServerText.sessionFollowEndSymbol)
        }
        .help(PipelineServerText.sessionFollowEnd)
        .accessibilityIdentifier("session.followEnd")
    }
}

/// La feuille du direct d'une session qui n'a pas de page : l'analyse d'un audit, un
/// job du poste (`drafts.sessionRequest`). Une feature, elle, s'ouvre en page.
struct HarnessSessionSheet: View {
    @ObservedObject var server: HarnessModel
    let request: HarnessSessionRequest
    @Environment(\.dismiss) private var dismiss
    @State private var followsEnd = true

    var body: some View {
        NavigationStack {
            HarnessSessionContent(server: server, target: request.target, pane: .live, followsEnd: $followsEnd)
                .navigationTitle(request.title)
                .navigationSubtitle(request.subtitle)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        HarnessFollowEndToggle(followsEnd: $followsEnd)
                    }
                    ToolbarItem(placement: .cancellationAction) {
                        Button(PipelineServerText.close) { dismiss() }
                            .keyboardShortcut(.cancelAction)
                            .accessibilityIdentifier("session.close")
                    }
                }
        }
        .frame(minWidth: 720, idealWidth: 900, minHeight: 560, idealHeight: 720)
        .onAppear { server.followSession(request.target) }
        .onDisappear { server.stopSession() }
        .accessibilityIdentifier("session.sheet")
    }
}

/// L'entrée dont on ouvre le détail.
struct HarnessSessionDetailRequest: Identifiable, Equatable {
    let seq: Int
    var id: Int { seq }
}

/// Une entrée du direct : un paragraphe rendu en Markdown, un raisonnement replié, un
/// outil (son état, son intention, sa commande, son résultat replié) ou un signal.
/// `open` ouvre son détail, quand le serveur en garde un.
struct HarnessSessionEntryRow: View {
    let entry: HarnessSessionEntry
    let open: () -> Void

    var body: some View {
        switch entry.sort {
        case .tool:
            tool
        case .thinking:
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 4) {
                    Text(entry.text)
                        .italic()
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if entry.canOpenDetails { detailsButton(PipelineServerText.sessionFullText) }
                }
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
            VStack(alignment: .leading, spacing: 4) {
                MarkdownBlocksView(markdown: entry.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if entry.canOpenDetails { detailsButton(PipelineServerText.sessionFullText) }
            }
        }
    }

    private func detailsButton(_ title: String) -> some View {
        Button(action: open) {
            Label(title, systemImage: PipelineServerText.sessionDetailsSymbol)
        }
        .buttonStyle(.link)
        .font(.caption)
        .accessibilityIdentifier("session.details.\(entry.seq)")
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
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(entry.tool ?? "")
                        .font(.caption.monospaced().weight(.semibold))
                        .foregroundStyle(.secondary)
                    if let duration = entry.durationMs {
                        Text(PipelineServerText.sessionDuration(ms: duration))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    Spacer(minLength: 0)
                    if entry.canOpenDetails { detailsButton(PipelineServerText.sessionDetails) }
                }
                if !entry.text.isEmpty {
                    Text(entry.text)
                        .font(.callout.monospaced())
                        .lineLimit(3)
                        .textSelection(.enabled)
                }
                if let call = entry.distinctCall {
                    Text(call)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .textSelection(.enabled)
                }
                if let agents = entry.agents, !agents.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(agents) { agent in
                            HarnessAgentLineView(agent: agent)
                        }
                    }
                    .padding(.top, 2)
                } else if let detail = entry.detail {
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
        .accessibilityActions {
            if entry.canOpenDetails { Button(PipelineServerText.sessionDetails, action: open) }
        }
    }
}

/// Le détail d'une entrée du direct : pour un outil, son rendu lisible et son JSON brut
/// replié — relus à chaque version de l'entrée tant qu'il tourne —, pour un long
/// paragraphe ou raisonnement, son texte entier. Un serveur sans rendu (1.10) montre
/// l'appel, les arguments et la sortie.
struct HarnessSessionDetailSheet: View {
    @ObservedObject var server: HarnessModel
    let target: HarnessSessionTarget
    let seq: Int
    @Environment(\.dismiss) private var dismiss
    @State private var detail: HarnessSessionDetail?
    @State private var loaded = false
    @State private var showsRaw = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    content
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding()
            }
            .navigationTitle(title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.close) { dismiss() }
                        .keyboardShortcut(.cancelAction)
                        .accessibilityIdentifier("session.detail.close")
                }
            }
        }
        .frame(minWidth: 640, idealWidth: 820, minHeight: 480, idealHeight: 640)
        .task(id: live) {
            // Une rafale de versions (une commande qui écrit) ne coûte qu'une lecture.
            if loaded { try? await Task.sleep(for: .milliseconds(300)) }
            guard !Task.isCancelled else { return }
            if let fresh = await server.sessionDetail(target, seq: seq) { detail = fresh }
            loaded = true
        }
        .accessibilityIdentifier("session.detail")
    }

    /// L'entrée telle que le direct la tient : chacune de ses versions relit le détail.
    private var live: HarnessSessionEntry? {
        guard server.session?.target == target else { return nil }
        return server.session?.entries.last { $0.seq == seq }
    }

    private var entry: HarnessSessionEntry? { live ?? detail?.entry }

    private var title: String {
        guard let entry else { return PipelineServerText.sessionDetails }
        switch entry.sort {
        case .tool: return entry.tool ?? PipelineServerText.sessionDetails
        case .thinking: return PipelineServerText.sessionThinking
        case .text, .notice: return PipelineServerText.sessionFullText
        }
    }

    @ViewBuilder
    private var content: some View {
        if let detail, let entry {
            header(entry)
            if entry.isTool, detail.hasRendering, let view = detail.view {
                if view.showsHeadline {
                    Text(view.headline)
                        .font(.title3.monospaced())
                        .textSelection(.enabled)
                }
                // L'intention de l'agent, quand elle dit autre chose que l'appel.
                if entry.distinctCall != nil {
                    Text(entry.text)
                        .foregroundStyle(.secondary)
                }
                HarnessToolBlocksView(blocks: view.blocks)
                if detail.args != nil || detail.result != nil {
                    DisclosureGroup(PipelineServerText.sessionRawJSON, isExpanded: $showsRaw) {
                        VStack(alignment: .leading, spacing: 12) {
                            if let args = detail.args {
                                section(PipelineServerText.sessionRawArguments) { code(args) }
                            }
                            if let result = detail.result {
                                section(PipelineServerText.sessionRawResult) { code(result) }
                            }
                        }
                        .padding(.top, 6)
                    }
                    .accessibilityIdentifier("session.detail.raw")
                }
            } else if entry.isTool {
                if let call = entry.call {
                    section(PipelineServerText.sessionCall) { code(call) }
                }
                if let args = detail.args {
                    section(PipelineServerText.sessionArguments) { code(args) }
                }
                section(PipelineServerText.sessionOutput) {
                    if let output = detail.output {
                        code(output, failure: entry.isFailure)
                    } else {
                        Text(PipelineServerText.sessionNoOutput)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if entry.isThinking {
                Text(detail.output ?? entry.text)
                    .italic()
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                MarkdownBlocksView(markdown: detail.output ?? entry.text)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else if loaded {
            Text(PipelineServerText.sessionDetailUnavailable)
                .foregroundStyle(.secondary)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity)
        }
    }

    /// L'état de l'outil, son étape et sa durée.
    private func header(_ entry: HarnessSessionEntry) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if entry.isRunning {
                ProgressView()
                    .controlSize(.small)
            } else {
                Image(systemName: PipelineServerText.sessionEntrySymbol(kind: entry.kind, status: entry.status))
                    .foregroundStyle(entry.isTool ? (entry.isFailure ? Color.red : Color.green) : Color.secondary)
                    .accessibilityHidden(true)
            }
            if entry.isTool {
                Text(PipelineServerText.toolStatus(entry.status))
            }
            if let step = entry.step {
                Text(PipelineServerText.sessionStep(HarnessRun.label(forStep: step)))
                    .foregroundStyle(.secondary)
            }
            if let duration = entry.durationMs {
                Text(PipelineServerText.sessionDuration(ms: duration))
                    .foregroundStyle(.secondary)
            }
        }
        .font(.callout)
    }

    private func section<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.headline)
                .accessibilityAddTraits(.isHeader)
            content()
        }
    }

    /// Un texte d'outil tel quel, en chasse fixe : une ligne longue défile, sans élargir la feuille.
    private func code(_ text: String, failure: Bool = false) -> some View {
        ScrollView(.horizontal) {
            Text(text)
                .font(.callout.monospaced())
                .foregroundStyle(failure ? Color.red : Color.primary)
                .textSelection(.enabled)
                .fixedSize(horizontal: true, vertical: false)
                .padding(8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 6))
    }
}
