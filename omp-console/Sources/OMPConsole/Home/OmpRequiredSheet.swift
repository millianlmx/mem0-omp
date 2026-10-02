// La feuille « OMP est requis » (S-5 de omp-console-redesign) : bloquante tant
// qu'OMP est introuvable — ni Échap ni geste système ne la ferment. Elle se ferme
// d'elle-même quand « Vérifier à nouveau » (ou « Choisir l'emplacement… ») trouve
// OMP (la politique ne la rend plus). Aucun `@State` : le pli et les échecs
// vivent dans `HomeModel`.
//
// Audit HIG Alerts (2026-10-01) : l'icône de l'app, pas un triangle d'alerte ;
// les boutons en rangée à droite, le défaut le plus à droite ; les emplacements
// cherchés sont un DÉTAIL replié, un chemin par ligne, jamais coupé.

import AppKit
import SwiftUI

struct OmpRequiredSheet: View {
    @ObservedObject var home: HomeModel

    /// Les emplacements cherchés, lus de `home.omp`.
    private var searched: [String] {
        if case .missing(let searched, _) = home.omp { return searched }
        return []
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 16) {
                Image(nsImage: NSApp.applicationIconImage)
                    .resizable()
                    .frame(width: 64, height: 64)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 8) {
                    Text(HomeText.ompMissingTitle)
                        .font(.headline)
                    Text(HomeText.ompMissingBody)
                        .fixedSize(horizontal: false, vertical: true)
                    if home.chosenPathRejected {
                        Text(HomeText.chosenNotExecutable)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("home.ompMissing.rejected")
                    } else if home.recheckFailed {
                        Text(HomeText.stillMissing)
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .accessibilityIdentifier("home.ompMissing.still")
                    }
                }
            }
            DisclosureGroup(
                HomeText.searchedDisclosure,
                isExpanded: Binding(get: { home.searchedExpanded }, set: { home.searchedExpanded = $0 })
            ) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(HomeText.searchedIntro)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                    ForEach(Array(searched.enumerated()), id: \.offset) { _, path in
                        Text(verbatim: ConsoleFormat.path(path))
                            .font(.system(.callout, design: .monospaced))
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(path)
                            .textSelection(.enabled)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityIdentifier("home.ompMissing.details")
            HStack(spacing: 10) {
                Spacer()
                Button(HomeText.quit) { home.requestQuit() }
                    .accessibilityIdentifier("home.ompMissing.quit")
                Button(HomeText.chooseLocation) { chooseOmp() }
                    .accessibilityIdentifier("home.ompMissing.choose")
                Button(HomeText.recheck) { home.recheck() }
                    .keyboardShortcut(.defaultAction)
                    .accessibilityIdentifier("home.ompMissing.retry")
            }
            .controlSize(.large)
        }
        .padding(20)
        .frame(width: 480)
        .interactiveDismissDisabled(true)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("home.ompMissing")
    }

    /// « Choisir l'emplacement… » : le programme `omp`, fichiers cachés visibles
    /// (`~/.bun/bin` est sous un dossier caché).
    private func chooseOmp() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.prompt = HomeText.chooseLocationPrompt
        panel.message = HomeText.chooseLocationMessage
        guard panel.runModal() == .OK, let url = panel.url else { return }
        home.chooseOmp(path: url.path)
    }
}
