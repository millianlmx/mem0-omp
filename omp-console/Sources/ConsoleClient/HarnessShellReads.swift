// Les lectures de la coque iOS, lancées EN MÊME TEMPS : à l'ouverture, au retour au premier
// plan et quand l'humain tire pour actualiser. Une lecture n'attend plus celle d'avant : le
// temps d'un chargement suit la plus longue chaîne de lectures dépendantes (deux allers-retours),
// pas la somme de toutes. Les lectures identiques en vol n'en font qu'une (`HarnessModel.send`).

import Foundation

/// Ce que la coque iOS lit d'un coup : à l'ouverture, ou pour actualiser (retour au premier plan, tirer).
public enum HarnessShellReads: Sendable {
    case opening
    case refreshing
}

extension HarnessModel {
    /// Lance toutes les lectures de la coque EN MÊME TEMPS et rend quand toutes ont fini. Ne lit jamais
    /// la boîte (l'appelant la lit : elle porte le curseur du flux). Chaque modèle garde ses données et
    /// ses échecs comme avant ; rien n'est publié ici.
    public func readShell(_ reads: HarnessShellReads) async {
        guard isConfigured else { return }
        switch reads {
        case .opening:
            async let runs: Void = history.refresh()
            async let station: Void = workstation.load()
            async let watch: Void = vigie.load()
            async let requests: Void = intakes.refresh()
            async let jira: Void = atlassian.refresh()
            async let local: Void = localSessions.refresh()
            async let clients: Void = spaces.refresh()
            async let found: Void = proposals.refresh()
            async let catalog: Void = refreshCatalog()
            _ = await (runs, station, watch, requests, jira, local, clients, found, catalog)
        case .refreshing:
            async let runs: Void = history.refresh()
            async let station: Void = workstation.refresh()
            async let requests: Void = intakes.refresh()
            async let jira: Void = atlassian.refresh()
            async let local: Void = localSessions.refresh()
            async let clients: Void = spaces.refresh()
            async let found: Void = proposals.refresh()
            async let paused: Void = pause.refresh()
            async let absence: Void = brief.refresh()
            async let consignes: Void = rules.refresh()
            async let levels: Void = autonomy.refresh()
            async let watch: Void = vigie.refresh()
            _ = await (runs, station, requests, jira, local, clients, found, paused, absence, consignes, levels, watch)
        }
    }
}
