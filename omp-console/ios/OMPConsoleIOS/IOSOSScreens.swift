import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// Les écrans de la coque de la nouvelle interface (`IOSOSRootView`) : le cadre de la racine
// d'un onglet, la page d'un fil, « Comprendre » et le direct d'une feature qu'il montre, et
// le bouton « Demander » de chaque barre. Les contenus sont partagés avec le Mac
// (`ConsoleUI/OS/`) ; les mots viennent du noyau (`OSText`, `PipelineServerText`) et de
// `IOSOSText` : aucun libellé en dur ici (`design-ios/AC-5`).

/// Le cadre de la racine d'un onglet : relier le serveur s'il ne l'est pas, sinon le
/// contenu, avec l'échec du dernier échange en tête, le titre de l'onglet, « Demander »
/// dans la barre et le tirer-pour-actualiser.
struct IOSOSScreen<Content: View>: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let tab: IOSOSTab
    let reload: @MainActor () async -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        Group {
            if !server.isLoaded {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if !server.isConfigured {
                IOSServerPrompt(drafts: drafts)
            } else {
                VStack(spacing: 0) {
                    if let failure = server.failure {
                        Text(failure.message)
                            .font(.callout)
                            .iosBanner(tone: .attention)
                            .padding(.horizontal)
                            .padding(.top, 8)
                    }
                    content()
                        .refreshable { await reload() }
                }
            }
        }
        .navigationTitle(tab.title)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                IOSOSAskButton(server: server, drafts: drafts)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.os.screen." + tab.rawValue)
    }
}

/// « Demander » : le bouton de barre de chaque onglet et de la page d'un fil. Il ouvre la
/// feuille du composeur (la Demande, posée à la racine par la palette).
struct IOSOSAskButton: View {
    @ObservedObject var server: HarnessModel
    let drafts: HarnessDrafts

    var body: some View {
        Button {
            drafts.openIntake()
        } label: {
            Label(IOSOSText.ask, systemImage: IOSOSText.askSymbol)
        }
        .disabled(!server.isConfigured || !server.canAct)
        .accessibilityIdentifier("ios.os.ask")
    }
}

/// La page d'un fil, poussée dans la pile de son onglet : le récit en cartes partagé avec
/// le Mac, « Comprendre » et « Demander » dans la barre. Un fil que le serveur ne connaît
/// plus le dit, sans écran vide.
struct IOSOSThreadPage: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workspace: OSWorkspace
    let thread: OSThread?
    /// L'historique a été lu : un fil absent n'existe plus.
    let loaded: Bool
    let browsers: [String: String]
    let reload: @MainActor () async -> Void

    var body: some View {
        Group {
            if let thread {
                OSThreadView(
                    server: server, workstation: server.workstation, intakes: server.intakes, pulse: workspace.pulse,
                    workspace: workspace, thread: thread, browsers: browsers, drafts: drafts
                )
                .id(thread.id)
                .refreshable { await reload() }
                .navigationTitle(thread.title)
            } else if loaded {
                ContentUnavailableView(IOSOSText.threadGone, systemImage: IOSOSText.threadGoneSymbol)
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // Le titre du fil est dans l'en-tête de la page : la barre ne le répète pas.
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(removing: .title)
        .toolbar {
            if let run = thread?.focusRun {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        workspace.understand(runId: run.id, level: workspace.level)
                    } label: {
                        Label(OSText.understand, systemImage: IOSOSText.understandSymbol)
                    }
                    .accessibilityIdentifier("ios.os.understand")
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                IOSOSAskButton(server: server, drafts: drafts)
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.os.screen.thread")
    }
}

/// « Comprendre » : le zoom en quatre niveaux sur une feature (partagé avec le Mac), dans
/// sa pile — une entrée du direct y pousse son détail — avec « Fermer » dans la barre.
struct IOSOSUnderstandPanel: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    @ObservedObject var workspace: OSWorkspace
    let runId: String?

    var body: some View {
        NavigationStack {
            Group {
                if let runId {
                    OSUnderstandView(server: server, drafts: drafts, workspace: workspace, runId: runId) { [server] runId, pane, followsEnd, focus in
                        AnyView(IOSOSSessionPane(server: server, runId: runId, tab: pane.iosTab, followsEnd: followsEnd, focus: focus))
                    }
                    .id(runId)
                } else {
                    ContentUnavailableView(OSText.noRun, systemImage: IOSOSText.threadGoneSymbol)
                }
            }
            .navigationTitle(OSText.understand)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.close) { workspace.understanding = false }
                        .accessibilityIdentifier("ios.os.understand.close")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.os.understand.panel")
    }
}

/// Le direct d'une feature dans « Comprendre » : le contenu partagé du direct de l'app
/// (`IOSSessionSections`), qui suit la fin et défile jusqu'à l'entrée qu'un nœud du récit
/// désigne.
struct IOSOSSessionPane: View {
    @ObservedObject var server: HarnessModel
    let runId: String
    let tab: IOSSessionTab
    @Binding var followsEnd: Bool
    @Binding var focus: Int?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var target: HarnessSessionTarget { .run(runId) }

    var body: some View {
        ScrollViewReader { proxy in
            List {
                IOSSessionSections(server: server, target: target, tab: tab, followsEnd: $followsEnd)
            }
            .iosGroupedList()
            .iosFollowsSessionEnd(server: server, target: target, shown: tab == .live, followsEnd: followsEnd, proxy: proxy)
            .onChange(of: focus, initial: true) { _, seq in
                guard let seq else { return }
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(150))
                    withAnimation(IOSMotion.scrollAnimation(reduceMotion: reduceMotion)) {
                        proxy.scrollTo(seq, anchor: .center)
                    }
                    focus = nil
                }
            }
        }
        // Le texte de l'agent, ses commandes et leurs résultats se copient.
        .textSelection(.enabled)
    }
}

private extension OSSessionPane {
    /// Le contenu du direct de l'app iOS.
    var iosTab: IOSSessionTab {
        // Le dernier cas est celui des fichiers touchés.
        switch self {
        case .live: .live
        case .tests: .tests
        case .timeline: .timeline
        default: .changes
        }
    }
}
