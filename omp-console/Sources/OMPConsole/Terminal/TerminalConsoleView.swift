// La fenêtre « Terminal » (S-10, BR-3) : bandeau (cible, ligne d'état, boutons) et
// zone de rendu.
//
// CHAQUE état de la fenêtre a son rendu : `idle` (aucun répertoire choisi),
// `listing` (le catalogue de la feuille se charge), `starting`, `running` (le TUI),
// `exited` (image gelée + « Relancer »), `failed` (message d'erreur + « Relancer »).
// Aucun état n'est un rectangle vide (AC-3) : tant qu'aucun `omp` n'a rien écrit,
// c'est le texte de l'état qui occupe la zone, jamais un terminal vide.
//
// Aucun attribut macro SwiftUI (`@State`, `@Preview`, …) : sous les Command Line
// Tools seuls, ils échouent à la compilation. Tout l'état vit dans le modèle
// (`@ObservedObject`), et les `Binding` sont construits à la main.

import SwiftUI

struct TerminalConsoleView: View {
    @ObservedObject var model: TerminalConsoleModel

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
        }
        .frame(minWidth: 720, minHeight: 480)
        .background(WindowAccessor { model.attach(window: $0) })
        .sheet(isPresented: $model.isPickerPresented) {
            TerminalLaunchSheet(model: model)
        }
    }

    // MARK: - Bandeau

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(model.targetLabel)
                    .font(.system(.callout, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .accessibilityIdentifier("terminal.status.target")
                Spacer(minLength: 8)
                Button(TerminalViewText.chooseTarget) { model.openPicker() }
                    .accessibilityIdentifier("terminal.choose")
                Button(TerminalViewText.relaunch) { model.relaunch() }
                    .disabled(!model.canRelaunch)
                    .accessibilityIdentifier("terminal.relaunch")
                if case .starting = model.state {
                    ProgressView().controlSize(.small)
                }
            }
            Text(model.statusText)
                .font(.system(.callout, design: .monospaced))
                .foregroundStyle(isFailure ? .red : .primary)
                .accessibilityIdentifier("terminal.status")
        }
        .padding(12)
    }

    private var isFailure: Bool {
        if case .failed = model.state { return true }
        return false
    }

    // MARK: - Zone de rendu

    @ViewBuilder private var content: some View {
        if let emulator = model.emulator {
            // Le TUI, même après la mort du process : la dernière image reste
            // affichée (S-1), et le bandeau porte alors l'état `exited`.
            TerminalViewRepresentable(
                emulator: emulator,
                palette: model.palette,
                onResize: { columns, rows in model.viewDidMeasure(columns: columns, rows: rows) },
                onKey: { bytes in model.send(keys: bytes) }
            )
            .accessibilityIdentifier("terminal.view")
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
