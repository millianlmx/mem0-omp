// La section « Fichiers » (BR-2) : l'en-tête (choix de cible, accès dédiés,
// rafraîchissement), l'arbre à gauche, le document à droite.
//
// Aucun attribut macro n'est employé ici (`@State`, `@Preview` ne compilent pas sous
// les Command Line Tools, D3) : l'état vit dans `FilesModel` et les liens sont
// construits à la main (`Binding(get:set:)`), comme la sélection de la coque.
//
// Tous les textes affichés viennent de `FilesText` : une erreur, un texte — la vue
// ne compose jamais un message, et un test peut donc les figer.

import AppKit
import SwiftUI

struct FilesView: ConsoleSectionView {
    static let section = ConsoleSection.files

    @ObservedObject var model: FilesModel

    var body: some View {
        VStack(spacing: 0) {
            header
            if let notice = model.notice {
                noticeBar(notice)
            }
            Divider()
            content
        }
        // Le premier chargement suit l'apparition de la section, et la veille est
        // libérée quand elle disparaît (S-7).
        .task { await model.refresh() }
        .onDisappear { model.suspend() }
    }

    // MARK: - En-tête

    private var header: some View {
        HStack(spacing: 8) {
            Picker(FilesText.targetPicker, selection: targetSelection) {
                ForEach(model.targets) { target in
                    Text(target.label)
                        .tag(Optional(target.path))
                }
            }
            .frame(maxWidth: 300)
            .disabled(model.targets.isEmpty)
            .help(model.target?.path ?? "")

            Button {
                model.openContract()
            } label: {
                Label(FilesText.contractButton, systemImage: "doc.plaintext")
            }

            Button {
                model.openProjectDocument()
            } label: {
                Label(FilesText.projectButton, systemImage: "doc.richtext")
            }

            Button {
                Task { await model.refresh() }
            } label: {
                Label(FilesText.refresh, systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: .command)
            .disabled(model.isLoading)

            Spacer()
        }
        .padding(8)
    }

    private func noticeBar(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
            Text(verbatim: text)
            Spacer()
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
    }

    /// La `List` exige une `Binding<String?>` : une écriture est résolue en entrée de
    /// l'arbre par le modèle (une ligne sans fichier correspondant est ignorée).
    private var targetSelection: Binding<String?> {
        Binding(
            get: { model.target?.path },
            set: { path in
                guard let path, let target = model.targets.first(where: { $0.path == path }) else { return }
                model.select(target: target)
            }
        )
    }

    // MARK: - Corps : chaque état de la section

    @ViewBuilder private var content: some View {
        if model.projectRoot == nil, model.errorMessage == nil {
            ContentUnavailableView(
                FilesText.noProjectTitle,
                systemImage: "folder.badge.questionmark",
                description: Text(FilesText.noProjectDescription)
            )
        } else if let error = model.errorMessage {
            ContentUnavailableView(
                FilesText.errorTitle,
                systemImage: "exclamationmark.triangle",
                description: Text(verbatim: error)
            )
        } else if model.isLoading, model.tree == nil {
            VStack(spacing: 10) {
                ProgressView()
                Text(verbatim: FilesText.loading(model.target?.path ?? model.projectRoot?.path ?? ""))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            HSplitView {
                treeColumn
                documentColumn
            }
        }
    }

    // MARK: - L'arbre

    @ViewBuilder private var treeColumn: some View {
        if model.nodes.isEmpty {
            Text(FilesText.noFiles)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding()
        } else {
            List(selection: treeSelection) {
                ForEach(model.nodes) { node in
                    FilesNodeRow(node: node, model: model)
                }
            }
            .listStyle(.sidebar)
            .frame(minWidth: 220)
        }
    }

    private var treeSelection: Binding<String?> {
        Binding(
            get: { model.highlight },
            set: { path in
                guard let path else { return }
                model.select(path: path)
            }
        )
    }

    // MARK: - Le document

    private var documentColumn: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 0) {
                documentHeader
                Divider()
                documentBody
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(minWidth: 320)
    }

    @ViewBuilder private var documentHeader: some View {
        switch model.pane {
        case .none:
            EmptyView()
        case let .file(entry):
            HStack(spacing: 8) {
                Text(verbatim: entry.path)
                    .font(.headline)
                Text(verbatim: FilesText.badge(for: entry.kind))
                    .foregroundStyle(.secondary)
                if let base = model.diffBase {
                    Text(verbatim: base.label)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }
            .padding(8)
        case .contract:
            dedicatedHeader(FilesModel.contractRelativePath)
        case .projectDocument:
            dedicatedHeader(FilesModel.projectDocumentRelativePath)
        }
    }

    private func dedicatedHeader(_ title: String) -> some View {
        HStack {
            Text(verbatim: title)
                .font(.headline)
            Spacer()
        }
        .padding(8)
    }

    @ViewBuilder private var documentBody: some View {
        switch model.pane {
        case .none:
            Text(FilesText.nothingSelected)
                .foregroundStyle(.secondary)
                .padding(8)
        case .file:
            diffSection
            Divider()
            contentSection(dedicated: nil)
        case .contract:
            contentSection(dedicated: FilesModel.contractRelativePath)
        case .projectDocument:
            contentSection(dedicated: FilesModel.projectDocumentRelativePath)
        }
    }

    @ViewBuilder private var diffSection: some View {
        if let failure = model.diffFailure {
            message(failure)
        } else if case let .unavailable(reason)? = model.diffBase {
            message(FilesText.baseUnavailable(reason: reason))
        } else if let diff = model.diff {
            if diff.isEmpty {
                message(FilesText.noDifference(base: model.diffBase?.label ?? "HEAD"))
            } else {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(diff.lines.enumerated()), id: \.offset) { _, line in
                        Text(verbatim: line.text)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(lineStyle(line))
                            .textSelection(.enabled)
                            // Les lignes très longues ne sont pas repliées : la
                            // colonne défile horizontalement.
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
                if diff.hasNoContent {
                    message(FilesText.emptyNewFile)
                }
            }
        }
    }

    @ViewBuilder private func contentSection(dedicated: String?) -> some View {
        if let content = model.content {
            if let message = content.message(dedicated: dedicated) {
                self.message(message)
            } else if case let .text(text) = content {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines(of: text).enumerated()), id: \.offset) { _, line in
                        Text(verbatim: line)
                            .font(.system(.body, design: .monospaced))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                }
            }
        }
    }

    private func message(_ text: String) -> some View {
        Text(verbatim: text)
            .foregroundStyle(.secondary)
            .padding(8)
    }

    /// Le rouge d'un retrait, le vert d'un ajout, et rien d'autre : la distinction
    /// ne repose jamais sur la couleur seule (le `+`/`-` de tête est toujours là).
    private func lineStyle(_ line: FilesDiffLine) -> Color {
        if let tint = line.tint { return Color(nsColor: tint) }
        return line.isSecondary ? Color.secondary : Color.primary
    }

    private func lines(of text: String) -> [String] {
        text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }
}

/// Une ligne de l'arbre : un `DisclosureGroup` pour un répertoire (dont l'état de
/// dépliage vient du modèle, jamais d'un `@State`), un fichier avec son badge
/// sinon.
private struct FilesNodeRow: View {
    let node: FilesNode
    @ObservedObject var model: FilesModel

    var body: some View {
        if node.isDirectory {
            DisclosureGroup(isExpanded: expansion) {
                ForEach(node.children) { child in
                    FilesNodeRow(node: child, model: model)
                }
            } label: {
                Label(node.name, systemImage: "folder")
            }
        } else {
            Label {
                if let entry = node.entry, entry.kind == .deleted {
                    HStack(spacing: 6) {
                        Text(verbatim: FilesText.deletedBadge)
                            .foregroundStyle(.secondary)
                        Text(verbatim: node.name)
                    }
                } else {
                    Text(verbatim: node.name)
                }
            } icon: {
                Image(systemName: "doc.text")
            }
            .tag(node.path)
        }
    }

    /// Le setter reçoit la NOUVELLE valeur, et le getter lit l'état courant :
    /// inverser produit donc exactement la valeur demandée.
    private var expansion: Binding<Bool> {
        Binding(
            get: { model.expanded.contains(node.path) },
            set: { _ in model.toggle(directory: node.path) }
        )
    }
}
