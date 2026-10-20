// Les marques de machine de l'Accueil et de Pipelines (S-6 de orchestrator-living-in-a-vps) :
// le badge « Mac » ou « VPS » d'une carte et le bandeau d'une machine injoignable.
//
// Sans VPS configuré, ni badge ni bandeau : la valeur d'environnement `showsMachineBadges`
// reste fausse et les vues sont rendues comme avant. Le badge lit la machine de
// l'IDENTIFIANT de la carte (`MachineCardID`) : aucune vue ne la porte.

import ConsoleCore
import SwiftUI

private struct ShowsMachineBadgesKey: EnvironmentKey {
    static let defaultValue = false
}

extension EnvironmentValues {
    /// Vrai quand l'ardoise mêle deux machines : chaque carte porte alors son badge.
    var showsMachineBadges: Bool {
        get { self[ShowsMachineBadgesKey.self] }
        set { self[ShowsMachineBadgesKey.self] = newValue }
    }
}

/// Le badge d'une machine : « Mac » ou « VPS ».
struct MachineBadge: View {
    let machine: RepoMachine

    var body: some View {
        Text(verbatim: machine == .mac ? ReposText.macLabel : ReposText.vpsLabel)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(machine == .mac ? Color.secondary : Color.accentColor)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
            .fixedSize()
            .accessibilityLabel(ReposText.accessibility(machine == .mac ? ReposText.macLabel : ReposText.vpsLabel, machine: machine))
            .accessibilityIdentifier("machine.badge.\(machine.rawValue)")
    }
}

/// Le badge de la machine d'une carte de l'ardoise unifiée ; rien sans VPS configuré.
struct CardMachineBadge: View {
    let cardId: String
    @Environment(\.showsMachineBadges) private var shows

    var body: some View {
        if shows {
            MachineBadge(machine: MachineCardID.machine(of: cardId))
        }
    }
}

/// Les bandeaux « Mac injoignable » / « VPS injoignable » au-dessus de l'ardoise : les
/// cartes d'une machine injoignable ne sont pas affichées, le bandeau le dit.
struct MachineBanners: View {
    let unreachable: [RepoMachine]

    var body: some View {
        ForEach(unreachable, id: \.self) { machine in
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle")
                Text(verbatim: ReposText.machineBanner(machine))
                Spacer()
            }
            .font(.callout)
            .foregroundStyle(.orange)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("machine.banner.\(machine.rawValue)")
        }
    }
}
