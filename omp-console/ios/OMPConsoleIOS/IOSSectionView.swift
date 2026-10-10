import ConsoleClient
import ConsoleCore
import SwiftUI

/// L'écran UNIQUE des sept sections (S-2, BR-3) : il rend le contenu pur de
/// `IOSSectionContent` sur le kit de design de `Design/` — SAUF les six sections
/// à écran réel : Pipelines (`PipelinesScreen`), Projet (`IOSProjectScreen`),
/// Mémoire (`IOSMemoryScreen`), Statistiques (`IOSStatsScreen`), Sessions
/// (`IOSSessionsScreen`) et Session OMP (`IOSSessionOmpScreen`), toutes nourries
/// par le client partagé et routées directement : chacune porte son propre cadre,
/// pour que le composant d'état de connexion plein écran soit rendu hors de tout
/// panneau (etats-non-connecte-heterogenes-ios, S-4).
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
    /// Le crochet de recette `-memoire.recipe` de la section Mémoire.
    let memoryRecipe: IOSMemoryGraphRecipe?
    /// Le crochet de recette `-pipelines.recipe <vide|choisi|rempli>` de l'écran
    /// Pipelines (feuille « Nouvelle feature »).
    let pipelinesRecipe: IOSPipelinesRecipe?
    /// Le crochet de recette `-pipelines.recipe <fiche|actions|arret>` de l'écran
    /// Pipelines (fiche d'une carte).
    let cardRecipe: PipelinesCardRecipe?
    /// La feuille Connexion de la racine, ouverte par « Se connecter » du
    /// composant d'état de connexion des sections.
    @Binding var showConnection: Bool

    private var content: IOSSectionContent? {
        IOSSectionContent.of(section, state: state)
    }

    var body: some View {
        if section == .kanban {
            PipelinesScreen(client: client, recipe: state, newFeatureRecipe: pipelinesRecipe,
                            cardRecipe: cardRecipe, showConnection: $showConnection)
        } else if section == .memory {
            IOSMemoryScreen(client: client, recipe: state, graphRecipe: memoryRecipe, showConnection: $showConnection)
        } else if section == .sessions {
            IOSSessionsScreen(client: client, recipe: recipe, showConnection: $showConnection)
        } else if section == .session {
            IOSSessionOmpScreen(client: client, showConnection: $showConnection)
        } else if section == .project {
            IOSProjectScreen(client: client, showConnection: $showConnection)
        } else if section == .stats {
            IOSStatsScreen(client: client, showConnection: $showConnection)
        } else {
            genericBody
        }
    }

    private var genericBody: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(section.title)
                .font(.title2)
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
        .iosPanel()
        .navigationTitle(section.title)
        .accessibilityElement(children: .contain)
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
