// La section « Poste » de la coque Mac : le cadre des sections du serveur
// (`HarnessSection`, formulaire groupé) autour du contenu PARTAGÉ avec l'app iOS
// (`WorkstationSections`, cible ConsoleUI) — l'état de l'extension, l'autonomie et la
// garde d'envoi, la pause, les adresses, les envois à approuver, le profil, le journal
// et les réunions. La feuille de refus est posée par le cadre (`workstationGestures`).

import ConsoleClient
import ConsoleCore
import ConsoleUI
import SwiftUI

struct WorkstationView: View {
    @ObservedObject var server: HarnessModel
    @ObservedObject var workstation: WorkstationModel
    @ObservedObject var drafts: HarnessDrafts

    var body: some View {
        HarnessSection(server: server, drafts: drafts, catalog: false, reload: { await workstation.load() }) {
            WorkstationSections(workstation: workstation, drafts: drafts)
        }
        .task { await workstation.load() }
        .accessibilityIdentifier("workstation.harness")
    }
}
