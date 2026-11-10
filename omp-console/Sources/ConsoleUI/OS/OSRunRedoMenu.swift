// L'« OS agentique » : le menu REFAIRE d'une feature finie. Le gabarit du serveur
// (`GET /v1/runs/{id}/template` : sa demande d'origine et ses options) pré-remplit la
// feuille de lancement de la coque (« Refaire », « Refaire ailleurs » sur un autre dépôt)
// ou sa feuille de planification (« En faire une routine… », cible feature : il ne reste
// qu'à dire quand). Les feuilles sont celles de la coque, ouvertes par ses brouillons.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSRunRedoMenu: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts
    let run: HarnessRun
    let failed: @MainActor () -> Void
    @State private var loading = false

    /// `drafts` : les brouillons de la coque, dont elle ouvre les feuilles. `failed` : le
    /// gabarit n'a pas pu être lu (`server.failure` dit pourquoi).
    public init(server: HarnessModel, drafts: HarnessDrafts, run: HarnessRun, failed: @escaping @MainActor () -> Void = {}) {
        self.server = server
        self.drafts = drafts
        self.run = run
        self.failed = failed
    }

    public var body: some View {
        let elsewhere = server.repos.map(\.name).filter { $0 != run.repo }
        Menu {
            Button(OSDecideText.redo, systemImage: "arrow.clockwise") {
                template { launch($0, repo: $0.repo) }
            }
            if !elsewhere.isEmpty {
                Menu(OSDecideText.redoElsewhere, systemImage: "arrow.triangle.branch") {
                    ForEach(elsewhere, id: \.self) { repo in
                        Button(repo) {
                            template { launch($0, repo: repo) }
                        }
                    }
                }
            }
            Button(OSDecideText.makeRoutine, systemImage: "calendar.badge.plus") {
                template { template in
                    drafts.scheduleDraft = OSRedo.scheduleDraft(template)
                    drafts.scheduleSheetShown = true
                }
            }
        } label: {
            Label(OSDecideText.redo, systemImage: "arrow.clockwise")
        }
        .fixedSize()
        .disabled(loading)
    }

    private func launch(_ template: HarnessRunTemplate, repo: String) {
        drafts.repo = repo
        drafts.runTitle = template.title
        drafts.runRequest = template.request
        drafts.runOptions = OSRedo.launchDraft(template, repo: repo)
        drafts.launchSheetShown = true
    }

    /// Lit le gabarit, puis en fait ce que le geste demande.
    private func template(_ use: @escaping @MainActor (HarnessRunTemplate) -> Void) {
        loading = true
        Task {
            if let template = await server.runTemplate(runId: run.id) {
                use(template)
            } else {
                failed()
            }
            loading = false
        }
    }
}
