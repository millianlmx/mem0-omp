// L'« OS agentique » : le CURSEUR D'AUTONOMIE d'un fil, à trois positions — « Tout me
// demander », « Règles du dépôt », « Livre et préviens-moi ». Il s'applique aux features
// vivantes du fil (`POST /v1/runs/{id}/autonomy`). Rien ne paraît sans features vivantes,
// pour un lecteur, ni sur un serveur qui n'annonce pas le curseur.

import ConsoleClient
import ConsoleCore
import SwiftUI

public struct OSAutonomyPicker: View {
    @ObservedObject var server: HarnessModel
    let runs: [HarnessRun]
    let failed: @MainActor () -> Void
    /// Le niveau que l'humain vient de poser, le temps que le serveur le rende.
    @State private var chosen: HarnessRunAutonomy??
    @State private var saving = false

    /// `runs` : les features du fil ; seules les vivantes reçoivent le niveau. `failed` :
    /// appelé quand le serveur refuse (`server.failure` dit pourquoi).
    public init(server: HarnessModel, runs: [HarnessRun], failed: @escaping @MainActor () -> Void = {}) {
        self.server = server
        self.runs = runs
        self.failed = failed
    }

    private var targets: [HarnessRun] { runs.filter { server.osGestures($0).autonomy } }

    public var body: some View {
        let live = self.targets
        if !live.isEmpty {
            #if os(iOS)
            // Le menu du système porte sa propre marge : le mot qui le précède garde celle de la page.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 0) {
                    Text(OSDecideText.autonomy).font(.callout).foregroundStyle(.secondary).accessibilityHidden(true)
                    picker(live)
                }
                picker(live)
            }
            #else
            // Trois symboles se lisent vite, mais le niveau retenu garde son mot à côté.
            HStack(spacing: 8) {
                picker(live)
                Text(title(of: chosen ?? live.last?.autonomy)).font(.caption).foregroundStyle(.secondary)
            }
            #endif
        }
    }

    private func picker(_ targets: [HarnessRun]) -> some View {
        Picker(OSDecideText.autonomy, selection: Binding(
            get: { chosen ?? targets.last?.autonomy },
            set: { level in apply(level, to: targets) }
        )) {
            level(OSDecideText.askAll, "hand.raised.fill", .some(.ask))
            level(OSDecideText.repoRules, "shield.lefthalf.filled", .none)
            level(OSDecideText.deliver, "paperplane.fill", .some(.deliver))
        }
        // Trois positions côte à côte sur le Mac ; sur l'iPhone, où elles ne tiennent pas en
        // largeur, le menu du système montre la position retenue.
        #if os(macOS)
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        #else
        .pickerStyle(.menu)
        .labelsHidden()
        .frame(minHeight: ConsolePlatform.minimumTarget)
        #endif
        .disabled(saving)
        .accessibilityLabel(OSDecideText.autonomy)
        // Le serveur a rendu les features : son niveau fait foi.
        .onChange(of: targets.map(\.autonomy)) { chosen = nil }
    }

    private func title(of level: HarnessRunAutonomy?) -> String {
        switch level {
        case .ask: OSDecideText.askAll
        case .deliver: OSDecideText.deliver
        case nil: OSDecideText.repoRules
        }
    }

    /// Une position du curseur : un symbole (la main qui retient, le bouclier des règles, l'envoi),
    /// le mot en infobulle et pour VoiceOver. Le menu de l'iPhone garde le mot à côté du symbole.
    private func level(_ title: String, _ symbol: String, _ value: HarnessRunAutonomy?) -> some View {
        #if os(macOS)
        Label(title, systemImage: symbol)
            .labelStyle(.iconOnly)
            .help(title)
            .tag(value)
        #else
        Label(title, systemImage: symbol).tag(value)
        #endif
    }

    private func apply(_ level: HarnessRunAutonomy?, to targets: [HarnessRun]) {
        chosen = .some(level)
        saving = true
        Task {
            var ok = true
            for run in targets where run.autonomy != level {
                ok = await server.setAutonomy(runId: run.id, level: level) && ok
            }
            saving = false
            if !ok {
                chosen = nil
                failed()
            }
        }
    }
}
