// Preuves de la bande d'état (BR-4, S-9) : les textes exacts, les identifiants
// d'accessibilité, et la visibilité de la ligne des notifications refusées (AC-7,
// AC-11).
//
// Les textes et la visibilité sont des fonctions PURES (`AlertsStripText`), donc
// vérifiables sans rendre de vue.

import Foundation
import Testing
@testable import OMPConsole

// MARK: - AC-7 : la ligne des compteurs, toujours présente

@Test("notifications-et-barre-de-menus/AC-7 : la bande affiche toujours les deux chiffres, x compris 0")
func countersLineTexts() {
    #expect(AlertsStripText.counters(.loading) == "Chargement des compteurs…")
    #expect(
        AlertsStripText.counters(.storeAbsent(dir: "/tmp/magasin"))
            == "Compteurs indisponibles — magasin d'état absent : /tmp/magasin"
    )
    // Référence de AC-7 : les DEUX chiffres sont affichés, même nuls.
    #expect(AlertsStripText.counters(.ready(.zero)) == "occupés : 0 · en attente : 0")
    #expect(AlertsStripText.counters(.ready(RunCounters(busy: 2, waiting: 5))) == "occupés : 2 · en attente : 5")
}

@Test("notifications-et-barre-de-menus/AC-7 : les identifiants d'accessibilité de la bande sont fixes")
func stripIdentifiers() {
    #expect(AlertsStripText.stripIdentifier == "status.strip")
    #expect(AlertsStripText.countersIdentifier == "status.counters")
    #expect(AlertsStripText.notificationsIdentifier == "status.notifications")
}

// MARK: - AC-11 : la ligne « notifications désactivées »

@Test("notifications-et-barre-de-menus/AC-11 : la ligne des notifications n'est visible que si l'autorisation est refusée")
func notificationsLineVisibility() {
    #expect(
        AlertsStripText.notifications
            == "Notifications désactivées — autorisez OMP Console dans Réglages Système ▸ Notifications."
    )
    // Visible SEULEMENT quand l'autorisation est refusée.
    #expect(AlertsStripText.showsNotifications(.denied))
    #expect(!AlertsStripText.showsNotifications(.authorized))
    #expect(!AlertsStripText.showsNotifications(.unknown))
    #expect(!AlertsStripText.showsNotifications(.unavailable))
}
