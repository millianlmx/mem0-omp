// La feuille « Nouvelle feature » (S-6 de omp-console-redesign) : dépôt, titre,
// besoin, puis « Lancer ». Présentée par la barre d'outils, par ⌘N et par l'écran
// de première fois de l'Accueil ; elle remplace le formulaire du tableau.
//
// Comme sur iOS (parite-mac-des-correctifs-ios, S-8, S-9) : chaque dépôt est
// nommé par `KanbanLaunchRepos.choices` (nom du dossier, « nom (parent) » pour
// les homonymes, jamais de chemin) et « Lancer » mène à Pipelines.
//
// L'état vit dans `ActionsModel` (`@State` interdit sous les CLT) : annuler garde
// la saisie, et la rouvrir la retrouve. Les liaisons passent par l'`ObservedObject`
// ou par `Binding(get:set:)`.

import AppKit
import ConsoleCore
import SwiftUI

struct NewFeatureSheet: View {
    @ObservedObject var actions: ActionsModel
    @ObservedObject var kanban: KanbanModel
    @ObservedObject var home: HomeModel
    @ObservedObject var console: ConsoleModel

    var body: some View {
        let projectRoot = ProjectRoot.resolve(defaults: .standard, fileManager: .default)?.path
        let options = LaunchRepo.options(
            cards: kanban.state.kanbanBoard?.cards ?? [],
            projectRoot: projectRoot,
            chosen: actions.launchRepoRoot
        )
        let fallback = KanbanLaunchRepos.defaultSelection(
            options: options,
            selectedRepoRoot: kanban.selectedCard?.action?.repoRoot,
            projectRoot: projectRoot
        )
        let selected: String = {
            if let chosen = actions.launchRepoRoot, options.contains(chosen) { return chosen }
            return fallback ?? ""
        }()
        let selection = Binding<String>(
            get: { selected },
            set: { actions.launchRepoRoot = $0.isEmpty ? nil : $0 }
        )
        let ready = !selected.isEmpty
            && LaunchRepo.isGitRoot(path: selected)
            && !Self.isBlank(actions.launchTitle)
            && !Self.isBlank(actions.launchDescription)
            && home.canLaunch

        VStack(alignment: .leading, spacing: 14) {
            Text(NewFeatureText.title)
                .font(.title2)
                .bold()

            VStack(alignment: .leading, spacing: 6) {
                Text(NewFeatureText.repo).font(.headline)
                HStack(spacing: 8) {
                    if options.isEmpty {
                        Text(NewFeatureText.noRepo)
                            .foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    } else {
                        Picker(NewFeatureText.repo, selection: selection) {
                            ForEach(KanbanLaunchRepos.choices(options)) { choice in
                                Text(verbatim: choice.label).tag(choice.root)
                            }
                        }
                        .labelsHidden()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityIdentifier("launch.repo")
                    }
                    Button(NewFeatureText.chooseFolder) { chooseFolder() }
                        .accessibilityIdentifier("launch.chooseFolder")
                }
                if let error = actions.launchRepoError {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(.red)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier("launch.repoError")
                }
            }

            ModelSlotsPicker(
                catalog: actions.modelCatalog,
                names: actions.modelNames,
                reqSpecs: $actions.launchModelReqSpecs,
                implReview: $actions.launchModelImplReview,
                onRetry: { actions.loadModelCatalog() }
            )

            VStack(alignment: .leading, spacing: 6) {
                Text(NewFeatureText.featureTitle).font(.headline)
                TextField(NewFeatureText.titlePlaceholder, text: $actions.launchTitle)
                    .textFieldStyle(.roundedBorder)
                    .accessibilityIdentifier("launch.title")
                Text(NewFeatureText.titleHelp)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text(NewFeatureText.need).font(.headline)
                ZStack(alignment: .topLeading) {
                    TextEditor(text: $actions.launchDescription)
                        .font(.body)
                        .frame(minHeight: 100)
                        .scrollContentBackground(.hidden)
                        .padding(4)
                        .background(Color(nsColor: .textBackgroundColor))
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.3)))
                        .accessibilityIdentifier("launch.description")
                    if actions.launchDescription.isEmpty {
                        Text(NewFeatureText.needPlaceholder)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .allowsHitTesting(false)
                    }
                }
            }

            HStack(spacing: 8) {
                Spacer()
                Button(NewFeatureText.cancel) { actions.launchFormShown = false }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("launch.cancel")
                Button(NewFeatureText.launch) {
                    Self.submit(actions: actions, console: console, repoRoot: selected)
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!ready)
                .accessibilityIdentifier("launch.submit")
            }
        }
        .padding(20)
        .frame(width: 520)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("launch.sheet")
    }

    /// « Lancer » : la commande part, la feuille se ferme (`launch` remet
    /// `launchFormShown` à faux) et Pipelines s'affiche, comme sur iOS.
    @MainActor
    static func submit(actions: ActionsModel, console: ConsoleModel, repoRoot: String) {
        actions.launch(
            title: actions.launchTitle,
            description: actions.launchDescription,
            repoRoot: repoRoot,
            modelReqSpecs: actions.launchModelReqSpecs,
            modelImplReview: actions.launchModelImplReview
        )
        actions.launchRepoError = nil
        console.showLaunchedFeature()
    }

    /// « Choisir un dossier… » : un dossier qui n'est pas une racine git est
    /// refusé avec son motif, la sélection restant inchangée ; annuler ne fait rien.
    @MainActor
    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.prompt = NewFeatureText.panelPrompt
        panel.message = NewFeatureText.panelMessage
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if LaunchRepo.isGitRoot(path: url.path) {
            actions.launchRepoRoot = realpathOr(url.path)
            actions.launchRepoError = nil
        } else {
            actions.launchRepoError = NewFeatureText.notGitRoot
        }
    }

    private static func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
