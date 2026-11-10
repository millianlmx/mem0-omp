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
        let targets = targets
        if !targets.isEmpty {
            Picker(OSDecideText.autonomy, selection: Binding(
                get: { chosen ?? targets.last?.autonomy },
                set: { level in apply(level, to: targets) }
            )) {
                Text(OSDecideText.askAll).tag(HarnessRunAutonomy?.some(.ask))
                Text(OSDecideText.repoRules).tag(HarnessRunAutonomy?.none)
                Text(OSDecideText.deliver).tag(HarnessRunAutonomy?.some(.deliver))
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .disabled(saving)
            .accessibilityLabel(OSDecideText.autonomy)
            // Le serveur a rendu les features : son niveau fait foi.
            .onChange(of: targets.map(\.autonomy)) { chosen = nil }
        }
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
