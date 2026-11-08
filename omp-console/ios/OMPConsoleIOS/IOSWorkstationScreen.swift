import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

// La section « Poste » de l'app iOS : le cadre commun des écrans du serveur
// (`IOSHarnessScreen`, liste groupée) autour du contenu PARTAGÉ avec le Mac
// (`WorkstationSections`, cible ConsoleUI) — l'état de l'extension et l'observation,
// l'autonomie et la garde d'envoi, la pause, les adresses, les envois à approuver, le
// profil, le journal et les réunions. Sur iPhone, la section est rangée sous « Plus » :
// ses envois à approuver remontent aussi sur l'Accueil.

struct IOSWorkstationScreen: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        IOSHarnessScreen(server: server, drafts: drafts, section: .workstation, catalog: false, reloadAlso: { await workstation.load() }) {
            WorkstationSections(workstation: workstation, drafts: drafts)
        }
        .task { await workstation.load() }
    }
}
