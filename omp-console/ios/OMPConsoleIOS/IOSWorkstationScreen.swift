import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// La section « Poste » de l'app iOS : le cadre commun des écrans du serveur
// (`IOSHarnessScreen`, liste groupée) autour de la page principale PARTAGÉE avec le Mac
// (`WorkstationSections`, cible ConsoleUI) — l'état et l'arrêt d'urgence, les envois à
// approuver, « Demander au poste », les dernières décisions — et des pages qu'elle pousse
// (`WorkstationPage`) dans la pile de navigation de l'onglet : pas de seconde pile ici.

struct IOSWorkstationScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .workstation, catalog: false, reloadAlso: {
            await workstation.load()
            await server.atlassian.refresh()
        }) {
            WorkstationSections(workstation: workstation, atlassian: server.atlassian, drafts: drafts)
        }
        .workstationDestinations(server: server, drafts: drafts)
        .task {
            await workstation.load()
            await server.atlassian.refresh()
        }
    }
}
