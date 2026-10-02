// La feuille « Choisir un répertoire » (S-2, BR-4) : une entrée par worktree de
// feature du pipeline PLUS le dépôt principal, sans aucune saisie de chemin.
//
// La liste EST le catalogue de la visionneuse de fichiers (`TargetCatalog.list`,
// délégué) : il n'existe pas de seconde énumération de worktrees, donc pas de
// seconde vérité sur ce qu'est une cible.
//
// Aucun `@State` : la sélection vit dans le modèle. « Ouvrir » est le bouton par
// défaut, « Annuler » la sortie par Échap, et « Ouvrir » reste désactivé sans
// sélection valide.

import SwiftUI

struct TerminalLaunchSheet: View {
    @ObservedObject var model: TerminalConsoleModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(TerminalViewText.pickerTitle)
                .font(.headline)

            HStack(spacing: 8) {
                Text(TerminalViewText.targetPath)
                Text(model.projectPath ?? "—")
                    .font(.system(.callout, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("terminal.launch.repository")
                Spacer(minLength: 8)
            }

            listContent

            if let error = model.sheetError {
                Text(verbatim: error)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("terminal.launch.error")
            }

            HStack(spacing: 8) {
                if case .failed = model.targetsState {
                    Button(TerminalViewText.retry) { model.retryTargets() }
                        .accessibilityIdentifier("terminal.launch.retry")
                }
                Spacer(minLength: 0)
                Button(TerminalViewText.cancel) { model.dismissPicker() }
                    .keyboardShortcut(.cancelAction)
                    .accessibilityIdentifier("terminal.launch.cancel")
                Button(TerminalViewText.open) { model.openSelectedTarget() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canOpenSelected)
                    .accessibilityIdentifier("terminal.launch.commit")
            }
        }
        .padding(20)
        .frame(minWidth: 540, minHeight: 360)
    }

    private var selection: Binding<String?> {
        Binding(get: { model.selectedTargetPath }, set: { model.selectedTargetPath = $0 })
    }

    /// Les quatre états de S-2, chacun avec son texte : `loading`, `ready` (la
    /// liste), `empty` (la note, la liste restant utilisable) et `failed`.
    @ViewBuilder private var listContent: some View {
        switch model.targetsState {
        case .idle, .loading:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(TerminalViewText.loadingTargets)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, minHeight: 180, alignment: .center)
            .accessibilityIdentifier("terminal.launch.list")
        case let .failed(message):
            ContentUnavailableView(
                TerminalViewText.pickerTitle,
                systemImage: "exclamationmark.triangle",
                description: Text(verbatim: message)
            )
            .frame(maxWidth: .infinity, minHeight: 180)
            .accessibilityIdentifier("terminal.launch.list")
        case .ready, .empty:
            VStack(alignment: .leading, spacing: 6) {
                if case .empty = model.targetsState {
                    Text(TerminalViewText.emptyTargets)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                List(selection: selection) {
                    ForEach(model.targets) { target in
                        targetRow(target)
                            .tag(target.path)
                    }
                }
                .frame(minHeight: 180)
                .accessibilityIdentifier("terminal.launch.list")
            }
        }
    }

    private func targetRow(_ target: FilesTarget) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(target.label)
            if let branch = target.branch {
                Text(branch)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        // Double-clic = « Ouvrir » (S-2), en geste SIMULTANÉ pour ne pas manger la
        // sélection d'un simple clic, qui reste celle de la liste.
        .simultaneousGesture(TapGesture(count: 2).onEnded {
            model.selectedTargetPath = target.path
            model.openSelectedTarget()
        })
    }
}
