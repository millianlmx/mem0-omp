import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// Le Tableau, poussé dans la pile de l'onglet Fils : les fils en colonnes par phase, partagés
// avec le Mac (`OSBoardView`). La page ne lance aucune lecture à l'ouverture ni quand les fils
// changent : elle montre ce que la coque tient déjà ; `reload` ne part que du tirer-pour-actualiser
// et de ⌘R.

struct IOSOSBoardPage: View {
    @ObservedObject var server: HarnessModel
    let drafts: HarnessDrafts
    let workspace: OSWorkspace
    let threads: [OSThread]
    /// La première lecture a abouti et ses fils sont regroupés.
    let loaded: Bool
    let reload: @MainActor () async -> Void

    var body: some View {
        OSBoardView(
            threads: threads, loaded: loaded, isConfigured: server.isConfigured, failure: server.failure,
            workspace: workspace, drafts: drafts
        )
        .refreshable { await reload() }
        .navigationTitle(OSText.board)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                IOSOSAskButton(server: server, drafts: drafts)
            }
        }
        .focusedSceneValue(\.iosRefresh, IOSCommandAction(owner: "ios.os.screen.board", isEnabled: server.isConfigured) {
            Task { await reload() }
        })
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("ios.os.screen.board")
    }
}
