// La section « Poste » de la coque Mac : le cadre des sections du serveur
// (`HarnessSection`, formulaire groupé) autour de la page principale PARTAGÉE avec l'app
// iOS (`WorkstationSections`, cible ConsoleUI) — l'état et l'arrêt d'urgence, les envois
// à approuver, « Demander au poste », les dernières décisions — et des pages qu'elle
// pousse (`WorkstationPage` : réglages, automatisations, commande, profil, réunions,
// journal, sessions). La colonne de détail du Mac n'a pas de pile de navigation : ce
// cadre pose la sienne. Feuilles et confirmations : `workstationGestures`, posé par
// `HarnessSection`. Propre au Mac : « Navigateur du serveur » (comptes, copie continue du
// profil Chrome, connexion interactive dans une feuille), voir `ServerBrowserViews`.

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct WorkstationView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts
    @State private var serverLoginShown = false

    var body: some View {
        NavigationStack {
            HarnessSection(server: server, drafts: drafts, catalog: false, reload: { await workstation.load() }) {
                WorkstationSections(workstation: workstation, drafts: drafts)
                ServerBrowserSection(workstation: workstation, model: server.serverBrowser, loginShown: $serverLoginShown)
            }
            .navigationTitle(ConsoleSection.workstation.title)
            .workstationDestinations(server: server, drafts: drafts)
        }
        .modifier(ServerBrowserTasks(model: server.serverBrowser))
        .sheet(isPresented: $serverLoginShown) {
            ServerBrowserLoginSheet(model: server.serverBrowser, isPresented: $serverLoginShown)
        }
        .task { await workstation.load() }
        .accessibilityIdentifier("workstation.harness")
    }
}
