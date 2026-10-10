// La fenêtre « Terminal » (S-10, BR-3) : la zone de rendu, sous un titre de
// fenêtre qui porte le nom du répertoire et un sous-titre « Shell · Actif ».
// « Choisir un dossier… » vit seul dans la barre d'outils ; « Relancer » et
// « Lancer omp », qui agissent sur le shell, partagent un même verre.
//
// CHAQUE état de la fenêtre a son rendu : `idle` sans projet (« Aucun projet
// ouvert » + « Choisir un projet… », mac-etats-vides-sans-issue), `idle` avec
// projet (« Choisissez un répertoire… » + le nom du projet), `listing` (le
// catalogue de la feuille se charge), `starting`, `running` (le shell), `exited`
// (image gelée + « Relancer »), `failed` (message d'erreur + « Relancer »). Aucun
// état n'est un rectangle vide (AC-3) : tant qu'aucun shell ne vit, c'est le
// texte de l'état qui occupe la zone, jamais un terminal vide. Ce qui s'affiche
// sans shell est décidé par `TerminalPlaceholder`, pur.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`, …) : sous les Command Line
// Tools seuls, ils échouent à la compilation. Tout l'état vit dans le modèle
// (`@ObservedObject`), et les `Binding` sont construits à la main.

import SwiftUI

struct TerminalConsoleView: View {
    @ObservedObject var model: TerminalConsoleModel
    /// Le sélecteur de projet de l'état « Aucun projet ouvert », à l'échelle de
    /// l'app.
    let chooser: ProjectChooserModel

    var body: some View {
        content
            .frame(minWidth: 480, minHeight: 360)
            // Le titre de la fenêtre est celui de la section (« Terminal ») : le
            // dossier et l'état du shell en sont le sous-titre.
            .navigationSubtitle(
                [model.windowTitle == TerminalViewText.windowTitle ? "" : model.windowTitle, model.windowSubtitle]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · ")
            )
            // Fermer la fenêtre principale tue le shell (S-7) : c'est elle qui
            // héberge désormais la section.
            .background(WindowAccessor { model.attach(window: $0) })
            .toolbar {
                // Le choix du dossier est sans rapport avec la vie du shell :
                // `ToolbarSpacer(.fixed)` le sépare du groupe (S-18 R3). Aucun
                // `.buttonStyle` : le verre est celui du système.
                ToolbarItemGroup(placement: .primaryAction) {
                    if case .starting = model.state {
                        ProgressView().controlSize(.small)
                    }
                    Button(TerminalViewText.chooseTarget) { model.openPicker() }
                        .accessibilityIdentifier("terminal.choose")
                }
                ToolbarSpacer(.fixed, placement: .primaryAction)
                ToolbarItemGroup(placement: .primaryAction) {
                    Button(TerminalViewText.relaunch) { model.relaunch() }
                        .disabled(!model.canRelaunch)
                        .accessibilityIdentifier("terminal.relaunch")
                    Button(TerminalViewText.launchOmp) { model.launchOmp() }
                        .disabled(!model.canLaunchOmp)
                        .accessibilityIdentifier("terminal.launchOmp")
                }
            }
            .sheet(isPresented: $model.isPickerPresented) {
                TerminalLaunchSheet(model: model)
            }
            // Le projet a pu être choisi ailleurs (Session OMP, Mémoire, Fichiers)
            // depuis la dernière apparition : la préférence n'émet rien (S-4).
            .onAppear { model.followProjectRoot() }
    }

    private var isFailure: Bool {
        if case .failed = model.state { return true }
        return false
    }

    /// Le shell n'est plus là mais sa dernière image l'est : un bandeau le dit.
    private var showsEndBanner: Bool {
        switch model.state {
        case .exited, .failed: return true
        default: return false
        }
    }

    // MARK: - Zone de rendu

    @ViewBuilder private var content: some View {
        if let emulator = model.emulator {
            // Le TUI, même après la mort du process : la dernière image reste
            // affichée (S-1), sous un bandeau qui dit la fin du shell.
            VStack(spacing: 0) {
                if showsEndBanner {
                    HStack(spacing: 8) {
                        Text(model.statusText)
                        if let diagnostic = model.failureDiagnostic {
                            DiagnosticCopyButton(diagnostic: diagnostic, identifier: "terminal.diagnostic.copy")
                        }
                    }
                        .consoleBanner(tint: isFailure ? .red : .orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        // Conteneur : « Copier le diagnostic » garde son identifiant.
                        .accessibilityElement(children: .contain)
                        .accessibilityIdentifier("terminal.status")
                }
                TerminalViewRepresentable(
                    emulator: emulator,
                    palette: model.palette,
                    onResize: { columns, rows in model.viewDidMeasure(columns: columns, rows: rows) },
                    onKey: { bytes in model.send(keys: bytes) },
                    onAppearanceChange: { appearance in model.refreshPalette(for: appearance) }
                )
                .accessibilityIdentifier("terminal.view")
            }
        } else {
            placeholder
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // Un groupe AX : sans lui, l'identifiant de la zone recouvrirait
                // ceux des boutons « Choisir un projet… » (`terminal.chooseProject`)
                // et « Copier le diagnostic » (`terminal.diagnostic.copy`).
                .accessibilityElement(children: .contain)
                .accessibilityIdentifier("terminal.view")
        }
    }

    @ViewBuilder private var placeholder: some View {
        switch TerminalPlaceholder.of(model) {
        case .noProject:
            // Le projet choisi, la feuille s'ouvre aussitôt sur ses répertoires
            // (S-3) : la section ne change pas.
            NoProjectView(state: .terminal, chooser: chooser) { model.openPicker() }
        case let .waiting(projectName):
            ContentUnavailableView {
                Label(model.statusText, systemImage: "terminal")
            } description: {
                Text(TerminalViewText.projectNamed(projectName))
            }
        case let .status(text, systemImage):
            ContentUnavailableView {
                Label(text, systemImage: systemImage)
            } actions: {
                if let diagnostic = model.failureDiagnostic {
                    DiagnosticCopyButton(diagnostic: diagnostic, identifier: "terminal.diagnostic.copy")
                }
            }
        }
    }
}

/// La zone du terminal tant qu'aucun émulateur n'existe (S-4 de
/// mac-etats-vides-sans-issue) : sans projet, l'état vide et son sélecteur ; avec
/// projet, l'attente qui le nomme ; sinon (chargement de la feuille, lancement,
/// fin ou échec sans image), le texte d'état de toujours.
enum TerminalPlaceholder: Equatable {
    case noProject
    case waiting(projectName: String)
    case status(String, systemImage: String)

    @MainActor
    static func of(_ model: TerminalConsoleModel) -> TerminalPlaceholder {
        if case .idle = model.state, model.targetsState != .loading {
            guard let root = model.projectRoot else { return .noProject }
            return .waiting(projectName: root.lastPathComponent)
        }
        if case .failed = model.state {
            return .status(model.statusText, systemImage: "exclamationmark.triangle")
        }
        return .status(model.statusText, systemImage: "terminal")
    }
}
