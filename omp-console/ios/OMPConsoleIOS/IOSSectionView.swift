import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'écran UNIQUE des sept sections (S-2, BR-3) : il rend le contenu pur de
/// `IOSSectionContent` sur le kit de design de `Design/` — SAUF les cinq sections
/// à écran réel : Pipelines (`PipelinesScreen`), Projet (`IOSProjectScreen`),
/// Mémoire (`IOSMemoryScreen`), Statistiques (`IOSStatsScreen`) et Sessions
/// (`IOSSessionsScreen`), toutes nourries par le client partagé.
///
/// Ordre du rendu (sections à contenu) : panneau → titre → pastille → carte de
/// l'état vide → bandeau. Aucune phrase n'est composée ici : les mots viennent du
/// noyau partagé, le message provisoire du bandeau vient de `IOSText`.
struct IOSSectionView: View {
    let section: ConsoleSection
    let state: IOSScreenState
    @ObservedObject var client: ConsoleClientModel
    /// Le crochet de recette `-sessions.recipe` de la section Sessions.
    let recipe: IOSSessionsRecipe?

    private var content: IOSSectionContent? {
        IOSSectionContent.of(section, state: state)
    }

    var body: some View {
        if section == .kanban {
            PipelinesScreen(client: client, recipe: state)
        } else if section == .memory {
            IOSMemoryScreen(client: client, recipe: state)
        } else if section == .sessions {
            IOSSessionsScreen(client: client, recipe: recipe)
        } else if section == .session {
            IOSSessionOmpScreen(client: client)
        } else {
            genericBody
        }
    }

    private var genericBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(section.title)
                .font(.title2)
            if section == .project {
                IOSProjectScreen(client: client)
            } else if section == .stats {
                IOSStatsScreen(client: client)
            } else {
                if let status = content?.status {
                    IOSStatusChip(status: status)
                }
                if let content {
                    card(content)
                }
                if let banner = content?.banner, let message = content?.bannerMessage {
                    Text(message)
                        .font(.callout)
                        .iosBanner(tone: banner.tone)
                }
            }
        }
        .iosPanel()
        .navigationTitle(section.title)
        .accessibilityIdentifier("ios.screen." + section.rawValue)
    }

    /// La carte de l'état vide : l'icône SF de la section (elle suit la police),
    /// le mot (`.headline`) et la phrase d'aide (`.callout`), repliés sur
    /// plusieurs lignes — aucune largeur ni hauteur fixée, donc Dynamic Type
    /// maximum ne tronque rien (S-7).
    private func card(_ content: IOSSectionContent) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Image(systemName: content.systemImage)
                .font(.title3)
                .foregroundStyle(.secondary)
            Text(content.message)
                .font(.headline)
                .multilineTextAlignment(.leading)
            if let detail = content.detail {
                Text(detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.leading)
            }
        }
        .iosCard()
    }
}
