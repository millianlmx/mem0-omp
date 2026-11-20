// Le « Tableau » de l'OS agentique, partagé par le Mac (au centre de la fenêtre) et l'iPhone/iPad
// (page poussée dans l'onglet Fils) : les fils en colonnes par phase, en lecture seule. Une carte
// ouvre la page de son fil. La vue ne lance AUCUNE lecture : elle range les fils déjà construits
// (`OSThreadStore`) et suit l'état tenu par la coque (serveur relié, première lecture aboutie,
// dernier échec). La logique est dans `OSBoard`.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSBoardView: View {
    let threads: [OSThread]
    let loaded: Bool
    let isConfigured: Bool
    let failure: HarnessFailure?
    // Non observés : le tableau ne se redessine pas à chaque frappe ni à chaque sélection.
    let workspace: OSWorkspace
    let drafts: HarnessDrafts
    /// Les colonnes de `threads`, rangées quand les fils changent (`nil` avant le premier rangement).
    @State private var columns: [OSBoardColumn]?
    @Environment(\.dynamicTypeSize) private var textSize

    /// N'affecte que ses paramètres : SwiftUI rappelle `init` à chaque rendu du parent, et le
    /// rangement de milliers de fils n'a pas à le suivre.
    public init(
        threads: [OSThread], loaded: Bool, isConfigured: Bool, failure: HarnessFailure?,
        workspace: OSWorkspace, drafts: HarnessDrafts
    ) {
        self.threads = threads
        self.loaded = loaded
        self.isConfigured = isConfigured
        self.failure = failure
        self.workspace = workspace
        self.drafts = drafts
    }

    public var body: some View {
        Group {
            switch OSBoard.state(
                isConfigured: isConfigured, loaded: loaded && columns != nil, failure: failure, columns: columns ?? []
            ) {
            case .unconfigured:
                ContentUnavailableView {
                    Label(PipelineServerText.notConfigured, systemImage: "server.rack")
                } actions: {
                    Button(PipelineServerText.configure) { drafts.serverSheetShown = true }
                        .buttonStyle(.borderedProminent)
                        .consoleID("os.board.configure")
                }
            case .loading:
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .failed(failure):
                // Vertical : le tirer pour actualiser de la coque iOS s'y applique.
                ScrollView { ConsoleFailureBanner(failure: failure).padding() }
            case .empty:
                ContentUnavailableView(OSText.boardEmpty, systemImage: "rectangle.split.3x1")
            case .columns:
                board
            }
        }
        .onChange(of: threads, initial: true) { columns = OSBoard.columns(threads) }
        .consoleID("os.board")
    }

    private var board: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let failure {
                ConsoleFailureBanner(failure: failure)
                    .padding(.horizontal, OSBoard.margin)
                    .padding(.top, OSBoard.margin)
            }
            boardScroll
        }
    }

    @ViewBuilder
    private var boardScroll: some View {
        let scroll = ScrollView(.horizontal) {
            LazyHStack(alignment: .top, spacing: OSBoard.spacing) {
                ForEach(columns ?? []) { column in
                    columnView(column)
                        .containerRelativeFrame(.horizontal) { length, _ in
                            OSBoard.columnWidth(textSize, available: length)
                        }
                }
            }
            .scrollTargetLayout()
            .padding(OSBoard.margin)
        }
        #if os(iOS)
            scroll.scrollTargetBehavior(.viewAligned)
        #else
            scroll
        #endif
    }

    private func columnView(_ column: OSBoardColumn) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                OSPhaseMark(phase: column.phase, size: 13)
                Text(column.phase.label).font(.headline)
                Spacer(minLength: 0)
                Text(column.threads.count.formatted())
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(OSBoard.columnLabel(column))
            .accessibilityAddTraits(.isHeader)
            ScrollView(.vertical) {
                LazyVStack(spacing: 8) {
                    ForEach(column.threads) { thread in
                        Button {
                            workspace.open(thread.id)
                        } label: {
                            OSBoardCard(thread: thread).equatable()
                        }
                        .buttonStyle(.plain)
                        .consoleID("os.board.card")
                    }
                }
            }
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .consoleID("os.board.column." + String(column.phase.rawValue))
    }
}

/// Une carte du tableau : le titre du fil (à la ligne, jamais coupé), son lieu et ce qui attend l'humain.
/// Un seul élément d'accessibilité : titre, lieu, attente et nom de la colonne.
public struct OSBoardCard: View, Equatable {
    let thread: OSThread

    public var body: some View {
        OSCard(tint: thread.phase.color) {
            VStack(alignment: .leading, spacing: 4) {
                Text(thread.title)
                HStack {
                    Text(OSBoard.place(of: thread)).font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    if let waiting = OSBoard.waiting(of: thread) {
                        Label {
                            Text(waiting.formatted())
                        } icon: {
                            Image(systemName: OSPhase.yours.symbol)
                        }
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.orange)
                    }
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(OSBoard.cardLabel(thread))
    }
}
