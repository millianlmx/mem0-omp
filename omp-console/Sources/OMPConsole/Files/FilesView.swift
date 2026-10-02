// La section « Fichiers » (BR-2) : la barre d'outils de la fenêtre (cible, accès
// dédiés, mode du document, rafraîchissement), l'arbre à gauche, le document à
// droite.
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
            if let notice = model.notice {
                noticeBar(notice)
            }
            content
        }
        // La section vit dans la colonne de détail : ses éléments rejoignent la
        // barre d'outils de la fenêtre et disparaissent avec elle.
        .toolbar { toolbarContent }
        // Le premier chargement suit l'apparition de la section, et la veille est
        // libérée quand elle disparaît (S-7).
        .task { await model.refresh() }
        .onDisappear { model.suspend() }
    }

    // MARK: - Barre d'outils

    @ToolbarContentBuilder private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            targetPicker
        }
        if availableModes.count > 1 {
            ToolbarItem(placement: .principal) {
                modePicker
            }
        }
        ToolbarItem(placement: .primaryAction) {
            Menu {
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
            } label: {
                Label(FilesText.openMenu, systemImage: "doc.text")
            }
            .help(FilesText.openHelp)
            .disabled(model.target == nil)
            .accessibilityIdentifier("files.open")
        }
        ToolbarItem(placement: .primaryAction) {
            Button {
                Task { await model.refresh() }
            } label: {
                Label(FilesText.refresh, systemImage: "arrow.clockwise")
            }
            .help(FilesText.refresh)
            .keyboardShortcut("r", modifiers: .command)
            .disabled(model.isLoading)
            .accessibilityIdentifier("files.refresh")
        }
    }

    private var targetPicker: some View {
        Picker(FilesText.targetPicker, selection: targetSelection) {
            ForEach(model.targets) { target in
                Text(verbatim: target.label)
                    .tag(Optional(target.path))
            }
        }
        // MESURÉ (2026-10-01, sonde /tmp/pickerprobe) : la barre d'outils impose un
        // style d'étiquette « icône seule » ; un Picker aux options texte s'y dessine
        // VIDE. Le titre seul rend la cible choisie lisible.
        .labelStyle(.titleOnly)
        .disabled(model.targets.isEmpty)
        .help(model.target.map { ConsoleFormat.path($0.path) } ?? FilesText.targetPicker)
        .accessibilityIdentifier("files.target")
    }

    private func noticeBar(_ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "exclamationmark.triangle")
            Text(verbatim: text)
            Spacer()
        }
        .font(.callout)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .consoleBanner(tint: .orange)
        .padding(8)
    }

    /// Le Picker exige une `Binding<String?>` : une écriture est résolue en cible
    /// par le modèle (un chemin sans cible correspondante est ignoré).
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
                Text(verbatim: FilesText.loading(loadingName))
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

    /// Le nom de ce qui se lit : la cible choisie, sinon le dossier du projet, en
    /// chemin lisible (`~/…`) plutôt qu'absolu.
    private var loadingName: String {
        if let target = model.target { return target.label }
        return model.projectRoot.map { ConsoleFormat.path($0.path) } ?? ""
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
            // Un fond de contenu, pas celui d'une barre latérale : la seule barre
            // latérale de la fenêtre est celle des sections.
            .listStyle(.inset)
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
        VStack(spacing: 0) {
            documentHeader
            Divider()
            documentBody
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
                if let badge = FilesText.badge(for: entry.kind) {
                    Text(verbatim: badge)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if mode == .diff, let comparison = model.diffBase.flatMap(FilesText.comparison) {
                    Text(verbatim: comparison)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(8)
        case .contract:
            dedicatedHeader(FilesModel.contractRelativePath)
        case .projectDocument:
            dedicatedHeader(FilesModel.projectDocumentRelativePath)
        }
    }

    private func dedicatedHeader(_ title: String) -> some View {
        Text(verbatim: title)
            .font(.headline)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(8)
    }

    // MARK: - Les vues du document (S-18 R5)

    private var language: CodeLanguage {
        model.pane.documentPath.map(CodeLanguage.from(path:)) ?? .plain
    }

    private var availableModes: [FilesDocumentMode] {
        var hasDiff = false
        if case .file = model.pane { hasDiff = true }
        return FilesDocumentMode.available(isMarkdown: language == .markdown, hasDiff: hasDiff)
    }

    private var mode: FilesDocumentMode {
        model.documentMode.effective(in: availableModes)
    }

    /// Présent dans la barre d'outils seulement quand le document a plusieurs vues.
    private var modePicker: some View {
        Picker(FilesText.modePicker, selection: modeSelection) {
            ForEach(availableModes, id: \.self) { mode in
                Text(FilesText.title(of: mode, isMarkdown: language == .markdown))
                    .tag(mode)
            }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .accessibilityIdentifier("files.document.mode")
    }

    private var modeSelection: Binding<FilesDocumentMode> {
        Binding(
            get: { mode },
            set: { model.documentMode = $0 }
        )
    }

    @ViewBuilder private var documentBody: some View {
        switch model.pane {
        case .none:
            Text(FilesText.nothingSelected)
                .foregroundStyle(.secondary)
                .padding(8)
        case .file:
            if mode == .diff {
                ScrollView(.vertical) {
                    VStack(alignment: .leading, spacing: 0) {
                        diffSection
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 8)
                }
                .background(Color(nsColor: .textBackgroundColor))
            } else {
                contentSection(dedicated: nil)
            }
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
                message(FilesText.noDifference)
            } else {
                // L'en-tête de git (`diff --git`, `index <sha>..<sha>`, `---`, `+++`)
                // ne dit rien au lecteur : seuls les hunks et les notes s'affichent.
                let shown = diff.lines.filter { $0.kind != .header }
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(shown.indices, id: \.self) { index in
                        Text(verbatim: shown[index].text)
                            .font(.system(.body, design: .monospaced))
                            .foregroundStyle(lineStyle(shown[index]))
                            .textSelection(.enabled)
                            // Une ligne trop longue se replie : rien n'est rogné.
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                    }
                }
                if diff.hasNoContent {
                    message(FilesText.emptyNewFile)
                }
            }
        }
    }

    /// Un Markdown se lit RENDU (ou en source numérotée) ; tout autre texte passe
    /// par la visionneuse de code. Les messages d'état sont ceux d'avant S-18.
    @ViewBuilder private func contentSection(dedicated: String?) -> some View {
        if let content = model.content {
            if let message = content.message(dedicated: dedicated) {
                self.message(message)
            } else if case let .text(text) = content {
                if language == .markdown, mode == .content {
                    MarkdownDocumentView(blocks: FilesRenderMemo.blocks(text))
                } else {
                    CodeDocumentView(lines: FilesRenderMemo.lines(text, language: language))
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
}

// MARK: - Mémo du rendu

/// Le dernier document découpé, gardé d'une évaluation du corps à la suivante :
/// le corps est réévalué à chaque publication du modèle, et relexer un gros
/// fichier à chaque fois serait coûteux. Une seule entrée par nature suffit — la
/// colonne n'affiche qu'un document.
@MainActor
private enum FilesRenderMemo {
    private static var markdown: (source: String, blocks: [MarkdownBlock])?
    private static var code: (source: String, language: CodeLanguage, lines: [[CodeToken]])?

    static func blocks(_ text: String) -> [MarkdownBlock] {
        if let markdown, markdown.source == text { return markdown.blocks }
        let blocks = MarkdownDocument.blocks(text)
        markdown = (text, blocks)
        return blocks
    }

    static func lines(_ text: String, language: CodeLanguage) -> [[CodeToken]] {
        if let code, code.language == language, code.source == text { return code.lines }
        let lines = CodeHighlighter.lines(CodeHighlighter.tokens(text, language: language))
        code = (text, language, lines)
        return lines
    }
}

// MARK: - Visionneuse de code

/// Gouttière de numéros alignés à droite, texte monospacé coloré, défilement dans
/// les deux sens ; seules les lignes visibles sont construites.
private struct CodeDocumentView: View {
    let lines: [[CodeToken]]

    /// La largeur d'un chiffre de la police du corps (13 pt sur macOS).
    private static let digitWidth: CGFloat = ("0" as NSString).size(
        withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: NSFont.systemFontSize, weight: .regular)]
    ).width

    var body: some View {
        let gutter = CGFloat(max(2, String(lines.count).count)) * Self.digitWidth
        // MESURÉ (recette du 2026-10-01) : dans un défilement 2D, une `LazyVStack`
        // prend la largeur de ses lignes DÉJÀ construites ; une ligne plus longue
        // déborde alors des deux côtés et tout le texte paraît poussé à droite. La
        // largeur de la pile est donc fixée d'avance par la plus longue ligne
        // (police monospacée : largeur = nombre de caractères × largeur d'un chiffre).
        let longest = lines.map { line in line.reduce(0) { $0 + $1.text.count } }.max() ?? 0
        let width = gutter + 14 + CGFloat(longest + 1) * Self.digitWidth
        ScrollView([.horizontal, .vertical]) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(lines.indices, id: \.self) { index in
                    HStack(alignment: .firstTextBaseline, spacing: 0) {
                        Text(verbatim: String(index + 1))
                            .foregroundStyle(.secondary)
                            .monospacedDigit()
                            .frame(width: gutter, alignment: .trailing)
                            .padding(.trailing, 14)
                            .accessibilityHidden(true)
                        Text(CodePalette.attributed(lines[index], size: .body))
                            .textSelection(.enabled)
                            .fixedSize(horizontal: true, vertical: false)
                    }
                    .font(.system(.body, design: .monospaced))
                    .frame(width: width, alignment: .leading)
                }
            }
            .frame(width: width, alignment: .leading)
            .padding(.vertical, 8)
            .padding(.leading, 8)
            .padding(.trailing, 16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        // MESURÉ (recette du 2026-10-01) : un contenu plus petit que la vue est
        // CENTRÉ par un défilement 2D ; un fichier court flottait au milieu.
        .defaultScrollAnchor(.topLeading, for: .alignment)
        .defaultScrollAnchor(.topLeading, for: .initialOffset)
        .background(Color(nsColor: .textBackgroundColor))
        .accessibilityIdentifier("files.document.code")
    }
}

// MARK: - Markdown rendu

/// Une colonne de lecture d'au plus 760 pt, centrée, en typographie système.
private struct MarkdownDocumentView: View {
    let blocks: [MarkdownBlock]

    var body: some View {
        ScrollView(.vertical) {
            // Paresseux : un `MarkdownBlocksView` par bloc, seuls les visibles
            // sont construits (un long document ne bâtit pas tout d'un coup).
            LazyVStack(alignment: .leading, spacing: 14) {
                ForEach(blocks.indices, id: \.self) { index in
                    MarkdownBlocksView(blocks: [blocks[index]])
                }
            }
            .frame(maxWidth: 760, alignment: .leading)
            .padding(.horizontal, 32)
            .padding(.vertical, 24)
            .frame(maxWidth: .infinity)
        }
        .accessibilityIdentifier("files.document.markdown")
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
