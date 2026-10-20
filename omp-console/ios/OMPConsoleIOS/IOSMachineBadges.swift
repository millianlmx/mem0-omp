// Les marques de machine des cartes de l'Accueil et de Pipelines (S-6 de
// orchestrator-living-in-a-vps) : un badge « Mac » ou « VPS » sur chaque carte QUAND
// un VPS est configuré, un bandeau « <Machine> injoignable » par machine configurée
// qui ne répond pas. Sans VPS configuré, aucune de ces vues n'affiche rien : le rendu
// est celui d'avant.

import ConsoleCore
import SwiftUI

/// Le badge de machine d'une carte de l'ardoise unifiée.
struct IOSCardMachineBadge: View {
    let cardId: String
    /// Vrai quand un VPS est configuré (`UnifiedBoard.showsBadges`).
    let shows: Bool

    var body: some View {
        if shows {
            let machine = MachineCardID.machine(of: cardId)
            Text(machine.label)
                .font(.caption.weight(.medium))
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.accentColor.opacity(0.15)))
                .accessibilityLabel(IOSReposContent.badgeLabel(machine))
                .accessibilityIdentifier(IOSReposText.cardBadge(cardId))
        }
    }
}

/// Un bandeau par machine configurée mais injoignable : ses cartes ne s'affichent pas.
struct IOSMachineBanners: View {
    let machines: [RepoMachine]

    var body: some View {
        ForEach(machines, id: \.self) { machine in
            Text(ReposText.machineBanner(machine))
                .font(.callout)
                .iosBanner(tone: .attention)
                .accessibilityIdentifier(IOSReposText.banner(machine.rawValue))
        }
    }
}
