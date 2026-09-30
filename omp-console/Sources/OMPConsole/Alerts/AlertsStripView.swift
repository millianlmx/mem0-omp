// La bande d'état de la fenêtre (BR-4, S-9) : deux lignes informatives au-dessus du
// `NavigationSplitView`, donc visibles dans les quatre sections.
//
// Purement informative : AUCUN élément focusable, aucun geste — l'ordre de tabulation
// existant (barre latérale puis contenu) est inchangé. Tous les textes vivent dans
// `AlertsStripText`, des fonctions PURES que le test vérifie sans rendre de vue.

import SwiftUI

/// Tous les textes de la bande et ses identifiants d'accessibilité, en un endroit.
enum AlertsStripText {
    static let stripIdentifier = "status.strip"
    static let countersIdentifier = "status.counters"
    static let notificationsIdentifier = "status.notifications"

    /// La ligne des compteurs, toujours présente (S-9).
    static func counters(_ status: AlertsStatus) -> String {
        switch status {
        case .loading:
            return "Chargement des compteurs…"
        case .storeAbsent(let dir):
            return "Compteurs indisponibles — magasin d'état absent : \(dir)"
        case .ready(let counters):
            // Les DEUX chiffres sont toujours affichés, y compris 0 : c'est la
            // référence de AC-7 (la barre de menus, elle, peut n'être qu'une icône).
            return "occupés : \(counters.busy) · en attente : \(counters.waiting)"
        }
    }

    /// La ligne des notifications refusées (S-9). L'information ne dépend jamais de
    /// la couleur seule : la phrase la porte.
    static let notifications =
        "Notifications désactivées — autorisez OMP Console dans Réglages Système ▸ Notifications."

    /// La seconde ligne est visible SEULEMENT quand l'autorisation est refusée
    /// (AC-11) : `unknown` (pas encore répondu) et `unavailable` (hors bundle) ne
    /// l'affichent pas.
    static func showsNotifications(_ authorization: AlertAuthorization) -> Bool {
        authorization == .denied
    }
}

/// La bande : la ligne des compteurs (toujours) puis, si l'autorisation est
/// refusée, la ligne rouge des notifications.
struct AlertsStripView: View {
    @ObservedObject var model: AlertsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(AlertsStripText.counters(model.status))
                .font(.callout)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier(AlertsStripText.countersIdentifier)
            if AlertsStripText.showsNotifications(model.authorization) {
                // Recette visuelle du bandeau d'anomalies du Kanban (KanbanBannerView) :
                // fond `Color.red.opacity(0.1)`, texte `.red`, `.font(.callout)`.
                Text(AlertsStripText.notifications)
                    .font(.callout)
                    .foregroundStyle(.red)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.red.opacity(0.1))
                    .accessibilityIdentifier(AlertsStripText.notificationsIdentifier)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityIdentifier(AlertsStripText.stripIdentifier)
    }
}
