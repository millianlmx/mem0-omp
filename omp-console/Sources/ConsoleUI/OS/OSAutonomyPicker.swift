// L'« OS agentique » : le CURSEUR D'AUTONOMIE d'un fil, à trois positions — « Tout me
// demander », « Règles du dépôt », « Livre et préviens-moi » —, toujours précédé de son
// libellé (« Autonomie : »). Il s'applique aux tâches vivantes du fil
// (`POST /v1/runs/{id}/autonomy`). La carte « Au travail » le montre ; ailleurs (carte de
// décision, carte « En attente ») le même réglage vit dans le menu « … » (`OSAutonomyMenu`).
// Rien ne paraît sans tâche vivante, pour un lecteur, ni sur un serveur qui n'annonce pas
// le curseur.

import ConsoleClient
import ConsoleCore
import SwiftUI

/// Les trois niveaux, dans l'ordre du curseur ; `nil` : les règles du dépôt.
private let osAutonomyLevels: [HarnessRunAutonomy?] = [.ask, nil, .deliver]

private func osAutonomyName(_ level: HarnessRunAutonomy?) -> String {
    switch level {
    case .ask: OSWatchText.autonomyAsk
    case .deliver: OSWatchText.autonomyDeliver
    case nil: OSWatchText.autonomyRules
    }
}

/// Pose `level` sur les tâches qui ne l'ont pas ; faux dès qu'une tâche le refuse.
@MainActor
private func osSetAutonomy(_ level: HarnessRunAutonomy?, on targets: [HarnessRun], server: HarnessModel) async -> Bool {
    var ok = true
    for run in targets where run.autonomy != level {
        ok = await server.setAutonomy(runId: run.id, level: level) && ok
    }
    return ok
}

public struct OSAutonomyPicker: View {
    @ObservedObject var server: HarnessModel
    let runs: [HarnessRun]
    let failed: @MainActor () -> Void
    /// Le niveau que l'humain vient de poser, le temps que le serveur le rende.
    @State private var chosen: HarnessRunAutonomy??
    @State private var saving = false

    /// `runs` : les tâches du fil ; seules les vivantes reçoivent le niveau. `failed` :
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
            // Le menu du système porte sa propre marge : le libellé garde celle de la carte.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 0) {
                    label
                    picker(live)
                }
                VStack(alignment: .leading, spacing: 0) {
                    label
                    picker(live)
                }
            }
            #else
            // Trois symboles se lisent vite, mais le niveau retenu garde son mot à côté.
            HStack(spacing: 8) {
                label
                picker(live)
                Text(osAutonomyName(chosen ?? live.last?.autonomy)).font(.caption).foregroundStyle(.secondary)
            }
            #endif
        }
    }

    /// « Autonomie : » — le curseur dit de quoi il règle le niveau.
    private var label: some View {
        Text(OSDecideText.autonomyLabel)
            .font(.callout)
            .foregroundStyle(.secondary)
            .accessibilityHidden(true)
    }

    private func picker(_ targets: [HarnessRun]) -> some View {
        Picker(OSDecideText.autonomy, selection: Binding(
            get: { chosen ?? targets.last?.autonomy },
            set: { level in apply(level, to: targets) }
        )) {
            level(osAutonomyName(.ask), "hand.raised.fill", .some(.ask))
            level(osAutonomyName(nil), "shield.lefthalf.filled", .none)
            level(osAutonomyName(.deliver), "paperplane.fill", .some(.deliver))
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
        // Le serveur a rendu les tâches : son niveau fait foi.
        .onChange(of: targets.map(\.autonomy)) { chosen = nil }
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
            let ok = await osSetAutonomy(level, on: targets, server: server)
            saving = false
            if !ok {
                chosen = nil
                failed()
            }
        }
    }
}

/// Le curseur d'autonomie en entrée de menu « … » : « Autonomie ▸ » et ses trois niveaux,
/// le niveau en vigueur coché. Rien sans tâche vivante ni sur un serveur sans curseur.
struct OSAutonomyMenu: View {
    @ObservedObject var server: HarnessModel
    let runs: [HarnessRun]
    let failed: @MainActor () -> Void

    var body: some View {
        let targets = runs.filter { server.osGestures($0).autonomy }
        if !targets.isEmpty {
            let current = targets.last?.autonomy
            Menu(OSDecideText.autonomy, systemImage: "dial.medium") {
                ForEach(osAutonomyLevels, id: \.self) { level in
                    Button {
                        Task {
                            if await !osSetAutonomy(level, on: targets, server: server) { failed() }
                        }
                    } label: {
                        if level == current {
                            Label(osAutonomyName(level), systemImage: "checkmark")
                        } else {
                            Text(osAutonomyName(level))
                        }
                    }
                }
            }
        }
    }
}
