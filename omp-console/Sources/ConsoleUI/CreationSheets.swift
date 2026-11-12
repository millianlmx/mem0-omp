// Les FEUILLES de création, écrites une fois pour le Mac et l'iPhone/iPad : « Nouveau
// projet » et « Nouvel audit » — ouvertes par le menu « Nouveau » de l'OS et la palette
// (`drafts.projectSheetShown`, `drafts.auditSheetShown`), jamais un formulaire en tête
// d'écran. Elles sont posées par `consolePalette`, à la racine.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// « Nouveau projet » : un dépôt, un nom, et ses features une à une.
struct NewProjectSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        NavigationStack {
            Form {
                if let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                Section {
                    RepoPicker(server: server, drafts: drafts)
                    TextField(PipelineServerText.projectTitleLabel, text: $drafts.projectTitle)
                        .consoleID("project.launch.title")
                } footer: {
                    Text(PipelineServerText.launchProjectHint)
                }
                ForEach(Array($drafts.features.enumerated()), id: \.element.id) { index, $feature in
                    Section {
                        TextField(PipelineServerText.titleLabel, text: $feature.title)
                        TextField(PipelineServerText.requestLabel, text: $feature.request, axis: .vertical)
                            .lineLimit(2...6)
                        TextField(PipelineServerText.modulesLabel, text: $feature.modules)
                        if drafts.features.count > 1 {
                            Button(PipelineServerText.removeFeature, role: .destructive) { drafts.removeFeature(feature.id) }
                        }
                    } header: {
                        Text(PipelineServerText.questionIndex(index + 1, of: drafts.features.count))
                    }
                }
                Section {
                    Button(PipelineServerText.addFeature, systemImage: "plus") { drafts.addFeature() }
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.launchProjectTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.projectSheetShown = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.launch) {
                        guard let repo = drafts.launchRepo(in: server.repos) else { return }
                        let title = drafts.projectTitle
                        let features = drafts.features
                        Task {
                            if await server.launchProject(repo: repo, title: title, features: features) != nil {
                                drafts.clearProject()
                                drafts.projectSheetShown = false
                            }
                        }
                    }
                    .disabled(!drafts.canLaunchProject || server.isLaunching || server.repos.isEmpty)
                    .consoleID("project.launch.commit")
                }
            }
        }
        .consoleSheetSize(minWidth: 540, minHeight: 560)
        .task { await server.refreshCatalog() }
    }
}

/// « Nouvel audit » : un dépôt et un périmètre (vide : le dépôt entier).
struct NewAuditSheet: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        NavigationStack {
            Form {
                if let failure = server.failure {
                    ConsoleFailureBanner(failure: failure)
                }
                Section {
                    RepoPicker(server: server, drafts: drafts)
                    TextField(PipelineServerText.focusLabel, text: $drafts.auditFocus, prompt: Text(PipelineServerText.focusPrompt))
                        .consoleID("audit.launch.focus")
                } footer: {
                    Text(PipelineServerText.launchAuditHint)
                }
            }
            .formStyle(.grouped)
            .navigationTitle(PipelineServerText.launchAuditTitle)
            .consoleInlineTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(PipelineServerText.cancel) { drafts.auditSheetShown = false }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(PipelineServerText.launch) {
                        guard let repo = drafts.launchRepo(in: server.repos) else { return }
                        let focus = drafts.auditFocus
                        Task {
                            if await server.launchAudit(repo: repo, focus: focus) != nil {
                                drafts.auditFocus = ""
                                drafts.auditSheetShown = false
                            }
                        }
                    }
                    .disabled(server.isLaunching || server.repos.isEmpty)
                    .consoleID("audit.launch.commit")
                }
            }
        }
        .consoleSheetSize(minWidth: 480, minHeight: 300)
        .task { await server.refreshCatalog() }
    }
}
