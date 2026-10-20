// Le sélecteur « Mac | VPS » des écrans mono-machine (S-6 de
// orchestrator-living-in-a-vps) : Projet, Session OMP, Sessions, Mémoire,
// Statistiques et Audit lisent UNE machine à la fois. Il n'apparaît que lorsqu'un
// VPS est configuré ; le défaut est le Mac s'il est joignable, sinon le VPS
// (`MachineClients.activeMachine`).

import ConsoleClient
import ConsoleCore
import SwiftUI

struct IOSMachinePicker: View {
    @ObservedObject var clients: MachineClients

    /// Les six sections qui portent le sélecteur.
    static func isSingleMachine(_ section: ConsoleSection) -> Bool {
        switch section {
        case .project, .session, .sessions, .memory, .stats, .audit: true
        default: false
        }
    }

    var body: some View {
        if clients.vpsConfigured {
            Picker(
                ReposText.machinePickerLabel,
                selection: Binding(get: { clients.activeMachine }, set: { clients.select($0) })
            ) {
                ForEach(RepoMachine.allCases, id: \.self) { machine in
                    Text(machine.label).tag(machine)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)
            .background(.bar)
            .accessibilityIdentifier(IOSReposText.machinePicker)
        }
    }
}
