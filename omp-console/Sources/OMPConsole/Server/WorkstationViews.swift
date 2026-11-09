// La section « Poste » de la coque Mac : le cadre des sections du serveur
// (`HarnessSection`, formulaire groupé) autour de la page principale PARTAGÉE avec l'app
// iOS (`WorkstationSections`, cible ConsoleUI) — l'état et l'arrêt d'urgence, les envois
// à approuver, « Demander au poste », les dernières décisions — et des pages qu'elle
// pousse (`WorkstationPage` : réglages, canaux, personnes, automatisations, commande, profil,
// réunions, journal, sessions). La colonne de détail du Mac n'a pas de pile de navigation : ce
// cadre pose la sienne. Feuilles et confirmations : `workstationGestures`, posé par
// `HarnessSection`.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct WorkstationView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        NavigationStack {
            HarnessSection(server: server, drafts: drafts, catalog: false, reload: { await load() }) {
                WorkstationSections(workstation: workstation, channels: server.channels, people: server.people, drafts: drafts)
            }
            .navigationTitle(ConsoleSection.workstation.title)
            .workstationDestinations(server: server, drafts: drafts)
        }
        .task { await load() }
        .accessibilityIdentifier("workstation.harness")
    }

    /// Le poste, puis ses canaux corpo et ses personnes (dont les rangées n’existent que s’ils sont servis).
    private func load() async {
        await workstation.load()
        await server.channels.refresh()
        await server.people.refresh()
    }
}
