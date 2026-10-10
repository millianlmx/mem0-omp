// La fenêtre « Terminal » (S-10, BR-3) : la zone de rendu, sous un titre de
// fenêtre qui porte le nom du répertoire et un sous-titre « Shell · Actif ».
// « Choisir un dossier… » vit seul dans la barre d'outils ; « Relancer » et
// « Lancer omp », qui agissent sur le shell, partagent un même verre.
//
// CHAQUE état de la fenêtre a son rendu : `idle` (aucun répertoire choisi),
// `listing` (le catalogue de la feuille se charge), `starting`, `running` (le
// shell), `exited` (image gelée + « Relancer »), `failed` (message d'erreur +
// « Relancer »). Aucun état n'est un rectangle vide (AC-3) : tant qu'aucun shell
// ne vit, c'est le texte de l'état qui occupe la zone, jamais un terminal vide.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`, …) : sous les Command Line
// Tools seuls, ils échouent à la compilation. Tout l'état vit dans le modèle
// (`@ObservedObject`), et les `Binding` sont construits à la main.

import SwiftUI

struct TerminalConsoleView: View {
    @ObservedObject var model: TerminalConsoleModel

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
                    Text(model.statusText)
                        .consoleBanner(tint: isFailure ? .red : .orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
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
            ContentUnavailableView(model.statusText, systemImage: placeholderImage)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityIdentifier("terminal.view")
        }
    }

    private var placeholderImage: String {
        isFailure ? "exclamationmark.triangle" : "terminal"
    }
}
